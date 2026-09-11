/**
 * Mirror of the "Probe Result" Code node in the n8n workflow
 * "HH Finder — Deep Probe (Tier 4 fallback)".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: this is the last node in the sub-workflow, and
 * the only thing WF2 ever sees. Every distinction the probe drew earlier has to
 * survive it, because there is nowhere downstream to recover one that does not.
 *
 * Two did not. `Parse Probe Reply` carefully separates "the model answered and
 * found nothing" from "the model refused to answer" — then this node discarded
 * the flag and reported whatever hh_propose_deal_change said, which for both
 * cases is `nothing_found`. Executions 803, 883 and 885 are the proof: three
 * real probes, three Gemini 429s, three `nothing_found` results telling WF2
 * those venues have no happy hour. WF2's `deepProbe.failed` counter — which
 * exists for exactly this — could never fire. Separately, a filing that got no
 * HTTP response at all fell through to the success path and reported
 * `unknown`, losing a finding the probe had already paid for.
 */

/**
 * @param {Array<{json: unknown}>} items Output of `Skip Probe` or `File Proposal`.
 * @param {object} [parseCtx] The `Parse Probe Reply` item, i.e. `$('Parse Probe Reply').first().json`.
 */
function probeResult(items, parseCtx) {
  const out = [];
  for (const item of items) {
    const j = item.json ?? {};

    if (j.probed === false) {
      out.push({
        probed: false,
        outcome: 'skipped',
        deal_id: j.deal_id,
        title: j.title,
        notes: j.notes,
        probesUsedToday: j.probesUsedToday,
        probeCap: j.probeCap,
      });
      continue;
    }

    // Only reachable on the File Proposal path, where Parse Probe Reply has
    // run. The HTTP node replaces the item with its response, so the deal's
    // identity and the parser's verdict have to be read back from the node that
    // holds them rather than from $json.
    const ctx = parseCtx ?? {};

    // File Proposal sends the full response and never throws on a status, so a
    // failed RPC is visible here rather than being counted as a filed proposal.
    // statusCode is absent ONLY when there was no response at all — a timeout,
    // a DNS failure, or the error item onError=continueRegularOutput emits.
    const code = j.statusCode;
    if (code === undefined || code < 200 || code >= 300) {
      const why =
        code === undefined
          ? String((j.error && j.error.message) || j.error || 'no response from Supabase')
          : 'HTTP ' + code;
      out.push({
        probed: true,
        outcome: 'file_failed',
        statusCode: code === undefined ? null : code,
        deal_id: ctx.deal_id,
        title: ctx.title,
        notes: 'proposal could not be filed: ' + why.slice(0, 160),
      });
      continue;
    }

    // A model failure is never a finding. hh_propose_deal_change cannot tell
    // one from a genuine "no happy hour here": both arrive as an empty proposal
    // and both come back `nothing_found`.
    if (ctx.modelFailed === true) {
      out.push({
        probed: true,
        outcome: 'model_failed',
        deal_id: ctx.deal_id,
        title: ctx.title,
        notes: ctx.notes,
      });
      continue;
    }

    const rpc = Array.isArray(j.body) ? j.body[0] : j.body;

    out.push({
      probed: true,
      outcome: (rpc && rpc.outcome) || 'unknown',
      deal_id: (rpc && rpc.deal_id) || ctx.deal_id,
      proposal_id: (rpc && rpc.proposal_id) || null,
      title: (rpc && rpc.title) || ctx.title,
      notes: ctx.notes,
    });
  }
  return out;
}

/**
 * Mirror of the outcome accounting in WF2's `Summarise Run`, so the two ends of
 * the contract are checked against each other rather than each against its own
 * idea of the other. Copied from "HH Finder — 2. Daily Deal Re-Validation"
 *.
 */
function summariseProbeOutcomes(results) {
  const probe = {
    attempted: 0,
    proposed: 0,
    nothingFound: 0,
    refusedUnparseable: 0,
    notProbed: 0,
    failed: 0,
  };
  for (const j of results) {
    if (j.probed === undefined) continue;
    if (j.probed) {
      probe.attempted += 1;
      if (j.outcome === 'proposed') probe.proposed += 1;
      else if (j.outcome === 'nothing_found') probe.nothingFound += 1;
      else if (j.outcome === 'rejected_unparseable') probe.refusedUnparseable += 1;
      else probe.failed += 1;
    } else {
      probe.notProbed += 1;
    }
  }
  return probe;
}

const DEAL = { deal_id: '0168dd52-ccdb-44cb-bea5-21902f5539bb', title: 'The Rabbit Hole Happy Hour' };

/** The `Parse Probe Reply` item for a probe that produced a real reading. */
const parsedFinding = {
  ...DEAL,
  probed: true,
  proposed: { time_window: '4 PM - 6 PM', days_active: [1, 2], description: null, confidence: 0.8 },
  evidence_url: 'https://example.com/hh',
  evidence_kind: 'url_context',
  notes: 'deep probe via url_context: hours read',
};

/** The `Parse Probe Reply` item for a call Gemini refused — a production run. */
const parsedModelFailure = {
  ...DEAL,
  probed: true,
  proposed: null,
  evidence_url: null,
  evidence_kind: null,
  notes: 'deep probe: model call failed: The service is receiving too many requests from you',
  modelFailed: true,
};

/** How `File Proposal` returns a 2xx, with fullResponse on. */
const rpcOk = (outcome, extra = {}) => [
  {
    json: {
      statusCode: 200,
      body: { deal_id: DEAL.deal_id, title: DEAL.title, outcome, proposal_id: null, ...extra },
    },
  },
];

describe('Probe Result — a model failure is never a finding', () => {
  // The regression this file was added for. Reproduced from a production run:
  // Gemini returned a 429, hh_propose_deal_change was still called with an
  // empty proposal, and the RPC answered `nothing_found` because it has no way
  // to know why the proposal was empty.
  it('reports a refused Gemini call as model_failed, not nothing_found', () => {
    const [r] = probeResult(rpcOk('nothing_found'), parsedModelFailure);
    expect(r.outcome).toBe('model_failed');
    expect(r.probed).toBe(true);
  });

  it('carries the real error forward instead of guessing at it', () => {
    const [r] = probeResult(rpcOk('nothing_found'), parsedModelFailure);
    expect(r.notes).toMatch(/too many requests/);
  });

  it('still names the deal, so a failure can be traced back to one', () => {
    const [r] = probeResult(rpcOk('nothing_found'), parsedModelFailure);
    expect(r.deal_id).toBe(DEAL.deal_id);
    expect(r.title).toBe(DEAL.title);
  });

  // The distinction only matters if it survives into WF2's tally, where
  // `nothingFound` is read as evidence about venues and `failed` as evidence
  // about the pipeline.
  it('lands in WF2 deepProbe.failed, not deepProbe.nothingFound', () => {
    const probe = summariseProbeOutcomes(probeResult(rpcOk('nothing_found'), parsedModelFailure));
    expect(probe).toMatchObject({ attempted: 1, failed: 1, nothingFound: 0, proposed: 0 });
  });

  it('a genuine "no happy hour here" is still nothing_found', () => {
    const probe = summariseProbeOutcomes(probeResult(rpcOk('nothing_found'), { ...DEAL, probed: true, notes: 'deep probe: no happy hour found for this venue' }));
    expect(probe).toMatchObject({ attempted: 1, nothingFound: 1, failed: 0 });
  });
});

describe('Probe Result — a filing that never got an answer is a filing failure', () => {
  // File Proposal runs with fullResponse always on, so a missing statusCode
  // means there was no response at all. That used to fall through to the
  // success path, where `rpc.outcome` is undefined, and report `unknown`.
  it.each([
    ['an error item from onError=continueRegularOutput', { error: 'ETIMEDOUT' }],
    ['an error object', { error: { message: 'socket hang up' } }],
    ['an empty item', {}],
  ])('reports %s as file_failed', (_label, payload) => {
    const [r] = probeResult([{ json: payload }], parsedFinding);
    expect(r.outcome).toBe('file_failed');
    expect(r.statusCode).toBeNull();
  });

  it('says what went wrong rather than reporting a bare unknown', () => {
    const [r] = probeResult([{ json: { error: { message: 'socket hang up' } } }], parsedFinding);
    expect(r.notes).toBe('proposal could not be filed: socket hang up');
  });

  it('names the deal whose finding was lost', () => {
    const [r] = probeResult([{ json: { error: 'ETIMEDOUT' } }], parsedFinding);
    expect(r.deal_id).toBe(DEAL.deal_id);
    expect(r.title).toBe(DEAL.title);
  });

  it.each([400, 401, 404, 500, 503])('reports HTTP %i as file_failed with the status', (code) => {
    const [r] = probeResult([{ json: { statusCode: code, body: { message: 'nope' } } }], parsedFinding);
    expect(r.outcome).toBe('file_failed');
    expect(r.statusCode).toBe(code);
    expect(r.notes).toBe('proposal could not be filed: HTTP ' + code);
    expect(r.deal_id).toBe(DEAL.deal_id);
  });

  it('counts as a failure in WF2, never as a proposal', () => {
    const probe = summariseProbeOutcomes(probeResult([{ json: { statusCode: 500, body: {} } }], parsedFinding));
    expect(probe).toMatchObject({ attempted: 1, failed: 1, proposed: 0 });
  });
});

describe('Probe Result — the outcomes that mean the probe worked', () => {
  it('passes a filed proposal through with its id', () => {
    const [r] = probeResult(rpcOk('proposed', { proposal_id: 'prop-9' }), parsedFinding);
    expect(r).toMatchObject({
      probed: true,
      outcome: 'proposed',
      deal_id: DEAL.deal_id,
      proposal_id: 'prop-9',
      title: DEAL.title,
    });
  });

  it('passes a window the pipeline refused through as its own outcome', () => {
    const [r] = probeResult(rpcOk('rejected_unparseable'), parsedFinding);
    expect(r.outcome).toBe('rejected_unparseable');
    expect(summariseProbeOutcomes([r]).refusedUnparseable).toBe(1);
  });

  it('unwraps a PostgREST array body', () => {
    const items = [{ json: { statusCode: 200, body: [{ deal_id: DEAL.deal_id, outcome: 'proposed', proposal_id: 'p1', title: DEAL.title }] } }];
    expect(probeResult(items, parsedFinding)[0].outcome).toBe('proposed');
  });

  it('falls back to the parser context when the RPC body says nothing', () => {
    const [r] = probeResult([{ json: { statusCode: 200, body: {} } }], parsedFinding);
    expect(r.outcome).toBe('unknown');
    expect(r.deal_id).toBe(DEAL.deal_id);
    expect(r.title).toBe(DEAL.title);
  });
});

describe('Probe Result — the skip branch', () => {
  const skipped = (notes, extra = {}) => [
    { json: { deal_id: DEAL.deal_id, title: DEAL.title, probed: false, proposed: null, outcome: 'skipped', notes, probesUsedToday: 3, probeCap: 3, ...extra } },
  ];

  it('reports a refusal without consulting the parser at all', () => {
    // Parse Probe Reply never ran on this path, so nothing here may read it.
    const [r] = probeResult(skipped('daily deep-probe budget spent (3/3)'), undefined);
    expect(r).toMatchObject({
      probed: false,
      outcome: 'skipped',
      deal_id: DEAL.deal_id,
      title: DEAL.title,
      notes: 'daily deep-probe budget spent (3/3)',
      probesUsedToday: 3,
      probeCap: 3,
    });
  });

  it('counts as notProbed in WF2, never as an attempt', () => {
    const probe = summariseProbeOutcomes(probeResult(skipped('venue has no usable website to probe'), undefined));
    expect(probe).toMatchObject({ notProbed: 1, attempted: 0, failed: 0 });
  });

  it('carries a null budget through when the count could not be read', () => {
    const [r] = probeResult(skipped('deep-probe budget could not be read, so the probe was refused', { probesUsedToday: null }), undefined);
    expect(r.probesUsedToday).toBeNull();
  });
});
