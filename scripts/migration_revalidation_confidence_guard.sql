-- ─────────────────────────────────────────────────────────────────────────────
-- Stop an inconclusive re-validation from restating a deal's confidence.
--
-- Found while diagnosing a production run (WF2, 2026-09-10 09:00 UTC). Rooftop Lounge
-- (1240 N Aspen St) publishes its happy hour on https://rooftoplounge.example/happenings/.
-- The site crawler had no vocabulary for an events page, so it read the
-- homepage and the dinner menu, Gemini answered `deals: []` with
-- `confidence: 0.4`, and Decide Verdict correctly returned `unclear` for both
-- stored deals -- it had learned nothing either way.
--
-- hh_record_verification() then wrote that 0.4 over the stored value anyway:
--
--     confidence = coalesce(v_conf, confidence)
--
-- ran on every verdict, and on `unclear` the p_extracted it receives is the
-- `blank` object, whose only populated field is the model's own confidence.
-- Rooftop Lounge's Mon-Fri 4-6 PM deal went from 0.80 to 0.40 on a run that never found
-- the page carrying it. Corpus-wide the pattern is 148 active/pending deals at
-- verification_status = 'conflict' averaging 0.39, against 0.98 for the 127
-- that verified.
--
-- That is worse than merely useless, because confidence is a gate, not a label:
--
--   * hh_record_verification() itself requires >= 0.80 before it will apply a
--     `changed` window, write days_active, or let a `gone` verdict move a deal
--     to 'pending'. A deal knocked down to 0.4 by a failed crawl is harder to
--     correct on the next run than it was before.
--   * the review console and hh_data_quality_issues sort on it.
--
-- So confidence is now written only by a verdict that actually produced a
-- reading -- 'changed' or 'verified'. Every other outcome leaves it alone;
-- verification_status already carries the news that the run was inconclusive.
--
-- Note this reads v_vstatus, not p_verdict: the two diverge on purpose. A
-- `changed` verdict that fails the 0.80 gate, trips the sibling guard, or would
-- create a collision lands at v_vstatus = 'conflict', and none of those wrote a
-- window either -- so none of them should move confidence.
--
-- Nothing else in the function changes. It is reproduced whole because
-- `create or replace` needs the entire body; diff against
-- scripts/migration_multi_deal_venues_fix_collision.sql to see the one hunk.
--
-- What this does NOT do: repair the rows already overwritten. The prior value
-- is not recoverable from content_audit_log -- that table records the NEW
-- confidence and does not carry the old one in field_changes. Those deals
-- re-earn a real confidence the next time a crawl reaches their page, which is
-- what scripts/requeue_conflict_deals.sql is for.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hh_record_verification(
  p_deal_id uuid,
  p_verdict text,
  p_extracted jsonb default '{}'::jsonb,
  p_source_url text default null,
  p_notes text default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_existing   public.deals%rowtype;
  v_conf       numeric := nullif(p_extracted ->> 'confidence', '')::numeric;
  v_window     text    := nullif(p_extracted ->> 'time_window', '');
  v_window_ok  boolean;
  v_days       int[];
  v_days_ok    boolean;
  v_changes    jsonb   := '{}'::jsonb;
  v_new_status public.deal_status;
  v_vstatus    text;
  v_action     text := 'update';
  v_siblings   int;
  v_wrong      boolean := false;
  v_new_window text;
  v_new_days   int[];
begin
  select * into v_existing from public.deals where id = p_deal_id;
  if not found then
    raise exception 'hh_record_verification: deal % not found', p_deal_id using errcode = '22023';
  end if;

  if p_verdict not in ('confirmed','changed','gone','unreachable','unclear') then
    raise exception 'hh_record_verification: unknown verdict %', p_verdict using errcode = '22023';
  end if;

  v_window_ok := public.hh_is_valid_time_window(v_window);
  v_days_ok   := coalesce(v_conf, 0) >= 0.80
                 and public.hh_valid_days_active(p_extracted -> 'days_active');
  if v_days_ok then
    v_days := public.hh_days_from_jsonb(p_extracted -> 'days_active');
  end if;
  v_new_status := v_existing.status;

  select count(*) into v_siblings
    from public.deals
   where venue_id = v_existing.venue_id
     and id <> p_deal_id
     and status in ('active', 'pending');

  if p_verdict = 'confirmed' then
    v_vstatus := 'verified';

  elsif p_verdict = 'unreachable' then
    -- last_verified_at is still bumped so the deal rotates out of the queue
    -- instead of being retried every run; verification_status carries the truth
    -- that nothing was actually confirmed.
    v_vstatus := 'unreachable';

  elsif p_verdict = 'unclear' then
    v_vstatus := 'conflict';

  elsif p_verdict = 'gone' then
    -- Only a confident reading may pull a deal out of the app. Anything weaker
    -- is a conflict for a human to judge, never a silent unpublish.
    if coalesce(v_conf, 0) >= 0.80 then
      v_new_status := 'pending';
      v_vstatus    := 'gone';
      v_action     := 'flag';
      v_changes    := jsonb_build_object('status',
                        jsonb_build_object('from', v_existing.status::text, 'to', 'pending'));
    else
      v_vstatus := 'conflict';
    end if;

  else
    -- changed
    if v_siblings > 0 then
      if v_days is not null and not (v_days && v_existing.days_active) then
        v_wrong := true;
      elsif v_window_ok and exists (
              select 1
                from public.deals s
               where s.venue_id = v_existing.venue_id
                 and s.id <> p_deal_id
                 and s.status in ('active', 'pending')
                 and public.hh_window_key(s.time_window) is not null
                 and public.hh_window_key(s.time_window) = public.hh_window_key(v_window))
            and public.hh_window_key(v_window)
                is distinct from public.hh_window_key(v_existing.time_window) then
        v_wrong := true;
      end if;
    end if;

    if v_wrong then
      -- Nothing is written. The reading is kept in the audit trail and the row
      -- is flagged so the digest puts it in front of a human, who can see the
      -- whole group at once and decide.
      v_changes := jsonb_build_object('wrong_sibling',
                     jsonb_build_object('kept', v_existing.time_window,
                                        'read', v_window,
                                        'read_days', to_jsonb(v_days),
                                        'stored_days', to_jsonb(v_existing.days_active),
                                        'siblings', v_siblings));
      v_vstatus := 'conflict';
      v_window  := null;
      v_days_ok := false;

    elsif coalesce(v_conf, 0) >= 0.80 and v_window_ok then
      if v_existing.time_window is distinct from v_window then
        v_changes := jsonb_build_object('time_window',
                       jsonb_build_object('from', v_existing.time_window, 'to', v_window));
      end if;
      v_vstatus := 'changed';

    else
      if v_window is not null and not v_window_ok then
        v_changes := jsonb_build_object('rejected_time_window',
                       jsonb_build_object('kept', v_existing.time_window, 'proposed', v_window));
      end if;
      v_vstatus := 'conflict';
      v_window  := null;
    end if;
  end if;

  -- A write must not move this row onto hours a sibling already covers.
  --
  -- The old test asked only whether a sibling shared a DAY, and excused itself
  -- whenever the two rows already shared one -- which made it inert at exactly
  -- the venues that needed it. Bocaditos runs 4-6 PM and 8:30-9:30 PM, both
  -- Sun-Thu; under the old test it had no protection at all, and a venue
  -- running an early and a late happy hour is not a contradiction anyway.
  --
  -- The question now is whether the WOULD-BE state -- window and days together,
  -- since either half can do it -- creates a collision that does not already
  -- exist. A collision that is already there is left alone: this refuses to
  -- make things worse, it does not tidy up.
  v_new_window := case when v_vstatus = 'changed' and v_window_ok and v_window is not null
                       then v_window else v_existing.time_window end;
  v_new_days   := case when v_vstatus in ('changed','verified') and v_days_ok
                       then v_days else v_existing.days_active end;

  if v_siblings > 0
     and (v_new_window is distinct from v_existing.time_window
          or public.hh_sort_days(v_new_days)
             is distinct from public.hh_sort_days(v_existing.days_active))
     and exists (
       select 1
         from public.deals s
        where s.venue_id = v_existing.venue_id
          and s.id <> p_deal_id
          and s.status in ('active', 'pending')
          and public.hh_windows_collide(v_new_window, v_new_days,
                                        s.time_window, s.days_active)
          and not public.hh_windows_collide(v_existing.time_window, v_existing.days_active,
                                            s.time_window, s.days_active)) then
    -- Nothing is written, and the reading is kept for the digest. Replaces any
    -- change already recorded above: none of it is being applied.
    v_changes := jsonb_build_object('rejected_collision',
                   jsonb_build_object('kept_window', v_existing.time_window,
                                      'kept_days', to_jsonb(v_existing.days_active),
                                      'proposed_window', v_new_window,
                                      'proposed_days', to_jsonb(v_new_days),
                                      'reason', 'would overlap another deal at this venue'));
    v_vstatus := 'conflict';
    v_window  := null;
    v_days_ok := false;
  end if;

  -- The days are independent of the window: a window the model confirms can
  -- still sit on the wrong days, so they are applied on any confident reading
  -- that produced them, not only when the window itself moved.
  if v_days_ok and v_vstatus in ('changed','verified')
     and public.hh_sort_days(v_existing.days_active) is distinct from v_days then
    v_changes := v_changes || jsonb_build_object('days_active',
                   jsonb_build_object('from', to_jsonb(v_existing.days_active),
                                      'to',   to_jsonb(v_days)));
  end if;

  update public.deals
     set status              = v_new_status,
         time_window         = case
           when v_vstatus = 'changed' and v_window_ok and v_window is not null then v_window
           else time_window
         end,
         description         = case
           when v_vstatus = 'changed' then coalesce(nullif(p_extracted ->> 'description', ''), description)
           else description
         end,
         days_active         = case
           when v_vstatus in ('changed','verified') and v_days_ok then v_days
           else days_active
         end,
         -- An inconclusive read learned nothing about this deal, so it must not
         -- restate its confidence. See the header: `unclear` used to stamp the
         -- model's own "I could not tell" score over a value a good read earned.
         confidence          = case
           when v_vstatus in ('changed', 'verified') then coalesce(v_conf, confidence)
           else confidence
         end,
         source_url          = coalesce(nullif(p_source_url, ''), source_url),
         last_verified_at    = now(),
         verification_status = v_vstatus
   where id = p_deal_id;

  insert into public.content_audit_log
    (entity_type, entity_id, action, field_changes, source, confidence, reason)
  values ('deal', p_deal_id, v_action, v_changes, 'validation', v_conf,
          coalesce(p_notes, format('verdict=%s -> %s', p_verdict, v_vstatus)));

  return jsonb_build_object(
    'deal_id', p_deal_id,
    'verdict', p_verdict,
    'verification_status', v_vstatus,
    'status', v_new_status,
    'wrong_sibling', v_wrong,
    'changes', v_changes);
end $$;

comment on function public.hh_record_verification(uuid, text, jsonb, text, text) is
  'Applies the outcome of one re-validation pass to a deal, with confidence gating, a sibling guard for multi-deal venues, and an audit entry. Only a verdict that produced a reading may write confidence.';

revoke all on function public.hh_record_verification(uuid, text, jsonb, text, text)
  from public, anon, authenticated;
