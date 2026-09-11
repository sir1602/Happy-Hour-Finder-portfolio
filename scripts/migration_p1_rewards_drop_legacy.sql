-- ============================================================================
-- P1-7, STEP 2 of 3. APPLIED 2026-09-03 (migration `p1_rewards_drop_legacy`).
--
-- Applied only after both preconditions held:
--   1. scripts/migration_p1_rewards_integrity.sql had been applied, AND
--   2. services/rewardsService.ts had moved to increment_rewards(p_action)
--      -- see rewardsService.awardAction. Nothing in the tree references the
--      legacy signature any more.
--
-- Running this while an older build is still installed breaks check-in, review
-- and deal-submission point awards for that build -- the RPC call 404s and
-- awardAction returns null. It does not lose data, but the user silently stops
-- earning points. Nothing had been distributed to testers at the time, so the
-- only affected client was a dev session running pre-change code.
--
-- This is the statement that actually closes hole (b): the legacy signature
-- takes a client-supplied `p_points` integer and adds it directly, so while it
-- exists any authenticated user can call it with p_points: 1000000.
--
-- Safe to re-run.
-- ============================================================================

drop function if exists public.increment_rewards(uuid, integer, text);

-- Verify afterwards -- this should return exactly one row, `p_action text`:
--
--   select pg_get_function_identity_arguments(p.oid)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'increment_rewards';
