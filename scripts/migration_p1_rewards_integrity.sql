-- ============================================================================
-- P1-7: close the two remaining paths that let a client mint reward points.
--
-- `migration_p1_lock_down_rewards.sql` dropped the UPDATE policy on
-- user_rewards to force writes through the hardened RPC. Verified against the
-- live database on 2026-09-02, two paths were still open:
--
--   a) The INSERT policy is what creates the row, and validates nothing but
--      ownership. pg_constraint reports NO check constraints on user_rewards,
--      and rewardsService.getRewards creates the row lazily on first read -- so
--      a user can POST their own row first with any values they like:
--        POST /rest/v1/user_rewards
--        {"user_id":"<self>","total_points":999999,"level":6}
--
--   b) increment_rewards validates the CALLER but not the AMOUNT. p_points is
--      a client-supplied integer used directly in
--      `total_points = total_points + p_points`.
--
-- Blast radius today is cosmetic -- no leaderboard, nothing gated on points.
-- It matters because three prior documents record this as already fixed, and
-- because it is far cheaper to close before testers have balances.
--
-- APPLIED 2026-09-03 (migration `p1_rewards_integrity`).
--
-- CORRECTION: an earlier revision of this header claimed the CHECK constraint
-- below "can no longer insert a row that starts anywhere but zero". It cannot.
-- The expression is a FLOOR -- `total_points >= 0 and level between 1 and 6` --
-- so {"total_points":999999,"level":6} satisfies it and hole (a) stayed open.
-- Verified live before and after applying. A CHECK also cannot tell an INSERT
-- from an UPDATE, so it could never express "starts at zero" without blocking
-- the RPC's own increments. Hole (a) is closed instead by the INSERT policy in
--   scripts/migration_p1_rewards_insert_zero.sql   (step 1b)
-- The `comment on constraint` below was always the accurate description.
--
-- The three steps, in the order they were applied:
--
--   STEP 1  (this file)          floors every counter; adds increment_rewards(text)
--                                ALONGSIDE the legacy signature, so installed
--                                builds keep working.
--   STEP 1b (…_insert_zero.sql)  tightens the INSERT policy -- closes (a).
--   STEP 2  (…_drop_legacy.sql)  drops increment_rewards(uuid, integer, text)
--                                -- closes (b). Applied only after
--                                services/rewardsService.ts moved to p_action.
--
-- Safe to re-run.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Every counter has a floor
-- ─────────────────────────────────────────────────────────────────────────────
-- This stops negative values and out-of-range levels. It does NOT stop a large
-- starting value -- see the correction at the top of this file. The "starts at
-- zero" half of the job is done by the INSERT policy in step 1b; the constraint
-- keeps its original name so the two migrations stay greppable together.

alter table public.user_rewards
  drop constraint if exists user_rewards_starts_at_zero;

-- Applied NOT VALID first so an existing non-zero row cannot block the
-- migration; validated separately below, which is where a real problem would
-- surface loudly rather than silently skipping the constraint.
alter table public.user_rewards
  add constraint user_rewards_starts_at_zero
  check (
    total_points          >= 0
    and level             between 1 and 6
    and current_streak    >= 0
    and longest_streak    >= 0
    and unique_venues_visited >= 0
    and total_visits      >= 0
    and total_reviews     >= 0
    and deals_submitted   >= 0
  ) not valid;

alter table public.user_rewards validate constraint user_rewards_starts_at_zero;

comment on constraint user_rewards_starts_at_zero on public.user_rewards is
  'Floors every counter. The INSERT policy validates ownership only, so without this a client could POST its own row pre-loaded with points before the app creates it.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The server decides what an action is worth
-- ─────────────────────────────────────────────────────────────────────────────
-- increment_rewards now takes an ACTION, not a number. The point values move
-- out of the client (services/rewardsService.ts POINTS) and into the function,
-- so a caller can say "I checked in" but not "give me a million points".
--
-- Added alongside the old signature rather than replacing it -- see the
-- two-step note at the top of this file. Postgres treats these as separate
-- functions because the argument types differ.

create or replace function public.increment_rewards(p_action text)
returns public.user_rewards
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_points  integer;
    v_stat    text;
    result    public.user_rewards;
    new_level integer;
begin
    if v_user_id is null then
        raise exception 'Not authenticated';
    end if;

    -- Server-side points table. Mirrors POINTS in services/rewardsService.ts;
    -- that copy is now presentational only.
    case p_action
        when 'check_in'        then v_points := 10; v_stat := 'total_visits';
        when 'check_in_first'  then v_points := 35; v_stat := 'total_visits';   -- 10 + 25 first-visit bonus
        when 'review'          then v_points := 15; v_stat := 'total_reviews';
        when 'deal_submitted'  then v_points := 50; v_stat := 'deals_submitted';
        else raise exception 'Unknown rewards action: %', p_action;
    end case;

    -- Create the row if the client never did, so the caller cannot dodge the
    -- increment by simply not having one.
    insert into public.user_rewards (user_id)
    values (v_user_id)
    on conflict (user_id) do nothing;

    if v_stat = 'total_visits' then
        update public.user_rewards
        set total_points = total_points + v_points,
            total_visits = total_visits + 1,
            updated_at = now()
        where user_id = v_user_id;
    elsif v_stat = 'total_reviews' then
        update public.user_rewards
        set total_points = total_points + v_points,
            total_reviews = total_reviews + 1,
            updated_at = now()
        where user_id = v_user_id;
    elsif v_stat = 'deals_submitted' then
        update public.user_rewards
        set total_points = total_points + v_points,
            deals_submitted = deals_submitted + 1,
            updated_at = now()
        where user_id = v_user_id;
    end if;

    select * into result from public.user_rewards where user_id = v_user_id;

    if    result.total_points >= 2000 then new_level := 6;
    elsif result.total_points >= 1000 then new_level := 5;
    elsif result.total_points >= 600  then new_level := 4;
    elsif result.total_points >= 300  then new_level := 3;
    elsif result.total_points >= 100  then new_level := 2;
    else  new_level := 1;
    end if;

    if result.level is distinct from new_level then
        update public.user_rewards set level = new_level where user_id = v_user_id;
        result.level := new_level;
    end if;

    return result;
end;
$$;

comment on function public.increment_rewards(text) is
  'Award points for a named action. The point value is looked up server-side; the previous signature took a client-supplied integer and added it directly.';

-- anon can never own a rewards row, so it has no business calling this.
revoke all on function public.increment_rewards(text) from public, anon;
grant execute on function public.increment_rewards(text) to authenticated;
