-- ─────────────────────────────────────────────────────────────────────────────
-- Give a venue a picture of itself.
--
-- A venue the discovery pipeline creates has no artwork at all. The app hid
-- that behind a stock photo, twice over and in two different places:
--
--   services/dealService.ts  image_url: data.imageUrl
--                              || 'https://picsum.photos/seed/placeholder/600/400'
--
-- written into the row on insert, and the identical URL again as the read-time
-- fallback. A *fixed* seed, so every imageless venue stored and rendered the
-- same random stock photograph -- and stored it as though it were data, which
-- is what made "which venues still need artwork?" an unanswerable question.
--
-- The fix is in two halves. The app stops writing a stock URL (null means "no
-- artwork", honestly), and Workflow 6 fills the gap from the one source that is
-- both free and unambiguously about this venue: the venue's own website, whose
-- og:image is the picture it publishes of itself.
--
-- Google Places is deliberately NOT that source. Place IDs may be stored
-- indefinitely, but Places photo content may not be cached or re-hosted -- it
-- has to be fetched live and shown with its authorAttributions. Honouring that
-- would mean a display-time proxy whose cost scales with views rather than with
-- venues, for artwork that changes about never.
--
-- Of the 364 venues at the time of writing, 15 have no image. All 15 came from
-- burst_scan, all 15 have an active deal in the feed, and all 15 have a website.
--
-- Depends on: migration_n8n_content_pipeline.sql, migration_metros.sql,
--             migration_deal_photo_intake.sql, migration_hh_review_console.sql
--
-- Safe to re-run: every statement is guarded.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Where the artwork came from, and when we last tried ──────────────────
alter table public.venues
  add column if not exists image_source     text,
  add column if not exists image_source_url text,
  add column if not exists image_checked_at timestamptz;

comment on column public.venues.image_source is
  'Provenance of image_url: ''venue_site'' (og:image off the venue''s own site, '
  'written by Workflow 6), ''user'' (a submitter''s photo of the place), '
  '''review'' (chosen in the review console), ''seed'' (the original import). '
  'NULL alongside a NULL image_url means no artwork has been found yet.';

comment on column public.venues.image_source_url is
  'The page image_url was taken from, kept so a wrong or stale picture can be '
  'traced back to what published it.';

comment on column public.venues.image_checked_at is
  'When artwork was last *attempted* -- not when it was last found. This is the '
  'queue cursor: bumping it on a failed attempt too is what stops a venue whose '
  'site publishes no usable image being refetched every single night.';

-- Dropped and re-added rather than guarded on existence, so that widening the
-- allowed set later is a re-run of this file rather than a hand-written alter.
alter table public.venues drop constraint if exists venues_image_source_check;
alter table public.venues
  add constraint venues_image_source_check
  check (image_source is null
         or image_source in ('venue_site', 'user', 'review', 'seed'));

-- Partial: the queue only ever reads rows with no artwork, so the index only
-- needs to cover those. Today that is 15 rows out of 364.
create index if not exists venues_image_backlog_idx
  on public.venues (image_checked_at nulls first) where image_url is null;

-- ── 2. The queue ────────────────────────────────────────────────────────────
-- Same shape as hh_deals_needing_verification: stalest first, nulls first so a
-- never-attempted venue goes to the front, and no cursor table -- the cursor is
-- image_checked_at, which hh_record_venue_image bumps on every attempt.
create or replace function public.hh_venues_needing_image(p_limit int default 20)
returns table (venue_id uuid, name text, website text, neighborhood text)
language sql stable security invoker set search_path = '' as $$
  select v.id, v.name, v.website, v.neighborhood
    from public.venues v
    left join public.metros m on m.id = v.metro_id
   where v.image_url is null
     and v.website is not null
     and v.permanently_closed = false
     and coalesce(m.active, true)
     and (v.image_checked_at is null
          or v.image_checked_at < now() - interval '30 days')
   order by v.image_checked_at asc nulls first, v.created_at asc
   limit greatest(p_limit, 1);
$$;

comment on function public.hh_venues_needing_image(int) is
  'Venues with no artwork and a website to look for some on, stalest attempt '
  'first. Read by Workflow 6. An inactive metro costs nothing, and a venue '
  'retried within 30 days is not returned again.';

revoke all on function public.hh_venues_needing_image(int)
  from public, anon, authenticated;

-- ── 3. The pipeline's writer ────────────────────────────────────────────────
-- Called by Workflow 6 with the service_role key. SECURITY INVOKER so it
-- inherits the caller's rights rather than granting anon a way to write venues.
create or replace function public.hh_record_venue_image(
  p_venue_id   uuid,
  p_image_url  text default null,
  p_source_url text default null,
  p_outcome    text default 'found'
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_venue   public.venues%rowtype;
  v_image   text := nullif(btrim(coalesce(p_image_url, '')), '');
  v_changes jsonb;
begin
  select * into v_venue from public.venues where id = p_venue_id;
  if not found then
    raise exception 'hh_record_venue_image: venue % not found', p_venue_id
      using errcode = '22023';
  end if;

  if v_image is not null and v_image !~* '^https?://[^[:space:]]+$' then
    raise exception 'hh_record_venue_image: image % must be an http(s) URL', quote_literal(v_image)
      using errcode = '22023';
  end if;

  -- The attempt is recorded whatever came of it. A venue whose homepage has no
  -- og:image is not a failure to retry tomorrow, it is an answer for 30 days.
  if v_image is null or v_venue.image_url is not null then
    update public.venues set image_checked_at = now() where id = p_venue_id;

    return jsonb_build_object(
      'venue_id', p_venue_id, 'name', v_venue.name, 'written', false,
      'reason', case when v_image is null then coalesce(nullif(p_outcome, ''), 'no_candidate')
                     else 'has_image' end);
  end if;

  -- Backfill, never overwrite -- the same rail hh_intake_deal keeps on
  -- website/phone/image_url. Curated artwork outranks anything found by robot.
  update public.venues
     set image_url        = v_image,
         image_source     = 'venue_site',
         image_source_url = nullif(btrim(coalesce(p_source_url, '')), ''),
         image_checked_at = now()
   where id = p_venue_id;

  v_changes := jsonb_build_object('image_url',
                 jsonb_build_object('from', null, 'to', v_image));

  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, reason)
  values ('venue', p_venue_id, 'update', v_changes, 'venue_artwork',
          format('artwork from %s', coalesce(p_source_url, 'the venue site')));

  return jsonb_build_object(
    'venue_id', p_venue_id, 'name', v_venue.name, 'written', true,
    'image_url', v_image);
end $$;

comment on function public.hh_record_venue_image(uuid, text, text, text) is
  'Record one Workflow 6 artwork attempt. Writes image_url only when the venue '
  'has none, and always bumps image_checked_at so the row leaves the queue '
  'whether or not a picture was found.';

revoke all on function public.hh_record_venue_image(uuid, text, text, text)
  from public, anon, authenticated;

-- ── 4. The submitter's own photo of the place ───────────────────────────────
-- `venues` has an INSERT policy and no UPDATE policy, so a submitter adding a
-- deal to a venue the app already knows cannot give that venue a picture -- the
-- exact hole types.ts documents on SubmitDealData.venueId ("cleared the moment
-- the user edits the venue name ... because venues has no UPDATE policy"). With
-- venue autocomplete that is now the *common* path, not an edge case.
--
-- SECURITY DEFINER for the same reason hh_claim_photo_scan is: this is the one
-- function here an end user calls directly. It is narrow on purpose -- one
-- column, only when empty, and only with an object the caller demonstrably
-- uploaded themselves.
create or replace function public.hh_attach_venue_image(
  p_venue_id  uuid,
  p_image_url text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id  uuid := auth.uid();
  v_per_hour constant int := 10;
  v_venue    public.venues%rowtype;
  v_image    text := nullif(btrim(coalesce(p_image_url, '')), '');
  v_used     int;
begin
  if v_user_id is null then
    raise exception 'hh_attach_venue_image: authentication required'
      using errcode = '28000';
  end if;

  -- The URL must be an object in this project's venue-images bucket, under the
  -- caller's OWN uid prefix. The bucket's INSERT policy already restricts that
  -- prefix to its owner, so this is what makes "a photo they uploaded" checkable
  -- here rather than merely hoped for. image_url is world-readable; an unchecked
  -- text write would let any signed-in user point every client at any URL.
  if v_image is null or v_image !~ (
       '^https://[A-Za-z0-9-]+\.supabase\.co/storage/v1/object/public/venue-images/'
       || v_user_id::text || '/[^[:space:]/]+$') then
    raise exception 'hh_attach_venue_image: image must be an uploaded venue-images object owned by the caller'
      using errcode = '22023';
  end if;

  select count(*) into v_used
    from public.content_audit_log
   where source = 'venue_photo_attach'
     and field_changes ->> 'attached_by' = v_user_id::text
     and created_at > now() - interval '1 hour';

  if v_used >= v_per_hour then
    return jsonb_build_object('attached', false, 'reason', 'rate_limited',
                              'used_hour', v_used);
  end if;

  select * into v_venue from public.venues where id = p_venue_id;
  if not found then
    raise exception 'hh_attach_venue_image: venue % not found', p_venue_id
      using errcode = '22023';
  end if;

  -- Already has artwork: a return value, not an error. The submission that
  -- carried this photo is still perfectly good, and the caller is best-effort.
  if v_venue.image_url is not null then
    return jsonb_build_object('attached', false, 'reason', 'has_image',
                              'venue_id', p_venue_id, 'name', v_venue.name);
  end if;

  update public.venues
     set image_url        = v_image,
         image_source     = 'user',
         image_source_url = null,
         image_checked_at = now()
   where id = p_venue_id;

  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, reason)
  values ('venue', p_venue_id, 'update',
          jsonb_build_object(
            'image_url', jsonb_build_object('from', null, 'to', v_image),
            'attached_by', v_user_id),
          'venue_photo_attach', 'submitter attached a photo of the venue');

  return jsonb_build_object('attached', true, 'venue_id', p_venue_id,
                            'name', v_venue.name, 'image_url', v_image);
end $function$;

comment on function public.hh_attach_venue_image(uuid, text) is
  'Attach a submitter''s photo to a venue that has no artwork. Accepts only a '
  'venue-images object under the caller''s own uid prefix, writes only when '
  'image_url is empty, and is capped at 10 an hour per user. Returns '
  '{attached:false, reason} rather than raising when there is already a picture.';

revoke all on function public.hh_attach_venue_image(uuid, text) from public, anon;
grant execute on function public.hh_attach_venue_image(uuid, text) to authenticated;

-- ── 5. Let the review console fix bad artwork ───────────────────────────────
-- hh_update_venue_fields handles every other venue field a reviewer might need
-- to correct. Artwork was the one thing it could not touch, which made a wrong
-- picture the only venue defect with no route to a fix short of hand-written
-- SQL. Unchanged except for image_url.
create or replace function public.hh_update_venue_fields(
  p_venue_id uuid,
  p_edits    jsonb default '{}'::jsonb,
  p_note     text  default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_venue   public.venues%rowtype;
  v_edits   jsonb := coalesce(p_edits, '{}'::jsonb);
  v_changes jsonb := '{}'::jsonb;
  v_site    text;
  v_addr    text;
  v_hood    text;
  v_phone   text;
  v_image   text;
  v_closed  boolean;
begin
  select * into v_venue from public.venues where id = p_venue_id;
  if not found then
    raise exception 'hh_update_venue_fields: venue % not found', p_venue_id using errcode = '22023';
  end if;

  v_site  := coalesce(public.hh_edit_text(v_edits, 'website'), v_venue.website);
  v_addr  := coalesce(public.hh_edit_text(v_edits, 'address'), v_venue.address);
  v_hood  := coalesce(public.hh_edit_text(v_edits, 'neighborhood'), v_venue.neighborhood);
  v_phone := coalesce(public.hh_edit_text(v_edits, 'phone'), v_venue.phone);
  v_image := coalesce(public.hh_edit_text(v_edits, 'image_url'), v_venue.image_url);

  -- A URL the app would render as a dead link is worse than no URL: the venue
  -- website is the one thing a user taps to check the hours themselves.
  if v_site is distinct from v_venue.website
     and v_site !~* '^https?://[^[:space:]]+$' then
    raise exception 'hh_update_venue_fields: website % must be an http(s) URL', coalesce(quote_literal(v_site), '(empty)')
      using errcode = '22023';
  end if;

  -- Same rule for artwork, and for the same reason: a broken image URL renders
  -- as a broken card rather than as the fallback the app has for having none.
  if v_image is distinct from v_venue.image_url
     and v_image !~* '^https?://[^[:space:]]+$' then
    raise exception 'hh_update_venue_fields: image_url % must be an http(s) URL', coalesce(quote_literal(v_image), '(empty)')
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_edits -> 'permanently_closed') = 'boolean' then
    v_closed := (v_edits ->> 'permanently_closed')::boolean;
  else
    v_closed := v_venue.permanently_closed;
  end if;

  if v_site   is distinct from v_venue.website then
    v_changes := v_changes || jsonb_build_object('website',
                   jsonb_build_object('from', v_venue.website, 'to', v_site)); end if;
  if v_addr   is distinct from v_venue.address then
    v_changes := v_changes || jsonb_build_object('address',
                   jsonb_build_object('from', v_venue.address, 'to', v_addr)); end if;
  if v_hood   is distinct from v_venue.neighborhood then
    v_changes := v_changes || jsonb_build_object('neighborhood',
                   jsonb_build_object('from', v_venue.neighborhood, 'to', v_hood)); end if;
  if v_phone  is distinct from v_venue.phone then
    v_changes := v_changes || jsonb_build_object('phone',
                   jsonb_build_object('from', v_venue.phone, 'to', v_phone)); end if;
  if v_image  is distinct from v_venue.image_url then
    v_changes := v_changes || jsonb_build_object('image_url',
                   jsonb_build_object('from', v_venue.image_url, 'to', v_image)); end if;
  if v_closed is distinct from v_venue.permanently_closed then
    v_changes := v_changes || jsonb_build_object('permanently_closed',
                   jsonb_build_object('from', v_venue.permanently_closed, 'to', v_closed)); end if;

  if v_changes = '{}'::jsonb then
    return jsonb_build_object('venue_id', p_venue_id, 'name', v_venue.name,
                              'changed', false, 'changes', v_changes);
  end if;

  update public.venues
     set website            = v_site,
         address            = v_addr,
         neighborhood       = v_hood,
         phone              = v_phone,
         image_url          = v_image,
         -- A reviewer's choice is curation, and curation outranks the robot:
         -- recording it as such is what stops Workflow 6 ever treating the row
         -- as unattended. 'review' rather than 'user' because a reviewer and a
         -- submitter are not the same person and the column should not say so.
         image_source       = case when v_image is distinct from v_venue.image_url
                                   then 'review' else image_source end,
         image_source_url   = case when v_image is distinct from v_venue.image_url
                                   then null else image_source_url end,
         permanently_closed = v_closed
   where id = p_venue_id;

  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, reason)
  values ('venue', p_venue_id, 'update', v_changes, 'human_review',
          coalesce(p_note, 'edited in the review console'));

  return jsonb_build_object('venue_id', p_venue_id, 'name', v_venue.name,
                            'changed', true, 'changes', v_changes);
end $$;

comment on function public.hh_update_venue_fields(uuid, jsonb, text) is
  'Edit a venue''s website, address, neighborhood, phone, image_url or permanently_closed flag from the review console, with an audit entry. Blank means "leave alone"; website and image_url must be http(s) URLs.';

revoke all on function public.hh_update_venue_fields(uuid, jsonb, text)
  from public, anon, authenticated;

-- ── 6. Surface the backlog in the Monday digest ─────────────────────────────
-- Unchanged from migration_metros.sql except for the missing_image row. The
-- view already reports a venue with no phone and no website; artwork is the
-- same kind of gap and, unlike those two, it is one the reader of the digest
-- can now do something about from the console.
create or replace view public.hh_data_quality_issues as
  select 'deal'::text as entity_type, d.id as entity_id, v.name as label,
         issue.code as issue, issue.detail as detail
    from public.deals d
    join public.venues v on v.id = d.venue_id
   cross join lateral (values
       ('unparseable_time_window', d.time_window,
        not public.hh_is_valid_time_window(d.time_window)),
       ('missing_description', null::text,
        d.description is null or btrim(d.description) = ''),
       ('no_days_active', null::text,
        d.days_active is null or array_length(d.days_active, 1) is null),
       ('never_verified', null::text, d.last_verified_at is null),
       ('stale_over_90d', d.last_verified_at::text,
        d.last_verified_at is not null and d.last_verified_at < now() - interval '90 days')
   ) as issue(code, detail, matched)
   where issue.matched and d.status in ('active','pending')
  union all
  select 'venue', v.id, v.name, issue.code, issue.detail
    from public.venues v
    left join public.metros m on m.id = v.metro_id
   cross join lateral (values
       ('venue_missing_metro', null::text, v.metro_id is null),
       ('coords_outside_metro',
        case when m.id is null then null
             else round(public.hh_distance_km(v.latitude, v.longitude, m.center_lat, m.center_lng)::numeric, 1)
                  || ' km from ' || m.name
        end,
        m.id is not null
          and public.hh_distance_km(v.latitude, v.longitude, m.center_lat, m.center_lng) > m.radius_km),
       ('missing_phone', null::text, v.phone is null),
       ('missing_website', null::text, v.website is null),
       ('missing_image', null::text, v.image_url is null)
   ) as issue(code, detail, matched)
   where issue.matched and v.permanently_closed = false;

comment on view public.hh_data_quality_issues is
  'One row per structural defect in the live corpus. Read by the weekly digest workflow.';

alter view public.hh_data_quality_issues set (security_invoker = on);

-- ── 7. Retire the stock photos already in the table ─────────────────────────
-- Seven rows hold https://picsum.photos/seed/<x>/600/400. They are not pictures
-- of anything; keeping them would only hide those venues from the queue that
-- exists to fix them. Nulling them is what puts them in it.
update public.venues
   set image_url        = null,
       image_source     = null,
       image_source_url = null,
       image_checked_at = null
 where image_url like 'https://picsum.photos/%';

-- Label what is already there, so image_source means something for every row
-- with a picture rather than only for rows written from here on. Order matters:
-- an uploaded object is a submitter's, everything left is from the import.
update public.venues
   set image_source = 'user'
 where image_source is null
   and image_url like '%/storage/v1/object/public/venue-images/%';

update public.venues
   set image_source = 'seed'
 where image_source is null
   and image_url is not null;
