-- ============================================================================
-- Tester feedback channel.
--
-- The alpha's whole purpose is signal, and until now a tester who found a
-- wrong deal had no way to say so — no report action, no contact address,
-- nothing. With 117 of 342 active deals currently flagged by the
-- re-validation pipeline as conflict/changed/unreachable, "this one is wrong"
-- is the single most likely thing a tester will want to tell us.
--
-- Applied as migration `feedback_channel`.
--
-- Purely additive: one new table, three policies, no existing object touched.
-- Reversible with `drop table public.feedback;`.
--
-- Verified after applying: RLS on; the three policies present with the right
-- roles; both CHECK constraints reject a bad `kind`, an empty message, and one
-- over 2000 characters; a null-user_id guest report is accepted. Read
-- isolation confirmed by impersonating a real user — they see their own row
-- and not a guest's, anon sees none, service role sees all. Test rows removed;
-- the table is empty.
--
-- Safe to re-run.
-- ============================================================================

create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  -- Null for general feedback; set when reporting a specific deal.
  deal_id     uuid references public.deals(id) on delete set null,
  kind        text not null check (kind in ('deal_report', 'general')),
  -- Bounded in the database, not just by a maxLength prop: the client cap is
  -- advisory and anyone can POST straight to /rest/v1.
  message     text not null check (length(message) between 1 and 2000),
  -- Free-form context the client attaches (app version, platform, the deal's
  -- verification_status at the time) so a report is actionable without a
  -- follow-up conversation.
  context     jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.feedback is
  'Tester-submitted reports and feedback. Written by the app; read by staff via the dashboard.';

create index if not exists idx_feedback_created_at on public.feedback (created_at desc);
create index if not exists idx_feedback_deal_id on public.feedback (deal_id) where deal_id is not null;

alter table public.feedback enable row level security;

-- Signed-in users may file feedback as themselves.
drop policy if exists "Users can submit their own feedback" on public.feedback;
create policy "Users can submit their own feedback"
on public.feedback for insert to authenticated
with check (user_id = (select auth.uid()));

-- Guests browse the app without an account, and a guest who spots a wrong deal
-- is exactly as valuable as a signed-in one. Their rows carry a null user_id.
drop policy if exists "Guests can submit anonymous feedback" on public.feedback;
create policy "Guests can submit anonymous feedback"
on public.feedback for insert to anon
with check (user_id is null);

-- Authors can read their own back; nobody can read anyone else's. There is
-- deliberately no UPDATE or DELETE policy — feedback is an append-only log,
-- and the service role handles triage.
drop policy if exists "Users can read their own feedback" on public.feedback;
create policy "Users can read their own feedback"
on public.feedback for select to authenticated
using (user_id = (select auth.uid()));

-- Triage query for the dashboard:
--
--   select f.created_at, f.kind, f.message, f.context,
--          d.title, v.name as venue
--   from public.feedback f
--   left join public.deals d on d.id = f.deal_id
--   left join public.venues v on v.id = d.venue_id
--   order by f.created_at desc;
