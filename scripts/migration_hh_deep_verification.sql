-- ─────────────────────────────────────────────────────────────────────────────
-- Deep re-validation support
--
-- The daily sweep (n8n Workflow 2) only ever read `venues.website`. For 280 of
-- the 342 in-scope deals that string is a bare homepage, and a restaurant's
-- happy hour almost never lives there -- Taco Bar's is at /menu/happy-hour/.
-- The sweep therefore asked the model "does this page mention happy hour?",
-- got a truthful "no" about the wrong page, and mapped it to verdict `gone`.
--
-- Two columns are all the workflow needs to crawl deeper:
--
--   source_url        -- the page a previous run PROVED carries this deal, so
--                        discovery is paid once per venue rather than nightly.
--                        hh_record_verification() already persists it; nothing
--                        ever read it back.
--   venue_neighborhood -- 31 venues share a domain with a sibling location
--                        (Beatrix x3, Taco Bar, Lonesome Rose...). Without it
--                        the model cannot tell Wicker Park's hours from
--                        Wrigleyville's and may write one onto the other.
--
-- A `returns table` signature cannot be widened in place, so the function is
-- dropped and recreated. The metro gating from migration_metros.sql is carried
-- over verbatim -- this supersedes that definition.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.hh_deals_needing_verification(int);

create function public.hh_deals_needing_verification(p_limit int default 40)
returns table (
  deal_id            uuid,
  title              text,
  time_window        text,
  days_active        int[],
  price_level        int,
  description        text,
  status             public.deal_status,
  confidence         numeric,
  last_verified_at   timestamptz,
  source_url         text,
  venue_id           uuid,
  venue_name         text,
  venue_address      text,
  venue_neighborhood text,
  website            text)
language sql stable security invoker set search_path = '' as $$
  select d.id, d.title, d.time_window, d.days_active, d.price_level, d.description,
         d.status, d.confidence, d.last_verified_at, d.source_url,
         v.id, v.name, v.address, v.neighborhood, v.website
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

comment on function public.hh_deals_needing_verification(int) is
  'Feeds the daily re-validation sweep, stalest first, active metros only. Returns source_url so a venue''s known happy-hour page is re-read directly, and neighborhood so a multi-location site can be disambiguated.';

revoke all on function public.hh_deals_needing_verification(int) from public, anon, authenticated;
