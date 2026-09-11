-- ─────────────────────────────────────────────────────────────────────────────
-- Deep Probe (Tier 4) proposals
--
-- Tier 1-3 read a venue's website with plain HTTP. When a site is JS-rendered,
-- dead, or otherwise unreadable, the crawl records `unreachable` and nothing is
-- learned. Tier 4 asks Gemini to fetch the site itself (urlContext) and, failing
-- that, to search for the venue's hours (googleSearch).
--
-- That evidence is weaker than a page we read ourselves: urlContext renders
-- pages we cannot, but googleSearch can surface a 2019 blog post or a review
-- aggregator with no way to tell how stale it is. So Tier 4 gets NO write path
-- to `deals` at all. It can only file a proposal here, which a human approves
-- from the Monday digest. Everything Tier 4 produces is inert until then.
--
-- Depends on: migration_n8n_content_pipeline.sql, migration_metros.sql,
--             migration_hh_days_active_writeback.sql (hh_valid_days_active).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The proposal queue
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.hh_deal_proposals (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid not null references public.deals(id) on delete cascade,
  source        text not null,
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected', 'superseded')),
  -- { time_window, days_active, description, confidence }
  proposed      jsonb not null default '{}'::jsonb,
  evidence_url  text,
  -- 'url_context' (the model read the venue's own site) or 'web_search'
  -- (the model found the hours elsewhere). Shown in the digest, because the
  -- two deserve different amounts of trust.
  evidence_kind text,
  model_notes   text,
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  review_action text
);

-- One open proposal per deal per source: a new one supersedes the old rather
-- than stacking, so the digest never shows two competing corrections for the
-- same deal.
create unique index if not exists hh_deal_proposals_one_pending_idx
  on public.hh_deal_proposals (deal_id, source)
  where status = 'pending';

create index if not exists hh_deal_proposals_status_idx
  on public.hh_deal_proposals (status, created_at desc);

comment on table public.hh_deal_proposals is
  'Corrections proposed by the Tier 4 deep probe. Inert until approved from the digest -- nothing here has touched a deal.';

-- Locked down like content_audit_log: no policies means only service_role
-- (which bypasses RLS) can read or write.
alter table public.hh_deal_proposals enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Filing a proposal
-- ─────────────────────────────────────────────────────────────────────────────

-- Called by the Deep Probe sub-workflow for EVERY attempt, including ones that
-- found nothing. The audit row it always writes is what the sub-workflow counts
-- to enforce its daily budget, so a probe that returned nothing must still be
-- recorded or the budget would not bind.
--
-- This function deliberately never touches public.deals.
create or replace function public.hh_propose_deal_change(
  p_deal_id      uuid,
  p_source       text default 'deep_probe',
  p_proposed     jsonb default '{}'::jsonb,
  p_evidence_url text default null,
  p_evidence_kind text default null,
  p_notes        text default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_deal      public.deals%rowtype;
  v_window    text    := nullif(p_proposed ->> 'time_window', '');
  v_conf      numeric := nullif(p_proposed ->> 'confidence', '')::numeric;
  v_days_ok   boolean;
  v_outcome   text;
  v_changes   jsonb   := '{}'::jsonb;
  v_id        uuid;
begin
  select * into v_deal from public.deals where id = p_deal_id;
  if not found then
    raise exception 'hh_propose_deal_change: deal % not found', p_deal_id using errcode = '22023';
  end if;

  v_days_ok := public.hh_valid_days_active(p_proposed -> 'days_active');

  if v_window is null then
    -- The probe ran and came back with nothing usable. Worth recording: it
    -- spent budget, and a venue that fails Tier 4 twice is a candidate for
    -- deletion rather than another probe.
    v_outcome := 'nothing_found';

  elsif not public.hh_is_valid_time_window(v_window) then
    -- Same rail as everywhere else in the pipeline: a window the app cannot
    -- render never enters the system, not even as something approvable. It goes
    -- to the digest's existing "changes the pipeline refused to apply" section.
    v_outcome := 'rejected_unparseable';
    v_changes := jsonb_build_object('rejected_time_window',
                   jsonb_build_object('kept', v_deal.time_window, 'proposed', v_window));

  else
    -- Supersede rather than stack, so the unique partial index above holds.
    update public.hh_deal_proposals
       set status = 'superseded', reviewed_at = now(), review_action = 'superseded'
     where deal_id = p_deal_id and source = p_source and status = 'pending';

    insert into public.hh_deal_proposals
      (deal_id, source, proposed, evidence_url, evidence_kind, model_notes)
    values
      (p_deal_id, p_source,
       jsonb_build_object(
         'time_window', v_window,
         'days_active', case when v_days_ok then p_proposed -> 'days_active' else null end,
         'description', nullif(p_proposed ->> 'description', ''),
         'confidence',  v_conf),
       nullif(p_evidence_url, ''), nullif(p_evidence_kind, ''), p_notes)
    returning id into v_id;

    v_outcome := 'proposed';
    v_changes := jsonb_build_object('proposed_time_window',
                   jsonb_build_object('current', v_deal.time_window, 'proposed', v_window));
  end if;

  -- Always logged: this row is both the audit trail and the budget counter.
  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, confidence, reason)
  values ('deal', p_deal_id, 'flag', v_changes, p_source, v_conf,
          coalesce(p_notes, 'deep probe: ' || v_outcome));

  return jsonb_build_object(
    'deal_id', p_deal_id,
    'proposal_id', v_id,
    'outcome', v_outcome,
    'title', v_deal.title);
end $$;

comment on function public.hh_propose_deal_change(uuid, text, jsonb, text, text, text) is
  'Files a Tier 4 deep-probe correction for human approval. Never modifies a deal. Always writes one content_audit_log row, which doubles as the probe budget counter.';

revoke all on function public.hh_propose_deal_change(uuid, text, jsonb, text, text, text)
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Approving or rejecting one
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_review_proposal(p_proposal_id uuid, p_action text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_p       public.hh_deal_proposals%rowtype;
  v_deal    public.deals%rowtype;
  v_window  text;
  v_days    int[];
  v_changes jsonb := '{}'::jsonb;
begin
  select * into v_p from public.hh_deal_proposals where id = p_proposal_id;
  if not found then
    raise exception 'hh_review_proposal: proposal % not found', p_proposal_id using errcode = '22023';
  end if;

  -- A second click on the same link is not an error worth showing an error page
  -- for -- the first click already did the work.
  if v_p.status <> 'pending' then
    select * into v_deal from public.deals where id = v_p.deal_id;
    return jsonb_build_object(
      'proposal_id', p_proposal_id, 'action', v_p.review_action,
      'already_reviewed', true, 'title', v_deal.title, 'status', v_p.status);
  end if;

  if p_action not in ('approve', 'reject') then
    raise exception 'hh_review_proposal: unknown action %', p_action using errcode = '22023';
  end if;

  select * into v_deal from public.deals where id = v_p.deal_id;
  if not found then
    raise exception 'hh_review_proposal: deal % no longer exists', v_p.deal_id using errcode = '22023';
  end if;

  if p_action = 'approve' then
    v_window := nullif(v_p.proposed ->> 'time_window', '');

    -- Belt and braces. hh_propose_deal_change already refuses to file an
    -- unparseable window, but this is the function that writes to a live deal,
    -- so it re-checks rather than trusting its own queue.
    if not public.hh_is_valid_time_window(v_window) then
      raise exception 'hh_review_proposal: proposed window %L is not parseable by the app', v_window
        using errcode = '22023';
    end if;

    if public.hh_valid_days_active(v_p.proposed -> 'days_active') then
      select array_agg((e#>>'{}')::int order by (e#>>'{}')::int)
        into v_days
        from jsonb_array_elements(v_p.proposed -> 'days_active') e;
    end if;

    if v_deal.time_window is distinct from v_window then
      v_changes := jsonb_build_object('time_window',
                     jsonb_build_object('from', v_deal.time_window, 'to', v_window));
    end if;
    if v_days is not null and v_deal.days_active is distinct from v_days then
      v_changes := v_changes || jsonb_build_object('days_active',
                     jsonb_build_object('from', to_jsonb(v_deal.days_active), 'to', to_jsonb(v_days)));
    end if;

    -- `status` is deliberately untouched. Approving a correction to the hours
    -- is not the same decision as publishing the deal: an active deal stays
    -- active, and a pending one still needs its own Approve.
    update public.deals
       set time_window         = v_window,
           days_active         = coalesce(v_days, days_active),
           description         = coalesce(nullif(v_p.proposed ->> 'description', ''), description),
           confidence          = coalesce(nullif(v_p.proposed ->> 'confidence', '')::numeric, confidence),
           source_url          = coalesce(nullif(v_p.evidence_url, ''), source_url),
           verification_status = 'verified',
           last_verified_at    = now()
     where id = v_p.deal_id;
  else
    -- Rejected: the deal is untouched, but bump last_verified_at so it rotates
    -- out of the stale queue instead of being re-probed immediately.
    update public.deals set last_verified_at = now() where id = v_p.deal_id;
  end if;

  update public.hh_deal_proposals
     set status = case when p_action = 'approve' then 'approved' else 'rejected' end,
         reviewed_at = now(), review_action = p_action
   where id = p_proposal_id;

  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, reason)
  values ('deal', v_p.deal_id, p_action, v_changes, 'human_review',
          'deep probe proposal ' || p_action || 'd from digest email');

  return jsonb_build_object(
    'proposal_id', p_proposal_id, 'deal_id', v_p.deal_id, 'action', p_action,
    'title', v_deal.title, 'status', v_deal.status::text, 'changes', v_changes);
end $$;

comment on function public.hh_review_proposal(uuid, text) is
  'Approve or reject a Tier 4 deep-probe proposal from the digest. Approving applies the hours but never publishes a deal.';

revoke all on function public.hh_review_proposal(uuid, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. What the digest reads
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.hh_pending_proposals as
select
  p.id            as proposal_id,
  p.deal_id,
  p.source,
  p.proposed,
  p.evidence_url,
  p.evidence_kind,
  p.model_notes,
  p.created_at,
  d.title,
  d.status::text  as deal_status,
  d.time_window   as current_time_window,
  d.days_active   as current_days_active,
  v.name          as venue_name,
  v.neighborhood  as venue_neighborhood,
  v.website       as venue_website
from public.hh_deal_proposals p
join public.deals  d on d.id = p.deal_id
join public.venues v on v.id = d.venue_id
where p.status = 'pending'
order by p.created_at desc;

comment on view public.hh_pending_proposals is
  'Open Tier 4 proposals joined to the deal they would change, for the Monday digest.';
