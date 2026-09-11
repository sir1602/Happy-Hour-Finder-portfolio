/**
 * Mirror of the "Build Failure Email" Code node in the n8n workflow
 * "HH Finder — Failure Alert (error workflow)".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: this node is the whole reason anybody finds out a
 * scheduled run broke, so the failure that matters is a mail that arrives
 * saying nothing.
 *
 * n8n hands an Error Trigger two different payload shapes. A node that threw
 * mid-run carries `execution`; a trigger that could not start at all carries
 * `trigger` instead, with no execution id and no node name. Reading only
 * `execution` sends a blank email for the second kind — which is the kind you
 * most want, because a schedule that never fired leaves no other trace.
 *
 * The other rail is escaping. The error message can carry a fragment of a page
 * the pipeline just crawled, and it is interpolated straight into HTML.
 */

/** @param {Array<{json: unknown}>} items Output of the Error Trigger. */
function buildFailureEmail(items) {
    const j = items[0].json ?? {};
    const wf = j.workflow ?? {};
    const ctx = j.execution ?? j.trigger ?? {};
    const err = ctx.error ?? {};

    const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const workflowName = String(wf.name || 'unknown workflow').trim();
    const nodeName = String(ctx.lastNodeExecuted || '').trim();
    const message = String(err.message || err.description || 'no error message was given').trim();
    const mode = String(ctx.mode || 'unknown');
    const url = String(ctx.url || '').trim();

    const subject = 'HH Finder failed: ' + workflowName + (nodeName ? ' — ' + nodeName : '');

    const rows = [
        ['Workflow', workflowName],
        ['Failed at', nodeName || 'before any node ran'],
        ['Error', message.slice(0, 600)],
        ['Run mode', mode],
        ['Execution', ctx.id ? String(ctx.id) : 'none — the trigger itself failed'],
        ['Detected', new Date().toISOString()],
    ];

    const html =
        '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1b1416;line-height:1.5">' +
        '<h2 style="margin:0 0 6px;font-size:18px">' + esc(workflowName) + ' failed</h2>' +
        '<p style="margin:0 0 18px;color:#a3232b">' + esc(message.slice(0, 600)) + '</p>' +
        '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">' +
        rows.map((r) =>
            '<tr><td style="color:#8c7c80;white-space:nowrap;vertical-align:top">' + esc(r[0]) +
            '</td><td style="color:#1b1416">' + esc(r[1]) + '</td></tr>').join('') +
        '</table>' +
        (url ? '<p style="margin:18px 0 0"><a href="' + esc(url) + '">Open this execution in n8n</a></p>' : '') +
        '<p style="margin:22px 0 0;font-size:13px;color:#8c7c80">' +
        'Sent by the shared failure alert workflow, which every HH Finder workflow points its ' +
        'errorWorkflow setting at. Production runs only — a manual test run does not send this, ' +
        'and this alert cannot report its own failure.' +
        '</p></div>';

    return [{
        json: {
            subject, html, workflowName, node: nodeName, message, executionUrl: url,
        }
    }];
}

/** The shape n8n sent for the real smoke test, a production run. */
const nodeThrew = (overrides = {}) => [{
    json: {
        workflow: { id: 'ETlvwZGiR3YEGOdf', name: 'HH Finder — 2. Daily Deal Re-Validation' },
        execution: {
            id: '898',
            url: 'https://n8n.example.com/workflow/example-workflow-id/executions/1',
            mode: 'trigger',
            lastNodeExecuted: 'Fetch Stalest Deals',
            error: { name: 'NodeApiError', message: 'The service refused the connection' },
        },
        ...overrides,
    },
}];

/** The shape n8n sends when the trigger itself could not start. */
const triggerFailed = () => [{
    json: {
        workflow: { id: 'example-workflow-id', name: 'HH Finder — 4. Review Digest & Approvals' },
        trigger: { mode: 'trigger', error: { message: 'Cron expression is invalid' } },
    },
}];

describe('Build Failure Email — both Error Trigger shapes', () => {
    it('reads a node that threw mid-run', () => {
        const out = buildFailureEmail(nodeThrew())[0].json;
        expect(out.workflowName).toBe('HH Finder — 2. Daily Deal Re-Validation');
        expect(out.node).toBe('Fetch Stalest Deals');
        expect(out.message).toBe('The service refused the connection');
        expect(out.executionUrl).toContain('/executions/1');
    });

    // The case that would otherwise send a blank mail — and the one that most
    // needs to arrive, because a schedule that never fired leaves no other trace.
    it('reads a trigger that never started', () => {
        const out = buildFailureEmail(triggerFailed())[0].json;
        expect(out.workflowName).toBe('HH Finder — 4. Review Digest & Approvals');
        expect(out.message).toBe('Cron expression is invalid');
        expect(out.subject).toContain('Review Digest');
        expect(out.html).toContain('Cron expression is invalid');
    });

    it('says so plainly when there is no node to name', () => {
        const out = buildFailureEmail(triggerFailed())[0].json;
        expect(out.node).toBe('');
        expect(out.html).toContain('before any node ran');
        expect(out.html).toContain('the trigger itself failed');
    });

    it('omits the execution link when there is no execution', () => {
        const out = buildFailureEmail(triggerFailed())[0].json;
        expect(out.executionUrl).toBe('');
        expect(out.html).not.toContain('<a href');
    });
});

describe('Build Failure Email — the subject is what gets read on a phone', () => {
    it('names the workflow and the node it stopped at', () => {
        const out = buildFailureEmail(nodeThrew())[0].json;
        expect(out.subject).toBe(
            'HH Finder failed: HH Finder — 2. Daily Deal Re-Validation — Fetch Stalest Deals'
        );
    });

    it('drops the trailing dash when no node is named', () => {
        const out = buildFailureEmail(triggerFailed())[0].json;
        expect(out.subject).toBe('HH Finder failed: HH Finder — 4. Review Digest & Approvals');
        expect(out.subject.endsWith('—')).toBe(false);
    });
});

describe('Build Failure Email — never send an empty alert', () => {
    it.each([
        ['an empty payload', [{ json: {} }]],
        ['a payload with only a workflow', [{ json: { workflow: { name: 'Something' } } }]],
        ['an execution with no error object', [{ json: { workflow: { name: 'X' }, execution: { id: '1' } } }]],
    ])('still produces a subject and a body for %s', (_label, items) => {
        const out = buildFailureEmail(items)[0].json;
        expect(out.subject).toContain('HH Finder failed:');
        expect(out.html.length).toBeGreaterThan(200);
        expect(out.message.length).toBeGreaterThan(0);
    });

    it('names the workflow as unknown rather than blank', () => {
        const out = buildFailureEmail([{ json: {} }])[0].json;
        expect(out.workflowName).toBe('unknown workflow');
        expect(out.message).toBe('no error message was given');
    });

    it('falls back to description when the error carries no message', () => {
        const items = [{ json: { workflow: { name: 'X' }, execution: { error: { description: 'quota exhausted' } } } }];
        expect(buildFailureEmail(items)[0].json.message).toBe('quota exhausted');
    });
});

describe('Build Failure Email — the error text is untrusted', () => {
    // The pipeline crawls venue websites, and a failure message can carry a
    // fragment of whatever came back.
    it('escapes markup out of the error message', () => {
        const items = nodeThrew();
        items[0].json.execution.error.message = '<img src=x onerror="alert(1)"> & "quoted"';
        const out = buildFailureEmail(items)[0].json;
        expect(out.html).not.toContain('<img');
        expect(out.html).toContain('&lt;img');
        expect(out.html).toContain('&amp;');
        expect(out.html).toContain('&quot;');
    });

    it('escapes the workflow name too', () => {
        const items = nodeThrew({ workflow: { name: '<b>bold</b>' } });
        expect(buildFailureEmail(items)[0].json.html).not.toContain('<b>bold</b>');
    });

    it('escapes a hostile execution url rather than emitting it raw', () => {
        const items = nodeThrew();
        items[0].json.execution.url = 'https://x/"><script>alert(1)</script>';
        const out = buildFailureEmail(items)[0].json;
        expect(out.html).not.toContain('<script>');
    });

    it('caps a runaway error message', () => {
        const items = nodeThrew();
        items[0].json.execution.error.message = 'y'.repeat(5000);
        const out = buildFailureEmail(items)[0].json;
        expect(out.html.length).toBeLessThan(3000);
    });
});
