-- ─────────────────────────────────────────────────────────────────────────────
-- One venue, several happy hours
--
-- The app and this pipeline disagreed about what a venue's happy hour is.
--
-- The APP models day-varying hours as a GROUP OF SIBLING ROWS. SubmitDealData
-- carries a Schedule[], submitUserDeal() inserts one deal per schedule joined by
-- a self-referencing parent_deal_id, and the browse queries filter on
-- `days_active @> [today]` with no parent filter -- so only the sibling running
-- today surfaces, and the detail screen lists the whole group.
--
-- The PIPELINE assumed exactly one deal per venue: one time_window, one flat
-- days_active, and a dedupe key of (venue_id, normalized title). Measured
-- against the live corpus when this was written:
--
--     38 venues carry more than one deal            -- 79 rows
--     29 of those have BOTH distinct windows and distinct day sets
--     79 of 79 share a normalized title with a sibling   (100%)
--
-- So the dedupe key collided for every day-varying deal in the table, and the
-- 38 "duplicate groups" the weekly digest reported as defects were in fact
-- legitimate schedules -- Cantina Verde - West Town runs 5:00pm-6:00pm Mon-Thu and
-- 3:00pm-6:00pm Fri; Amaru runs 4:00pm-5:00pm Sun and 5:00pm-6:00pm Mon-Fri.
--
-- Three concrete faults this migration closes:
--
--   1. hh_intake_deal() matched with `limit 1` and NO `order by`, so a
--      re-scrape rewrote an ARBITRARY sibling -- and its update branch never
--      wrote days_active, so that row ended up with new hours on the old days.
--      It also never set parent_deal_id, so a discovered sibling floated free
--      of the group, and it dropped deal.image_url on the floor even though
--      Workflow 1 goes to some trouble to attach the photo as review evidence.
--
--   2. hh_record_verification() applies a `changed` verdict to whichever row
--      the sweep happened to be checking. The re-validation model is handed one
--      stored deal at a time and is never told its days, so at a multi-deal
--      venue it reads the most prominent window off the shared page and the
--      OTHER siblings get rewritten into copies of it. 43 rows were eligible
--      for exactly this on the next sweep. Workflow 2 being inactive and
--      unpublished is the only reason it has not happened.
--
--   3. hh_duplicate_deals reported legitimate day-variants for manual merge.
--
-- The fix is to make the DEAL GROUP the unit rather than the deal row. Every
-- safety rail from migration_n8n_content_pipeline.sql carries over untouched:
-- confidence gating, "a parseable window is never surrendered to an unparseable
-- one", "nothing is ever hard-deleted", and one content_audit_log row per
-- automated change.
--
-- Depends on: migration_n8n_content_pipeline.sql, migration_metros.sql,
--             migration_hh_deep_verification.sql,
--             migration_hh_days_active_writeback.sql (hh_valid_days_active),
--             migration_hh_deep_probe_proposals.sql,
--             migration_open_ended_time_windows.sql (hh_is_valid_time_window).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Day-set helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- Stored day arrays are not sorted -- Americano's is {2,3,4,6,0} -- and Postgres
-- array equality is order sensitive, so every comparison goes through this.
create or replace function public.hh_sort_days(p_days int[])
returns int[] language sql immutable parallel safe set search_path = '' as $$
  select case
           when p_days is null then null
           else (select array_agg(distinct x order by x) from unnest(p_days) x)
         end;
$$;

comment on function public.hh_sort_days(int[]) is
  'Day array normalised to sorted distinct values, so two day sets can be compared for equality.';

-- Reads a days_active payload only when it is well formed, so a malformed array
-- is never mistaken for "no days" or for a day set that happens to overlap.
create or replace function public.hh_days_from_jsonb(p_days jsonb)
returns int[] language sql immutable parallel safe set search_path = '' as $$
  select case
           when public.hh_valid_days_active(p_days)
           then (select array_agg(distinct (e #>> '{}')::int order by (e #>> '{}')::int)
                   from jsonb_array_elements(p_days) e)
           else null
         end;
$$;

comment on function public.hh_days_from_jsonb(jsonb) is
  'A jsonb days_active payload as int[], or NULL when it is not 1-7 distinct integers in 0..6.';

-- True when any two of the supplied day sets share a day. A NULL or malformed
-- set counts as overlapping: unknown days cannot be shown to be disjoint, and
-- the callers here all treat "cannot tell" as the unsafe answer.
create or replace function public.hh_day_sets_overlap(p_sets jsonb)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select coalesce((
    select bool_or(
             a.s is null or b.s is null
             or jsonb_typeof(a.s) <> 'array' or jsonb_typeof(b.s) <> 'array'
             or exists (select 1
                          from jsonb_array_elements_text(a.s) x
                          join jsonb_array_elements_text(b.s) y on x.value = y.value))
      from jsonb_array_elements(p_sets) with ordinality a(s, i)
      join jsonb_array_elements(p_sets) with ordinality b(s, j) on a.i < b.j
  ), false);
$$;

comment on function public.hh_day_sets_overlap(jsonb) is
  'True when any two day sets in the array share a day. NULL or malformed sets count as overlapping.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Comparing two time windows by meaning
--
-- The SQL twin of windowKey() in Workflow 2's Decide Verdict node: both sides
-- reduce to minutes past midnight, so "4:00pm - 7:00pm" and "4:00 PM - 7:00 PM"
-- compare equal. Deliberately NOT hh_is_valid_time_window() (a gate, not a
-- comparison) and deliberately NOT canonicalTimeWindow() (which produces the
-- storage format and keeps ":00" as written).
--
-- It exists here because the sibling guard below has to answer "is the window
-- the model just read actually a DIFFERENT sibling's window?", and that
-- question has to be settled in SQL where no workflow can skip it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_time_to_minutes(p_side text)
returns int language plpgsql immutable parallel safe set search_path = '' as $$
declare
  m    text[];
  h    int;
  mins int;
begin
  if p_side is null then return null; end if;

  m := regexp_match(btrim(p_side), '^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$', 'i');
  if m is not null then
    h := m[1]::int;
    mins := coalesce(m[2]::int, 0);
    if h < 1 or h > 12 or mins > 59 then return null; end if;
    if h = 12 then h := 0; end if;
    return (h + case when lower(m[3]) = 'p' then 12 else 0 end) * 60 + mins;
  end if;

  m := regexp_match(btrim(p_side), '^(\d{1,2}):(\d{2})$');
  if m is not null then
    h := m[1]::int;
    mins := m[2]::int;
    if h > 23 or mins > 59 then return null; end if;
    return h * 60 + mins;
  end if;

  return null;
end $$;

create or replace function public.hh_window_key(p_input text)
returns text language plpgsql immutable parallel safe set search_path = '' as $$
declare
  s     text;
  parts text[];
  a     int;
  b     int;
begin
  if p_input is null then return null; end if;

  -- Google and copy-pasted menus use en/em dashes and a minus sign.
  s := regexp_replace(p_input, '[‐‑‒–—―−]', '-', 'g');
  s := regexp_replace(s, '\yto\y', '-', 'gi');
  s := btrim(regexp_replace(s, '\s+', ' ', 'g'));

  parts := array(select btrim(x) from unnest(string_to_array(s, '-')) x where btrim(x) <> '');
  if coalesce(array_length(parts, 1), 0) <> 2 then return null; end if;

  a := public.hh_time_to_minutes(parts[1]);
  b := public.hh_time_to_minutes(parts[2]);
  -- Two windows this function cannot read are not evidence of agreement, so a
  -- NULL key never equals anything -- including another NULL key.
  if a is null or b is null then return null; end if;

  return a::text || '-' || b::text;
end $$;

comment on function public.hh_window_key(text) is
  'A time window reduced to "startMinutes-endMinutes" for comparison, or NULL when unreadable. Mirrors windowKey() in Workflow 2.';

-- Two rows at one venue are only in conflict when they could be RUNNING at the
-- same time. Sharing a day is not enough: Bocaditos serves 4-6 PM and again
-- 8:30-9:30 PM, Sunday through Thursday, and those are two offers rather than
-- one deal recorded twice. The day-only test this replaces called that a
-- duplicate, and -- worse -- would have refused to publish the pair from
-- discovery. Every sibling test below goes through this function.

create or replace function public.hh_windows_collide(
  p_win_a text, p_days_a int[],
  p_win_b text, p_days_b int[]
)
returns boolean language plpgsql immutable parallel safe set search_path = '' as $$
declare
  ka text; kb text;
  a1 int; a2 int; b1 int; b2 int;
  da int; db int;
  sa int; ea int; sb int; eb int;
begin
  -- Unknown days cannot be shown to be safe.
  if p_days_a is null or p_days_b is null then return true; end if;

  ka := public.hh_window_key(p_win_a);
  kb := public.hh_window_key(p_win_b);
  -- With hours we cannot read, the strongest thing still true of these two rows
  -- is whether they are ever on screen on the same day. That is exactly the old
  -- day-only test, which is the right fallback and no weaker than before.
  if ka is null or kb is null then return p_days_a && p_days_b; end if;

  a1 := split_part(ka, '-', 1)::int; a2 := split_part(ka, '-', 2)::int;
  b1 := split_part(kb, '-', 1)::int; b2 := split_part(kb, '-', 2)::int;

  -- An end at or before the start is an overnight window -- "9 PM - 2 AM" runs
  -- past midnight into the next day. Carrying the end past 1440 keeps the
  -- interval contiguous, and keeps the spill visible to the day comparison
  -- below: Monday 9 PM - 2 AM really does occupy part of Tuesday.
  if a2 <= a1 then a2 := a2 + 1440; end if;
  if b2 <= b1 then b2 := b2 + 1440; end if;

  -- Lay both windows out on one 10080-minute week and compare every pair of
  -- days they run on. Day-set intersection is not a shortcut here: an overnight
  -- window collides with a row on the FOLLOWING day, which a day test can never
  -- see. Half-open intervals, so touching endpoints do not collide -- 4-6 PM and
  -- 6-8 PM are adjacent, not overlapping.
  foreach da in array p_days_a loop
    foreach db in array p_days_b loop
      sa := da * 1440 + a1; ea := da * 1440 + a2;
      sb := db * 1440 + b1; eb := db * 1440 + b2;
      -- The week is a circle, so the two shifted tests let a Saturday-night
      -- window meet a Sunday-morning one.
      if (sa < eb and sb < ea)
         or (sb + 10080 < ea)
         or (sa + 10080 < eb) then
        return true;
      end if;
    end loop;
  end loop;

  return false;
end $$;

comment on function public.hh_windows_collide(text, int[], text, int[]) is
  'True when two deals could both be running at once: laid out on one week, their hours overlap. Adjacent windows do not collide, and an overnight window is compared against the day it runs into. With hours that cannot be read this falls back to asking whether the two share a day; with unknown days it collides, because it cannot be shown not to.';

revoke all on function public.hh_sort_days(int[]) from public, anon, authenticated;
revoke all on function public.hh_days_from_jsonb(jsonb) from public, anon, authenticated;
revoke all on function public.hh_day_sets_overlap(jsonb) from public, anon, authenticated;
revoke all on function public.hh_time_to_minutes(text) from public, anon, authenticated;
revoke all on function public.hh_window_key(text) from public, anon, authenticated;
revoke all on function public.hh_windows_collide(text, int[], text, int[])
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Matching an incoming deal to a row in the venue's group
--
-- Replaces the `limit 1` with no `order by` that hh_intake_deal() used. With
-- every multi-deal row in the corpus sharing a title with a sibling, that
-- clause picked whichever row the planner happened to return first.
--
-- Three tiers, most specific first:
--   1. same normalized title AND the same day set  -- this is the row
--   2. same normalized title, greatest day overlap -- absorbs legitimate drift
--      such as Mon-Thu becoming Mon-Fri
--   3. no usable days supplied                     -- fall back to the group's
--      oldest row, deterministically
--
-- No overlap at all and no exact match means this is a NEW sibling, not a
-- correction to an existing one, and the caller inserts.
-- ─────────────────────────────────────────────────────────────────────────────

-- The signature gained p_exclude, so the old one is dropped rather than
-- replaced -- `create or replace` would leave both as an overload.
drop function if exists public.hh_match_deal_in_group(uuid, text, int[]);

create or replace function public.hh_match_deal_in_group(
  p_venue_id uuid,
  p_title    text,
  p_days     int[],
  -- Rows an earlier deal in the same payload already claimed. Without this, two
  -- incoming windows can both match the same stored row and the second silently
  -- overwrites the first.
  p_exclude  uuid[] default '{}'::uuid[]
)
returns uuid language sql stable security invoker set search_path = '' as $$
  with candidates as (
    select d.id, d.days_active, d.last_verified_at, d.created_at
      from public.deals d
     where d.venue_id = p_venue_id
       and d.status in ('active', 'pending')
       and public.hh_norm_text(d.title) = public.hh_norm_text(p_title)
       and not (d.id = any(coalesce(p_exclude, '{}'::uuid[])))
  ),
  ranked as (
    select id, 0 as tier, 0 as overlap, last_verified_at, created_at
      from candidates
     where p_days is not null
       and public.hh_sort_days(days_active) is not distinct from public.hh_sort_days(p_days)

    union all

    select id, 1,
           (select count(*)::int from unnest(days_active) x where x = any(p_days)),
           last_verified_at, created_at
      from candidates
     where p_days is not null
       and days_active && p_days

    union all

    select id, 2, 0, last_verified_at, created_at
      from candidates
     where p_days is null
  )
  select id
    from ranked
   order by tier asc, overlap desc, last_verified_at desc nulls last, created_at asc
   limit 1;
$$;

comment on function public.hh_match_deal_in_group(uuid, text, int[], uuid[]) is
  'The row in a venue''s deal group an incoming extraction corresponds to, or NULL when it is a new sibling. Deterministic: exact day set, then greatest overlap, then oldest.';

revoke all on function public.hh_match_deal_in_group(uuid, text, int[], uuid[])
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Group intake -- the venue and ALL of its deals in one call
--
-- Accepts `deals: [...]` and, for every caller that predates this migration,
-- a singular `deal: {...}`. hh_intake_deal() below is now a wrapper, so the
-- Google Sheet, any external poster and the current Workflow 1 contract keep
-- working byte for byte.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_intake_venue_deals(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_venue_id     uuid;
  v_venue_action text := 'matched';
  v_lat          double precision := (p_payload -> 'venue' ->> 'latitude')::double precision;
  v_lng          double precision := (p_payload -> 'venue' ->> 'longitude')::double precision;
  v_name         text := p_payload -> 'venue' ->> 'name';
  v_place_id     text := nullif(p_payload -> 'venue' ->> 'google_place_id', '');
  v_source       text := coalesce(p_payload ->> 'source', 'unknown');
  v_source_url   text := nullif(p_payload ->> 'source_url', '');
  v_deals        jsonb;
  v_deal         jsonb;
  v_missing      text[];
  v_bad          text[];
  v_overlap      boolean;
  v_root_id      uuid;
  v_results      jsonb := '[]'::jsonb;
  v_seen         uuid[] := '{}';
  v_unseen       uuid[];
  -- per deal
  v_title        text;
  v_window       text;
  v_window_ok    boolean;
  v_conf         numeric;
  v_days         int[];
  v_status       public.deal_status;
  v_deal_id      uuid;
  v_deal_action  text;
  v_existing     public.deals%rowtype;
  v_changes      jsonb;
  v_idx          int := 0;
begin
  -- ── Normalise the deal list ──────────────────────────────────────────────
  v_deals := case
    when jsonb_typeof(p_payload -> 'deals') = 'array'  then p_payload -> 'deals'
    when jsonb_typeof(p_payload -> 'deal')  = 'object' then jsonb_build_array(p_payload -> 'deal')
    else '[]'::jsonb
  end;

  -- ── Required fields, named rather than left to a NOT NULL constraint ─────
  v_missing := array_remove(array[
    case when v_name is null                                  then 'venue.name' end,
    case when p_payload -> 'venue' ->> 'address' is null      then 'venue.address' end,
    case when p_payload -> 'venue' ->> 'neighborhood' is null then 'venue.neighborhood' end,
    case when v_lat is null                                   then 'venue.latitude' end,
    case when v_lng is null                                   then 'venue.longitude' end,
    case when jsonb_array_length(v_deals) = 0                 then 'deals[]' end
  ], null);

  if array_length(v_missing, 1) > 0 then
    raise exception 'hh_intake_venue_deals: missing required field(s): %', array_to_string(v_missing, ', ')
      using errcode = '22023';
  end if;

  select array_remove(array_agg(
           case
             when e.value ->> 'title' is null       then format('deals[%s].title', e.ordinality - 1)
             when e.value ->> 'time_window' is null then format('deals[%s].time_window', e.ordinality - 1)
           end), null)
    into v_bad
    from jsonb_array_elements(v_deals) with ordinality e(value, ordinality);

  if array_length(v_bad, 1) > 0 then
    raise exception 'hh_intake_venue_deals: missing required field(s): %', array_to_string(v_bad, ', ')
      using errcode = '22023';
  end if;

  -- Two windows that could BOTH be shown at once is a model error, not a
  -- schedule: the whole set lands in review rather than half of it going live,
  -- because picking which half to believe is the judgement a human is here to
  -- make. This used to test days alone, which refused a venue running an early
  -- and a late happy hour on the same days -- Bocaditos does exactly that, and
  -- it is two offers, not a contradiction.
  select exists (
    select 1
      from jsonb_array_elements(v_deals) with ordinality a(d, i)
      join jsonb_array_elements(v_deals) with ordinality b(d, j) on a.i < b.j
     where public.hh_windows_collide(
             a.d ->> 'time_window', public.hh_days_from_jsonb(a.d -> 'days_active'),
             b.d ->> 'time_window', public.hh_days_from_jsonb(b.d -> 'days_active'))
  ) into v_overlap;

  -- ── Resolve the venue ────────────────────────────────────────────────────
  -- Unchanged from hh_intake_deal(): Google Place ID, else normalized name
  -- within ~300m, else insert.
  if v_place_id is not null then
    select id into v_venue_id from public.venues where google_place_id = v_place_id limit 1;
  end if;

  if v_venue_id is null then
    select id into v_venue_id
      from public.venues
     where public.hh_norm_text(name) = public.hh_norm_text(v_name)
       and abs(latitude - v_lat) < 0.003
       and abs(longitude - v_lng) < 0.004
     limit 1;
  end if;

  if v_venue_id is null then
    insert into public.venues (
      name, address, neighborhood, latitude, longitude,
      website, phone, image_url, google_place_id, source, source_url, last_verified_at
    )
    values (
      v_name,
      p_payload -> 'venue' ->> 'address',
      p_payload -> 'venue' ->> 'neighborhood',
      v_lat, v_lng,
      nullif(p_payload -> 'venue' ->> 'website', ''),
      nullif(p_payload -> 'venue' ->> 'phone', ''),
      nullif(p_payload -> 'venue' ->> 'image_url', ''),
      v_place_id, v_source, v_source_url, now()
    )
    returning id into v_venue_id;

    v_venue_action := 'inserted';

    insert into public.content_audit_log (entity_type, entity_id, action, field_changes, source, reason)
    values ('venue', v_venue_id, 'insert', to_jsonb(p_payload -> 'venue'), v_source, 'new venue from intake');
  else
    update public.venues
       set website          = coalesce(website, nullif(p_payload -> 'venue' ->> 'website', '')),
           phone            = coalesce(phone, nullif(p_payload -> 'venue' ->> 'phone', '')),
           image_url        = coalesce(image_url, nullif(p_payload -> 'venue' ->> 'image_url', '')),
           google_place_id  = coalesce(google_place_id, v_place_id),
           last_verified_at = now()
     where id = v_venue_id;
  end if;

  -- The group root every new sibling hangs off. NULL means this venue has no
  -- deals yet, so the first row inserted below becomes the root itself.
  select id into v_root_id
    from public.deals
   where venue_id = v_venue_id and parent_deal_id is null
   order by created_at asc
   limit 1;

  -- ── Reconcile each incoming deal against the group ───────────────────────
  for v_deal in select value from jsonb_array_elements(v_deals) loop
    v_idx       := v_idx + 1;
    v_changes   := '{}'::jsonb;
    v_title     := v_deal ->> 'title';
    v_window    := v_deal ->> 'time_window';
    v_window_ok := public.hh_is_valid_time_window(v_window);
    v_conf      := nullif(v_deal ->> 'confidence', '')::numeric;
    v_days      := public.hh_days_from_jsonb(v_deal -> 'days_active');

    -- Same gate as always, with one addition: a set the extractor contradicted
    -- itself on never auto-publishes.
    if coalesce(v_conf, 0) >= 0.80 and v_window_ok and not v_overlap then
      v_status := 'active';
    else
      v_status := 'pending';
    end if;

    if v_days is null and jsonb_array_length(v_deals) > 1 then
      -- One window out of several that does not say when it runs cannot be
      -- matched to a sibling at all: siblings are told apart BY their days.
      -- Matching it would overwrite whichever sibling happened to sort first.
      -- It becomes its own unpublished row for a human to place.
      v_deal_id := null;
    else
      v_deal_id := public.hh_match_deal_in_group(v_venue_id, v_title, v_days, v_seen);
    end if;

    if v_deal_id is null then
      insert into public.deals (
        venue_id, title, description, time_window, days_active, tags,
        price_level, type, status, source, source_url, confidence,
        image_url, parent_deal_id, last_verified_at, verification_status
      )
      values (
        v_venue_id,
        v_title,
        nullif(v_deal ->> 'description', ''),
        v_window,
        -- An unstated day set is only "every day" when this is the venue's one
        -- and only deal. One window out of several saying nothing about days is
        -- not a claim that it runs all week, so it is left for a human.
        coalesce(v_days, case when jsonb_array_length(v_deals) = 1 and v_root_id is null
                              then '{0,1,2,3,4,5,6}'::int[] end),
        coalesce((select array_agg(value) from jsonb_array_elements_text(v_deal -> 'tags')), '{}'::text[]),
        coalesce(nullif(v_deal ->> 'price_level', '')::int, 1),
        coalesce(nullif(v_deal ->> 'type', ''), 'regular'),
        -- A row with no days cannot be published: the app filters on
        -- days_active @> [today], so it would be invisible while claiming active.
        case when v_days is null and not (jsonb_array_length(v_deals) = 1 and v_root_id is null)
             then 'pending'::public.deal_status else v_status end,
        v_source,
        v_source_url,
        v_conf,
        -- The photo a deal was read off, kept as review evidence. The old
        -- intake accepted this field from Workflow 1 and then never stored it.
        nullif(v_deal ->> 'image_url', ''),
        v_root_id,
        now(),
        case when v_status = 'active' then 'verified' else 'unverified' end
      )
      returning id into v_deal_id;

      -- First row at a venue that had none becomes the group root, so the rest
      -- of this payload hangs off it.
      if v_root_id is null then v_root_id := v_deal_id; end if;

      v_deal_action := 'inserted';

      insert into public.content_audit_log
        (entity_type, entity_id, action, field_changes, source, confidence, reason)
      values ('deal', v_deal_id, 'insert', v_deal, v_source, v_conf,
              format('new deal, published as %s', v_status));
    else
      select * into v_existing from public.deals where id = v_deal_id;

      if coalesce(v_conf, 0) >= coalesce(v_existing.confidence, 0) then
        if not v_window_ok then
          v_changes := v_changes || jsonb_build_object('rejected_time_window',
                         jsonb_build_object('kept', v_existing.time_window, 'proposed', v_window));
        elsif v_existing.time_window is distinct from v_window then
          v_changes := v_changes || jsonb_build_object('time_window',
                         jsonb_build_object('from', v_existing.time_window, 'to', v_window));
        end if;

        -- Days on the update path, which hh_intake_deal() never wrote. Gated
        -- exactly like the window and like hh_record_verification() does it, so
        -- a deal can no longer have its hours corrected and keep running on
        -- days it does not.
        if v_days is not null and coalesce(v_conf, 0) >= 0.80
           and public.hh_sort_days(v_existing.days_active) is distinct from v_days then
          v_changes := v_changes || jsonb_build_object('days_active',
                         jsonb_build_object('from', to_jsonb(v_existing.days_active),
                                            'to',   to_jsonb(v_days)));
        end if;

        update public.deals
           set time_window      = case when v_window_ok then v_window else time_window end,
               days_active      = case when v_days is not null and coalesce(v_conf, 0) >= 0.80
                                       then v_days else days_active end,
               description      = coalesce(nullif(v_deal ->> 'description', ''), description),
               confidence       = v_conf,
               source_url       = coalesce(v_source_url, source_url),
               image_url        = coalesce(nullif(v_deal ->> 'image_url', ''), image_url),
               last_verified_at = now(),
               verification_status = case
                 when v_status <> 'active'    then 'conflict'
                 when v_changes = '{}'::jsonb then 'verified'
                 else 'changed'
               end
         where id = v_deal_id;

        v_deal_action := case when v_changes = '{}'::jsonb then 'refreshed' else 'updated' end;

        insert into public.content_audit_log
          (entity_type, entity_id, action, field_changes, source, confidence, reason)
        values ('deal', v_deal_id, 'update', v_changes, v_source, v_conf,
                'intake matched existing deal in group');
      else
        v_deal_action := 'skipped_lower_confidence';

        insert into public.content_audit_log
          (entity_type, entity_id, action, field_changes, source, confidence, reason)
        values ('deal', v_deal_id, 'skip_duplicate', '{}'::jsonb, v_source, v_conf,
                'incoming confidence below stored value');
      end if;
    end if;

    v_seen := v_seen || v_deal_id;
    v_results := v_results || jsonb_build_object(
      'deal_id', v_deal_id, 'deal_action', v_deal_action, 'status', v_status,
      'title', v_title, 'days_active', to_jsonb(v_days));
  end loop;

  -- ── Rows this scan did not see ───────────────────────────────────────────
  -- Never retired. The strongest automated action in this pipeline is still
  -- moving a deal to `pending`, and a scan that missed a window is far more
  -- likely than a venue that dropped one. Recorded so the digest can show it.
  select array_agg(id) into v_unseen
    from public.deals
   where venue_id = v_venue_id
     and status in ('active', 'pending')
     and not (id = any(v_seen));

  if v_unseen is not null then
    insert into public.content_audit_log
      (entity_type, entity_id, action, field_changes, source, reason)
    select 'deal', u, 'flag',
           jsonb_build_object('unseen_in_scan', jsonb_build_object('scanned', jsonb_array_length(v_deals))),
           v_source, 'venue rescanned; this sibling was not among the deals read'
      from unnest(v_unseen) u;
  end if;

  return jsonb_build_object(
    'venue_id', v_venue_id,
    'venue_action', v_venue_action,
    'deals', v_results,
    'overlapping_day_sets', v_overlap,
    'unseen_deal_ids', to_jsonb(coalesce(v_unseen, '{}'::uuid[])));
end $$;

comment on function public.hh_intake_venue_deals(jsonb) is
  'Atomic upsert of a venue and its whole deal group, with deterministic per-sibling dedupe, confidence gating and audit logging. Called by the n8n intake workflow using the service_role key.';

revoke all on function public.hh_intake_venue_deals(jsonb) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The single-deal contract, unchanged for its callers
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_intake_deal(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
  v_first  jsonb;
begin
  v_result := public.hh_intake_venue_deals(p_payload);
  v_first  := v_result -> 'deals' -> 0;

  -- The flat shape Workflow 1's Respond 200 and the Area Scan Engine's
  -- `body.result.status` read. Callers that send one deal see no difference.
  return jsonb_build_object(
    'venue_id',     v_result -> 'venue_id',
    'venue_action', v_result -> 'venue_action',
    'deal_id',      v_first  -> 'deal_id',
    'deal_action',  v_first  -> 'deal_action',
    'status',       v_first  -> 'status');
end $$;

comment on function public.hh_intake_deal(jsonb) is
  'Single-deal intake, kept for callers that predate group intake. Delegates to hh_intake_venue_deals() and flattens the reply.';

revoke all on function public.hh_intake_deal(jsonb) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Re-validation, with the sibling guard
--
-- Workflow 2 hands the model ONE stored deal and the venue's whole website. At
-- a single-deal venue "the window I read differs from the one stored" means the
-- deal drifted, and correcting it is the entire point of the sweep -- Taco Bar
-- is the worked example in that workflow's own comments.
--
-- At a MULTI-deal venue the same reading means something else entirely: the
-- model very likely read a DIFFERENT sibling off the shared page. Applying it
-- rewrites one schedule into a copy of another and the first one vanishes from
-- the app. Cantina Verde - West Town would have lost its Friday 3:00pm-6:00pm the
-- first time the sweep reached that row.
--
-- Two signals say "wrong sibling", and either is enough to write nothing:
--   * the days read have NO overlap with the days stored, or
--   * the window read is, in minutes, another sibling's stored window and not
--     this one's.
-- A third guard covers the `confirmed` case: a reading must not hand this row
-- days that currently belong to a sibling.
--
-- All of it lives here rather than in Decide Verdict so that no workflow, and
-- no hand-run RPC call, can skip it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_record_verification(
  p_deal_id uuid,
  p_verdict text,
  p_extracted jsonb default '{}'::jsonb,
  p_source_url text default null,
  p_notes text default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_existing   public.deals%rowtype;
  v_conf       numeric := nullif(p_extracted ->> 'confidence', '')::numeric;
  v_window     text    := nullif(p_extracted ->> 'time_window', '');
  v_window_ok  boolean;
  v_days       int[];
  v_days_ok    boolean;
  v_changes    jsonb   := '{}'::jsonb;
  v_new_status public.deal_status;
  v_vstatus    text;
  v_action     text := 'update';
  v_siblings   int;
  v_wrong      boolean := false;
  v_new_window text;
  v_new_days   int[];
begin
  select * into v_existing from public.deals where id = p_deal_id;
  if not found then
    raise exception 'hh_record_verification: deal % not found', p_deal_id using errcode = '22023';
  end if;

  if p_verdict not in ('confirmed','changed','gone','unreachable','unclear') then
    raise exception 'hh_record_verification: unknown verdict %', p_verdict using errcode = '22023';
  end if;

  v_window_ok := public.hh_is_valid_time_window(v_window);
  v_days_ok   := coalesce(v_conf, 0) >= 0.80
                 and public.hh_valid_days_active(p_extracted -> 'days_active');
  if v_days_ok then
    v_days := public.hh_days_from_jsonb(p_extracted -> 'days_active');
  end if;
  v_new_status := v_existing.status;

  select count(*) into v_siblings
    from public.deals
   where venue_id = v_existing.venue_id
     and id <> p_deal_id
     and status in ('active', 'pending');

  if p_verdict = 'confirmed' then
    v_vstatus := 'verified';

  elsif p_verdict = 'unreachable' then
    -- last_verified_at is still bumped so the deal rotates out of the queue
    -- instead of being retried every run; verification_status carries the truth
    -- that nothing was actually confirmed.
    v_vstatus := 'unreachable';

  elsif p_verdict = 'unclear' then
    v_vstatus := 'conflict';

  elsif p_verdict = 'gone' then
    -- Only a confident reading may pull a deal out of the app. Anything weaker
    -- is a conflict for a human to judge, never a silent unpublish.
    if coalesce(v_conf, 0) >= 0.80 then
      v_new_status := 'pending';
      v_vstatus    := 'gone';
      v_action     := 'flag';
      v_changes    := jsonb_build_object('status',
                        jsonb_build_object('from', v_existing.status::text, 'to', 'pending'));
    else
      v_vstatus := 'conflict';
    end if;

  else
    -- changed
    if v_siblings > 0 then
      if v_days is not null and not (v_days && v_existing.days_active) then
        v_wrong := true;
      elsif v_window_ok and exists (
              select 1
                from public.deals s
               where s.venue_id = v_existing.venue_id
                 and s.id <> p_deal_id
                 and s.status in ('active', 'pending')
                 and public.hh_window_key(s.time_window) is not null
                 and public.hh_window_key(s.time_window) = public.hh_window_key(v_window))
            and public.hh_window_key(v_window)
                is distinct from public.hh_window_key(v_existing.time_window) then
        v_wrong := true;
      end if;
    end if;

    if v_wrong then
      -- Nothing is written. The reading is kept in the audit trail and the row
      -- is flagged so the digest puts it in front of a human, who can see the
      -- whole group at once and decide.
      v_changes := jsonb_build_object('wrong_sibling',
                     jsonb_build_object('kept', v_existing.time_window,
                                        'read', v_window,
                                        'read_days', to_jsonb(v_days),
                                        'stored_days', to_jsonb(v_existing.days_active),
                                        'siblings', v_siblings));
      v_vstatus := 'conflict';
      v_window  := null;
      v_days_ok := false;

    elsif coalesce(v_conf, 0) >= 0.80 and v_window_ok then
      if v_existing.time_window is distinct from v_window then
        v_changes := jsonb_build_object('time_window',
                       jsonb_build_object('from', v_existing.time_window, 'to', v_window));
      end if;
      v_vstatus := 'changed';

    else
      if v_window is not null and not v_window_ok then
        v_changes := jsonb_build_object('rejected_time_window',
                       jsonb_build_object('kept', v_existing.time_window, 'proposed', v_window));
      end if;
      v_vstatus := 'conflict';
      v_window  := null;
    end if;
  end if;

  -- A write must not move this row onto hours a sibling already covers.
  --
  -- The old test asked only whether a sibling shared a DAY, and excused itself
  -- whenever the two rows already shared one -- which made it inert at exactly
  -- the venues that needed it. Bocaditos runs 4-6 PM and 8:30-9:30 PM, both
  -- Sun-Thu; under the old test it had no protection at all, and a venue
  -- running an early and a late happy hour is not a contradiction anyway.
  --
  -- The question now is whether the WOULD-BE state -- window and days together,
  -- since either half can do it -- creates a collision that does not already
  -- exist. A collision that is already there is left alone: this refuses to
  -- make things worse, it does not tidy up.
  v_new_window := case when v_vstatus = 'changed' and v_window_ok and v_window is not null
                       then v_window else v_existing.time_window end;
  v_new_days   := case when v_vstatus in ('changed','verified') and v_days_ok
                       then v_days else v_existing.days_active end;

  if v_siblings > 0
     and (v_new_window is distinct from v_existing.time_window
          or public.hh_sort_days(v_new_days)
             is distinct from public.hh_sort_days(v_existing.days_active))
     and exists (
       select 1
         from public.deals s
        where s.venue_id = v_existing.venue_id
          and s.id <> p_deal_id
          and s.status in ('active', 'pending')
          and public.hh_windows_collide(v_new_window, v_new_days,
                                        s.time_window, s.days_active)
          and not public.hh_windows_collide(v_existing.time_window, v_existing.days_active,
                                            s.time_window, s.days_active)) then
    -- Nothing is written, and the reading is kept for the digest. Replaces any
    -- change already recorded above: none of it is being applied.
    v_changes := jsonb_build_object('rejected_collision',
                   jsonb_build_object('kept_window', v_existing.time_window,
                                      'kept_days', to_jsonb(v_existing.days_active),
                                      'proposed_window', v_new_window,
                                      'proposed_days', to_jsonb(v_new_days),
                                      'reason', 'would overlap another deal at this venue'));
    v_vstatus := 'conflict';
    v_window  := null;
    v_days_ok := false;
  end if;

  -- The days are independent of the window: a window the model confirms can
  -- still sit on the wrong days, so they are applied on any confident reading
  -- that produced them, not only when the window itself moved.
  if v_days_ok and v_vstatus in ('changed','verified')
     and public.hh_sort_days(v_existing.days_active) is distinct from v_days then
    v_changes := v_changes || jsonb_build_object('days_active',
                   jsonb_build_object('from', to_jsonb(v_existing.days_active),
                                      'to',   to_jsonb(v_days)));
  end if;

  update public.deals
     set status              = v_new_status,
         time_window         = case
           when v_vstatus = 'changed' and v_window_ok and v_window is not null then v_window
           else time_window
         end,
         description         = case
           when v_vstatus = 'changed' then coalesce(nullif(p_extracted ->> 'description', ''), description)
           else description
         end,
         days_active         = case
           when v_vstatus in ('changed','verified') and v_days_ok then v_days
           else days_active
         end,
         confidence          = coalesce(v_conf, confidence),
         source_url          = coalesce(nullif(p_source_url, ''), source_url),
         last_verified_at    = now(),
         verification_status = v_vstatus
   where id = p_deal_id;

  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, confidence, reason)
  values ('deal', p_deal_id, v_action, v_changes, 'validation', v_conf,
          coalesce(p_notes, format('verdict=%s -> %s', p_verdict, v_vstatus)));

  return jsonb_build_object(
    'deal_id', p_deal_id,
    'verdict', p_verdict,
    'verification_status', v_vstatus,
    'status', v_new_status,
    'wrong_sibling', v_wrong,
    'changes', v_changes);
end $$;

comment on function public.hh_record_verification(uuid, text, jsonb, text, text) is
  'Applies the outcome of one re-validation pass to a deal, with confidence gating, a sibling guard for multi-deal venues, and an audit entry.';

revoke all on function public.hh_record_verification(uuid, text, jsonb, text, text)
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. The sweep feed, one row per VENUE
--
-- The old per-deal feed made a multi-deal venue pay a crawl and a model call
-- per sibling, and gave the model no way to know which sibling it was being
-- asked about. One row per venue costs less and can actually be answered:
-- Workflow 2 shows the model the whole group and asks it to place what it reads
-- against each stored deal.
--
-- hh_deals_needing_verification() is left in place for now so the two can be
-- switched over independently.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_venues_needing_verification(p_limit int default 10)
returns table (
  venue_id           uuid,
  venue_name         text,
  venue_address      text,
  venue_neighborhood text,
  website            text,
  source_url         text,
  stalest_at         timestamptz,
  deal_count         int,
  deals              jsonb)
language sql stable security invoker set search_path = '' as $$
  with eligible as (
    select d.id as deal_id, d.venue_id, d.title, d.time_window, d.days_active,
           d.confidence, d.source_url, d.last_verified_at, d.status,
           v.name as venue_name, v.address as venue_address,
           v.neighborhood as venue_neighborhood, v.website
      from public.deals d
      join public.venues v on v.id = d.venue_id
      left join public.metros m on m.id = v.metro_id
     where d.status in ('active', 'pending')
       and v.permanently_closed = false
       and v.website is not null
       and coalesce(m.active, true)
  )
  select e.venue_id,
         min(e.venue_name),
         min(e.venue_address),
         min(e.venue_neighborhood),
         min(e.website),
         -- The page a previous run proved carries this venue's hours, freshest
         -- first. The crawler fetches it before rediscovering anything.
         (array_remove(array_agg(e.source_url order by e.last_verified_at desc nulls last), null))[1],
         min(coalesce(e.last_verified_at, '-infinity'::timestamptz)) as stalest_at,
         count(*)::int,
         jsonb_agg(jsonb_build_object(
           'deal_id',     e.deal_id,
           'title',       e.title,
           'time_window', e.time_window,
           'days_active', to_jsonb(public.hh_sort_days(e.days_active)),
           'confidence',  e.confidence,
           'status',      e.status::text,
           'source_url',  e.source_url)
           order by e.deal_id)
    from eligible e
   group by e.venue_id
  having min(coalesce(e.last_verified_at, '-infinity'::timestamptz)) < now() - interval '30 days'
   order by stalest_at asc
   limit greatest(p_limit, 1);
$$;

comment on function public.hh_venues_needing_verification(int) is
  'Feeds the daily re-validation sweep one VENUE at a time, stalest first, active metros only, with the venue''s whole deal group so the model can say which sibling it read.';

revoke all on function public.hh_venues_needing_verification(int) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Duplicates, now told apart from schedules
--
-- hh_duplicate_deals grouped on (venue, normalized title) and reported every
-- group of more than one. All 79 multi-deal rows in the corpus share a title
-- with a sibling, so all 38 groups were reported -- and 29 of them were
-- Mon-Thu/Fri style schedules that the app renders exactly as intended.
--
-- Two rows are duplicates when they could BOTH be shown on the same day. Two
-- rows with disjoint day sets never can be, so they are a schedule.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.hh_duplicate_deals as
with grp as (
  select d.venue_id,
         v.name as venue_name,
         public.hh_norm_text(d.title) as normalized_title,
         count(*) as copies,
         array_agg(d.id order by d.created_at) as deal_ids,
         array_agg(d.title order by d.created_at) as titles
    from public.deals d
    join public.venues v on v.id = d.venue_id
   where d.status in ('active', 'pending')
   group by d.venue_id, v.name, public.hh_norm_text(d.title)
  having count(*) > 1
)
select g.venue_id, g.venue_name, g.normalized_title, g.copies, g.deal_ids, g.titles
  from grp g
 where exists (
   select 1
     from public.deals a
     join public.deals b
       on b.venue_id = a.venue_id and b.id > a.id
      and b.status in ('active', 'pending')
      and public.hh_norm_text(b.title) = public.hh_norm_text(a.title)
    where a.venue_id = g.venue_id
      and a.status in ('active', 'pending')
      and public.hh_norm_text(a.title) = g.normalized_title
      and public.hh_windows_collide(a.time_window, a.days_active,
                                    b.time_window, b.days_active));

comment on view public.hh_duplicate_deals is
  'Deal rows at one venue that could BOTH be shown at once -- same normalized title, overlapping days and overlapping hours. Surfaced for manual merge. An early and a late-night happy hour on the same days is not this; see hh_day_variant_deals.';

-- The other half of the old view: same title, disjoint days. Not a defect --
-- this is how the app stores a happy hour whose hours change with the day.
-- Reported so the corpus can be understood, not so anyone acts on it.
create or replace view public.hh_day_variant_deals as
with grp as (
  select d.venue_id,
         v.name as venue_name,
         public.hh_norm_text(d.title) as normalized_title,
         count(*) as schedules,
         array_agg(d.id order by d.created_at) as deal_ids,
         array_agg(d.time_window order by d.created_at) as time_windows,
         jsonb_agg(to_jsonb(public.hh_sort_days(d.days_active)) order by d.created_at) as day_sets
    from public.deals d
    join public.venues v on v.id = d.venue_id
   where d.status in ('active', 'pending')
   group by d.venue_id, v.name, public.hh_norm_text(d.title)
  having count(*) > 1
)
select g.venue_id, g.venue_name, g.normalized_title, g.schedules,
       g.deal_ids, g.time_windows, g.day_sets
  from grp g
 where not exists (
   select 1
     from public.deals a
     join public.deals b
       on b.venue_id = a.venue_id and b.id > a.id
      and b.status in ('active', 'pending')
      and public.hh_norm_text(b.title) = public.hh_norm_text(a.title)
    where a.venue_id = g.venue_id
      and a.status in ('active', 'pending')
      and public.hh_norm_text(a.title) = g.normalized_title
      and public.hh_windows_collide(a.time_window, a.days_active,
                                    b.time_window, b.days_active));

comment on view public.hh_day_variant_deals is
  'One happy hour on several schedules -- different days, or the same days at different hours. Informational: these are correct, not duplicates.';

alter view public.hh_duplicate_deals   set (security_invoker = on);
alter view public.hh_day_variant_deals set (security_invoker = on);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Proposals that can add a sibling, not only correct one
--
-- The deep probe and the re-validation sweep both now hit the case "this venue
-- runs a second window nobody has stored". Neither may insert a deal, so it
-- becomes a proposal against the group and waits for a click in the digest,
-- exactly like a correction does.
--
-- The kind rides inside p_proposed rather than as a seventh argument, so the
-- function signature -- and every PostgREST caller of it -- is unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.hh_deal_proposals
  add column if not exists proposed_kind text not null default 'correction';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hh_deal_proposals_kind_check') then
    alter table public.hh_deal_proposals
      add constraint hh_deal_proposals_kind_check
      check (proposed_kind in ('correction', 'new_sibling'));
  end if;
end
$$;

comment on column public.hh_deal_proposals.proposed_kind is
  'correction -- change the deal this row points at. new_sibling -- add a deal to that deal''s venue group.';

-- One open proposal per deal per source PER KIND: a re-probe still supersedes
-- its own last correction, but a "there is also a Friday window" finding no
-- longer wipes out an unrelated correction waiting in the same digest.
drop index if exists public.hh_deal_proposals_one_pending_idx;
create unique index if not exists hh_deal_proposals_one_pending_idx
  on public.hh_deal_proposals (deal_id, source, proposed_kind)
  where status = 'pending';

create or replace function public.hh_propose_deal_change(
  p_deal_id       uuid,
  p_source        text default 'deep_probe',
  p_proposed      jsonb default '{}'::jsonb,
  p_evidence_url  text default null,
  p_evidence_kind text default null,
  p_notes         text default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_deal    public.deals%rowtype;
  v_window  text    := nullif(p_proposed ->> 'time_window', '');
  v_conf    numeric := nullif(p_proposed ->> 'confidence', '')::numeric;
  v_kind    text    := coalesce(nullif(p_proposed ->> 'kind', ''), 'correction');
  v_days_ok boolean;
  v_outcome text;
  v_changes jsonb   := '{}'::jsonb;
  v_id      uuid;
begin
  select * into v_deal from public.deals where id = p_deal_id;
  if not found then
    raise exception 'hh_propose_deal_change: deal % not found', p_deal_id using errcode = '22023';
  end if;

  if v_kind not in ('correction', 'new_sibling') then
    raise exception 'hh_propose_deal_change: unknown kind %', v_kind using errcode = '22023';
  end if;

  v_days_ok := public.hh_valid_days_active(p_proposed -> 'days_active');

  if v_window is null then
    -- The probe ran and came back with nothing usable. Worth recording: it
    -- spent budget, and a venue that fails Tier 4 twice is a candidate for
    -- deletion rather than another probe.
    v_outcome := 'nothing_found';

  elsif not public.hh_is_valid_time_window(v_window) then
    -- Same rail as everywhere else: a window the app cannot render never enters
    -- the system, not even as something approvable.
    v_outcome := 'rejected_unparseable';
    v_changes := jsonb_build_object('rejected_time_window',
                   jsonb_build_object('kept', v_deal.time_window, 'proposed', v_window));

  elsif v_kind = 'new_sibling' and not v_days_ok then
    -- A new row is only worth adding if it says when it runs. The app filters
    -- on days_active, so a sibling without days would be invisible -- and the
    -- one thing a second window is FOR is running on different days.
    v_outcome := 'rejected_no_days';
    v_changes := jsonb_build_object('rejected_new_sibling',
                   jsonb_build_object('proposed', v_window, 'reason', 'no valid days_active'));

  elsif v_kind = 'new_sibling' and exists (
          select 1 from public.deals s
           where s.venue_id = v_deal.venue_id
             and s.status in ('active', 'pending')
             and public.hh_windows_collide(
                   v_window, public.hh_days_from_jsonb(p_proposed -> 'days_active'),
                   s.time_window, s.days_active)) then
    -- Already covered at those HOURS on those days by a row that exists. That
    -- is a correction to that row, if anything, not a new one. Sharing a day is
    -- not enough: a late-night window alongside an early one is a real second
    -- offer, and refusing it was how the day-only test lost them.
    v_outcome := 'rejected_overlaps_existing';
    v_changes := jsonb_build_object('rejected_new_sibling',
                   jsonb_build_object('proposed', v_window,
                                      'proposed_days', p_proposed -> 'days_active',
                                      'reason', 'those days are already covered at this venue'));

  else
    update public.hh_deal_proposals
       set status = 'superseded', reviewed_at = now(), review_action = 'superseded'
     where deal_id = p_deal_id and source = p_source
       and proposed_kind = v_kind and status = 'pending';

    insert into public.hh_deal_proposals
      (deal_id, source, proposed_kind, proposed, evidence_url, evidence_kind, model_notes)
    values
      (p_deal_id, p_source, v_kind,
       jsonb_build_object(
         'kind',        v_kind,
         'title',       nullif(p_proposed ->> 'title', ''),
         'time_window', v_window,
         'days_active', case when v_days_ok then p_proposed -> 'days_active' else null end,
         'description', nullif(p_proposed ->> 'description', ''),
         'confidence',  v_conf),
       nullif(p_evidence_url, ''), nullif(p_evidence_kind, ''), p_notes)
    returning id into v_id;

    v_outcome := case when v_kind = 'new_sibling' then 'proposed_sibling' else 'proposed' end;
    v_changes := jsonb_build_object('proposed_time_window',
                   jsonb_build_object('current', case when v_kind = 'new_sibling' then null
                                                      else v_deal.time_window end,
                                      'proposed', v_window));
  end if;

  -- Always logged: this row is both the audit trail and the probe budget counter.
  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, confidence, reason)
  values ('deal', p_deal_id, 'flag', v_changes, p_source, v_conf,
          coalesce(p_notes, 'deep probe: ' || v_outcome));

  return jsonb_build_object(
    'deal_id', p_deal_id,
    'proposal_id', v_id,
    'kind', v_kind,
    'outcome', v_outcome,
    'title', v_deal.title);
end $$;

comment on function public.hh_propose_deal_change(uuid, text, jsonb, text, text, text) is
  'Files a correction, or a new sibling deal, for human approval. Never modifies a deal. Always writes one content_audit_log row, which doubles as the probe budget counter. The kind travels inside p_proposed so the signature is unchanged.';

revoke all on function public.hh_propose_deal_change(uuid, text, jsonb, text, text, text)
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Reviewing a proposal, including one that adds a sibling
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_review_proposal(p_proposal_id uuid, p_action text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_p       public.hh_deal_proposals%rowtype;
  v_deal    public.deals%rowtype;
  v_window  text;
  v_days    int[];
  v_changes jsonb := '{}'::jsonb;
  v_root_id uuid;
  v_new_id  uuid;
  v_status  public.deal_status;
begin
  select * into v_p from public.hh_deal_proposals where id = p_proposal_id;
  if not found then
    raise exception 'hh_review_proposal: proposal % not found', p_proposal_id using errcode = '22023';
  end if;

  -- A second click on the same link is not an error worth showing an error page
  -- for -- the first click already did the work.
  if v_p.status <> 'pending' then
    select * into v_deal from public.deals where id = v_p.deal_id;
    return jsonb_build_object(
      'proposal_id', p_proposal_id, 'action', v_p.review_action,
      'already_reviewed', true, 'title', v_deal.title, 'status', v_p.status);
  end if;

  if p_action not in ('approve', 'reject') then
    raise exception 'hh_review_proposal: unknown action %', p_action using errcode = '22023';
  end if;

  select * into v_deal from public.deals where id = v_p.deal_id;
  if not found then
    raise exception 'hh_review_proposal: deal % no longer exists', v_p.deal_id using errcode = '22023';
  end if;

  if p_action = 'approve' then
    v_window := nullif(v_p.proposed ->> 'time_window', '');

    -- Belt and braces. hh_propose_deal_change already refuses to file an
    -- unparseable window, but this is the function that writes to a live deal,
    -- so it re-checks rather than trusting its own queue.
    if not public.hh_is_valid_time_window(v_window) then
      raise exception 'hh_review_proposal: proposed window %L is not parseable by the app', v_window
        using errcode = '22023';
    end if;

    v_days := public.hh_days_from_jsonb(v_p.proposed -> 'days_active');

    if v_p.proposed_kind = 'new_sibling' then
      if v_days is null then
        raise exception 'hh_review_proposal: a new sibling needs a valid days_active'
          using errcode = '22023';
      end if;

      -- Re-checked at approval time, not only at filing time: the group can
      -- have gained a row while this proposal sat in the digest, and two
      -- siblings sharing a day is the collision this whole migration exists to
      -- prevent.
      if exists (select 1 from public.deals s
                  where s.venue_id = v_deal.venue_id
                    and s.status in ('active', 'pending')
                    and public.hh_windows_collide(v_window, v_days,
                                                  s.time_window, s.days_active)) then
        raise exception 'hh_review_proposal: those hours are already covered at this venue'
          using errcode = '22023';
      end if;

      select id into v_root_id
        from public.deals
       where venue_id = v_deal.venue_id and parent_deal_id is null
       order by created_at asc
       limit 1;

      -- The sibling joins a group that is already live, a human has just
      -- approved it, and the parseable-window rail held at both filing and
      -- here -- so it goes live with the group rather than queueing for a
      -- second click. A sibling of a pending deal stays pending.
      v_status := case when v_deal.status = 'active' then 'active' else 'pending' end;

      insert into public.deals (
        venue_id, title, description, time_window, days_active, tags,
        price_level, type, status, source, source_url, confidence,
        parent_deal_id, last_verified_at, verification_status
      )
      values (
        v_deal.venue_id,
        coalesce(nullif(v_p.proposed ->> 'title', ''), v_deal.title),
        nullif(v_p.proposed ->> 'description', ''),
        v_window,
        v_days,
        v_deal.tags,
        v_deal.price_level,
        coalesce(v_deal.type, 'regular'),
        v_status,
        v_p.source,
        nullif(v_p.evidence_url, ''),
        nullif(v_p.proposed ->> 'confidence', '')::numeric,
        coalesce(v_root_id, v_deal.id),
        now(),
        'verified'
      )
      returning id into v_new_id;

      v_changes := jsonb_build_object('new_sibling',
                     jsonb_build_object('deal_id', v_new_id,
                                        'time_window', v_window,
                                        'days_active', to_jsonb(v_days),
                                        'status', v_status::text,
                                        'parent_deal_id', coalesce(v_root_id, v_deal.id)));

      insert into public.content_audit_log
        (entity_type, entity_id, action, field_changes, source, reason)
      values ('deal', v_new_id, 'insert', v_changes, 'human_review',
              'second happy hour window added at this venue, approved from digest email');

    else
      if v_deal.time_window is distinct from v_window then
        v_changes := jsonb_build_object('time_window',
                       jsonb_build_object('from', v_deal.time_window, 'to', v_window));
      end if;
      if v_days is not null and public.hh_sort_days(v_deal.days_active) is distinct from v_days then
        v_changes := v_changes || jsonb_build_object('days_active',
                       jsonb_build_object('from', to_jsonb(v_deal.days_active), 'to', to_jsonb(v_days)));
      end if;

      -- `status` is deliberately untouched. Approving a correction to the hours
      -- is not the same decision as publishing the deal: an active deal stays
      -- active, and a pending one still needs its own Approve.
      update public.deals
         set time_window         = v_window,
             days_active         = coalesce(v_days, days_active),
             description         = coalesce(nullif(v_p.proposed ->> 'description', ''), description),
             confidence          = coalesce(nullif(v_p.proposed ->> 'confidence', '')::numeric, confidence),
             source_url          = coalesce(nullif(v_p.evidence_url, ''), source_url),
             verification_status = 'verified',
             last_verified_at    = now()
       where id = v_p.deal_id;
    end if;
  else
    -- Rejected: the deal is untouched, but bump last_verified_at so it rotates
    -- out of the stale queue instead of being re-probed immediately.
    update public.deals set last_verified_at = now() where id = v_p.deal_id;
  end if;

  update public.hh_deal_proposals
     set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
         reviewed_at = now(), review_action = p_action
   where id = p_proposal_id;

  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, reason)
  values ('deal', v_p.deal_id, p_action, v_changes, 'human_review',
          format('%s proposal %sd from digest email', v_p.proposed_kind, p_action));

  return jsonb_build_object(
    'proposal_id', p_proposal_id, 'deal_id', v_p.deal_id, 'action', p_action,
    'kind', v_p.proposed_kind, 'new_deal_id', v_new_id,
    'title', v_deal.title, 'status', v_deal.status::text, 'changes', v_changes);
end $$;

comment on function public.hh_review_proposal(uuid, text) is
  'Approve or reject a proposal from the digest. A correction applies the hours without publishing; a new_sibling inserts a second window into the venue''s deal group.';

revoke all on function public.hh_review_proposal(uuid, text) from public, anon, authenticated;

-- The digest needs to say which of the two a row is, and show the rest of the
-- group -- "add a Friday window" is only reviewable next to the windows the
-- venue already has.
-- Dropped rather than replaced: `create or replace view` cannot insert a column
-- in the middle, and proposed_kind belongs next to the proposal it describes.
drop view if exists public.hh_pending_proposals;
create view public.hh_pending_proposals as
select
  p.id            as proposal_id,
  p.deal_id,
  p.source,
  p.proposed_kind,
  p.proposed,
  p.evidence_url,
  p.evidence_kind,
  p.model_notes,
  p.created_at,
  d.title,
  d.status::text  as deal_status,
  d.time_window   as current_time_window,
  d.days_active   as current_days_active,
  v.name          as venue_name,
  v.neighborhood  as venue_neighborhood,
  v.website       as venue_website,
  (select jsonb_agg(jsonb_build_object(
            'deal_id', s.id, 'title', s.title, 'time_window', s.time_window,
            'days_active', to_jsonb(public.hh_sort_days(s.days_active)))
          order by s.created_at)
     from public.deals s
    where s.venue_id = d.venue_id
      and s.status in ('active', 'pending')) as venue_deals
from public.hh_deal_proposals p
join public.deals  d on d.id = p.deal_id
join public.venues v on v.id = d.venue_id
where p.status = 'pending'
order by p.created_at desc;

comment on view public.hh_pending_proposals is
  'Open proposals joined to the deal they would change and the venue''s whole deal group, for the Monday digest.';

alter view public.hh_pending_proposals set (security_invoker = on);
