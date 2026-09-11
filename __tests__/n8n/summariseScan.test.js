/**
 * Mirror of the "Summarise Scan" Code node in the n8n workflow
 * "HH Finder — Area Scan Engine (sub-workflow)".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: this node decides what a scan REPORTS, and every
 * bug it has had has been the same bug — a lost deal counted as a filed one.
 * `POST to Intake API` runs with `neverError`, so a 404 comes back as a normal
 * item; that was fixed by reading `statusCode`. But `neverError` only tames
 * HTTP *replies*. A request that never reaches the network still throws, and
 * `onError=continueRegularOutput` turns it into a bare `{ error }` item with no
 * response on it at all — which fell straight through the undefined-statusCode
 * back-compat path and was counted as `submitted`.
 *
 * That is the worst case to get wrong, because it is not one venue: an auth
 * credential whose HEADER NAME is not a valid HTTP token ("HH Intake Webhook
 * Token", spaces and all, instead of "X-Intake-Token") fails this way on every
 * single post, as ERR_INVALID_HTTP_TOKEN. The run then reports a full sheet of
 * submissions while the database receives nothing.
 */

/**
 * @param {Array<{json: unknown}>} items Everything that reached `Summarise Scan`.
 */
function summariseScan(items) {
    let submitted = 0;
    let skipped = 0;
    let skippedNoModel = 0;
    let failed = 0;
    let active = 0;
    let pending = 0;
    const failureCodes = [];
    const failureReasons = [];

    for (const item of items) {
        const j = item.json ?? {};
        if (j.skipped) {
            skipped += 1;
            if (j.noModel) skippedNoModel += 1;
            continue;
        }

        const code = j.statusCode;
        const body = code === undefined ? j : j.body;

        // A fault before the send: no reply, so no status code, just an error.
        if (code === undefined && j.error !== undefined) {
            failed += 1;
            const e = j.error;
            const why = typeof e === 'string' ? e
                : (e && (e.code || e.message)) ? (e.code || e.message) : 'request failed';
            const reason = String(why).slice(0, 80);
            if (failureReasons.length < 5) failureReasons.push(reason);
            if (failureCodes.length < 5) failureCodes.push(reason);
            continue;
        }

        if (code !== undefined && (code < 200 || code >= 300)) {
            failed += 1;
            if (failureCodes.length < 5) failureCodes.push(code);
            continue;
        }

        submitted += 1;
        const status = body && body.result ? body.result.status : undefined;
        if (status === 'active') active += 1;
        else if (status === 'pending') pending += 1;
    }

    return {
        dryRun: false,
        candidateCount: submitted + skipped + failed,
        submitted: submitted,
        skipped: skipped,
        skippedNoModel: skippedNoModel,
        failedToSubmit: failed,
        failedStatusCodes: failureCodes,
        failedReasons: failureReasons,
        landedActive: active,
        landedPending: pending,
    };
}

/** A post intake accepted, as the node returns it with fullResponse. */
const landed = (status) => ({ json: { statusCode: 200, body: { result: { status } } } });
/** A post intake answered with a non-2xx. */
const rejected = (statusCode) => ({ json: { statusCode, body: { message: 'nope' } } });
/** A post that never left n8n, as onError=continueRegularOutput emits it. */
const threw = (error) => ({ json: { error } });

describe('Summarise Scan — a post that never left n8n is not a submission', () => {
    // The regression this file was added for. ERR_INVALID_HTTP_TOKEN is what
    // Node throws when a header name is not a valid HTTP token, and it is the
    // shape a misconfigured httpHeaderAuth credential arrives in.
    it('counts an ERR_INVALID_HTTP_TOKEN item as failed, not submitted', () => {
        const out = summariseScan([threw({ code: 'ERR_INVALID_HTTP_TOKEN' })]);
        expect(out.submitted).toBe(0);
        expect(out.failedToSubmit).toBe(1);
        expect(out.failedReasons).toEqual(['ERR_INVALID_HTTP_TOKEN']);
        // Carried in both, so WF5's report names the cause without a change.
        expect(out.failedStatusCodes).toEqual(['ERR_INVALID_HTTP_TOKEN']);
    });

    it.each([
        ['an error object with a code', { code: 'ENOTFOUND' }, 'ENOTFOUND'],
        ['an error object with only a message', { message: 'socket hang up' }, 'socket hang up'],
        ['a bare string error', 'ECONNRESET', 'ECONNRESET'],
        ['an error with nothing readable on it', {}, 'request failed'],
    ])('names the cause from %s', (_label, error, expected) => {
        const out = summariseScan([threw(error)]);
        expect(out.failedToSubmit).toBe(1);
        expect(out.failedReasons).toEqual([expected]);
    });

    // The whole point: a credential fault fails every post in the run, and the
    // run must not report a full sheet of submissions.
    it('reports a run where every post threw as entirely failed', () => {
        const out = summariseScan(Array.from({ length: 12 }, () => threw({ code: 'ERR_INVALID_HTTP_TOKEN' })));
        expect(out.submitted).toBe(0);
        expect(out.failedToSubmit).toBe(12);
        expect(out.candidateCount).toBe(12);
        // Capped so a long run does not paste 12 identical codes into the email.
        expect(out.failedReasons).toHaveLength(5);
    });

    it('truncates a long error message rather than mailing a stack trace', () => {
        const out = summariseScan([threw({ message: 'x'.repeat(500) })]);
        expect(out.failedReasons[0]).toHaveLength(80);
    });
});

describe('Summarise Scan — a non-2xx reply is not a submission either', () => {
    it.each([[400], [401], [404], [500]])('counts HTTP %i as failed', (statusCode) => {
        const out = summariseScan([rejected(statusCode)]);
        expect(out.submitted).toBe(0);
        expect(out.failedToSubmit).toBe(1);
        expect(out.failedStatusCodes).toEqual([statusCode]);
        // A status code is a code, not a reason — the two stay distinguishable.
        expect(out.failedReasons).toEqual([]);
    });

    it.each([[200], [201], [204]])('counts HTTP %i as submitted', (statusCode) => {
        const out = summariseScan([{ json: { statusCode, body: {} } }]);
        expect(out.submitted).toBe(1);
        expect(out.failedToSubmit).toBe(0);
    });
});

describe('Summarise Scan — the counts a report is built from', () => {
    it('splits landed deals by the status intake gave them', () => {
        const out = summariseScan([landed('active'), landed('active'), landed('pending')]);
        expect(out.submitted).toBe(3);
        expect(out.landedActive).toBe(2);
        expect(out.landedPending).toBe(1);
    });

    it('separates a skip for want of a model from an ordinary skip', () => {
        const out = summariseScan([
            { json: { skipped: true, noModel: true, name: 'Bistro Nine' } },
            { json: { skipped: true, noModel: false, name: 'Speakeasy' } },
        ]);
        expect(out.skipped).toBe(2);
        expect(out.skippedNoModel).toBe(1);
        expect(out.failedToSubmit).toBe(0);
    });

    it('accounts for every candidate exactly once', () => {
        const out = summariseScan([
            landed('active'),
            landed('pending'),
            rejected(404),
            threw({ code: 'ERR_INVALID_HTTP_TOKEN' }),
            { json: { skipped: true, noModel: true } },
            { json: { skipped: true } },
        ]);
        expect(out).toMatchObject({ submitted: 2, failedToSubmit: 2, skipped: 2, candidateCount: 6 });
    });

    // Back-compat: an item with neither a status code nor an error predates
    // fullResponse and is still read as a success.
    it('treats an item with no statusCode and no error as submitted', () => {
        const out = summariseScan([{ json: { result: { status: 'pending' } } }]);
        expect(out.submitted).toBe(1);
        expect(out.landedPending).toBe(1);
    });

    it('reports an empty run as nothing at all rather than as a failure', () => {
        expect(summariseScan([])).toMatchObject({
            submitted: 0, failedToSubmit: 0, skipped: 0, candidateCount: 0,
        });
    });
});
