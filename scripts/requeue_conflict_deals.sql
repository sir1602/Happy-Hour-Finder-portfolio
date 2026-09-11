-- ─────────────────────────────────────────────────────────────────────────────
-- One-off: return the deals a blind crawl gave up on to the front of the queue.
--
-- RUN THIS ONLY AFTER the Site Crawler fix is published in n8n. Requeueing
-- before that just spends the sweep's budget failing the same way again.
--
-- Why it is needed. hh_record_verification() bumps last_verified_at = now() on
-- every verdict, `unclear` included -- deliberately, so a venue is not retried
-- every single night. But hh_venues_needing_verification() then holds anything
-- verified inside 30 days out of the queue:
--
--     having min(coalesce(e.last_verified_at, '-infinity'::timestamptz))
--            < now() - interval '30 days'
--
-- So a deal that failed only because the crawler could not find its happy-hour
-- page waits a full month to fail again in exactly the same way. Rooftop Lounge, the
-- venue that prompted this a production run, was written to `conflict` on
-- 2026-09-10 and would not be looked at again until ~2026-10-10.
--
-- Setting last_verified_at to null sorts as '-infinity' in that RPC and puts
-- these venues at the head of the queue, so the improved crawler reaches them
-- in days rather than a month.
--
-- The filter is the signature of "we never found the page", not of "the deal is
-- bad": verification_status = 'conflict' AND no source_url. As of 2026-09-10
-- that is 146 of the 148 conflict rows -- the other two do have a source_url and
-- are a genuine disagreement about hours, which a human should judge in the
-- digest rather than a re-crawl.
--
-- Cost to accept knowingly: at p_limit = 10 venues/day these ~73 venues occupy
-- the sweep for roughly 8 days, and genuinely stale venues queue behind them.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Look before you leap.
select v.name as venue,
       count(*) as deals,
       min(d.confidence) as min_confidence,
       max(d.last_verified_at) as last_swept
  from public.deals d
  join public.venues v on v.id = d.venue_id
 where d.status in ('active', 'pending')
   and d.verification_status = 'conflict'
   and d.source_url is null
 group by v.name
 order by v.name;

-- 2. Requeue. Wrapped so a surprising row count can be rolled back rather than
--    discovered afterwards.
begin;

update public.deals
   set last_verified_at = null
 where status in ('active', 'pending')
   and verification_status = 'conflict'
   and source_url is null;

-- Expected ~146 rows. If this is wildly off, `rollback;` instead of `commit;`.
commit;

-- 3. Confirm the queue now leads with them.
select venue_name, deal_count, stalest_at
  from public.hh_venues_needing_verification(10);
