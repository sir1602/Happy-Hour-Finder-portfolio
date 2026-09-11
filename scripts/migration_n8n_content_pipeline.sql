-- ============================================================================
-- Content automation pipeline: provenance, verification tracking, and audit.
--
-- Supports the n8n workflows in /n8n-workflows. Everything here is additive
-- and nullable, so the Expo app (which selects `deals.*` + `venues.*`) keeps
-- working unchanged -- the extra columns simply ride along and are ignored by
-- mapSupabaseToDeal().
--
-- Safe to re-run: every statement is guarded.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Helper functions
-- ─────────────────────────────────────────────────────────────────────────────

-- Normalize free text for fuzzy matching: casefold, strip accents/punctuation,
-- drop common venue-name noise words, collapse whitespace.
create or replace function public.hh_norm_text(p_input text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    trim(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(coalesce(p_input, '')), '[^a-z0-9 ]+', ' ', 'g'),
          '\y(the|a|an|and|chicago|restaurant|bar|tavern|lounge|grill|co|inc|llc)\y',
          ' ',
          'g'
        ),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$$;

comment on function public.hh_norm_text(text) is
  'Casefold + strip punctuation/noise words. Used for venue and deal dedupe matching.';

-- The app's parseDealTime() in utils/dealTime.ts only understands
-- "H[:MM] AM/PM - H[:MM] AM/PM". Anything else renders as a raw string and
-- loses live countdown behaviour, so the pipeline gates on this.
create or replace function public.hh_is_valid_time_window(p_input text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(p_input, '') ~*
    '^\s*\d{1,2}(:\d{2})?\s*(AM|PM)\s*-\s*\d{1,2}(:\d{2})?\s*(AM|PM)\s*$';
$$;

comment on function public.hh_is_valid_time_window(text) is
  'True when a time_window parses under utils/dealTime.ts parseDealTime().';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Provenance + verification columns
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.venues
  add column if not exists google_place_id   text,
  add column if not exists source            text,
  add column if not exists source_url        text,
  add column if not exists last_verified_at  timestamptz,
  add column if not exists permanently_closed boolean not null default false,
  add column if not exists updated_at        timestamptz not null default now();

alter table public.deals
  add column if not exists source             text,
  add column if not exists source_url         text,
  add column if not exists confidence         numeric(3,2),
  add column if not exists last_verified_at   timestamptz,
  add column if not exists verification_status text,
  add column if not exists updated_at         timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'deals_confidence_range'
  ) then
    alter table public.deals
      add constraint deals_confidence_range
      check (confidence is null or (confidence >= 0 and confidence <= 1));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'deals_verification_status_valid'
  ) then
    alter table public.deals
      add constraint deals_verification_status_valid
      check (verification_status is null or verification_status in (
        'unverified',  -- never checked against a live source
        'verified',    -- source still advertises this deal as stored
        'changed',     -- source advertises different terms; deal was updated
        'conflict',    -- source disagrees but confidence too low to auto-apply
        'unreachable', -- venue site failed to load on the last N attempts
        'gone'         -- source no longer mentions any happy hour
      ));
  end if;
end
$$;

comment on column public.venues.google_place_id is
  'Google Places ID. Primary dedupe key for discovery-sourced venues.';
comment on column public.venues.permanently_closed is
  'Set by the validation workflow when the source reports the venue as closed.';
comment on column public.deals.confidence is
  '0-1 extraction confidence from the AI extractor. Gates auto-publish.';
comment on column public.deals.verification_status is
  'Outcome of the most recent re-validation pass.';
comment on column public.deals.source is
  'Origin of the record: seed | discovery | sheet | user_submission | manual.';

-- Backfill provenance for the existing seeded corpus so "never verified"
-- reporting is meaningful from day one.
update public.venues
   set source = 'seed'
 where source is null;

update public.deals
   set source = coalesce(source, case when submitted_by is null then 'seed' else 'user_submission' end),
       verification_status = coalesce(verification_status, 'unverified')
 where source is null or verification_status is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- Partial unique: one venue per Google Place, but existing NULLs are unconstrained.
create unique index if not exists venues_google_place_id_key
  on public.venues (google_place_id)
  where google_place_id is not null;

create index if not exists venues_norm_name_idx
  on public.venues (public.hh_norm_text(name));

create index if not exists venues_last_verified_idx
  on public.venues (last_verified_at nulls first);

-- NOTE: deliberately NOT unique. The live table already has 38 duplicate
-- (venue_id, title) groups; a unique index would fail to build. The intake RPC
-- dedupes on write, and the validation workflow reports the existing dupes.
create index if not exists deals_venue_norm_title_idx
  on public.deals (venue_id, public.hh_norm_text(title));

create index if not exists deals_verification_sweep_idx
  on public.deals (status, last_verified_at nulls first);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. updated_at maintenance
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists venues_touch_updated_at on public.venues;
create trigger venues_touch_updated_at
  before update on public.venues
  for each row execute function public.hh_touch_updated_at();

drop trigger if exists deals_touch_updated_at on public.deals;
create trigger deals_touch_updated_at
  before update on public.deals
  for each row execute function public.hh_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Audit log
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.content_audit_log (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null check (entity_type in ('deal', 'venue')),
  entity_id    uuid,
  action       text not null check (action in (
                 'insert', 'update', 'skip_duplicate', 'expire',
                 'flag', 'approve', 'reject', 'reopen'
               )),
  field_changes jsonb not null default '{}'::jsonb,
  reason       text,
  source       text,
  confidence   numeric(3,2),
  created_at   timestamptz not null default now()
);

create index if not exists content_audit_log_entity_idx
  on public.content_audit_log (entity_type, entity_id, created_at desc);

create index if not exists content_audit_log_created_idx
  on public.content_audit_log (created_at desc);

comment on table public.content_audit_log is
  'Append-only trail of every automated change made by the n8n content pipeline.';

-- Locked down: no policies means only service_role (which bypasses RLS) can
-- touch it. The mobile app has no reason to read the audit trail.
alter table public.content_audit_log enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Intake RPC -- atomic upsert of a venue + deal with dedupe
-- ─────────────────────────────────────────────────────────────────────────────

-- Called by the n8n "Intake API" workflow with the service_role key.
-- SECURITY INVOKER so it inherits the caller's rights rather than granting a
-- privilege-escalation path to anon.
create or replace function public.hh_intake_deal(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_venue_id      uuid;
  v_deal_id       uuid;
  v_venue_action  text := 'matched';
  v_deal_action   text;
  v_lat           double precision := (p_payload -> 'venue' ->> 'latitude')::double precision;
  v_lng           double precision := (p_payload -> 'venue' ->> 'longitude')::double precision;
  v_name          text := p_payload -> 'venue' ->> 'name';
  v_place_id      text := nullif(p_payload -> 'venue' ->> 'google_place_id', '');
  v_title         text := p_payload -> 'deal' ->> 'title';
  v_confidence    numeric := nullif(p_payload -> 'deal' ->> 'confidence', '')::numeric;
  v_status        public.deal_status;
  v_time_window   text := p_payload -> 'deal' ->> 'time_window';
  v_window_ok     boolean;
  v_missing       text[];
  v_source        text := coalesce(p_payload ->> 'source', 'unknown');
  v_existing      public.deals%rowtype;
  v_changes       jsonb := '{}'::jsonb;
begin
  v_window_ok := public.hh_is_valid_time_window(v_time_window);

  -- Fail loudly with the field names rather than letting a NOT NULL
  -- constraint surface as an opaque 23502 three frames down. venues.address
  -- and venues.neighborhood are NOT NULL, so they are required even though
  -- only a new venue would need them.
  v_missing := array_remove(array[
    case when v_name is null                                   then 'venue.name' end,
    case when p_payload -> 'venue' ->> 'address' is null       then 'venue.address' end,
    case when p_payload -> 'venue' ->> 'neighborhood' is null  then 'venue.neighborhood' end,
    case when v_lat is null                                    then 'venue.latitude' end,
    case when v_lng is null                                    then 'venue.longitude' end,
    case when v_title is null                                  then 'deal.title' end,
    case when v_time_window is null                            then 'deal.time_window' end
  ], null);

  if array_length(v_missing, 1) > 0 then
    raise exception 'hh_intake_deal: missing required field(s): %', array_to_string(v_missing, ', ')
      using errcode = '22023';
  end if;

  -- ── Resolve the venue ────────────────────────────────────────────────────
  -- Prefer the Google Place ID; fall back to normalized name within ~300m.
  if v_place_id is not null then
    select id into v_venue_id
      from public.venues
     where google_place_id = v_place_id
     limit 1;
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
      v_lat,
      v_lng,
      nullif(p_payload -> 'venue' ->> 'website', ''),
      nullif(p_payload -> 'venue' ->> 'phone', ''),
      nullif(p_payload -> 'venue' ->> 'image_url', ''),
      v_place_id,
      v_source,
      nullif(p_payload ->> 'source_url', ''),
      now()
    )
    returning id into v_venue_id;

    v_venue_action := 'inserted';

    insert into public.content_audit_log (entity_type, entity_id, action, field_changes, source, reason)
    values ('venue', v_venue_id, 'insert', to_jsonb(p_payload -> 'venue'), v_source, 'new venue from intake');
  else
    -- Enrich blanks on an existing venue without clobbering curated values.
    update public.venues
       set website          = coalesce(website, nullif(p_payload -> 'venue' ->> 'website', '')),
           phone            = coalesce(phone, nullif(p_payload -> 'venue' ->> 'phone', '')),
           image_url        = coalesce(image_url, nullif(p_payload -> 'venue' ->> 'image_url', '')),
           google_place_id  = coalesce(google_place_id, v_place_id),
           last_verified_at = now()
     where id = v_venue_id;
  end if;

  -- ── Decide publish status ────────────────────────────────────────────────
  -- Auto-publish only when the extractor is confident AND the time window is
  -- parseable by the app. Everything else queues for human review.
  if coalesce(v_confidence, 0) >= 0.80 and v_window_ok then
    v_status := 'active';
  else
    v_status := 'pending';
  end if;

  -- ── Resolve the deal ─────────────────────────────────────────────────────
  select * into v_existing
    from public.deals
   where venue_id = v_venue_id
     and public.hh_norm_text(title) = public.hh_norm_text(v_title)
   limit 1;

  if v_existing.id is null then
    insert into public.deals (
      venue_id, title, description, time_window, days_active, tags,
      price_level, type, status, source, source_url, confidence,
      last_verified_at, verification_status
    )
    values (
      v_venue_id,
      v_title,
      nullif(p_payload -> 'deal' ->> 'description', ''),
      v_time_window,
      coalesce(
        (select array_agg(value::int) from jsonb_array_elements_text(p_payload -> 'deal' -> 'days_active')),
        '{0,1,2,3,4,5,6}'::int[]
      ),
      coalesce(
        (select array_agg(value) from jsonb_array_elements_text(p_payload -> 'deal' -> 'tags')),
        '{}'::text[]
      ),
      coalesce(nullif(p_payload -> 'deal' ->> 'price_level', '')::int, 1),
      coalesce(nullif(p_payload -> 'deal' ->> 'type', ''), 'regular'),
      v_status,
      v_source,
      nullif(p_payload ->> 'source_url', ''),
      v_confidence,
      now(),
      -- Only a deal that cleared the auto-publish gate can claim to be
      -- verified; anything queued for review is unverified by definition.
      case when v_status = 'active' then 'verified' else 'unverified' end
    )
    returning id into v_deal_id;

    v_deal_action := 'inserted';

    insert into public.content_audit_log (entity_type, entity_id, action, field_changes, source, confidence, reason)
    values ('deal', v_deal_id, 'insert', to_jsonb(p_payload -> 'deal'), v_source, v_confidence,
            format('new deal, published as %s', v_status));
  else
    v_deal_id := v_existing.id;

    -- Only overwrite when the incoming extraction is at least as confident as
    -- what produced the stored row. Prevents a low-confidence scrape from
    -- degrading a human-approved deal.
    if coalesce(v_confidence, 0) >= coalesce(v_existing.confidence, 0) then
      -- A stored window the app can actually parse is never surrendered to an
      -- unparseable one, however confident the extractor claims to be. The
      -- rejected value is kept in the audit trail so a human can adjudicate.
      if not v_window_ok then
        v_changes := v_changes || jsonb_build_object(
          'rejected_time_window',
          jsonb_build_object('kept', v_existing.time_window, 'proposed', v_time_window));
      elsif v_existing.time_window is distinct from v_time_window then
        v_changes := v_changes || jsonb_build_object(
          'time_window', jsonb_build_object('from', v_existing.time_window, 'to', v_time_window));
      end if;

      update public.deals
         set time_window      = case when v_window_ok then v_time_window else time_window end,
             description      = coalesce(nullif(p_payload -> 'deal' ->> 'description', ''), description),
             confidence       = v_confidence,
             source_url       = coalesce(nullif(p_payload ->> 'source_url', ''), source_url),
             last_verified_at = now(),
             -- An incoming extraction that fails the auto-publish gate can
             -- still be the freshest thing we have, but it must not silently
             -- upgrade the row to "verified" -- flag it for review instead.
             verification_status = case
               when v_status <> 'active' then 'conflict'
               when v_changes = '{}'::jsonb then 'verified'
               else 'changed'
             end
       where id = v_deal_id;

      v_deal_action := case when v_changes = '{}'::jsonb then 'refreshed' else 'updated' end;

      insert into public.content_audit_log (entity_type, entity_id, action, field_changes, source, confidence, reason)
      values ('deal', v_deal_id, 'update', v_changes, v_source, v_confidence, 'intake matched existing deal');
    else
      v_deal_action := 'skipped_lower_confidence';

      insert into public.content_audit_log (entity_type, entity_id, action, field_changes, source, confidence, reason)
      values ('deal', v_deal_id, 'skip_duplicate', '{}'::jsonb, v_source, v_confidence,
              'incoming confidence below stored value');
    end if;
  end if;

  return jsonb_build_object(
    'venue_id', v_venue_id,
    'venue_action', v_venue_action,
    'deal_id', v_deal_id,
    'deal_action', v_deal_action,
    'status', v_status
  );
end
$$;

comment on function public.hh_intake_deal(jsonb) is
  'Atomic venue+deal upsert with dedupe, confidence gating, and audit logging. Called by the n8n intake workflow using the service_role key.';

revoke all on function public.hh_intake_deal(jsonb) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Validation support
-- ─────────────────────────────────────────────────────────────────────────────

-- Feeds the re-validation workflow: stalest first, only deals whose venue has
-- a website worth scraping.
create or replace function public.hh_deals_needing_verification(p_limit int default 40)
returns table (
  deal_id          uuid,
  title            text,
  time_window      text,
  days_active      int[],
  price_level      int,
  description      text,
  status           public.deal_status,
  confidence       numeric,
  last_verified_at timestamptz,
  venue_id         uuid,
  venue_name       text,
  venue_address    text,
  website          text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.id, d.title, d.time_window, d.days_active, d.price_level, d.description,
         d.status, d.confidence, d.last_verified_at,
         v.id, v.name, v.address, v.website
    from public.deals d
    join public.venues v on v.id = d.venue_id
   where d.status in ('active', 'pending')
     and v.permanently_closed = false
     and v.website is not null
     and (d.last_verified_at is null or d.last_verified_at < now() - interval '30 days')
   order by d.last_verified_at asc nulls first, d.created_at asc
   limit greatest(p_limit, 1);
$$;

revoke all on function public.hh_deals_needing_verification(int) from public, anon, authenticated;

-- Standing report of everything structurally wrong in the corpus. Backs the
-- weekly digest email.
create or replace view public.hh_data_quality_issues as
  select 'deal'::text as entity_type,
         d.id         as entity_id,
         v.name       as label,
         issue.code   as issue,
         issue.detail as detail
    from public.deals d
    join public.venues v on v.id = d.venue_id
   cross join lateral (
     values
       ('unparseable_time_window',
        d.time_window,
        not public.hh_is_valid_time_window(d.time_window)),
       ('missing_description',
        null::text,
        d.description is null or btrim(d.description) = ''),
       ('no_days_active',
        null::text,
        d.days_active is null or array_length(d.days_active, 1) is null),
       ('never_verified',
        null::text,
        d.last_verified_at is null),
       ('stale_over_90d',
        d.last_verified_at::text,
        d.last_verified_at is not null and d.last_verified_at < now() - interval '90 days')
   ) as issue(code, detail, matched)
   where issue.matched
     and d.status in ('active', 'pending')

  union all

  select 'venue',
         v.id,
         v.name,
         issue.code,
         issue.detail
    from public.venues v
   cross join lateral (
     values
       ('coords_outside_chicago',
        format('%s, %s', v.latitude, v.longitude),
        v.latitude not between 41.6 and 42.1 or v.longitude not between -87.95 and -87.5),
       ('missing_phone', null::text, v.phone is null),
       ('missing_website', null::text, v.website is null)
   ) as issue(code, detail, matched)
   where issue.matched
     and v.permanently_closed = false;

comment on view public.hh_data_quality_issues is
  'One row per structural defect in the live corpus. Read by the weekly digest workflow.';

-- Duplicate deal groups -- reported, never auto-merged.
create or replace view public.hh_duplicate_deals as
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
  having count(*) > 1;

comment on view public.hh_duplicate_deals is
  'Deal rows that collide on (venue, normalized title). Surfaced for manual merge.';

-- Views inherit the RLS of their base tables under security_invoker.
alter view public.hh_data_quality_issues set (security_invoker = on);
alter view public.hh_duplicate_deals set (security_invoker = on);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Validation outcome RPC
-- ─────────────────────────────────────────────────────────────────────────────

-- Applies the result of one re-validation pass. Called by the n8n validation
-- workflow with the service_role key.
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
begin
  select * into v_existing from public.deals where id = p_deal_id;
  if not found then
    raise exception 'hh_record_verification: deal % not found', p_deal_id using errcode = '22023';
  end if;

  if p_verdict not in ('confirmed','changed','gone','unreachable','unclear') then
    raise exception 'hh_record_verification: unknown verdict %', p_verdict using errcode = '22023';
  end if;

  v_window_ok  := public.hh_is_valid_time_window(v_window);
  -- A corrected window without corrected days would still advertise the deal on
  -- days it does not run, so the days ride the same gate.
  v_days_ok    := coalesce(v_conf, 0) >= 0.80
                  and public.hh_valid_days_active(p_extracted -> 'days_active');
  if v_days_ok then
    select array_agg((e#>>'{}')::int order by (e#>>'{}')::int)
      into v_days
      from jsonb_array_elements(p_extracted -> 'days_active') e;
  end if;
  v_new_status := v_existing.status;

  if p_verdict = 'confirmed' then
    v_vstatus := 'verified';

  elsif p_verdict = 'unreachable' then
    -- last_verified_at is still bumped so the deal rotates out of the queue
    -- instead of being retried every run; verification_status carries the
    -- truth that nothing was actually confirmed.
    v_vstatus := 'unreachable';

  elsif p_verdict = 'unclear' then
    v_vstatus := 'conflict';

  elsif p_verdict = 'gone' then
    -- Only a confident reading may pull a deal out of the app. Anything
    -- weaker is a conflict for a human to judge, never a silent unpublish.
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
    -- changed: apply only a confident AND app-parseable window. A window the
    -- app cannot parse is recorded as a proposal, never written to the row.
    if coalesce(v_conf, 0) >= 0.80 and v_window_ok then
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

  -- The days are independent of the window: a window the model confirms can
  -- still sit on the wrong days, so they are applied on any confident reading
  -- that produced them, not only when the window itself moved. Every automated
  -- edit stays auditable.
  if v_days_ok and v_vstatus in ('changed','verified')
     and v_existing.days_active is distinct from v_days then
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
    'changes', v_changes);
end $$;

comment on function public.hh_record_verification(uuid, text, jsonb, text, text) is
  'Applies the outcome of one re-validation pass to a deal, with confidence gating and an audit entry. Called by the n8n validation workflow.';

revoke all on function public.hh_record_verification(uuid, text, jsonb, text, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Human review RPC
-- ─────────────────────────────────────────────────────────────────────────────

-- Backs the Approve / Reject links in the weekly digest email.
create or replace function public.hh_review_deal(p_deal_id uuid, p_action text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_existing public.deals%rowtype;
  v_new      public.deal_status;
begin
  select * into v_existing from public.deals where id = p_deal_id;
  if not found then
    raise exception 'hh_review_deal: deal % not found', p_deal_id using errcode = '22023';
  end if;

  if p_action = 'approve' then
    -- Approving a deal whose window the app cannot parse would publish a
    -- broken card, so that has to be fixed before it can go live.
    if not public.hh_is_valid_time_window(v_existing.time_window) then
      raise exception 'hh_review_deal: cannot approve deal % -- time_window %L is not parseable by the app',
        p_deal_id, v_existing.time_window using errcode = '22023';
    end if;
    v_new := 'active';
  elsif p_action = 'reject' then
    v_new := 'rejected';
  else
    raise exception 'hh_review_deal: unknown action %', p_action using errcode = '22023';
  end if;

  update public.deals
     set status              = v_new,
         verification_status = case when p_action = 'approve' then 'verified' else verification_status end,
         last_verified_at    = now()
   where id = p_deal_id;

  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, reason)
  values ('deal', p_deal_id, p_action,
          jsonb_build_object('status', jsonb_build_object('from', v_existing.status::text, 'to', v_new::text)),
          'human_review', 'reviewed from digest email');

  return jsonb_build_object('deal_id', p_deal_id, 'action', p_action, 'status', v_new, 'title', v_existing.title);
end $$;

comment on function public.hh_review_deal(uuid, text) is
  'Approve or reject a pending deal from the weekly digest, with an audit entry.';

revoke all on function public.hh_review_deal(uuid, text) from public, anon, authenticated;
