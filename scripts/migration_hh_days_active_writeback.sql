-- ─────────────────────────────────────────────────────────────────────────────
-- Apply a corrected days_active
--
-- hh_record_verification() accepted `days_active` inside p_extracted and threw
-- it away: the UPDATE wrote time_window, description, confidence and
-- source_url, but never the days. So a deal could have its hours corrected and
-- still be advertised on days it does not run -- Taco Bar's happy hour is
-- Mon-Thu 4-6 PM, and the row kept days_active = {0,1,2,3,4,5,6} even after a
-- confident `changed` reading returned {1,2,3,4}.
--
-- Gated exactly like the time window, so it inherits the same safety rails:
-- only on a `changed` verdict, only at confidence >= 0.80, and only when the
-- array is well formed (1-7 distinct integers in 0..6). Anything else leaves
-- the stored days untouched, and the change is written to content_audit_log
-- like every other automated edit.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_valid_days_active(p_days jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p_days is not null
     and jsonb_typeof(p_days) = 'array'
     and jsonb_array_length(p_days) between 1 and 7
     and not exists (
       select 1 from jsonb_array_elements(p_days) e
        where jsonb_typeof(e) <> 'number'
           or (e#>>'{}')::numeric <> floor((e#>>'{}')::numeric)
           or (e#>>'{}')::int not between 0 and 6)
     and (select count(distinct (e#>>'{}')::int) from jsonb_array_elements(p_days) e)
         = jsonb_array_length(p_days);
$$;

comment on function public.hh_valid_days_active(jsonb) is
  'True when a proposed days_active payload is 1-7 distinct integers in 0..6.';

revoke all on function public.hh_valid_days_active(jsonb) from public, anon, authenticated;
