-- P1 #11 — Let deal submitters see their own pending submissions.
--
-- `deals` SELECT was restricted to `status = 'active'` and there was no column
-- recording who submitted a row, so a user who filled out the submit form was
-- told "pending approval by our moderators" and then had no way to see the deal
-- ever again — not its status, not even confirmation it was received.
--
-- Adding `submitted_by` fixes that and, just as importantly, gives moderation an
-- attribution trail and gives future server-side rate limiting something to
-- count against (the current 60s cooldown is an AsyncStorage timestamp, which is
-- client-side only and trivially bypassed).

begin;

alter table public.deals
    add column if not exists submitted_by uuid references auth.users(id) on delete set null;

comment on column public.deals.submitted_by is
    'User who submitted this deal via the in-app form. NULL for seeded/imported deals.';

-- Supports the self-read policy below and moderation queries by submitter.
create index if not exists idx_deals_submitted_by on public.deals (submitted_by);

-- Submitters can read their own rows regardless of status. Combined with the
-- existing "Active deals are publicly readable" policy (policies are OR'd), a
-- user sees all active deals plus their own pending/rejected ones.
drop policy if exists "Users can view their own submitted deals" on public.deals;
create policy "Users can view their own submitted deals"
    on public.deals for select
    using (submitted_by = (select auth.uid()));

-- Tighten INSERT so a submission must be attributed to the caller. Without this
-- a user could insert rows attributed to someone else, or to no one.
drop policy if exists "Authenticated users can insert pending deals" on public.deals;
create policy "Authenticated users can insert pending deals"
    on public.deals for insert
    with check (
        (select auth.role()) = 'authenticated'
        and status = 'pending'
        and submitted_by = (select auth.uid())
    );

commit;
