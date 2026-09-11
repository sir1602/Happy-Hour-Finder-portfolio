-- ============================================================================
-- Photo intake: submit a happy hour by photographing the menu board
-- ============================================================================
-- Adds the three server-side pieces the photo path needs:
--
--   1. deals.image_url      -- the photo an extraction was read off, kept as
--                              evidence for the reviewer. NOT feed artwork.
--   2. hh_photo_scans       -- one row per model call, so the scan endpoint can
--                              be rate limited per user.
--   3. hh_claim_photo_scan  -- authenticate + claim quota in a single round
--                              trip, called by WF1's /hh-deal-scan branch.
--
-- Plus the storage hardening the alpha review asked for, which stops being
-- optional the moment the app starts asking every submitter for a photo.
--
-- Depends on: migration_n8n_content_pipeline.sql, migration_metros.sql
-- ============================================================================

-- ── 1. The evidence photo ───────────────────────────────────────────────────
alter table public.deals
  add column if not exists image_url text;

comment on column public.deals.image_url is
  'Photo the deal was read from (a menu board, a chalkboard, a printed sign). '
  'Evidence for whoever reviews the submission -- it is deliberately NOT what '
  'the app renders on a deal card, which comes from venues.image_url. A photo '
  'of a menu is proof, not appetising artwork.';

-- ── 2. Scan ledger ──────────────────────────────────────────────────────────
-- Gemini runs on the free tier and every workflow shares that one quota (see
-- n8n-workflows/README.md). A scan endpoint the app can call is the first
-- consumer a *user* can trigger at will, so it needs its own meter.
create table if not exists public.hh_photo_scans (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  image_url  text,
  created_at timestamptz not null default now()
);

create index if not exists hh_photo_scans_user_recent_idx
  on public.hh_photo_scans (user_id, created_at desc);

comment on table public.hh_photo_scans is
  'One row per menu-photo model call, written by hh_claim_photo_scan. Exists to '
  'rate limit the scan endpoint and to account for the share of the shared '
  'Gemini free-tier quota that user-triggered scans consume.';

alter table public.hh_photo_scans enable row level security;

-- No policies on purpose: the ledger is written only by the SECURITY DEFINER
-- function below and read only by the service role. RLS on with zero policies
-- denies every client, which is the intent.
revoke all on table public.hh_photo_scans from anon, authenticated;

-- ── 3. Claim a scan ─────────────────────────────────────────────────────────
-- Called by n8n with the *caller's* JWT, so auth.uid() is the submitter. This
-- is deliberately one call doing two jobs: PostgREST rejects a bad token before
-- the body runs, and the body rejects an over-quota user -- so the workflow
-- gets authentication and rate limiting from a single request.
create or replace function public.hh_claim_photo_scan(p_image_url text default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare
  v_user_id     uuid := auth.uid();
  v_per_hour    constant int := 6;
  v_per_day     constant int := 20;
  v_used_hour   int;
  v_used_day    int;
  v_next_free   timestamptz;
begin
  if v_user_id is null then
    raise exception 'hh_claim_photo_scan: authentication required'
      using errcode = '28000';
  end if;

  select count(*) filter (where created_at > now() - interval '1 hour'),
         count(*) filter (where created_at > now() - interval '1 day')
    into v_used_hour, v_used_day
    from public.hh_photo_scans
   where user_id = v_user_id
     and created_at > now() - interval '1 day';

  if v_used_hour >= v_per_hour or v_used_day >= v_per_day then
    -- When the oldest call in the window ages out, the next one is free.
    select min(created_at) + case when v_used_hour >= v_per_hour
                                 then interval '1 hour' else interval '1 day' end
      into v_next_free
      from public.hh_photo_scans
     where user_id = v_user_id
       and created_at > now() - case when v_used_hour >= v_per_hour
                                     then interval '1 hour' else interval '1 day' end;

    return jsonb_build_object(
      'allowed', false,
      'reason', case when v_used_hour >= v_per_hour then 'hourly_limit' else 'daily_limit' end,
      'retry_after_seconds',
        greatest(1, ceil(extract(epoch from (v_next_free - now())))::int),
      'used_hour', v_used_hour,
      'used_day', v_used_day);
  end if;

  insert into public.hh_photo_scans (user_id, image_url)
  values (v_user_id, nullif(p_image_url, ''));

  return jsonb_build_object(
    'allowed', true,
    'user_id', v_user_id,
    'remaining_hour', v_per_hour - v_used_hour - 1,
    'remaining_day', v_per_day - v_used_day - 1);
end $function$;

comment on function public.hh_claim_photo_scan(text) is
  'Authenticates the caller and claims one menu-photo scan against their quota '
  '(6/hour, 20/day). Returns {allowed:false, retry_after_seconds} rather than '
  'raising when the quota is spent, so the caller can answer 429 with a real '
  'retry hint. Called by WF1 /hh-deal-scan with the end user JWT.';

revoke all on function public.hh_claim_photo_scan(text) from public, anon;
grant execute on function public.hh_claim_photo_scan(text) to authenticated;

-- ── 4. Storage hardening ────────────────────────────────────────────────────
-- venue-images has been public with no size limit and no MIME allowlist since
-- it was created (docs/Alpha-Readiness-Review-2026-08-26.md, section 8). The
-- photo flow multiplies the number of uploads, so it closes here.
update storage.buckets
   set file_size_limit   = 5242880,   -- 5 MB; the app downscales well under this
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'venue-images';

-- Uploads move to <uid>/<file> so an object has an owner in its path, which is
-- what makes the DELETE policy below expressible at all. The old blanket
-- "any authenticated user may write anywhere" policy is replaced.
drop policy if exists "Authenticated users can upload to venue-images" on storage.objects;

create policy "Users upload to their own venue-images folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'venue-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users delete their own venue-images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'venue-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── 5. Carry the evidence photo through intake ──────────────────────────────
-- Unchanged from the version in migration_metros.sql except for deal.image_url:
-- written on insert, and preferred over the stored photo on a confident update
-- (the freshest photo is the one that matches the freshest extraction).
create or replace function public.hh_intake_deal(p_payload jsonb)
  returns jsonb
  language plpgsql
  set search_path to ''
as $function$
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
  v_deal_image    text := nullif(p_payload -> 'deal' ->> 'image_url', '');
  v_window_ok     boolean;
  v_missing       text[];
  v_metro_slug    text := coalesce(
                     nullif(p_payload ->> 'metro_slug', ''),
                     nullif(p_payload -> 'venue' ->> 'metro_slug', ''));
  v_metro_id      uuid;
  v_source        text := coalesce(p_payload ->> 'source', 'unknown');
  v_existing      public.deals%rowtype;
  v_changes       jsonb := '{}'::jsonb;
begin
  v_window_ok := public.hh_is_valid_time_window(v_time_window);

  v_missing := array_remove(array[
    case when v_name is null                                  then 'venue.name' end,
    case when p_payload -> 'venue' ->> 'address' is null      then 'venue.address' end,
    case when p_payload -> 'venue' ->> 'neighborhood' is null then 'venue.neighborhood' end,
    case when v_lat is null                                   then 'venue.latitude' end,
    case when v_lng is null                                   then 'venue.longitude' end,
    case when v_title is null                                 then 'deal.title' end,
    case when v_time_window is null                           then 'deal.time_window' end
  ], null);

  if array_length(v_missing, 1) > 0 then
    raise exception 'hh_intake_deal: missing required field(s): %', array_to_string(v_missing, ', ')
      using errcode = '22023';
  end if;

  if v_metro_slug is not null then
    select id into v_metro_id from public.metros where slug = v_metro_slug;
    if v_metro_id is null then
      raise exception 'hh_intake_deal: unknown metro_slug %', v_metro_slug using errcode = '22023';
    end if;
  else
    select id into v_metro_id
      from public.metros
     where public.hh_distance_km(v_lat, v_lng, center_lat, center_lng) <= radius_km
     order by public.hh_distance_km(v_lat, v_lng, center_lat, center_lng)
     limit 1;
  end if;

  if v_place_id is not null then
    select id into v_venue_id from public.venues where google_place_id = v_place_id limit 1;
  end if;

  if v_venue_id is null then
    select id into v_venue_id from public.venues
     where public.hh_norm_text(name) = public.hh_norm_text(v_name)
       and abs(latitude - v_lat) < 0.003
       and abs(longitude - v_lng) < 0.004
     limit 1;
  end if;

  if v_venue_id is null then
    insert into public.venues (
      name, address, neighborhood, latitude, longitude,
      website, phone, image_url, google_place_id, source, source_url,
      last_verified_at, metro_id)
    values (
      v_name,
      p_payload -> 'venue' ->> 'address',
      p_payload -> 'venue' ->> 'neighborhood',
      v_lat, v_lng,
      nullif(p_payload -> 'venue' ->> 'website', ''),
      nullif(p_payload -> 'venue' ->> 'phone', ''),
      nullif(p_payload -> 'venue' ->> 'image_url', ''),
      v_place_id, v_source,
      nullif(p_payload ->> 'source_url', ''),
      now(), v_metro_id)
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
           metro_id         = coalesce(metro_id, v_metro_id),
           last_verified_at = now()
     where id = v_venue_id;
  end if;

  if coalesce(v_confidence, 0) >= 0.80 and v_window_ok then
    v_status := 'active';
  else
    v_status := 'pending';
  end if;

  select * into v_existing from public.deals
   where venue_id = v_venue_id
     and public.hh_norm_text(title) = public.hh_norm_text(v_title)
   limit 1;

  if v_existing.id is null then
    insert into public.deals (
      venue_id, title, description, time_window, days_active, tags,
      price_level, type, status, source, source_url, confidence,
      last_verified_at, verification_status, image_url)
    values (
      v_venue_id, v_title,
      nullif(p_payload -> 'deal' ->> 'description', ''),
      v_time_window,
      coalesce((select array_agg(value::int) from jsonb_array_elements_text(p_payload -> 'deal' -> 'days_active')),
               '{0,1,2,3,4,5,6}'::int[]),
      coalesce((select array_agg(value) from jsonb_array_elements_text(p_payload -> 'deal' -> 'tags')),
               '{}'::text[]),
      coalesce(nullif(p_payload -> 'deal' ->> 'price_level', '')::int, 1),
      coalesce(nullif(p_payload -> 'deal' ->> 'type', ''), 'regular'),
      v_status, v_source,
      nullif(p_payload ->> 'source_url', ''),
      v_confidence, now(),
      case when v_status = 'active' then 'verified' else 'unverified' end,
      v_deal_image)
    returning id into v_deal_id;

    v_deal_action := 'inserted';

    insert into public.content_audit_log
      (entity_type, entity_id, action, field_changes, source, confidence, reason)
    values ('deal', v_deal_id, 'insert', to_jsonb(p_payload -> 'deal'), v_source, v_confidence,
            format('new deal, published as %s', v_status));
  else
    v_deal_id := v_existing.id;

    if coalesce(v_confidence, 0) >= coalesce(v_existing.confidence, 0) then
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
             image_url        = coalesce(v_deal_image, image_url),
             last_verified_at = now(),
             verification_status = case
               when v_status <> 'active' then 'conflict'
               when v_changes = '{}'::jsonb then 'verified'
               else 'changed'
             end
       where id = v_deal_id;

      v_deal_action := case when v_changes = '{}'::jsonb then 'refreshed' else 'updated' end;

      insert into public.content_audit_log
        (entity_type, entity_id, action, field_changes, source, confidence, reason)
      values ('deal', v_deal_id, 'update', v_changes, v_source, v_confidence, 'intake matched existing deal');
    else
      v_deal_action := 'skipped_lower_confidence';

      insert into public.content_audit_log
        (entity_type, entity_id, action, field_changes, source, confidence, reason)
      values ('deal', v_deal_id, 'skip_duplicate', '{}'::jsonb, v_source, v_confidence,
              'incoming confidence below stored value');
    end if;
  end if;

  return jsonb_build_object(
    'venue_id', v_venue_id, 'venue_action', v_venue_action,
    'deal_id', v_deal_id, 'deal_action', v_deal_action,
    'metro_id', v_metro_id, 'status', v_status);
end $function$;

comment on function public.hh_intake_deal(jsonb) is
  'Single write path for venues/deals from every source. Dedupes, decides the '
  'publish status (confidence >= 0.80 AND a parseable time window), records the '
  'evidence photo on deals.image_url, and writes the audit trail.';

revoke all on function public.hh_intake_deal(jsonb) from public, anon, authenticated;
