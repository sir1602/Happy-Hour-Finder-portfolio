-- ============================================================================
-- P1-7, STEP 1b of 3. APPLIED 2026-09-03 (migration `p1_rewards_insert_must_start_at_zero`).
--
-- This is the statement that actually closes hole (a).
--
-- scripts/migration_p1_rewards_integrity.sql adds a CHECK constraint named
-- user_rewards_starts_at_zero, and an earlier revision of that file claimed the
-- constraint stopped a client from creating a pre-loaded rewards row. It does
-- not. The expression is a floor:
--
--     total_points >= 0 and level between 1 and 6 and ...
--
-- so this POST still succeeded against the live database after step 1:
--
--     POST /rest/v1/user_rewards
--     {"user_id":"<self>","total_points":999999,"level":6}
--
-- 999999 >= 0 is true and 6 is in range. Confirmed empirically, not inferred.
--
-- A CHECK constraint cannot fix this, because it cannot tell an INSERT from an
-- UPDATE -- a true "must be zero" CHECK would also block increment_rewards from
-- ever raising the total. The INSERT policy is the right place: the client only
-- ever CREATES this row (rewardsService.getRewards does it lazily on first
-- read), and every subsequent write goes through the RPC, which is
-- SECURITY DEFINER and so is not subject to this policy.
--
-- Each counter is compared with `= 0` rather than wrapped in coalesce, so an
-- explicit null is rejected too. The columns are nullable, and a null
-- total_points would poison `total_points + p_points` inside the RPC. Columns
-- the client omits entirely still pass, because WITH CHECK is evaluated against
-- the finished row, after column defaults are applied -- and every default is
-- already 0, with level defaulting to 1.
--
-- Verified live as the `authenticated` role (impersonated via request.jwt.claims):
--   - inflated row  -> denied  (insufficient_privilege)
--   - null counters -> denied  (insufficient_privilege)
--   - zeroed row as defaultRewards() sends it -> accepted
--
-- Safe to re-run.
-- ============================================================================

alter policy "Users can insert own rewards" on public.user_rewards
  with check (
    (select auth.uid()) = user_id
    and total_points          = 0
    and level                 = 1
    and current_streak        = 0
    and longest_streak        = 0
    and unique_venues_visited = 0
    and total_visits          = 0
    and total_reviews         = 0
    and deals_submitted       = 0
  );

-- Verify afterwards -- with_check should list every counter, not just user_id:
--
--   select pg_get_expr(polwithcheck, polrelid)
--   from pg_policy
--   where polrelid = 'public.user_rewards'::regclass and polcmd = 'a';
