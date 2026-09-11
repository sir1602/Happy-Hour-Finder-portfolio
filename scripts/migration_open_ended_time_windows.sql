-- ─────────────────────────────────────────────────────────────────────────────
-- Accept a happy hour that runs "until close".
--
-- Plenty of venues advertise their happy hour as "4 PM - close" and give no
-- end time at all. The app now stores that as written -- "4:00 PM - Close" --
-- rather than refusing the submission or inventing an end hour.
--
-- What it costs is the countdown, and only for those deals: getDealStatus()
-- shows "Starts in 1h 30m" before the start and "Active · until close" after,
-- instead of time remaining. Every other deal is unaffected. Reminders still
-- fire, because they are scheduled off the start time, which is known.
--
-- This function has to move with the app, and not just to keep the two in
-- agreement:
--
--   hh_review_deal() REFUSES TO APPROVE a deal whose time_window fails this
--   check. Every user submission lands as 'pending' and needs approval, so
--   without this migration an "until close" submission would be accepted by
--   the form and then be impossible for a moderator to publish -- stuck
--   pending forever, with the error blaming the time window.
--
-- The other three call sites follow from the same meaning:
--   * hh_intake_deal() / hh_upsert_deal_from_scan() -- the n8n pipeline can
--     now carry through an "until close" window it reads off a menu.
--   * hh_data_quality_issues -- stops reporting these as
--     'unparseable_time_window', which they no longer are.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_is_valid_time_window(p_input text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(p_input, '') ~*
    '^\s*\d{1,2}(:\d{2})?\s*(AM|PM)\s*-\s*(\d{1,2}(:\d{2})?\s*(AM|PM)|CLOSE)\s*$';
$$;

comment on function public.hh_is_valid_time_window(text) is
  'True when a time_window renders in the app: two clock times, or a start '
  'and "Close". Mirrors parseDealWindow() in utils/dealTime.ts. Note that '
  'parseDealTime() -- the narrower parser used where an end hour is required '
  '-- still rejects the "Close" form, by design.';
