/**
 * Mirror of the "Read Apply Request" Code node in the n8n workflow
 * "HH Finder — 4. Review Digest & Approvals".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: this is the only thing between a form POST and an
 * RPC that writes to a published deal. Three properties matter, and each one is
 * a real hole if it slips.
 *
 *   1. THE WHITELIST. The review console can edit the title and description of
 *      a deal that is about to go live in the app. A field that is not on the
 *      list must not reach the RPC at all — `status`, `venue_id` and
 *      `submitted_by` are all columns a form field could otherwise name.
 *      hh_review_deal_v2 ignores unknown keys too; this is the outer of the two
 *      doors, not the only one.
 *
 *   2. BLANK IS NOT EMPTY. The form posts every input on every submit, so a
 *      reviewer who clears a box — or a browser that autofills one empty —
 *      must not be able to wipe a column. A blank field means "leave it alone".
 *
 *   3. POSTS FROM ANOTHER SITE ARE REFUSED. The console endpoints sit behind n8n
 *      basic auth, and basic auth rides a cross-site request exactly like a
 *      cookie does, so authentication alone is NOT CSRF protection.
 *
 *      This check reads `Origin`, not `Sec-Fetch-Site`. The first version read
 *      Sec-Fetch-Site on the reasoning that "a browser always sets it and a page
 *      cannot suppress it" -- which is false, and broke every real approval for a
 *      day. A page CAN suppress it: a document with `Referrer-Policy:
 *      no-referrer` submits forms with `Origin: null`, and Chrome then reports
 *      that same-origin navigation as `Sec-Fetch-Site: cross-site`. The confirm
 *      page carried exactly that meta tag, so it refused its own button
 *      a production run.
 *
 *      Origin is the classic CSRF signal and behaves correctly: a hostile page
 *      always sends its own real origin, so a mismatch is real evidence. A
 *      missing origin, or the literal string `null`, is NOT evidence of an
 *      attack -- privacy settings, sandboxed frames and in-app browsers all
 *      produce it, and so does curl. Those are allowed; only a positively
 *      identified foreign origin is refused.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every deal field a reviewer may change. Anything else in the body is dropped
// before it can reach PostgREST.
const DEAL_FIELDS = [
    'title',
    'description',
    'time_window',
    'source_url',
    'type',
    'price_level',
    'confidence',
];

// Venue fields are prefixed in the form so they cannot collide with a deal
// field of the same name — `address` is unambiguous, `website` is not.
const VENUE_FIELDS = {
    venue_website: 'website',
    venue_address: 'address',
    venue_neighborhood: 'neighborhood',
    venue_phone: 'phone',
};

/**
 * @param {{body?: object, query?: object, headers?: object}} input The webhook item.
 * @param {object} [vars] n8n `$vars`.
 */
function readApplyRequest(input, vars) {
    const body = (input && input.body) || {};
    const query = (input && input.query) || {};
    const headers = (input && input.headers) || {};

    const SUPABASE = (vars && vars.HH_SUPABASE_URL) || 'https://example-project.supabase.co';
    const CONSOLE =
        (vars && vars.HH_REVIEW_CONSOLE_URL) || 'https://n8n.example.com/webhook/hh-review-queue';

    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    // A blank value is absent, not empty. See property 2 above.
    const field = (k) => str(body[k]) || null;

    const fail = (message) => ({
        json: { ok: false, error: 'invalid request', message, console_url: CONSOLE },
    });

    // ── Property 3. Checked before anything is read out of the body.
    //
    // Compared against this webhook's own host rather than a constant, so it
    // survives the instance being renamed. The fallback only matters if n8n ever
    // stops setting webhookUrl.
    const hostOf = (u) => {
        try {
            return new URL(String(u)).host;
            // Kept as `catch (e)` to match the deployed node character for character,
            // the same way parseMenuExtraction does.
            // eslint-disable-next-line no-unused-vars
        } catch (e) {
            return '';
        }
    };
    const selfHost = hostOf(input && input.webhookUrl) || 'n8n.example.com';
    const origin = String(headers.origin || '').trim();
    if (origin && origin.toLowerCase() !== 'null' && hostOf(origin) !== selfHost) {
        return fail('That request came from another site and was not applied.');
    }

    const action = str(body.action);
    const ACTIONS = ['approve', 'reject', 'save', 'reopen', 'batch_approve', 'batch_reject'];
    if (!ACTIONS.includes(action)) {
        return fail('That request was missing the action, or named one that does not exist.');
    }

    // The console keeps the sitting alive: `since` is stamped when the page is
    // first opened and carried through every decision, so the "decided" panel
    // keeps growing instead of resetting on each redirect.
    const since = str(query.since) || str(body.since) || '';
    const consoleUrl = CONSOLE + (since ? '?since=' + encodeURIComponent(since) : '?since=');

    // ── Bulk. The checkboxes post as `select=deal:<uuid>` / `select=proposal:<uuid>`.
    if (action === 'batch_approve' || action === 'batch_reject') {
        const raw = body.select === undefined ? [] : [].concat(body.select);
        const items = [];
        for (const entry of raw) {
            const [kind, id] = str(entry).split(':');
            if (!UUID.test(id || '')) continue;
            items.push(kind === 'proposal' ? { proposal_id: id } : { deal_id: id });
        }
        if (!items.length) {
            return fail('Nothing was selected, so nothing was applied.');
        }
        return {
            json: {
                ok: true,
                kind: 'batch',
                rpc: 'hh_review_batch',
                url: SUPABASE + '/rest/v1/rpc/hh_review_batch',
                payload: {
                    p_items: items,
                    p_action: action === 'batch_approve' ? 'approve' : 'reject',
                    p_note: field('note') || 'bulk decision from the review console',
                },
                venue: null,
                console_url: consoleUrl,
            },
        };
    }

    const dealId = str(body.deal_id);
    const proposalId = str(body.proposal_id);
    const id = proposalId || dealId;
    if (!UUID.test(id)) {
        return fail('That request was missing the item it applies to.');
    }

    // ── Undo. Always addresses a deal: reopening is what puts a row back in the
    // queue, and a proposal that has already been applied cannot be un-applied.
    if (action === 'reopen') {
        if (!UUID.test(dealId)) {
            return fail('Undo needs the deal it should reopen.');
        }
        return {
            json: {
                ok: true,
                kind: 'reopen',
                rpc: 'hh_reopen_decision',
                url: SUPABASE + '/rest/v1/rpc/hh_reopen_decision',
                payload: { p_deal_id: dealId, p_note: field('note') },
                venue: null,
                console_url: consoleUrl,
            },
        };
    }

    // ── Property 1. Built key by key from a fixed list.
    const edits = {};
    for (const key of DEAL_FIELDS) {
        const value = field(key);
        if (value !== null) edits[key] = value;
    }

    // A number the form got wrong is refused here rather than handed to
    // PostgREST, which answers a bad cast with a type error the result page
    // cannot explain to anyone.
    for (const key of ['price_level', 'confidence']) {
        if (edits[key] !== undefined && !Number.isFinite(Number(edits[key]))) {
            return fail('“' + edits[key] + '” is not a number, so ' + key + ' was not changed.');
        }
    }

    // Day checkboxes. Some form parsers give a bare value for a single check and
    // an array for several, and `days[]` is as likely a key as `days`.
    const rawDays = body.days !== undefined ? body.days : body['days[]'];
    if (rawDays !== undefined) {
        const days = [
            ...new Set(
                []
                    .concat(rawDays)
                    .map((d) => Number(str(d)))
                    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
            ),
        ].sort((a, b) => a - b);
        // An empty day set is refused rather than sent: hh_review_deal_v2 would
        // reject it anyway, and "every day" and "no days" must never be
        // confusable on a form where unchecking everything is one gesture.
        if (!days.length) {
            return fail('A deal needs at least one day. Nothing was changed.');
        }
        edits.days_active = days;
    }

    if (field('tags') !== null) {
        edits.tags = [
            ...new Set(
                field('tags')
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
            ),
        ].sort();
    }

    // ── Venue edits travel separately: they are a different table, a different
    // RPC and a different audit entity, and a venue fix must not be lost just
    // because the deal decision was refused.
    const venueEdits = {};
    for (const [formKey, column] of Object.entries(VENUE_FIELDS)) {
        const value = field(formKey);
        if (value !== null) venueEdits[column] = value;
    }
    if (body.venue_permanently_closed !== undefined) {
        venueEdits.permanently_closed =
            str(body.venue_permanently_closed) === 'on' ||
            str(body.venue_permanently_closed) === 'true';
    }
    const venueId = str(body.venue_id);
    const venue =
        Object.keys(venueEdits).length && UUID.test(venueId)
            ? {
                  rpc: 'hh_update_venue_fields',
                  url: SUPABASE + '/rest/v1/rpc/hh_update_venue_fields',
                  payload: {
                      p_venue_id: venueId,
                      p_edits: venueEdits,
                      p_note: field('note') || 'edited in the review console',
                  },
              }
            : null;

    const isProposal = UUID.test(proposalId);
    const rpc = isProposal ? 'hh_review_proposal_v2' : 'hh_review_deal_v2';

    return {
        json: {
            ok: true,
            kind: isProposal ? 'proposal' : 'deal',
            rpc,
            url: SUPABASE + '/rest/v1/rpc/' + rpc,
            payload: isProposal
                ? { p_proposal_id: proposalId, p_action: action, p_edits: edits, p_note: field('note') }
                : { p_deal_id: dealId, p_action: action, p_edits: edits, p_note: field('note') },
            venue,
            console_url: consoleUrl,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────

const DEAL = '3405cd3d-d61f-4879-91eb-78194efe5222';
const PROPOSAL = 'fada6799-9ff1-406b-be44-9f116d20b290';
const VENUE = 'ac5a429c-9cd9-44ec-b542-c8078d894542';

const post = (body, headers) => readApplyRequest({ body, headers: headers || {} }, {});

describe('Read Apply Request — the whitelist', () => {
    it('passes through only the fields a reviewer is allowed to change', () => {
        const out = post({
            deal_id: DEAL,
            action: 'save',
            title: 'Brick Oven Happy Hour',
            time_window: '4:00 PM - 6:00 PM',
            // None of the rest are review fields.
            status: 'active',
            venue_id: VENUE,
            submitted_by: '00000000-0000-0000-0000-000000000001',
            id: '00000000-0000-0000-0000-000000000002',
        });

        expect(out.json.ok).toBe(true);
        expect(Object.keys(out.json.payload.p_edits).sort()).toEqual(['time_window', 'title']);
        expect(out.json.payload.p_edits.status).toBeUndefined();
        expect(out.json.payload.p_edits.submitted_by).toBeUndefined();
        expect(out.json.payload.p_edits.id).toBeUndefined();
    });

    it('never lets a blank field blank a column', () => {
        const out = post({
            deal_id: DEAL,
            action: 'approve',
            title: '   ',
            description: '',
            source_url: '',
            time_window: '4:00 PM - 6:00 PM',
        });

        expect(out.json.payload.p_edits).toEqual({ time_window: '4:00 PM - 6:00 PM' });
    });

    it('sends no edits at all when the reviewer changed nothing', () => {
        const out = post({ deal_id: DEAL, action: 'approve' });
        expect(out.json.payload.p_edits).toEqual({});
        expect(out.json.payload.p_action).toBe('approve');
    });

    it('refuses a number field that is not a number', () => {
        const out = post({ deal_id: DEAL, action: 'save', price_level: 'cheap' });
        expect(out.json.ok).toBe(false);
        expect(out.json.message).toContain('not a number');
    });
});

describe('Read Apply Request — days', () => {
    it('reads several checked days, sorted and de-duplicated', () => {
        const out = post({ deal_id: DEAL, action: 'save', days: ['3', '1', '1', '5'] });
        expect(out.json.payload.p_edits.days_active).toEqual([1, 3, 5]);
    });

    it('reads a single checked day that arrives as a bare value', () => {
        const out = post({ deal_id: DEAL, action: 'save', days: '2' });
        expect(out.json.payload.p_edits.days_active).toEqual([2]);
    });

    it('reads the days[] spelling too', () => {
        const out = post({ deal_id: DEAL, action: 'save', 'days[]': ['0', '6'] });
        expect(out.json.payload.p_edits.days_active).toEqual([0, 6]);
    });

    it('drops a day outside 0..6 instead of sending it', () => {
        const out = post({ deal_id: DEAL, action: 'save', days: ['2', '9', 'x'] });
        expect(out.json.payload.p_edits.days_active).toEqual([2]);
    });

    it('refuses an empty day set rather than reading it as "every day"', () => {
        const out = post({ deal_id: DEAL, action: 'save', days: [] });
        expect(out.json.ok).toBe(false);
        expect(out.json.message).toContain('at least one day');
    });

    it('leaves the stored days alone when no day field was posted', () => {
        const out = post({ deal_id: DEAL, action: 'approve', title: 'x' });
        expect(out.json.payload.p_edits.days_active).toBeUndefined();
    });
});

describe('Read Apply Request — refusals', () => {
    it('refuses a POST whose Origin is another site, even though basic auth rides along', () => {
        const out = post(
            { deal_id: DEAL, action: 'approve' },
            { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        );
        expect(out.json.ok).toBe(false);
        expect(out.json.message).toContain('another site');
    });

    it('refuses a sibling subdomain, which is a different host', () => {
        const out = post(
            { deal_id: DEAL, action: 'approve' },
            { origin: 'https://evil.example.com', 'sec-fetch-site': 'same-site' },
        );
        expect(out.json.ok).toBe(false);
    });

    it('allows the console’s own form POST', () => {
        const out = post(
            { deal_id: DEAL, action: 'approve' },
            { origin: 'https://n8n.example.com', 'sec-fetch-site': 'same-origin' },
        );
        expect(out.json.ok).toBe(true);
    });

    // The regression. This is the exact header shape a production run
    // recorded from a real phone, on a same-origin form post that the old check
    // refused: the page's own no-referrer policy nulled the origin, and Chrome
    // then called it cross-site.
    it('allows a null Origin reported as cross-site — a page can do that to itself', () => {
        const out = post(
            { deal_id: DEAL, action: 'approve' },
            {
                origin: 'null',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-dest': 'document',
            },
        );
        expect(out.json.ok).toBe(true);
    });

    it('allows a request with no Origin at all, so curl still works', () => {
        const out = post({ deal_id: DEAL, action: 'approve' });
        expect(out.json.ok).toBe(true);
    });

    it('compares against the webhook’s own host, not a hardcoded one', () => {
        const onOtherHost = (headers) =>
            readApplyRequest(
                {
                    body: { deal_id: DEAL, action: 'approve' },
                    query: {},
                    headers,
                    webhookUrl: 'https://n8n-staging.example.com/webhook/hh-review-apply',
                },
                {},
            );
        expect(onOtherHost({ origin: 'https://n8n-staging.example.com' }).json.ok).toBe(true);
        expect(onOtherHost({ origin: 'https://n8n.example.com' }).json.ok).toBe(false);
    });

    it('refuses a bad uuid before it can reach PostgREST', () => {
        const out = post({ deal_id: 'not-a-uuid', action: 'approve' });
        expect(out.json.ok).toBe(false);
        expect(out.json.message).toContain('missing the item');
    });

    it('refuses an action that is not one of the six', () => {
        const out = post({ deal_id: DEAL, action: 'delete' });
        expect(out.json.ok).toBe(false);
        expect(out.json.message).toContain('action');
    });

    it('always answers with a console URL, so even a refusal can be shown in place', () => {
        const out = post({ action: 'nonsense' });
        expect(out.json.console_url).toContain('hh-review-queue');
    });
});

describe('Read Apply Request — routing', () => {
    it('sends a deal to hh_review_deal_v2', () => {
        const out = post({ deal_id: DEAL, action: 'approve' });
        expect(out.json.rpc).toBe('hh_review_deal_v2');
        expect(out.json.payload.p_deal_id).toBe(DEAL);
    });

    it('sends a proposal to hh_review_proposal_v2, even when a deal_id rides along', () => {
        const out = post({ deal_id: DEAL, proposal_id: PROPOSAL, action: 'approve' });
        expect(out.json.rpc).toBe('hh_review_proposal_v2');
        expect(out.json.payload.p_proposal_id).toBe(PROPOSAL);
        expect(out.json.payload.p_deal_id).toBeUndefined();
    });

    it('sends an undo to hh_reopen_decision', () => {
        const out = post({ deal_id: DEAL, action: 'reopen', note: 'changed my mind' });
        expect(out.json.rpc).toBe('hh_reopen_decision');
        expect(out.json.payload).toEqual({ p_deal_id: DEAL, p_note: 'changed my mind' });
    });

    it('builds a batch out of the checked rows and keeps the two kinds apart', () => {
        const out = post({
            action: 'batch_approve',
            select: ['deal:' + DEAL, 'proposal:' + PROPOSAL, 'deal:junk'],
        });
        expect(out.json.rpc).toBe('hh_review_batch');
        expect(out.json.payload.p_items).toEqual([{ deal_id: DEAL }, { proposal_id: PROPOSAL }]);
        expect(out.json.payload.p_action).toBe('approve');
    });

    it('refuses a batch with nothing selected', () => {
        const out = post({ action: 'batch_reject', select: [] });
        expect(out.json.ok).toBe(false);
        expect(out.json.message).toContain('Nothing was selected');
    });
});

describe('Read Apply Request — venue edits', () => {
    it('splits venue fields into their own call, unprefixed', () => {
        const out = post({
            deal_id: DEAL,
            venue_id: VENUE,
            action: 'save',
            venue_website: 'https://brickoven.example/',
            venue_phone: '+1 312 555 0100',
            title: 'Brick Oven Happy Hour',
        });

        expect(out.json.payload.p_edits).toEqual({ title: 'Brick Oven Happy Hour' });
        expect(out.json.venue.rpc).toBe('hh_update_venue_fields');
        expect(out.json.venue.payload.p_venue_id).toBe(VENUE);
        expect(out.json.venue.payload.p_edits).toEqual({
            website: 'https://brickoven.example/',
            phone: '+1 312 555 0100',
        });
    });

    it('makes no venue call when no venue field was touched', () => {
        const out = post({ deal_id: DEAL, venue_id: VENUE, action: 'approve', title: 'x' });
        expect(out.json.venue).toBeNull();
    });

    it('makes no venue call when the venue fields have no venue to write to', () => {
        const out = post({ deal_id: DEAL, action: 'save', venue_website: 'https://example.com' });
        expect(out.json.venue).toBeNull();
    });

    it('reads the permanently-closed checkbox as a real boolean', () => {
        const on = post({
            deal_id: DEAL,
            venue_id: VENUE,
            action: 'save',
            venue_permanently_closed: 'on',
        });
        expect(on.json.venue.payload.p_edits.permanently_closed).toBe(true);
    });
});

describe('Read Apply Request — the sitting', () => {
    it('carries `since` through so the decided panel keeps growing', () => {
        const out = readApplyRequest(
            {
                body: { deal_id: DEAL, action: 'approve' },
                query: { since: '2026-09-09T14:00:00.000Z' },
                headers: {},
            },
            {},
        );
        expect(out.json.console_url).toContain('since=2026-09-09T14%3A00%3A00.000Z');
    });

    it('takes `since` from the form when it is not in the query', () => {
        const out = post({ deal_id: DEAL, action: 'approve', since: '2026-09-09T14:00:00.000Z' });
        expect(out.json.console_url).toContain('since=2026-09-09T14%3A00%3A00.000Z');
    });
});
