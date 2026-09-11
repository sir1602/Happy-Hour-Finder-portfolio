/**
 * Mirror of the "Budget Check" Code node in the n8n workflow
 * "HH Finder — Deep Probe (Tier 4 fallback)".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: this is the only thing standing between the
 * pipeline and unbounded spend on its most expensive call — one Gemini request
 * with web tooling attached, out of the same free-tier pool everything else
 * draws on.
 *
 * It used to fail OPEN. `Count Probes Today` runs with
 * onError=continueRegularOutput and alwaysOutputData, so a failed query arrived
 * as an item carrying no rows — indistinguishable from a genuine count of zero.
 * A Supabase blip therefore lifted the daily cap silently. The node now
 * reads the full HTTP response, and the tests below fix the rule that came out
 * of that: a budget check that cannot see the budget refuses.
 */

/**
 * @param {Array<{json: unknown}>} countItems Output of `Count Probes Today`.
 * @param {object} deal The `Probe Request` item for the deal being probed.
 * @param {object} [vars] n8n `$vars`.
 */
function budgetCheck(countItems, deal, vars) {
    // 10/24h. No longer the binding constraint: WF2 fetches 10 deals a night
    // and only the ones the crawler could not read at all reach Tier 4, so the
    // supply of work runs out before the budget does.
    const CAP = Number(vars?.HH_DEEP_PROBE_DAILY_CAP) || 10;

    // hh_propose_deal_change writes one content_audit_log row per attempt the
    // model answered, including attempts that found nothing. That row IS the
    // counter: counting proposals instead would let a run of fruitless probes
    // spend the whole quota while appearing to have used none of it.
    //
    // A call the API REFUSED is a different thing and is deliberately not in
    // the query this reads: File Proposal files those under source
    // `deep_probe_failed`, so a 429 or a timeout costs nothing and does not
    // read as a probe that was spent.
    let counted = false;
    let used = 0;

    for (const item of countItems) {
        const j = item.json ?? {};
        const code = j.statusCode;

        // A usable answer always carries a 2xx and an array body. Everything
        // else — a 4xx/5xx, an error item, or the empty item alwaysOutputData
        // emits when the request died outright — leaves `counted` false and is
        // refused below. An empty array is NOT that case: it is a successful
        // read of zero rows.
        if (code === undefined || code < 200 || code >= 300) continue;
        if (!Array.isArray(j.body)) continue;

        for (const r of j.body) if (r && r.id) used += 1;
        counted = true;
    }

    const website = String(deal.website || '').trim();
    let refuse = null;
    if (!/^https?:\/\//i.test(website)) refuse = 'venue has no usable website to probe';
    else if (!counted) refuse = 'deep-probe budget could not be read, so the probe was refused';
    else if (used >= CAP) refuse = 'daily deep-probe budget spent (' + used + '/' + CAP + ')';

    return {
        deal_id: deal.deal_id,
        title: deal.title,
        time_window: deal.time_window,
        venue_name: deal.venue_name,
        venue_address: deal.venue_address,
        venue_neighborhood: deal.venue_neighborhood,
        website: website,
        probesUsedToday: counted ? used : null,
        probeCap: CAP,
        budgetKnown: counted,
        mayProbe: refuse === null,
        refusedBecause: refuse,
    };
}

const dealFixture = (overrides = {}) => ({
    deal_id: 'f261474c-1702-47f1-bd4c-f1c073c689f7',
    title: 'Arcade Bar Happy Hour',
    time_window: '4:00pm - 7:00pm',
    venue_name: 'Arcade Bar',
    venue_address: '2310 Oakbrook Center, Oak Brook, IL 60523, USA',
    venue_neighborhood: 'Oak Brook (Chicago Suburbs)',
    website: 'https://www.arcadebar.example/',
    ...overrides,
});

/**
 * A successful count of `n` prior probes, as the HTTP node now returns it.
 * `Count Probes Today` filters on `source=eq.deep_probe`, so refused calls
 * (filed as `deep_probe_failed`) never appear in this body in the first place.
 */
const okCount = (n) => [
    { json: { statusCode: 200, body: Array.from({ length: n }, (_, i) => ({ id: 'row-' + i })) } },
];

describe('Budget Check — a budget it cannot read is a refusal', () => {
    // The regression this file was added for.
    it.each([
        ['a 500 from PostgREST', { statusCode: 500, body: { message: 'boom' } }],
        ['a 401 from PostgREST', { statusCode: 401, body: { message: 'bad key' } }],
        ['an error item from onError=continueRegularOutput', { error: 'ETIMEDOUT' }],
        ['the empty item alwaysOutputData emits', {}],
    ])('refuses on %s', (_label, payload) => {
        const out = budgetCheck([{ json: payload }], dealFixture());
        expect(out.mayProbe).toBe(false);
        expect(out.budgetKnown).toBe(false);
        expect(out.refusedBecause).toContain('could not be read');
        // Never report a number nobody actually counted.
        expect(out.probesUsedToday).toBeNull();
    });

    it('refuses when the node produced no items at all', () => {
        const out = budgetCheck([], dealFixture());
        expect(out.mayProbe).toBe(false);
        expect(out.budgetKnown).toBe(false);
    });

    // The case that must NOT be confused with the ones above: a successful
    // read that legitimately found nothing. Getting this wrong deadlocks the
    // probe permanently, because the only thing that writes a deep_probe row is
    // a probe that got past this node.
    it('permits on a successful read of zero rows', () => {
        const out = budgetCheck(okCount(0), dealFixture());
        expect(out.mayProbe).toBe(true);
        expect(out.budgetKnown).toBe(true);
        expect(out.probesUsedToday).toBe(0);
        expect(out.refusedBecause).toBeNull();
    });
});

describe('Budget Check — the daily cap', () => {
    it.each([
        [0, true],
        [1, true],
        [8, true],
        [9, true],
        [10, false],
        [11, false],
    ])('with %i probes used today, mayProbe is %s', (used, expected) => {
        const out = budgetCheck(okCount(used), dealFixture());
        expect(out.mayProbe).toBe(expected);
        expect(out.probesUsedToday).toBe(used);
    });

    it('names the spend when it refuses', () => {
        const out = budgetCheck(okCount(10), dealFixture());
        expect(out.refusedBecause).toBe('daily deep-probe budget spent (10/10)');
    });

    // The variable overrides the fallback in both directions — a lower cap has
    // to bite, or there would be no way to throttle Tier 4 without an edit.
    it('honours HH_DEEP_PROBE_DAILY_CAP above the fallback', () => {
        const out = budgetCheck(okCount(12), dealFixture(), { HH_DEEP_PROBE_DAILY_CAP: 20 });
        expect(out.probeCap).toBe(20);
        expect(out.mayProbe).toBe(true);
    });

    it('honours HH_DEEP_PROBE_DAILY_CAP below the fallback', () => {
        const out = budgetCheck(okCount(5), dealFixture(), { HH_DEEP_PROBE_DAILY_CAP: 4 });
        expect(out.probeCap).toBe(4);
        expect(out.mayProbe).toBe(false);
    });

    it('falls back to 10 when the variable is unset or unusable', () => {
        expect(budgetCheck(okCount(0), dealFixture(), {}).probeCap).toBe(10);
        expect(budgetCheck(okCount(0), dealFixture(), { HH_DEEP_PROBE_DAILY_CAP: 'x' }).probeCap).toBe(10);
        expect(budgetCheck(okCount(0), dealFixture(), undefined).probeCap).toBe(10);
    });

    // `Number(...) || CAP` treats 0 as unset, so the variable cannot be used to
    // stop probing. Pinned because it is the obvious thing to reach for, and it
    // silently does the opposite: disable `Run Deep Probe` in WF2 instead.
    it('cannot be switched off by setting the variable to 0', () => {
        expect(budgetCheck(okCount(0), dealFixture(), { HH_DEEP_PROBE_DAILY_CAP: 0 }).probeCap).toBe(10);
    });

    it('ignores rows that carry no id', () => {
        const out = budgetCheck([{ json: { statusCode: 200, body: [{ id: 'a' }, {}, null] } }], dealFixture());
        expect(out.probesUsedToday).toBe(1);
    });
});

describe('Budget Check — a venue with nothing to read', () => {
    it.each([
        ['an empty website', ''],
        ['a null website', null],
        ['a non-http scheme', 'ftp://example.com'],
        ['a bare hostname', 'example.com'],
    ])('refuses %s before spending anything', (_label, website) => {
        const out = budgetCheck(okCount(0), dealFixture({ website }));
        expect(out.mayProbe).toBe(false);
        expect(out.refusedBecause).toBe('venue has no usable website to probe');
    });

    it.each([
        ['http', 'http://example.com'],
        ['https', 'https://example.com/'],
    ])('accepts a %s website', (_label, website) => {
        expect(budgetCheck(okCount(0), dealFixture({ website })).mayProbe).toBe(true);
    });

    // The website check runs first: with no site there is nothing to probe
    // whatever the budget says, and that is the more useful thing to report.
    it('reports the missing website even when the budget is also unreadable', () => {
        const out = budgetCheck([{ json: {} }], dealFixture({ website: '' }));
        expect(out.refusedBecause).toBe('venue has no usable website to probe');
    });
});

describe('Budget Check — the deal is carried through untouched', () => {
    it('passes every field the probe needs on to the model prompt', () => {
        const deal = dealFixture();
        const out = budgetCheck(okCount(0), deal);
        expect(out).toMatchObject({
            deal_id: deal.deal_id,
            title: deal.title,
            time_window: deal.time_window,
            venue_name: deal.venue_name,
            venue_address: deal.venue_address,
            venue_neighborhood: deal.venue_neighborhood,
            website: deal.website,
        });
    });

    it('trims a website with stray whitespace', () => {
        const out = budgetCheck(okCount(0), dealFixture({ website: '  https://example.com  ' }));
        expect(out.website).toBe('https://example.com');
        expect(out.mayProbe).toBe(true);
    });
});
