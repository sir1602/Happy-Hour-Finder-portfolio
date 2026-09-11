-- ============================================================================
-- Multi-metro support.
--
-- Splits two concerns that were previously both "Chicago":
--   * the pipeline scopes by METRO (per-city discovery + geocoding config)
--   * the app scopes by RADIUS around the user (see search_deals below)
--
-- Everything is additive. `venues.metro_id` is nullable so the migration cannot
-- fail on unassignable rows; anything unassigned is reported by the
-- hh_data_quality_issues view rather than silently defaulted.
--
-- Safe to re-run: every statement is guarded.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Distance helper
-- ─────────────────────────────────────────────────────────────────────────────

-- Great-circle distance in kilometres. Plain trig rather than PostGIS/earthdistance
-- to avoid adding an extension for what is only ever a coarse radius check.
create or replace function public.hh_distance_km(
  p_lat1 double precision, p_lng1 double precision,
  p_lat2 double precision, p_lng2 double precision
)
returns double precision
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 6371.0 * 2 * asin(least(1.0, sqrt(
    power(sin(radians(p_lat2 - p_lat1) / 2), 2) +
    cos(radians(p_lat1)) * cos(radians(p_lat2)) *
    power(sin(radians(p_lng2 - p_lng1) / 2), 2)
  )));
$$;

comment on function public.hh_distance_km(double precision, double precision, double precision, double precision) is
  'Great-circle distance in km. Used for metro radius checks and deal scoping.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Metros
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.metros (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  name           text not null,
  center_lat     double precision not null,
  center_lng     double precision not null,
  radius_km      numeric not null default 60 check (radius_km > 0),
  geocode_suffix text,
  timezone       text not null default 'America/Chicago',
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.metros is
  'A city/metro the app covers. Drives discovery parameters, geocoding context, and which deals the re-validation sweep refreshes.';
comment on column public.metros.active is
  'When false the metro is kept but frozen: hh_deals_needing_verification skips it, so no re-validation spend after a trip ends.';
comment on column public.metros.radius_km is
  'How far from center still counts as this metro. Chicago is 60km to include Arlington Heights, Wheeling and Oak Brook.';
comment on column public.metros.geocode_suffix is
  'Appended to bare street addresses before geocoding, e.g. ", Chicago, IL".';

drop trigger if exists metros_touch_updated_at on public.metros;
create trigger metros_touch_updated_at
  before update on public.metros
  for each row execute function public.hh_touch_updated_at();

-- The app reads this to resolve the nearest metro when the user is outside every
-- coverage radius, so anon needs SELECT. Writes stay service_role only (no
-- INSERT/UPDATE/DELETE policy exists, and service_role bypasses RLS).
alter table public.metros enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'metros'
       and policyname = 'Metros are publicly readable'
  ) then
    create policy "Metros are publicly readable"
      on public.metros for select using (true);
  end if;
end
$$;

insert into public.metros (slug, name, center_lat, center_lng, radius_km, geocode_suffix, timezone)
values ('chicago', 'Chicago, IL', 41.8781, -87.6298, 60, ', Chicago, IL', 'America/Chicago')
on conflict (slug) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Venue -> metro
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.venues
  add column if not exists metro_id uuid references public.metros(id);

comment on column public.venues.metro_id is
  'Owning metro. Nullable: an unassigned venue is reported by hh_data_quality_issues rather than guessed at.';

create index if not exists venues_metro_idx on public.venues (metro_id);

-- Every venue that exists today is Chicago-area by construction.
update public.venues
   set metro_id = (select id from public.metros where slug = 'chicago')
 where metro_id is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Data quality view -- per-metro radius instead of a hardcoded Chicago box
-- ─────────────────────────────────────────────────────────────────────────────

-- The previous `coords_outside_chicago` check used a literal bounding box of
-- 41.6-42.1 / -87.95 to -87.5. That box was too tight and produced 8 false
-- positives -- Arlington Heights, Wheeling and Oak Brook are genuine suburbs,
-- not bad data. Distance from the venue's own metro center is both correct and
-- city-agnostic.
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
       ('missing_website', null::text, v.website is null)
   ) as issue(code, detail, matched)
   where issue.matched and v.permanently_closed = false;

comment on view public.hh_data_quality_issues is
  'One row per structural defect in the live corpus. Read by the weekly digest workflow.';

alter view public.hh_data_quality_issues set (security_invoker = on);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Re-validation scope -- active metros only
-- ─────────────────────────────────────────────────────────────────────────────

-- Without this the daily sweep is global: adding a visited metro would dilute
-- Chicago's refresh rate and keep paying to re-verify bars in a city you left
-- months ago. Setting metros.active = false freezes a metro's data in place.
create or replace function public.hh_deals_needing_verification(p_limit int default 40)
returns table (
  deal_id uuid, title text, time_window text, days_active int[], price_level int,
  description text, status public.deal_status, confidence numeric,
  last_verified_at timestamptz, venue_id uuid, venue_name text,
  venue_address text, website text)
language sql stable security invoker set search_path = '' as $$
  select d.id, d.title, d.time_window, d.days_active, d.price_level, d.description,
         d.status, d.confidence, d.last_verified_at,
         v.id, v.name, v.address, v.website
    from public.deals d
    join public.venues v on v.id = d.venue_id
    left join public.metros m on m.id = v.metro_id
   where d.status in ('active','pending')
     and v.permanently_closed = false
     and v.website is not null
     and coalesce(m.active, true)
     and (d.last_verified_at is null or d.last_verified_at < now() - interval '30 days')
   order by d.last_verified_at asc nulls first, d.created_at asc
   limit greatest(p_limit, 1);
$$;

revoke all on function public.hh_deals_needing_verification(int) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Intake -- metro assignment
-- ─────────────────────────────────────────────────────────────────────────────

-- Adds metro resolution to the existing intake RPC. Precedence:
--   1. an explicit metro_slug in the payload (unknown slug raises, so a typo
--      cannot silently create an unscoped venue)
--   2. otherwise geography -- the nearest metro whose radius contains the venue
--   3. otherwise NULL, reported as venue_missing_metro
-- Rule 2 means a venue self-assigns correctly as soon as its metro exists,
-- rather than defaulting to Chicago and landing a Phoenix bar in Illinois.
create or replace function public.hh_intake_deal(p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
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
      last_verified_at, verification_status)
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
      case when v_status = 'active' then 'verified' else 'unverified' end)
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
end $$;

comment on function public.hh_intake_deal(jsonb) is
  'Atomic venue+deal upsert with dedupe, metro assignment, confidence gating, and audit logging. Called by the n8n intake workflow using the service_role key.';

revoke all on function public.hh_intake_deal(jsonb) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. search_deals -- optional radius scoping
-- ─────────────────────────────────────────────────────────────────────────────

-- Adds three nullable geo parameters. When any is NULL the behaviour is byte
-- for byte what it was before, so existing callers are unaffected; the app
-- opts in once it knows where the user is.
--
-- DROP + CREATE rather than CREATE OR REPLACE: adding parameters changes the
-- signature, which would otherwise leave a second overload behind and make the
-- PostgREST call ambiguous.
drop function if exists public.search_deals(text, integer, text, integer, text[], text, integer, integer);

create or replace function public.search_deals(
  search_query        text,
  day_filter          integer  default null,
  deal_type           text     default null,
  price_max           integer  default null,
  tag_filter          text[]   default null,
  neighborhood_filter text     default null,
  row_limit           integer  default 50,
  row_offset          integer  default 0,
  center_lat          double precision default null,
  center_lng          double precision default null,
  radius_km           double precision default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
DECLARE
  tsq       tsquery;
  geo_on    boolean := center_lat is not null and center_lng is not null and radius_km is not null;
  lat_delta double precision;
  lng_delta double precision;
BEGIN
  tsq := to_tsquery(
    'english',
    array_to_string(
      ARRAY(
        SELECT lexeme || ':*'
          FROM unnest(string_to_array(trim(search_query), ' ')) AS lexeme
         WHERE trim(lexeme) <> ''
      ),
      ' & '
    )
  );

  -- Cheap bounding box first so the lat/lng indexes can be used, then refine
  -- with true distance. cos() is floored so a near-polar centre cannot blow the
  -- longitude delta up to infinity.
  IF geo_on THEN
    lat_delta := radius_km / 111.045;
    lng_delta := radius_km / (111.045 * greatest(cos(radians(center_lat)), 0.01));
  END IF;

  RETURN (
    SELECT jsonb_agg(row_json ORDER BY rank DESC)
    FROM (
      SELECT
        ts_rank(d.search_vector, tsq) AS rank,
        jsonb_build_object(
          'id',             d.id,
          'venue_id',       d.venue_id,
          'title',          d.title,
          'description',    d.description,
          'time_window',    d.time_window,
          'days_active',    d.days_active,
          'tags',           d.tags,
          'price_level',    d.price_level,
          'type',           d.type,
          'ends_in',        d.ends_in,
          'status',         d.status,
          'parent_deal_id', d.parent_deal_id,
          'created_at',     d.created_at,
          'venues', jsonb_build_object(
            'name',         v.name,
            'address',      v.address,
            'neighborhood', v.neighborhood,
            'latitude',     v.latitude,
            'longitude',    v.longitude,
            'website',      v.website,
            'phone',        v.phone,
            'image_url',    v.image_url,
            'rating',       v.rating,
            'review_count', v.review_count
          )
        ) AS row_json
      FROM deals d
      JOIN venues v ON v.id = d.venue_id
      WHERE d.status = 'active'
        AND d.search_vector @@ tsq
        AND (day_filter IS NULL OR day_filter = ANY(d.days_active))
        AND (deal_type IS NULL OR d.type = deal_type)
        AND (price_max IS NULL OR d.price_level <= price_max)
        AND (tag_filter IS NULL OR d.tags @> tag_filter)
        AND (neighborhood_filter IS NULL
             OR v.neighborhood ILIKE '%' || neighborhood_filter || '%')
        AND (NOT geo_on OR (
              v.latitude  BETWEEN center_lat - lat_delta AND center_lat + lat_delta
          AND v.longitude BETWEEN center_lng - lng_delta AND center_lng + lng_delta
          AND public.hh_distance_km(v.latitude, v.longitude, center_lat, center_lng) <= radius_km
        ))
      LIMIT row_limit
      OFFSET row_offset
    ) sub
  );
END;
$function$;

comment on function public.search_deals(text, integer, text, integer, text[], text, integer, integer, double precision, double precision, double precision) is
  'Full-text deal search. Passing center_lat/center_lng/radius_km scopes results to that radius; omitting them preserves the original unscoped behaviour.';
