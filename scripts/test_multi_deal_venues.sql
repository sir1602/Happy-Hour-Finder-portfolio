-- ─────────────────────────────────────────────────────────────────────────────
-- Behaviour tests for migration_multi_deal_venues.sql
--
-- Runs against a throwaway Postgres 16, NOT against the project. Everything is
-- wrapped in a transaction that rolls back, but point it at a scratch database
-- anyway -- the fixtures insert venues and deals.
--
--   initdb -D /tmp/hhpg/data -U postgres --auth=trust
--   pg_ctl -D /tmp/hhpg/data -o "-k /tmp/hhpg -p 5433 -c listen_addresses=" start
--   psql -h /tmp/hhpg -p 5433 -U postgres -c "create role anon; create role authenticated; create role service_role;"
--   # create the venues/deals/metros base tables, then apply in this order:
--   #   migration_n8n_content_pipeline.sql
--   #   migration_hh_days_active_writeback.sql
--   #   migration_hh_deep_probe_proposals.sql
--   #   migration_hh_deep_verification.sql
--   #   migration_open_ended_time_windows.sql
--   #   migration_multi_deal_venues.sql
--   psql -h /tmp/hhpg -p 5433 -U postgres -f scripts/test_multi_deal_venues.sql
--
-- Every assertion prints "ok <label>"; the first failure aborts with FAIL.
-- 81 assertions at the time of writing. Section 14 is the contract with the
-- n8n workflows: payloads captured verbatim from real n8n executions rather
-- than shaped by hand to suit these functions. Section 15 pins the collision
-- rule, added after WF2's first live run showed that two happy hours on the
-- same day at different hours are two offers, not a duplicate.
--
-- The fixtures are the real thing: Cantina Verde - West Town's Mon-Thu/Fri pair and
-- Taco Bar's single deal are both taken from the live corpus, because the bug
-- this migration fixes is one that would have hit those exact rows.
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.ok(p_cond boolean, p_label text)
returns void language plpgsql as $$
begin
  if not p_cond then raise exception 'FAIL: %', p_label; end if;
  raise notice 'ok  %', p_label;
end $$;

insert into public.metros (slug, name, active) values ('chicago','Chicago, IL', true);

-- ── Fixture: the Cantina Verde case, exactly as it sits in the live corpus ──────
insert into public.venues (id, name, address, neighborhood, latitude, longitude, website, metro_id)
values ('11111111-1111-1111-1111-111111111111', 'Cantina Verde – West Town',
        '860 W Walnut St, Chicago, IL', 'West Town', 41.8961, -87.6570,
        'https://cantinaverde.example', (select id from public.metros where slug='chicago'));

insert into public.deals (id, venue_id, title, time_window, days_active, status, parent_deal_id, confidence)
values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        'Cantina Verde Happy Hour', '3:00pm - 6:00pm', '{5}', 'active', null, null),
       ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
        'Cantina Verde Happy Hour', '5:00pm - 6:00pm', '{1,2,3,4}', 'active',
        'aaaaaaaa-0000-0000-0000-000000000001', null);

-- ═══ 1. The regression this migration exists to prevent ════════════════════
-- The sweep checks the FRIDAY row, the model reads the more prominent Mon-Thu
-- window off the shared page, and reports it confidently. Before the guard this
-- rewrote Friday into a copy of Mon-Thu and the Friday happy hour vanished.
do $$
declare r jsonb; d public.deals%rowtype;
begin
  r := public.hh_record_verification(
         'aaaaaaaa-0000-0000-0000-000000000001', 'changed',
         '{"time_window":"5:00pm - 6:00pm","days_active":[1,2,3,4],"confidence":0.95}'::jsonb);
  select * into d from public.deals where id = 'aaaaaaaa-0000-0000-0000-000000000001';

  perform pg_temp.ok((r ->> 'wrong_sibling')::boolean, 'wrong-sibling reading is refused');
  perform pg_temp.ok(r ->> 'verification_status' = 'conflict', 'refused reading flags conflict for a human');
  perform pg_temp.ok(d.time_window = '3:00pm - 6:00pm', 'Friday window survives untouched');
  perform pg_temp.ok(d.days_active = '{5}', 'Friday days survive untouched');
  perform pg_temp.ok(d.status = 'active', 'Friday deal is still published');
  perform pg_temp.ok(r -> 'changes' ? 'wrong_sibling', 'the rejected reading is kept in the audit trail');
end $$;

-- ═══ 2. A genuine correction at the same venue still applies ═══════════════
-- Same row, but the model reads a Friday window that has actually moved. Days
-- overlap the stored ones, the window is nobody else's, so it is written.
do $$
declare r jsonb; d public.deals%rowtype;
begin
  r := public.hh_record_verification(
         'aaaaaaaa-0000-0000-0000-000000000001', 'changed',
         '{"time_window":"2:00 PM - 6:00 PM","days_active":[5],"confidence":0.95}'::jsonb);
  select * into d from public.deals where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  perform pg_temp.ok(not (r ->> 'wrong_sibling')::boolean, 'a real drift is not mistaken for a sibling');
  perform pg_temp.ok(d.time_window = '2:00 PM - 6:00 PM', 'a real drift is applied');
  perform pg_temp.ok(d.days_active = '{5}', 'days unchanged when the model agrees with them');
end $$;

-- ═══ 3. A confirmed reading may not steal a sibling's days ═════════════════
-- Window matches Mon-Thu perfectly, but the model returned the venue's WHOLE
-- schedule as the day list. Writing it would put Mon-Thu on Friday too.
do $$
declare r jsonb; d public.deals%rowtype;
begin
  r := public.hh_record_verification(
         'aaaaaaaa-0000-0000-0000-000000000002', 'confirmed',
         '{"time_window":"5:00pm - 6:00pm","days_active":[1,2,3,4,5],"confidence":0.95}'::jsonb);
  select * into d from public.deals where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  perform pg_temp.ok(d.days_active = '{1,2,3,4}', 'Mon-Thu does not absorb Friday');
  -- Recorded under `rejected_collision` since the collision fix: the guard now
  -- asks whether the write would create a day+hours overlap, not whether it
  -- touches a sibling's days.
  perform pg_temp.ok(r -> 'changes' ? 'rejected_collision', 'the refused reading is recorded');
end $$;

-- ═══ 4. Single-deal venues still behave exactly as before ══════════════════
insert into public.venues (id, name, address, neighborhood, latitude, longitude, website, metro_id)
values ('22222222-2222-2222-2222-222222222222', 'Taco Bar', '100 N Main St, Chicago, IL',
        'Wicker Park', 41.9096, -87.6773, 'https://tacobar.example',
        (select id from public.metros where slug='chicago'));
insert into public.deals (id, venue_id, title, time_window, days_active, status, confidence)
values ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
        '$3 Tacos & $5 Margaritas', '3:00pm - 6:00pm', '{0,1,2,3,4,5,6}', 'active', 0.5);

do $$
declare d public.deals%rowtype;
begin
  perform public.hh_record_verification(
    'bbbbbbbb-0000-0000-0000-000000000001', 'changed',
    '{"time_window":"4 PM - 6 PM","days_active":[1,2,3,4],"confidence":0.95}'::jsonb);
  select * into d from public.deals where id = 'bbbbbbbb-0000-0000-0000-000000000001';
  perform pg_temp.ok(d.time_window = '4 PM - 6 PM', 'Taco Bar: drift still corrected at a one-deal venue');
  perform pg_temp.ok(d.days_active = '{1,2,3,4}', 'Taco Bar: days still corrected');
end $$;

-- ═══ 5. Group intake: two windows, one venue, one call ════════════════════
do $$
declare r jsonb; n int; root uuid; child uuid;
begin
  r := public.hh_intake_venue_deals('{
    "source":"burst_scan","source_url":"https://gallery.example/happy-hour",
    "venue":{"name":"Gallery","address":"1020 W Spruce St, Chicago, IL",
             "neighborhood":"River North","latitude":41.8957,"longitude":-87.6350,
             "website":"https://gallery.example"},
    "deals":[
      {"title":"Gallery Apero","time_window":"4 PM - 5:30 PM","days_active":[1,2,3,4],"confidence":0.9},
      {"title":"Gallery Apero","time_window":"12 PM - 3 PM","days_active":[5],"confidence":0.9}]}'::jsonb);

  perform pg_temp.ok(r ->> 'venue_action' = 'inserted', 'new venue inserted once for the whole group');
  perform pg_temp.ok(jsonb_array_length(r -> 'deals') = 2, 'both windows written');
  perform pg_temp.ok(not (r ->> 'overlapping_day_sets')::boolean, 'disjoint day sets are accepted');

  select count(*) into n from public.deals d
    join public.venues v on v.id = d.venue_id where v.name = 'Gallery';
  perform pg_temp.ok(n = 2, 'two sibling rows exist');

  select d.id into root from public.deals d join public.venues v on v.id = d.venue_id
   where v.name = 'Gallery' and d.parent_deal_id is null;
  select d.id into child from public.deals d join public.venues v on v.id = d.venue_id
   where v.name = 'Gallery' and d.parent_deal_id is not null;
  perform pg_temp.ok(root is not null and child is not null, 'the group has one root and one child');
  perform pg_temp.ok((select parent_deal_id from public.deals where id = child) = root,
                     'the second window is parented to the group root');
  perform pg_temp.ok((select bool_and(status = 'active') from public.deals where id in (root, child)),
                     'both windows published at confidence 0.9');
end $$;

-- ═══ 6. Re-scan: one window shifts, the sibling is untouched ══════════════
do $$
declare r jsonb; fri public.deals%rowtype; mon public.deals%rowtype;
begin
  r := public.hh_intake_venue_deals('{
    "source":"burst_scan",
    "venue":{"name":"Gallery","address":"1020 W Spruce St, Chicago, IL",
             "neighborhood":"River North","latitude":41.8957,"longitude":-87.6350},
    "deals":[
      {"title":"Gallery Apero","time_window":"4 PM - 5:30 PM","days_active":[1,2,3,4],"confidence":0.95},
      {"title":"Gallery Apero","time_window":"12 PM - 4 PM","days_active":[5],"confidence":0.95}]}'::jsonb);

  perform pg_temp.ok(r ->> 'venue_action' = 'matched', 'the venue is matched, not duplicated');
  perform pg_temp.ok((select count(*) from public.deals d join public.venues v on v.id = d.venue_id
                       where v.name = 'Gallery') = 2, 'still two rows, nothing duplicated');

  select d.* into fri from public.deals d join public.venues v on v.id = d.venue_id
   where v.name = 'Gallery' and d.days_active = '{5}';
  select d.* into mon from public.deals d join public.venues v on v.id = d.venue_id
   where v.name = 'Gallery' and d.days_active = '{1,2,3,4}';

  perform pg_temp.ok(fri.time_window = '12 PM - 4 PM', 'the Friday window is the one that moved');
  perform pg_temp.ok(mon.time_window = '4 PM - 5:30 PM', 'the Mon-Thu window is untouched');
  perform pg_temp.ok(fri.verification_status = 'changed', 'the moved row is marked changed');
  perform pg_temp.ok(mon.verification_status = 'verified', 'the unmoved row is marked verified');
end $$;

-- ═══ 7. Two windows that could both be shown at once are a model error ════
-- The fixture used to be 4-6 PM Mon-Wed alongside 12-3 PM Wed-Thu, which shares
-- Wednesday but not an hour -- a lunch and an afternoon happy hour. Under the
-- day-only invariant that was refused; it is legitimate, and section 15 now
-- pins that. This fixture genuinely collides: both cover Wednesday evening.
do $$
declare r jsonb;
begin
  r := public.hh_intake_venue_deals('{
    "source":"burst_scan",
    "venue":{"name":"Overlap Tavern","address":"1 W Nowhere St, Chicago, IL",
             "neighborhood":"Loop","latitude":41.8800,"longitude":-87.6300},
    "deals":[
      {"title":"Overlap HH","time_window":"4 PM - 6 PM","days_active":[1,2,3],"confidence":0.99},
      {"title":"Overlap HH","time_window":"5 PM - 7 PM","days_active":[3,4],"confidence":0.99}]}'::jsonb);

  perform pg_temp.ok((r ->> 'overlapping_day_sets')::boolean, 'the overlap is detected');
  perform pg_temp.ok((select bool_and(status = 'pending') from public.deals d
                        join public.venues v on v.id = d.venue_id where v.name = 'Overlap Tavern'),
                     'the whole set queues for review, not half of it');
end $$;

-- ═══ 8. The single-deal contract is byte-for-byte unchanged ═══════════════
do $$
declare r jsonb;
begin
  r := public.hh_intake_deal('{
    "source":"google_sheet","source_url":"https://sheet.example",
    "venue":{"name":"Sheet Bar","address":"9 N Sheet St, Chicago, IL",
             "neighborhood":"Loop","latitude":41.8820,"longitude":-87.6290},
    "deal":{"title":"$5 Margaritas","time_window":"4 PM - 7 PM","days_active":[1,2,3,4,5],"confidence":0.9}}'::jsonb);

  perform pg_temp.ok(r ? 'deal_id' and r ? 'deal_action' and r ? 'status',
                     'the flat single-deal reply shape is preserved');
  perform pg_temp.ok(r ->> 'status' = 'active', 'a confident parseable single deal still auto-publishes');
  perform pg_temp.ok(r ->> 'deal_action' = 'inserted', 'and reports inserted');
end $$;

-- An unstated day set at a brand-new single-deal venue still means all week,
-- exactly as before -- that default is only withdrawn when there are siblings.
do $$
declare r jsonb;
begin
  r := public.hh_intake_deal('{
    "source":"google_sheet",
    "venue":{"name":"Daily Bar","address":"7 N Daily St, Chicago, IL",
             "neighborhood":"Loop","latitude":41.8830,"longitude":-87.6280},
    "deal":{"title":"All Week HH","time_window":"4 PM - 7 PM","confidence":0.9}}'::jsonb);
  perform pg_temp.ok((select days_active from public.deals where id = (r ->> 'deal_id')::uuid)
                     = '{0,1,2,3,4,5,6}', 'a lone deal with no days still defaults to every day');
end $$;

-- ...but one window out of several saying nothing about days is not a claim
-- that it runs all week, so it waits for a human instead.
do $$
declare r jsonb; ids uuid[];
begin
  r := public.hh_intake_venue_deals('{
    "source":"burst_scan",
    "venue":{"name":"Vague Tavern","address":"3 N Vague St, Chicago, IL",
             "neighborhood":"Loop","latitude":41.8840,"longitude":-87.6270},
    "deals":[
      {"title":"Vague HH","time_window":"4 PM - 6 PM","days_active":[1,2,3,4],"confidence":0.99},
      {"title":"Vague HH","time_window":"12 PM - 3 PM","confidence":0.99}]}'::jsonb);

  perform pg_temp.ok((select count(*) from public.deals d join public.venues v on v.id = d.venue_id
                       where v.name = 'Vague Tavern' and d.days_active is null and d.status = 'pending') = 1,
                     'a window with no days is never published as running all week');
end $$;

-- ═══ 9. Duplicates told apart from schedules ══════════════════════════════
do $$
begin
  perform pg_temp.ok((select count(*) from public.hh_duplicate_deals
                       where venue_name like 'Cantina Verde%') = 0,
                     'a Mon-Thu / Fri schedule is not reported as a duplicate');
  perform pg_temp.ok((select count(*) from public.hh_day_variant_deals
                       where venue_name like 'Cantina Verde%') = 1,
                     'it is reported as a day-variant instead');

  insert into public.deals (venue_id, title, time_window, days_active, status)
  values ('22222222-2222-2222-2222-222222222222', '$3 Tacos & $5 Margaritas',
          '5 PM - 7 PM', '{1,2,3,4}', 'active');
  perform pg_temp.ok((select count(*) from public.hh_duplicate_deals
                       where venue_name = 'Taco Bar') = 1,
                     'two rows that could both show on a Monday ARE a duplicate');
end $$;

-- ═══ 10. Proposing and approving a second window ══════════════════════════
do $$
declare r jsonb; a jsonb; newid uuid;
begin
  r := public.hh_propose_deal_change(
         'bbbbbbbb-0000-0000-0000-000000000001', 'deep_probe',
         '{"kind":"new_sibling","title":"Taco Bar Late Night","time_window":"10 PM - 12 AM",
           "days_active":[5,6],"confidence":0.7}'::jsonb,
         'https://tacobar.example/happy-hour', 'url_context');
  perform pg_temp.ok(r ->> 'outcome' = 'proposed_sibling', 'a second window can be proposed');
  perform pg_temp.ok((select count(*) from public.deals
                       where venue_id = '22222222-2222-2222-2222-222222222222') = 2,
                     'proposing writes nothing to deals');

  a := public.hh_review_proposal((r ->> 'proposal_id')::uuid, 'approve');
  newid := (a ->> 'new_deal_id')::uuid;
  perform pg_temp.ok(newid is not null, 'approving inserts the sibling');
  perform pg_temp.ok((select days_active from public.deals where id = newid) = '{5,6}',
                     'the new sibling carries its own days');
  perform pg_temp.ok((select parent_deal_id from public.deals where id = newid) is not null,
                     'the new sibling joins the group');
end $$;

-- A proposal that would collide with a row the venue already has is refused at
-- filing time. The fixture used to be 7-9 PM on Friday against Cantina Verde's
-- 3-6 PM Friday row -- the same day, but four hours apart, which is an early
-- and a late-night happy hour rather than a contradiction. Under the day-only
-- invariant that was refused; section 15 now pins that it is allowed. 4-5 PM
-- sits inside the existing Friday window, so it genuinely collides.
do $$
declare r jsonb;
begin
  r := public.hh_propose_deal_change(
         'aaaaaaaa-0000-0000-0000-000000000001', 'deep_probe',
         '{"kind":"new_sibling","time_window":"4 PM - 5 PM","days_active":[5],"confidence":0.9}'::jsonb);
  perform pg_temp.ok(r ->> 'outcome' = 'rejected_overlaps_existing',
                     'a sibling colliding with an existing window is refused');

  -- ...and the same day at hours that do not overlap is not a collision.
  r := public.hh_propose_deal_change(
         'aaaaaaaa-0000-0000-0000-000000000001', 'deep_probe',
         '{"kind":"new_sibling","time_window":"7 PM - 9 PM","days_active":[5],"confidence":0.9}'::jsonb);
  perform pg_temp.ok(r ->> 'outcome' = 'proposed_sibling',
                     'a late-night sibling on a day already covered is allowed');
end $$;

-- ═══ 11. The sweep feed hands over whole groups ═══════════════════════════
do $$
declare row_count int; barco jsonb;
begin
  update public.deals set last_verified_at = now() - interval '90 days';
  select count(*) into row_count from public.hh_venues_needing_verification(50);
  perform pg_temp.ok(row_count > 0, 'the venue feed returns work');

  select deals into barco from public.hh_venues_needing_verification(50)
   where venue_name like 'Cantina Verde%';
  perform pg_temp.ok(jsonb_array_length(barco) = 2,
                     'a multi-deal venue arrives as one row carrying both siblings');
  perform pg_temp.ok((select count(*) from public.hh_venues_needing_verification(50)
                       where venue_name like 'Cantina Verde%') = 1,
                     'and is crawled once, not once per sibling');
end $$;

-- ═══ 12. hh_window_key agrees with the app on what "the same time" means ══
do $$
begin
  perform pg_temp.ok(public.hh_window_key('4:00pm - 7:00pm') = public.hh_window_key('4:00 PM - 7:00 PM'),
                     'case and spacing do not make two windows differ');
  perform pg_temp.ok(public.hh_window_key('4 PM - 7 PM') = public.hh_window_key('4:00 PM - 7:00 PM'),
                     '"4 PM" and "4:00 PM" are the same time');
  perform pg_temp.ok(public.hh_window_key('4 PM – 7 PM') = public.hh_window_key('4 PM - 7 PM'),
                     'an en dash is still a range');
  perform pg_temp.ok(public.hh_window_key('4 PM to 7 PM') = public.hh_window_key('4 PM - 7 PM'),
                     '"to" is still a range');
  perform pg_temp.ok(public.hh_window_key('All Day') is null, 'an unreadable window has no key');
  -- Two windows this function cannot read are not evidence of agreement. The
  -- key is NULL for both, and NULL = NULL is NULL rather than true, which is
  -- exactly what every call site above relies on.
  perform pg_temp.ok(
    coalesce(public.hh_window_key('All Day') = public.hh_window_key('4pm - Close'), false) = false,
    'two unreadable windows never compare equal');
end $$;

-- ═══ 13. A scan that misses a window never retires it ═════════════════════
do $$
declare r jsonb;
begin
  r := public.hh_intake_venue_deals('{
    "source":"burst_scan",
    "venue":{"name":"Gallery","address":"1020 W Spruce St, Chicago, IL",
             "neighborhood":"River North","latitude":41.8957,"longitude":-87.6350},
    "deals":[{"title":"Gallery Apero","time_window":"4 PM - 5:30 PM",
              "days_active":[1,2,3,4],"confidence":0.95}]}'::jsonb);

  perform pg_temp.ok(jsonb_array_length(r -> 'unseen_deal_ids') = 1,
                     'the window this scan did not read is reported');
  perform pg_temp.ok((select count(*) from public.deals d join public.venues v on v.id = d.venue_id
                       where v.name = 'Gallery' and d.status = 'active') = 2,
                     'and is left published -- a missed window is not a removed one');
  perform pg_temp.ok(exists (select 1 from public.content_audit_log
                              where field_changes ? 'unseen_in_scan'),
                     'it is recorded in the audit trail for the digest');
end $$;

-- ═══ 14. The contract with the workflows ══════════════════════════════════
-- The payload below is not written to suit this function: it is the `intake`
-- object Workflow 1's "Normalize & Validate" node actually produced, copied
-- verbatim out of a production run. Every other test here calls the RPC with
-- arguments shaped by hand, which cannot catch the one failure that no amount
-- of hand-shaping would -- the workflow naming a field the RPC does not read,
-- or omitting one it requires.
--
-- If you change the payload Normalize & Validate builds, re-capture it from a
-- `test_workflow` run and paste the new one here. The venue NAME is the one
-- thing altered from the capture -- section 5 already uses "Gallery", and a
-- collision there would make `venue_action` read `matched` and hide what this
-- section is actually asserting.
do $$
declare r jsonb; n int; root uuid; child uuid;
begin
  r := public.hh_intake_venue_deals('{
    "source": "burst_scan",
    "source_url": "https://gallery.example/happy-hour",
    "metro_slug": null,
    "venue": {
      "name": "Gallery Superior", "address": "1020 W Spruce St, Chicago, IL",
      "neighborhood": "River North", "latitude": 41.8957, "longitude": -87.635,
      "website": "https://gallery.example", "phone": null, "image_url": null,
      "google_place_id": null
    },
    "deals": [
      {"title": "Gallery Apero", "description": null, "time_window": "4 PM - 5:30 PM",
       "days_active": [1,2,3,4], "tags": ["cocktails"], "price_level": 3,
       "type": "regular", "image_url": null, "confidence": 0.9},
      {"title": "Gallery Apero", "description": null, "time_window": "12 PM - 3 PM",
       "days_active": [5], "tags": ["cocktails"], "price_level": 3,
       "type": "regular", "image_url": null, "confidence": 0.9}
    ]
  }'::jsonb);

  perform pg_temp.ok(r ->> 'venue_action' = 'inserted', 'the workflow payload is accepted as-is');
  perform pg_temp.ok(jsonb_array_length(r -> 'deals') = 2, 'both windows are written');

  select d.id into root from public.deals d join public.venues v on v.id = d.venue_id
   where v.name = 'Gallery Superior' and d.parent_deal_id is null;
  select d.id into child from public.deals d join public.venues v on v.id = d.venue_id
   where v.name = 'Gallery Superior' and d.parent_deal_id is not null;
  perform pg_temp.ok(root is not null and child is not null,
                     'the workflow payload produces a real deal group');
  perform pg_temp.ok((select parent_deal_id from public.deals where id = child) = root,
                     'the second window is parented to the root');
  perform pg_temp.ok((select bool_and(status = 'active') from public.deals d
                        join public.venues v on v.id = d.venue_id where v.name = 'Gallery Superior'),
                     'a confident parseable group from the engine publishes both windows');
  perform pg_temp.ok((select bool_and(tags = '{cocktails}') from public.deals d
                        join public.venues v on v.id = d.venue_id where v.name = 'Gallery Superior'),
                     'tags survive the round trip');
  perform pg_temp.ok((select source_url from public.deals where id = root)
                     = 'https://gallery.example/happy-hour',
                     'the evidence page, not the homepage, is stored as source_url');
end $$;

-- The other direction: what hh_venues_needing_verification() hands back is the
-- pin data Workflow 2's "Fetch Stalest Venues" was tested against (execution
-- 1298), so the keys Flatten RPC Rows and Crawl Target read are asserted here.
do $$
declare row_json jsonb;
begin
  update public.deals set last_verified_at = now() - interval '90 days';
  select to_jsonb(t) into row_json from public.hh_venues_needing_verification(50) t
   where t.venue_name like 'Cantina Verde%';

  perform pg_temp.ok(row_json ? 'venue_id' and row_json ? 'venue_name'
                     and row_json ? 'venue_address' and row_json ? 'venue_neighborhood'
                     and row_json ? 'website' and row_json ? 'source_url'
                     and row_json ? 'deals',
                     'every key Crawl Target reads is present');
  perform pg_temp.ok(jsonb_array_length(row_json -> 'deals') = 2,
                     'the venue arrives carrying its whole group');
  perform pg_temp.ok((row_json -> 'deals' -> 0) ? 'deal_id'
                     and (row_json -> 'deals' -> 0) ? 'time_window'
                     and (row_json -> 'deals' -> 0) ? 'days_active'
                     and (row_json -> 'deals' -> 0) ? 'title',
                     'every key Decide Verdict reads is present on each deal');
end $$;

-- ═══ 15. Same day is fine. Same day AND the same hours is not ═════════════
-- Added after WF2's first live run (a production run) disproved the original
-- invariant. Bocaditos runs 4-6 PM and 8:30-9:30 PM, both Sunday to Thursday.
-- That is two offers, not a duplicate, and the day-only test got it wrong in
-- three separate places.
do $$
begin
  -- The collision test itself.
  perform pg_temp.ok(
    not public.hh_windows_collide('4 PM - 6 PM', '{0,1,2,3,4}', '8:30 PM - 9:30 PM', '{0,1,2,3,4}'),
    'an early and a late happy hour on the same days do not collide');
  perform pg_temp.ok(
    public.hh_windows_collide('4 PM - 6 PM', '{1,2,3}', '5 PM - 7 PM', '{3,4,5}'),
    'overlapping hours on a shared day do collide');
  perform pg_temp.ok(
    not public.hh_windows_collide('4 PM - 6 PM', '{1,2,3}', '5 PM - 7 PM', '{4,5}'),
    'overlapping hours on days never shared do not collide');
  perform pg_temp.ok(
    not public.hh_windows_collide('4 PM - 6 PM', '{1}', '6 PM - 8 PM', '{1}'),
    'windows that merely touch are adjacent, not overlapping');
  perform pg_temp.ok(
    public.hh_windows_collide('9 PM - 2 AM', '{1}', '1 AM - 3 AM', '{2}'),
    'an overnight window collides with the next morning it runs into');
  perform pg_temp.ok(
    public.hh_windows_collide('All Day', '{1}', '4 PM - 6 PM', '{1}'),
    'a window that cannot be read cannot be shown not to collide');
end $$;

-- Intake must publish an early+late pair rather than refusing the whole set.
do $$
declare r jsonb;
begin
  r := public.hh_intake_venue_deals('{
    "source": "burst_scan",
    "venue": {"name": "Bocaditos Test", "address": "915 W Willow St, Chicago, IL",
              "neighborhood": "West Loop", "latitude": 41.8814, "longitude": -87.6554},
    "deals": [
      {"title": "Bocaditos Happy Hour", "time_window": "4 PM - 6 PM",
       "days_active": [0,1,2,3,4], "confidence": 0.95},
      {"title": "Bocaditos Happy Hour", "time_window": "8:30 PM - 9:30 PM",
       "days_active": [0,1,2,3,4], "confidence": 0.95}]}'::jsonb);

  perform pg_temp.ok(not (r ->> 'overlapping_day_sets')::boolean,
                     'an early and a late window on the same days is not a contradiction');
  perform pg_temp.ok((select bool_and(status = 'active') from public.deals d
                        join public.venues v on v.id = d.venue_id where v.name = 'Bocaditos Test'),
                     'both windows publish');
  perform pg_temp.ok((select count(*) from public.hh_duplicate_deals
                       where venue_name = 'Bocaditos Test') = 0,
                     'and they are not reported as duplicates');
  perform pg_temp.ok((select count(*) from public.hh_day_variant_deals
                       where venue_name = 'Bocaditos Test') = 1,
                     'they are reported as one happy hour on two schedules');
end $$;

-- Two windows that really do collide still land in review.
do $$
declare r jsonb;
begin
  r := public.hh_intake_venue_deals('{
    "source": "burst_scan",
    "venue": {"name": "Collide Tavern", "address": "5 N Collide St, Chicago, IL",
              "neighborhood": "Loop", "latitude": 41.8850, "longitude": -87.6250},
    "deals": [
      {"title": "Collide HH", "time_window": "4 PM - 6 PM", "days_active": [1,2,3], "confidence": 0.99},
      {"title": "Collide HH", "time_window": "5 PM - 7 PM", "days_active": [3,4], "confidence": 0.99}]}'::jsonb);

  perform pg_temp.ok((r ->> 'overlapping_day_sets')::boolean, 'a real collision is still caught');
  perform pg_temp.ok((select bool_and(status = 'pending') from public.deals d
                        join public.venues v on v.id = d.venue_id where v.name = 'Collide Tavern'),
                     'and the whole set still queues for review');
end $$;

-- The guard that was inert: a reading may not drag one window onto its
-- sibling's hours, even at a venue whose rows already share days.
do $$
declare early uuid; late uuid; r jsonb; after public.deals%rowtype;
begin
  select d.id into early from public.deals d join public.venues v on v.id = d.venue_id
   where v.name = 'Bocaditos Test' and d.time_window = '4 PM - 6 PM';
  select d.id into late from public.deals d join public.venues v on v.id = d.venue_id
   where v.name = 'Bocaditos Test' and d.time_window = '8:30 PM - 9:30 PM';

  -- The model reads the EARLY window and it gets placed on the late row.
  r := public.hh_record_verification(late, 'changed',
         '{"time_window":"4:30 PM - 6:00 PM","days_active":[0,1,2,3,4],"confidence":0.95}'::jsonb);
  select * into after from public.deals where id = late;

  perform pg_temp.ok(r ->> 'verification_status' = 'conflict',
                     'a reading that would overlap the sibling is refused');
  perform pg_temp.ok(after.time_window = '8:30 PM - 9:30 PM',
                     'the late window survives untouched');
  perform pg_temp.ok(r -> 'changes' ? 'rejected_collision',
                     'and the refused reading is kept for the digest');

  -- A genuine correction to the late window, still clear of the early one.
  r := public.hh_record_verification(late, 'changed',
         '{"time_window":"9 PM - 10 PM","days_active":[0,1,2,3,4],"confidence":0.95}'::jsonb);
  select * into after from public.deals where id = late;
  perform pg_temp.ok(after.time_window = '9 PM - 10 PM',
                     'a correction that stays clear of the sibling still applies');
end $$;

rollback;
