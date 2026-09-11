-- P2 #19 + #16 — index the hot query paths, constrain price_level, and move
-- deal-submission rate limiting server-side.

begin;

-- ── #19: indexes ────────────────────────────────────────────────────────────
-- Every getDeals / getHighlightDeals / getBoundingBoxDeals call filters on
-- `status = 'active'` AND `days_active @> ARRAY[n]`, and neither column was
-- indexed. The map's bounding-box query scans venues by lat/lng, and the filter
-- dropdown scans by neighborhood — also unindexed.
--
-- At 342 deals / 348 venues this is invisible; sequential scans are fine at that
-- size. These are cheap insurance for the paths that will be hit hardest first.

create index if not exists idx_deals_status on public.deals (status);
create index if not exists idx_deals_days_active on public.deals using gin (days_active);
create index if not exists idx_venues_lat_lng on public.venues (latitude, longitude);
create index if not exists idx_venues_neighborhood on public.venues (neighborhood);

-- ── #21: price_level constraint ─────────────────────────────────────────────
-- `reviews.rating` had `CHECK (rating between 1 and 5)`, but price_level was an
-- unconstrained nullable integer. The UI renders it as `'$'.repeat(price)` and
-- `'$'.repeat(4 - price)`, so a row outside 1-4 throws `RangeError` during
-- render and takes out the whole card. Clamped client-side too (utils/price.ts),
-- but the data should not be able to get into that state in the first place.
-- Verified: all 342 existing rows are already within range.
alter table public.deals drop constraint if exists deals_price_level_check;
alter table public.deals
    add constraint deals_price_level_check
    check (price_level is null or (price_level >= 1 and price_level <= 4));

-- ── #16: server-side submission rate limiting ───────────────────────────────
-- The only limit was a 60-second AsyncStorage timestamp in useSubmitDealForm:
-- client-side, cleared by wiping app data, and entirely absent for anyone
-- posting directly to /rest/v1 with the public anon key (which ships in the
-- bundle). RLS allowed unlimited inserts to both deals and venues.
--
-- Attribute venues the same way deals now are, so both can be counted per user.
alter table public.venues
    add column if not exists submitted_by uuid references auth.users(id) on delete set null;

comment on column public.venues.submitted_by is
    'User who created this venue via the in-app deal submission form. NULL for seeded/imported venues.';

create index if not exists idx_venues_submitted_by on public.venues (submitted_by);

create or replace function public.enforce_deal_submission_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_recent_hour integer;
    v_recent_day  integer;
begin
    -- Only the group representative counts as one "submission"; a multi-schedule
    -- submission inserts several child rows (parent_deal_id not null) in the same
    -- statement and must not be counted once per schedule.
    if new.parent_deal_id is not null or new.submitted_by is null then
        return new;
    end if;

    select count(*) into v_recent_hour
    from public.deals
    where submitted_by = new.submitted_by
      and parent_deal_id is null
      and created_at > now() - interval '1 hour';

    if v_recent_hour >= 10 then
        raise exception 'Rate limit exceeded: at most 10 deal submissions per hour'
            using errcode = 'check_violation';
    end if;

    select count(*) into v_recent_day
    from public.deals
    where submitted_by = new.submitted_by
      and parent_deal_id is null
      and created_at > now() - interval '24 hours';

    if v_recent_day >= 40 then
        raise exception 'Rate limit exceeded: at most 40 deal submissions per day'
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

drop trigger if exists enforce_deal_submission_rate_limit_trigger on public.deals;
create trigger enforce_deal_submission_rate_limit_trigger
    before insert on public.deals
    for each row execute function public.enforce_deal_submission_rate_limit();

create or replace function public.enforce_venue_submission_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_recent integer;
begin
    if new.submitted_by is null then
        return new;
    end if;

    select count(*) into v_recent
    from public.venues
    where submitted_by = new.submitted_by
      and created_at > now() - interval '1 hour';

    if v_recent >= 10 then
        raise exception 'Rate limit exceeded: at most 10 new venues per hour'
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

drop trigger if exists enforce_venue_submission_rate_limit_trigger on public.venues;
create trigger enforce_venue_submission_rate_limit_trigger
    before insert on public.venues
    for each row execute function public.enforce_venue_submission_rate_limit();

-- Require venue inserts to be self-attributed, so the limit above can't be
-- sidestepped by simply omitting submitted_by.
drop policy if exists "Authenticated users can insert venues" on public.venues;
create policy "Authenticated users can insert venues"
    on public.venues for insert
    with check (
        (select auth.role()) = 'authenticated'
        and submitted_by = (select auth.uid())
    );

-- Trigger functions are not meant to be part of the exposed REST API.
revoke execute on function public.enforce_deal_submission_rate_limit() from public, anon, authenticated;
revoke execute on function public.enforce_venue_submission_rate_limit() from public, anon, authenticated;

commit;
