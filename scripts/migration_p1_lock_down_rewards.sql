-- P1 #6 — Close the rewards/badges write bypass.
--
-- `increment_rewards` was previously hardened to raise unless
-- `auth.uid() = p_user_id`. That fix was bypassable: the `user_rewards` table
-- still carried a permissive UPDATE policy, so a client holding the public anon
-- key could simply skip the RPC and write points directly:
--
--   PATCH /rest/v1/user_rewards?user_id=eq.<their-own-id>
--   {"total_points": 999999, "level": 6, "longest_streak": 52}
--
-- Removing the UPDATE policy makes the SECURITY DEFINER RPC the only write path
-- to points, levels, and streaks. The RPC is owned by a superuser role, so it
-- continues to work with RLS enforced for everyone else.
--
-- Badges had the same shape: INSERT was allowed for any row where
-- `auth.uid() = user_id`, with nothing validating `badge_id`. That is replaced
-- with an `award_badge` RPC that authenticates the caller and rejects unknown
-- badge IDs.

begin;

-- ── user_rewards ────────────────────────────────────────────────────────────
-- INSERT stays: rewardsService.getRewards() creates the row on first read.
-- SELECT stays: the client reads its own rewards summary.
-- UPDATE goes: increment_rewards is now the only mutation path.
drop policy if exists "Users can update own rewards" on public.user_rewards;

-- ── user_badges ─────────────────────────────────────────────────────────────
drop policy if exists "Users can insert own badges" on public.user_badges;

create or replace function public.award_badge(p_badge_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if v_user_id is null then
        raise exception 'Not authenticated';
    end if;

    -- Only badges the app actually defines can be awarded. Keep in sync with
    -- BADGES in services/rewardsService.ts.
    if p_badge_id is null or p_badge_id <> all (array[
        'first_sip', 'explorer', 'regular', 'critic', 'deal_hunter',
        'streak_master', 'hh_royalty', 'storyteller', 'night_owl', 'trailblazer'
    ]) then
        raise exception 'Unknown badge: %', coalesce(p_badge_id, '<null>');
    end if;

    -- (user_id, badge_id) is UNIQUE, so a repeat award is a no-op.
    insert into public.user_badges (user_id, badge_id)
    values (v_user_id, p_badge_id)
    on conflict (user_id, badge_id) do nothing;

    -- FOUND is false when ON CONFLICT DO NOTHING suppressed the insert.
    return found;
end;
$$;

revoke execute on function public.award_badge(text) from public, anon;
grant execute on function public.award_badge(text) to authenticated;

-- ── Trigger functions should not be part of the exposed REST API ────────────
-- These take no meaningful arguments and reference NEW/OLD, so a direct RPC
-- call errors rather than doing damage — but they don't belong on the API
-- surface at all. (Flagged by Supabase's security advisor.)
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.update_venue_rating() from public, anon, authenticated;

commit;

-- Follow-up (not in this migration): award_badge validates the badge ID and the
-- caller, which closes the "insert anything" hole, but it does not yet re-verify
-- each badge's earning criteria server-side. Doing so requires moving the
-- per-badge rules out of rewardsService.checkAndAwardBadges and into SQL.
