-- ─────────────────────────────────────────────────────────────────────────────
-- A review surface that shows the evidence, can be edited, and remembers.
--
-- The whole moderation surface for this app is one Monday email (WF4, n8n
-- example-workflow-id). Three things were wrong with it, and none of them was a
-- rendering problem -- the data the reviewer needs was simply never queried.
--
-- 1. NO EVIDENCE. WF4's pending-deal fetch selected `venues(name,neighborhood)`
--    and printed `source_url` when present. Every pending deal in the corpus has
--    source_url = NULL, so that link never rendered even once. Meanwhile the
--    reason the deal is pending was sitting in content_audit_log the whole time:
--
--      "auto re-validation of O'Malley's Happy Hour (3 page(s) read,
--       happy-hour page reached, no reading matched this deal,
--       3 deals at this venue)"
--
--    That sentence is the review. So is venues.website, so is deals.image_url
--    (the photo a deal was read FROM), so is verification_status = 'gone'.
--    hh_pending_proposals already joined all of this for Tier 4 proposals;
--    pending deals had no equivalent view. hh_pending_deals is that view.
--
-- 2. NO EDITING. Every path was approve/reject on a (uuid, text) RPC. A deal
--    needing a one-word fix had to be rejected and repaired by hand in SQL --
--    e.g. a O'Malley's row carrying days_active {1,2,3} whose own description only
--    ever supported Tuesday. The _v2 functions here take a whitelisted jsonb of
--    edits and apply them before the decision.
--
-- 3. NO MEMORY. hh_review_deal() has NO already-reviewed short circuit (unlike
--    hh_review_proposal, which returns already_reviewed and stops). A second
--    click on a REJECTED deal therefore walked straight into its approve branch
--    and published it. That is a live bug, and hh_review_deal_v2 fixes it.
--    hh_review_decisions is what lets the reviewer see what they have already
--    decided instead of re-reading a static email.
--
-- WRAP, DO NOT FORK. The two rails that matter already live inside
-- hh_review_deal / hh_review_proposal: the parseable-window gate
-- (hh_is_valid_time_window) and the sibling-collision gate
-- (hh_windows_collide). Every function below applies its edits and then
-- DELEGATES the decision to the existing RPC, so those rails stay in exactly
-- one place and cannot drift. The originals keep their signatures, because
-- WF5's Burst Area Scan emails reuse the same /hh-review endpoint and the
-- approve links already sitting in an inbox must keep working.
--
-- Depends on: migration_n8n_content_pipeline.sql (deals/venues columns,
--             content_audit_log, hh_review_deal, hh_is_valid_time_window),
--             migration_hh_deep_probe_proposals.sql (hh_deal_proposals),
--             migration_multi_deal_venues.sql (hh_sort_days, hh_days_from_jsonb,
--             hh_review_proposal, proposed_kind),
--             migration_multi_deal_venues_fix_collision.sql (hh_windows_collide),
--             migration_hh_days_active_writeback.sql (hh_valid_days_active),
--             migration_metros.sql (hh_data_quality_issues).
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. What the reviewer sees
-- ─────────────────────────────────────────────────────────────────────────────

-- The counterpart to hh_pending_proposals, shaped the same way: one row per
-- item in the queue carrying enough to decide without a second query. Dropped
-- rather than replaced so column order can be chosen freely on a re-run.
drop view if exists public.hh_pending_deals;
create view public.hh_pending_deals as
select
  d.id                  as deal_id,
  d.title,
  d.description,
  d.time_window,
  public.hh_sort_days(d.days_active) as days_active,
  d.tags,
  d.price_level,
  d.type,
  d.confidence,
  d.source,
  d.source_url,
  d.image_url,
  d.verification_status,
  d.created_at,
  d.last_verified_at,
  d.submitted_by,
  -- Approve is refused in SQL for a window the app cannot render. Surfacing it
  -- here lets the console grey the button out and say why, instead of the
  -- reviewer finding out from an error page after the click.
  public.hh_is_valid_time_window(d.time_window) as window_ok,
  v.id                  as venue_id,
  v.name                as venue_name,
  v.neighborhood        as venue_neighborhood,
  v.address             as venue_address,
  v.website             as venue_website,
  v.phone               as venue_phone,
  v.google_place_id     as venue_google_place_id,
  v.permanently_closed  as venue_permanently_closed,
  -- The venue's whole live group. A venue with three happy hours cannot be
  -- judged one window at a time -- "no reading matched this deal" only means
  -- something next to the windows that DID match.
  (select jsonb_agg(jsonb_build_object(
            'deal_id', s.id, 'title', s.title, 'time_window', s.time_window,
            'days_active', to_jsonb(public.hh_sort_days(s.days_active)),
            'status', s.status::text)
          order by s.created_at)
     from public.deals s
    where s.venue_id = d.venue_id
      and s.status in ('active', 'pending')) as venue_deals,
  -- THE EVIDENCE. Why this row is in the queue, in the pipeline's own words.
  (select jsonb_agg(jsonb_build_object(
            'action', a.action, 'source', a.source, 'reason', a.reason,
            'field_changes', a.field_changes, 'confidence', a.confidence,
            'created_at', a.created_at)
          order by a.created_at desc)
     from (select * from public.content_audit_log al
            where al.entity_type = 'deal' and al.entity_id = d.id
            order by al.created_at desc
            limit 5) a) as review_notes,
  (select jsonb_agg(jsonb_build_object('issue', q.issue, 'detail', q.detail))
     from public.hh_data_quality_issues q
    where q.entity_type = 'deal' and q.entity_id = d.id) as open_issues
from public.deals d
join public.venues v on v.id = d.venue_id
where d.status = 'pending'
order by d.created_at desc;

comment on view public.hh_pending_deals is
  'The review queue with its evidence: every pending deal joined to its venue, the venue''s whole live deal group, the last five audit entries explaining why it is pending, and its open data-quality issues. The counterpart to hh_pending_proposals.';

alter view public.hh_pending_deals set (security_invoker = on);

-- Belt and braces. security_invoker already means anon sees nothing here -- the
-- SELECT policy on deals is `status = 'active'` -- but Supabase grants ALL on a
-- new view in public to anon and authenticated by default, and a review queue
-- should not depend on one RLS predicate for that.
revoke all on public.hh_pending_deals from anon, authenticated;


-- What a human has already decided. Powers the console's running "decided since
-- you opened this page" panel and the Undo button next to each entry.
drop view if exists public.hh_review_decisions;
create view public.hh_review_decisions as
select
  a.id           as audit_id,
  a.created_at   as decided_at,
  a.entity_type,
  a.entity_id,
  a.action,
  a.field_changes,
  a.reason,
  coalesce(d.title, v.name)   as title,
  coalesce(dv.name, v.name)   as venue_name,
  dv.neighborhood             as venue_neighborhood,
  d.status::text              as deal_status,
  -- Only a deal that has left the queue can be put back into it.
  (d.id is not null and d.status <> 'pending') as reopenable
from public.content_audit_log a
left join public.deals  d  on a.entity_type = 'deal'  and d.id = a.entity_id
left join public.venues dv on dv.id = d.venue_id
left join public.venues v  on a.entity_type = 'venue' and v.id = a.entity_id
where a.source = 'human_review'
order by a.created_at desc;

comment on view public.hh_review_decisions is
  'Every human review decision, newest first, joined to the deal or venue it touched. Read with a created_at filter to get "what I have decided in this sitting".';

alter view public.hh_review_decisions set (security_invoker = on);
revoke all on public.hh_review_decisions from anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Reading an edit payload
-- ─────────────────────────────────────────────────────────────────────────────

-- A blank field means "leave this alone", never "set it to empty". The review
-- form posts every input on every submit, so a reviewer who clears a box by
-- accident -- or a browser that autofills one empty -- must not be able to wipe
-- a column on a deal that is about to be published.
create or replace function public.hh_edit_text(p_edits jsonb, p_key text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select nullif(btrim(coalesce(p_edits, '{}'::jsonb) ->> p_key), '');
$$;

comment on function public.hh_edit_text(jsonb, text) is
  'One text field out of an edit payload, trimmed, with blank read as absent.';

-- Tags arrive as a jsonb array from the console and as a comma-separated string
-- from anything hand-driven. Both are accepted; neither is guessed at.
create or replace function public.hh_edit_tags(p_edits jsonb)
returns text[] language sql immutable parallel safe set search_path = '' as $$
  select case
    when p_edits -> 'tags' is null then null
    when jsonb_typeof(p_edits -> 'tags') = 'array' then (
      select array_agg(t order by t)
        from (select distinct nullif(btrim(e #>> '{}'), '') as t
                from jsonb_array_elements(p_edits -> 'tags') e) s
       where t is not null)
    when jsonb_typeof(p_edits -> 'tags') = 'string' then (
      select array_agg(t order by t)
        from (select distinct nullif(btrim(x), '') as t
                from unnest(string_to_array(p_edits ->> 'tags', ',')) x) s
       where t is not null)
    else null
  end;
$$;

comment on function public.hh_edit_tags(jsonb) is
  'The tags field of an edit payload as a sorted distinct text[], from either a jsonb array or a comma-separated string. NULL when absent or unusable, meaning "leave the stored tags alone".';

revoke all on function public.hh_edit_text(jsonb, text) from public, anon, authenticated;
revoke all on function public.hh_edit_tags(jsonb) from public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Approve, reject, or just fix -- with edits
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_review_deal_v2(
  p_deal_id uuid,
  p_action  text  default 'approve',
  p_edits   jsonb default '{}'::jsonb,
  p_note    text  default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_deal    public.deals%rowtype;
  v_edits   jsonb   := coalesce(p_edits, '{}'::jsonb);
  v_changes jsonb   := '{}'::jsonb;
  v_window  text;
  v_days    int[];
  v_old_days int[];
  v_desc    text;
  v_title   text;
  v_srcurl  text;
  v_type    text;
  v_tags    text[];
  v_price   int;
  v_conf    numeric;
  v_result  jsonb;
begin
  if p_action not in ('approve', 'reject', 'save') then
    raise exception 'hh_review_deal_v2: unknown action %', p_action using errcode = '22023';
  end if;

  select * into v_deal from public.deals where id = p_deal_id;
  if not found then
    raise exception 'hh_review_deal_v2: deal % not found', p_deal_id using errcode = '22023';
  end if;

  -- The guard hh_review_deal() never had. Without it a second confirm on a
  -- REJECTED deal falls through to the approve branch and publishes it -- and a
  -- double click and a mail scanner's prefetch look identical, so nothing would
  -- have looked wrong. Editing a deal that has left the queue is refused too:
  -- reopen it first, so the unpublish is a decision someone took on purpose.
  if v_deal.status <> 'pending' then
    return jsonb_build_object(
      'deal_id', p_deal_id, 'action', p_action, 'already_reviewed', true,
      'status', v_deal.status::text, 'title', v_deal.title,
      'changes', '{}'::jsonb);
  end if;

  -- ── Edits. Whitelisted: a key that is not one of these is ignored rather
  -- than rejected, so the form gaining a field cannot fail a decision.
  v_old_days := public.hh_sort_days(v_deal.days_active);

  v_title  := coalesce(public.hh_edit_text(v_edits, 'title'), v_deal.title);
  v_desc   := coalesce(public.hh_edit_text(v_edits, 'description'), v_deal.description);
  v_srcurl := coalesce(public.hh_edit_text(v_edits, 'source_url'), v_deal.source_url);
  v_window := coalesce(public.hh_edit_text(v_edits, 'time_window'), v_deal.time_window);
  v_tags   := coalesce(public.hh_edit_tags(v_edits), v_deal.tags);

  -- Malformed days are refused, not silently ignored: falling back to the
  -- stored days would report success for an edit that did not happen, and the
  -- reviewer would publish the row believing they had fixed it.
  if v_edits ? 'days_active' and jsonb_typeof(v_edits -> 'days_active') <> 'null' then
    v_days := public.hh_days_from_jsonb(v_edits -> 'days_active');
    if v_days is null then
      raise exception 'hh_review_deal_v2: days_active must be 1-7 distinct integers in 0..6, got %',
        v_edits -> 'days_active' using errcode = '22023';
    end if;
  else
    v_days := v_old_days;
  end if;

  if public.hh_edit_text(v_edits, 'price_level') is not null then
    v_price := (public.hh_edit_text(v_edits, 'price_level'))::int;
    if v_price not between 1 and 4 then
      raise exception 'hh_review_deal_v2: price_level must be 1..4, got %', v_price
        using errcode = '22023';
    end if;
  else
    v_price := v_deal.price_level;
  end if;

  if public.hh_edit_text(v_edits, 'confidence') is not null then
    v_conf := (public.hh_edit_text(v_edits, 'confidence'))::numeric;
    if v_conf < 0 or v_conf > 1 then
      raise exception 'hh_review_deal_v2: confidence must be 0..1, got %', v_conf
        using errcode = '22023';
    end if;
  else
    v_conf := v_deal.confidence;
  end if;

  -- Mirrors DealType in types.ts. A type the app does not know renders as
  -- nothing on a card, so it is refused here rather than shipped.
  v_type := coalesce(public.hh_edit_text(v_edits, 'type'), v_deal.type);
  if v_type is not null and v_type not in ('regular', 'trending', 'ends-soon', 'new') then
    raise exception 'hh_review_deal_v2: unknown deal type %', v_type using errcode = '22023';
  end if;

  -- Only checked when the window is actually being changed. A deal already
  -- carrying an unparseable window must still be editable -- refusing here
  -- would make the one thing that unsticks it impossible.
  if v_window is distinct from v_deal.time_window
     and not public.hh_is_valid_time_window(v_window) then
    raise exception 'hh_review_deal_v2: time_window % is not parseable by the app', coalesce(quote_literal(v_window), '(empty)')
      using errcode = '22023';
  end if;

  -- An edit must not be able to create the collision migration_multi_deal_venues
  -- exists to prevent. Scoped to an edited window or days: an already-pending
  -- deal that overlaps a sibling is a pre-existing condition, and refusing it
  -- here would wedge the queue on rows a human is trying to sort out.
  if p_action = 'approve'
     and (v_window is distinct from v_deal.time_window or v_days is distinct from v_old_days)
     and exists (select 1
                   from public.deals s
                  where s.venue_id = v_deal.venue_id
                    and s.id <> v_deal.id
                    and s.status in ('active', 'pending')
                    and public.hh_windows_collide(v_window, v_days, s.time_window, s.days_active))
  then
    raise exception 'hh_review_deal_v2: those hours are already covered at this venue'
      using errcode = '22023';
  end if;

  -- ── What actually changed, for the audit trail.
  if v_title  is distinct from v_deal.title then
    v_changes := v_changes || jsonb_build_object('title',
                   jsonb_build_object('from', v_deal.title, 'to', v_title)); end if;
  if v_desc   is distinct from v_deal.description then
    v_changes := v_changes || jsonb_build_object('description',
                   jsonb_build_object('from', v_deal.description, 'to', v_desc)); end if;
  if v_window is distinct from v_deal.time_window then
    v_changes := v_changes || jsonb_build_object('time_window',
                   jsonb_build_object('from', v_deal.time_window, 'to', v_window)); end if;
  if v_days   is distinct from v_old_days then
    v_changes := v_changes || jsonb_build_object('days_active',
                   jsonb_build_object('from', to_jsonb(v_old_days), 'to', to_jsonb(v_days))); end if;
  if v_srcurl is distinct from v_deal.source_url then
    v_changes := v_changes || jsonb_build_object('source_url',
                   jsonb_build_object('from', v_deal.source_url, 'to', v_srcurl)); end if;
  if v_type   is distinct from v_deal.type then
    v_changes := v_changes || jsonb_build_object('type',
                   jsonb_build_object('from', v_deal.type, 'to', v_type)); end if;
  if v_price  is distinct from v_deal.price_level then
    v_changes := v_changes || jsonb_build_object('price_level',
                   jsonb_build_object('from', v_deal.price_level, 'to', v_price)); end if;
  if v_conf   is distinct from v_deal.confidence then
    v_changes := v_changes || jsonb_build_object('confidence',
                   jsonb_build_object('from', v_deal.confidence, 'to', v_conf)); end if;
  if v_tags   is distinct from v_deal.tags then
    v_changes := v_changes || jsonb_build_object('tags',
                   jsonb_build_object('from', to_jsonb(v_deal.tags), 'to', to_jsonb(v_tags))); end if;

  if v_changes <> '{}'::jsonb then
    update public.deals
       set title       = v_title,
           description = v_desc,
           time_window = v_window,
           days_active = v_days,
           source_url  = v_srcurl,
           type        = v_type,
           price_level = v_price,
           confidence  = v_conf,
           tags        = v_tags
     where id = p_deal_id;

    insert into public.content_audit_log
      (entity_type, entity_id, action, field_changes, source, confidence, reason)
    values ('deal', p_deal_id, 'update', v_changes, 'human_review', v_conf,
            coalesce(p_note, 'edited in the review console'));
  end if;

  -- ── The decision itself, delegated. hh_review_deal() owns the publish gate
  -- and writes its own audit row; it now sees the EDITED window, which is the
  -- whole point of applying the edits first.
  if p_action in ('approve', 'reject') then
    v_result := public.hh_review_deal(p_deal_id, p_action);
  else
    v_result := jsonb_build_object('deal_id', p_deal_id, 'action', 'save',
                                   'status', 'pending', 'title', v_title);
  end if;

  return v_result || jsonb_build_object('changes', v_changes, 'already_reviewed', false);
end $$;

comment on function public.hh_review_deal_v2(uuid, text, jsonb, text) is
  'Approve, reject, or just save edits to a pending deal. Applies a whitelisted jsonb of field edits, then delegates the decision to hh_review_deal so the publish gate stays in one place. Unlike hh_review_deal it short-circuits on an already-reviewed deal instead of re-deciding it.';

revoke all on function public.hh_review_deal_v2(uuid, text, jsonb, text)
  from public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The same, for a Tier 4 proposal
-- ─────────────────────────────────────────────────────────────────────────────

-- A proposal that is nearly right used to have to be rejected and the deal
-- repaired by hand. Now the proposed values are editable before they are
-- accepted. `kind` is deliberately NOT editable: it decides whether approving
-- updates the deal in place or inserts a second window at the venue, and that is
-- not a typo-level change.
create or replace function public.hh_review_proposal_v2(
  p_proposal_id uuid,
  p_action      text  default 'approve',
  p_edits       jsonb default '{}'::jsonb,
  p_note        text  default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_p       public.hh_deal_proposals%rowtype;
  v_edits   jsonb := coalesce(p_edits, '{}'::jsonb);
  v_prop    jsonb;
  v_new     jsonb;
  v_window  text;
  v_old_win text;
  v_days    int[];
  v_conf    numeric;
  v_title   text;
  v_result  jsonb;
begin
  if p_action not in ('approve', 'reject', 'save') then
    raise exception 'hh_review_proposal_v2: unknown action %', p_action using errcode = '22023';
  end if;

  select * into v_p from public.hh_deal_proposals where id = p_proposal_id;
  if not found then
    raise exception 'hh_review_proposal_v2: proposal % not found', p_proposal_id
      using errcode = '22023';
  end if;

  if v_p.status <> 'pending' then
    select title into v_title from public.deals where id = v_p.deal_id;
    return jsonb_build_object(
      'proposal_id', p_proposal_id, 'deal_id', v_p.deal_id,
      'action', v_p.review_action, 'already_reviewed', true,
      'status', v_p.status, 'title', v_title, 'changes', '{}'::jsonb);
  end if;

  v_prop    := coalesce(v_p.proposed, '{}'::jsonb);
  v_new     := v_prop;
  v_old_win := nullif(v_prop ->> 'time_window', '');

  if public.hh_edit_text(v_edits, 'time_window') is not null then
    v_new := v_new || jsonb_build_object('time_window', public.hh_edit_text(v_edits, 'time_window'));
  end if;
  if public.hh_edit_text(v_edits, 'title') is not null then
    v_new := v_new || jsonb_build_object('title', public.hh_edit_text(v_edits, 'title'));
  end if;
  if public.hh_edit_text(v_edits, 'description') is not null then
    v_new := v_new || jsonb_build_object('description', public.hh_edit_text(v_edits, 'description'));
  end if;

  if public.hh_edit_text(v_edits, 'confidence') is not null then
    v_conf := (public.hh_edit_text(v_edits, 'confidence'))::numeric;
    if v_conf < 0 or v_conf > 1 then
      raise exception 'hh_review_proposal_v2: confidence must be 0..1, got %', v_conf
        using errcode = '22023';
    end if;
    v_new := v_new || jsonb_build_object('confidence', v_conf);
  end if;

  if v_edits ? 'days_active' and jsonb_typeof(v_edits -> 'days_active') <> 'null' then
    v_days := public.hh_days_from_jsonb(v_edits -> 'days_active');
    if v_days is null then
      raise exception 'hh_review_proposal_v2: days_active must be 1-7 distinct integers in 0..6, got %',
        v_edits -> 'days_active' using errcode = '22023';
    end if;
    v_new := v_new || jsonb_build_object('days_active', to_jsonb(v_days));
  end if;

  v_window := nullif(v_new ->> 'time_window', '');

  -- Refused on a `save` too, not only on the way to a live deal: a stored
  -- proposal carrying a window the app cannot render is a trap for whoever
  -- clicks Approve on it next week.
  if v_window is distinct from v_old_win
     and not public.hh_is_valid_time_window(v_window) then
    raise exception 'hh_review_proposal_v2: time_window % is not parseable by the app', coalesce(quote_literal(v_window), '(empty)')
      using errcode = '22023';
  end if;

  if v_new <> v_prop then
    update public.hh_deal_proposals set proposed = v_new where id = p_proposal_id;

    insert into public.content_audit_log
      (entity_type, entity_id, action, field_changes, source, reason)
    values ('deal', v_p.deal_id, 'update',
            jsonb_build_object('proposed', jsonb_build_object('from', v_prop, 'to', v_new)),
            'human_review',
            coalesce(p_note, 'proposal edited in the review console'));
  end if;

  -- hh_review_proposal owns the rest: it re-validates the window, re-checks the
  -- sibling collision for a new_sibling at approval time, leaves `status` alone
  -- on a correction, and writes the decision's audit row.
  if p_action in ('approve', 'reject') then
    v_result := public.hh_review_proposal(p_proposal_id, p_action);
  else
    select title into v_title from public.deals where id = v_p.deal_id;
    v_result := jsonb_build_object(
      'proposal_id', p_proposal_id, 'deal_id', v_p.deal_id, 'action', 'save',
      'status', 'pending', 'title', v_title, 'kind', v_p.proposed_kind);
  end if;

  return v_result || jsonb_build_object(
    'edited', v_new <> v_prop, 'proposed', v_new, 'already_reviewed', false);
end $$;

comment on function public.hh_review_proposal_v2(uuid, text, jsonb, text) is
  'Approve, reject, or just save edits to a pending Tier 4 proposal. Merges whitelisted edits into `proposed` (never `kind`), then delegates to hh_review_proposal so the window and collision rails stay in one place.';

revoke all on function public.hh_review_proposal_v2(uuid, text, jsonb, text)
  from public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Venue fields, fixed where they are noticed
-- ─────────────────────────────────────────────────────────────────────────────

-- Plenty of items sit in the queue because of venue data, not deal data: a
-- missing website is why the crawler could not verify the deal in the first
-- place, and `missing_website` / `missing_phone` are two of the standing
-- hh_data_quality_issues codes. Fixing that from the same card that shows the
-- problem is the difference between an issue being closed and being counted.
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

  -- A URL the app would render as a dead link is worse than no URL: the venue
  -- website is the one thing a user taps to check the hours themselves.
  if v_site is distinct from v_venue.website
     and v_site !~* '^https?://[^[:space:]]+$' then
    raise exception 'hh_update_venue_fields: website % must be an http(s) URL', coalesce(quote_literal(v_site), '(empty)')
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
  'Edit a venue''s website, address, neighborhood, phone or permanently_closed flag from the review console, with an audit entry. Blank means "leave alone"; a website must be an http(s) URL.';

revoke all on function public.hh_update_venue_fields(uuid, jsonb, text)
  from public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Undo
-- ─────────────────────────────────────────────────────────────────────────────

-- content_audit_log's action CHECK has always allowed 'reopen'. Nothing wrote
-- one until now.
--
-- Reopening a REJECTED deal is free. Reopening an ACTIVE one UNPUBLISHES it --
-- `pending` is not visible in the app -- so the console labels that button
-- differently. Deliberately does not touch verification_status: that column
-- carries what the pipeline last observed, and a human changing their mind about
-- publishing does not change what the crawler read.
create or replace function public.hh_reopen_decision(
  p_deal_id uuid,
  p_note    text default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
begin
  select * into v_deal from public.deals where id = p_deal_id;
  if not found then
    raise exception 'hh_reopen_decision: deal % not found', p_deal_id using errcode = '22023';
  end if;

  if v_deal.status = 'pending' then
    return jsonb_build_object('deal_id', p_deal_id, 'title', v_deal.title,
                              'status', 'pending', 'reopened', false);
  end if;

  update public.deals set status = 'pending' where id = p_deal_id;

  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, reason)
  values ('deal', p_deal_id, 'reopen',
          jsonb_build_object('status',
            jsonb_build_object('from', v_deal.status::text, 'to', 'pending')),
          'human_review',
          coalesce(p_note, 'reopened from the review console'));

  return jsonb_build_object('deal_id', p_deal_id, 'title', v_deal.title,
                            'status', 'pending', 'reopened', true,
                            'was', v_deal.status::text);
end $$;

comment on function public.hh_reopen_decision(uuid, text) is
  'Put a decided deal back into the review queue. Reopening an active deal unpublishes it. Writes the reopen audit row content_audit_log always had room for.';

revoke all on function public.hh_reopen_decision(uuid, text) from public, anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Deciding a whole venue group at once
-- ─────────────────────────────────────────────────────────────────────────────

-- A venue with three happy hours is one judgement, not three, and three round
-- trips through an email is how a queue stops getting cleared.
--
-- Each item runs in its own subtransaction. One failure -- a collision on the
-- third window, a deal someone already approved in another tab -- must not
-- discard the first two: the reviewer would have no way to tell which of their
-- decisions survived. The failures come back in the result instead, and the
-- console reports them next to the ones that worked.
create or replace function public.hh_review_batch(
  p_items  jsonb,
  p_action text default 'approve',
  p_note   text default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_item    jsonb;
  v_results jsonb := '[]'::jsonb;
  v_one     jsonb;
  v_id      text;
  v_ok      int := 0;
  v_failed  int := 0;
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'hh_review_batch: unknown action %', p_action using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'hh_review_batch: p_items must be a jsonb array of {deal_id} or {proposal_id}'
      using errcode = '22023';
  end if;

  for v_item in select e from jsonb_array_elements(p_items) e loop
    v_id := coalesce(v_item ->> 'proposal_id', v_item ->> 'deal_id');
    begin
      if v_item ->> 'proposal_id' is not null then
        v_one := public.hh_review_proposal_v2((v_item ->> 'proposal_id')::uuid,
                                              p_action, '{}'::jsonb, p_note);
      elsif v_item ->> 'deal_id' is not null then
        v_one := public.hh_review_deal_v2((v_item ->> 'deal_id')::uuid,
                                          p_action, '{}'::jsonb, p_note);
      else
        raise exception 'item has neither deal_id nor proposal_id' using errcode = '22023';
      end if;
      v_ok := v_ok + 1;
      v_results := v_results || jsonb_build_array(v_one || jsonb_build_object('id', v_id, 'ok', true));
    exception when others then
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(
        jsonb_build_object('id', v_id, 'ok', false, 'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object('action', p_action, 'applied', v_ok,
                            'failed', v_failed, 'results', v_results);
end $$;

comment on function public.hh_review_batch(jsonb, text, text) is
  'Approve or reject many queue items in one call, in the order given. Each item is applied in its own subtransaction so one failure never discards the rest; per-item outcomes come back in `results`.';

revoke all on function public.hh_review_batch(jsonb, text, text) from public, anon, authenticated;
