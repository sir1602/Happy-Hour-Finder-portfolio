/**
 * Mirror of the "Build Console HTML" Code node in the n8n workflow
 * "HH Finder — 4. Review Digest & Approvals".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: every string this node renders was written by a
 * language model reading a stranger's website — deal titles, descriptions,
 * `model_notes`, and the audit `reason` sentences — and every URL it turns into
 * a link came from the same place. The page it builds is then opened by the one
 * person who can publish to the app, in a browser holding their session.
 *
 *   1. TEXT IS ESCAPED. A venue that puts a <script> tag in its own name is
 *      not a hypothetical; a model that copies it into a title is not either.
 *
 *   2. A LINK IS http OR https OR IT IS NOT A LINK. `javascript:` in
 *      deals.source_url, hh_deal_proposals.evidence_url or venues.website would
 *      otherwise be one click from running in the reviewer's browser, and all
 *      three of those columns are written by the pipeline, not by a human.
 *
 *   3. AN EMPTY QUEUE RENDERS. The empty-array trap is this pipeline's
 *      characteristic failure, found three times (n8n-workflows/README.md), and
 *      "nothing to review" is the state this page should be in most of the time.
 *
 *   4. APPROVE IS NOT OFFERED WHERE IT CANNOT WORK. hh_review_deal refuses to
 *      publish a deal whose window the app cannot render, so a queue that shows
 *      a live Approve button on one is offering a click that always fails.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * @param {Array<{json: unknown}>} inputItems Merged output of the three fetch nodes.
 * @param {object} [query] The console webhook's query string.
 * @param {object} [vars] n8n `$vars`.
 */
function buildConsoleHtml(inputItems, query, vars) {
    const q = query || {};
    const APPLY = (vars && vars.HH_REVIEW_APPLY_URL) || 'https://n8n.example.com/webhook/hh-review-apply';
    const CONSOLE =
        (vars && vars.HH_REVIEW_CONSOLE_URL) || 'https://n8n.example.com/webhook/hh-review-queue';

    // Property 1.
    const esc = (v) =>
        String(v === null || v === undefined ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

    // Property 2. Anything that is not plainly http(s) is rendered as text, so a
    // reviewer can still see what the pipeline stored without it being clickable.
    const safeUrl = (v) => {
        const s = typeof v === 'string' ? v.trim() : '';
        return /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
    };
    const link = (url, label, style) => {
        const safe = safeUrl(url);
        if (!safe) return url ? '<span class="dim">' + esc(url) + '</span>' : '';
        return (
            '<a href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer"' +
            (style ? ' class="' + style + '"' : '') + '>' + esc(label) + '</a>'
        );
    };

    const dayLabel = (arr) =>
        Array.isArray(arr) && arr.length && arr.length < 7
            ? arr.map((d) => DAYS[d]).join(', ')
            : Array.isArray(arr) && arr.length === 7
              ? 'Every day'
              : 'No days set';

    const pct = (c) =>
        c === null || c === undefined || c === '' ? 'n/a' : Math.round(Number(c) * 100) + '%';

    const ago = (iso) => {
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return '';
        const days = Math.floor((Date.now() - t) / 86400000);
        if (days <= 0) return 'today';
        if (days === 1) return 'yesterday';
        if (days < 60) return days + ' days ago';
        return Math.floor(days / 30) + ' months ago';
    };

    // ── Sort the merged inputs. Proposals carry a deal_id too, and decisions
    // carry an entity_id, so the order of these tests is load bearing.
    const deals = [];
    const proposals = [];
    const decided = [];
    for (const item of inputItems || []) {
        const j = item && item.json !== undefined ? item.json : item;
        const rows = Array.isArray(j) ? j : [j];
        for (const r of rows) {
            if (!r || typeof r !== 'object') continue;
            if (r.proposal_id !== undefined) proposals.push(r);
            else if (r.audit_id !== undefined) decided.push(r);
            else if (r.deal_id !== undefined) deals.push(r);
        }
    }

    // ── The sitting. `since` is stamped once, when the page is first opened,
    // and carried through every decision — that is what makes the decided panel
    // "what I have done since I sat down" rather than "the last 20 things".
    const since = typeof q.since === 'string' && q.since ? q.since : new Date().toISOString();
    const sort = ['age', 'confidence', 'venue', 'status'].includes(q.sort) ? q.sort : 'age';
    const group = q.group === 'venue' ? 'venue' : 'none';
    const filter = (typeof q.q === 'string' ? q.q : '').trim().toLowerCase();
    const flash = typeof q.flash === 'string' ? q.flash : '';

    const matches = (d) =>
        !filter ||
        [d.title, d.venue_name, d.venue_neighborhood, d.time_window]
            .map((x) => String(x || '').toLowerCase())
            .some((x) => x.includes(filter));

    const shown = deals.filter(matches);
    const shownProposals = proposals.filter(matches);

    const byConfidence = (a, b) =>
        (a.confidence === null || a.confidence === undefined ? 2 : Number(a.confidence)) -
        (b.confidence === null || b.confidence === undefined ? 2 : Number(b.confidence));
    const byVenue = (a, b) => String(a.venue_name || '').localeCompare(String(b.venue_name || ''));
    const byStatus = (a, b) =>
        String(a.verification_status || '').localeCompare(String(b.verification_status || ''));
    if (sort === 'confidence') shown.sort(byConfidence);
    else if (sort === 'venue') shown.sort(byVenue);
    else if (sort === 'status') shown.sort(byStatus);

    // Every form carries the sitting forward, so a decision lands back on the
    // same page with the same filters and a longer decided list.
    const hiddenSince = '<input type="hidden" name="since" value="' + esc(since) + '">';

    const badge = (text, tone) =>
        '<span class="badge ' + tone + '">' + esc(text) + '</span>';

    const statusTone = (s) =>
        s === 'gone' ? 'no' : s === 'conflict' || s === 'unreachable' ? 'warn' : 'info';

    // ── Evidence. This is the block that did not exist before: the reason a row
    // is in the queue, in the pipeline's own words.
    const evidence = (d) => {
        let h = '';
        const notes = Array.isArray(d.review_notes) ? d.review_notes : [];
        if (notes.length) {
            h += '<div class="evidence"><h4>Why it is here</h4><ul>';
            for (const n of notes.slice(0, 5)) {
                h +=
                    '<li><span class="dim">' + esc(ago(n.created_at)) + ' · ' +
                    esc(n.source || '') + ' · ' + esc(n.action || '') + '</span><br>' +
                    esc(n.reason || '(no reason recorded)') + '</li>';
            }
            h += '</ul></div>';
        }
        const issues = Array.isArray(d.open_issues) ? d.open_issues : [];
        if (issues.length) {
            h += '<p class="dim">Open issues: ';
            h += issues
                .map((i) => badge(String(i.issue || '').replace(/_/g, ' '), 'warn'))
                .join(' ');
            h += '</p>';
        }
        const group_ = Array.isArray(d.venue_deals) ? d.venue_deals : [];
        if (group_.length > 1) {
            h += '<div class="evidence"><h4>All ' + group_.length + ' windows at this venue</h4><ul>';
            for (const s of group_) {
                const self = s.deal_id === d.deal_id;
                h +=
                    '<li>' + (self ? '<strong>this one → </strong>' : '') +
                    '<code>' + esc(s.time_window) + '</code> · ' + esc(dayLabel(s.days_active)) +
                    ' <span class="dim">' + esc(s.status || '') + '</span></li>';
            }
            h += '</ul></div>';
        }
        return h;
    };

    const dayBoxes = (selected) => {
        const on = new Set(Array.isArray(selected) ? selected : []);
        let h = '<span class="days">';
        for (let i = 0; i < 7; i++) {
            h +=
                '<label><input type="checkbox" name="days" value="' + i + '"' +
                (on.has(i) ? ' checked' : '') + '> ' + DAYS[i] + '</label>';
        }
        return h + '</span>';
    };

    const dealCard = (d) => {
        const site = link(d.venue_website, 'venue site');
        const src = link(d.source_url, 'source');
        const photo = safeUrl(d.image_url);

        let h = '<article class="card" id="deal-' + esc(d.deal_id) + '">';
        h +=
            '<div class="head"><label class="pick"><input type="checkbox" form="bulk" name="select" value="deal:' +
            esc(d.deal_id) + '"> <strong>' + esc(d.title) + '</strong></label> ';
        if (d.verification_status) h += badge(d.verification_status, statusTone(d.verification_status));
        h += badge('confidence ' + pct(d.confidence), 'info');
        h += badge('via ' + (d.source || 'unknown'), 'info');
        h += '<span class="dim"> ' + esc(ago(d.created_at)) + '</span></div>';

        h +=
            '<p class="dim">' + esc(d.venue_name) +
            (d.venue_neighborhood ? ' · ' + esc(d.venue_neighborhood) : '') +
            (d.venue_address ? ' · ' + esc(d.venue_address) : '') + '</p>';

        const links = [site, src].filter(Boolean).join(' · ');
        if (links) h += '<p>' + links + '</p>';
        // The photo a deal was READ FROM. Evidence for the reviewer, and
        // deliberately not what the app renders on a card.
        if (photo) {
            h +=
                '<p><a href="' + esc(photo) + '" target="_blank" rel="noopener noreferrer">' +
                '<img class="shot" src="' + esc(photo) + '" alt="the photo this deal was read from"></a></p>';
        }
        if (d.description) h += '<p class="desc">' + esc(d.description) + '</p>';

        h += evidence(d);

        h += '<form method="POST" action="' + esc(APPLY) + '" class="edit">';
        h += hiddenSince;
        h += '<input type="hidden" name="deal_id" value="' + esc(d.deal_id) + '">';
        h += '<input type="hidden" name="venue_id" value="' + esc(d.venue_id) + '">';
        h +=
            '<label class="row">Hours <input name="time_window" value="' +
            esc(d.time_window) + '"></label>';
        h += '<div class="row">Days ' + dayBoxes(d.days_active) + '</div>';

        h += '<details><summary>More fields</summary>';
        h += '<label class="row">Title <input name="title" value="' + esc(d.title) + '"></label>';
        h +=
            '<label class="row">Description <textarea name="description" rows="3">' +
            esc(d.description) + '</textarea></label>';
        h +=
            '<label class="row">Tags <input name="tags" value="' +
            esc(Array.isArray(d.tags) ? d.tags.join(', ') : '') + '"></label>';
        h +=
            '<label class="row">Price 1-4 <input name="price_level" type="number" min="1" max="4" value="' +
            esc(d.price_level) + '"></label>';
        h +=
            '<label class="row">Confidence 0-1 <input name="confidence" type="number" step="0.05" min="0" max="1" value="' +
            esc(d.confidence) + '"></label>';
        h +=
            '<label class="row">Source URL <input name="source_url" value="' +
            esc(d.source_url) + '"></label>';
        h += '<fieldset><legend>Venue</legend>';
        h +=
            '<label class="row">Website <input name="venue_website" value="' +
            esc(d.venue_website) + '"></label>';
        h +=
            '<label class="row">Address <input name="venue_address" value="' +
            esc(d.venue_address) + '"></label>';
        h +=
            '<label class="row">Neighborhood <input name="venue_neighborhood" value="' +
            esc(d.venue_neighborhood) + '"></label>';
        h +=
            '<label class="row">Phone <input name="venue_phone" value="' +
            esc(d.venue_phone) + '"></label>';
        h +=
            '<label class="row"><input type="checkbox" name="venue_permanently_closed"' +
            (d.venue_permanently_closed ? ' checked' : '') + '> Permanently closed</label>';
        h += '</fieldset>';
        h += '</details>';

        h += '<label class="row">Note <input name="note" placeholder="why (optional)"></label>';

        // Property 4.
        h += '<div class="actions">';
        if (d.window_ok === false) {
            h +=
                '<button disabled class="ok">Approve</button>' +
                '<span class="warnline">The app cannot read <code>' + esc(d.time_window) +
                '</code>, so approving is refused. Fix the hours and save first.</span> ';
        } else {
            h += '<button type="submit" name="action" value="approve" class="ok">Approve</button> ';
        }
        h += '<button type="submit" name="action" value="reject" class="no">Reject</button> ';
        h += '<button type="submit" name="action" value="save" class="neutral">Save edits</button>';
        h += '</div></form></article>';
        return h;
    };

    const proposalCard = (p) => {
        const prop = p.proposed || {};
        const searched = p.evidence_kind === 'web_search';
        let h = '<article class="card" id="proposal-' + esc(p.proposal_id) + '">';
        h +=
            '<div class="head"><label class="pick"><input type="checkbox" form="bulk" name="select" value="proposal:' +
            esc(p.proposal_id) + '"> <strong>' + esc(p.title) + '</strong></label> ';
        h += badge(searched ? 'web search' : 'venue site', searched ? 'warn' : 'info');
        h += badge(p.proposed_kind === 'new_sibling' ? 'new window' : 'correction', 'info');
        h += badge('confidence ' + pct(prop.confidence), 'info');
        h += '</div>';
        h +=
            '<p class="dim">' + esc(p.venue_name) +
            (p.venue_neighborhood ? ' · ' + esc(p.venue_neighborhood) : '') + '</p>';

        const evLinks = [link(p.venue_website, 'venue site'), link(p.evidence_url, 'evidence')]
            .filter(Boolean)
            .join(' · ');
        if (evLinks) h += '<p>' + evLinks + '</p>';
        if (searched) {
            h +=
                '<p class="warnline">Found by web search, not on the venue’s own site — ' +
                'check the date before approving.</p>';
        }
        if (p.model_notes) h += '<p class="desc">' + esc(p.model_notes) + '</p>';

        h +=
            '<p>now <code>' + esc(p.current_time_window) + '</code> · ' +
            esc(dayLabel(p.current_days_active)) + '<br>proposed <code>' +
            esc(prop.time_window) + '</code> · ' + esc(dayLabel(prop.days_active)) + '</p>';

        h += '<form method="POST" action="' + esc(APPLY) + '" class="edit">';
        h += hiddenSince;
        h += '<input type="hidden" name="proposal_id" value="' + esc(p.proposal_id) + '">';
        h +=
            '<label class="row">Proposed hours <input name="time_window" value="' +
            esc(prop.time_window) + '"></label>';
        h += '<div class="row">Proposed days ' + dayBoxes(prop.days_active) + '</div>';
        h += '<label class="row">Note <input name="note" placeholder="why (optional)"></label>';
        h += '<div class="actions">';
        h += '<button type="submit" name="action" value="approve" class="ok">Approve</button> ';
        h += '<button type="submit" name="action" value="reject" class="no">Reject</button> ';
        h += '<button type="submit" name="action" value="save" class="neutral">Save edits</button>';
        h += '</div></form></article>';
        return h;
    };

    // ── The panel that answers "what have I already done in this sitting".
    const decidedPanel = () => {
        if (!decided.length) {
            return (
                '<p class="dim">Nothing decided yet in this sitting. Decisions you make will ' +
                'be listed here.</p>'
            );
        }
        let h = '<ul class="decided">';
        for (const d of decided) {
            const tone = d.action === 'approve' ? 'ok' : d.action === 'reopen' ? 'info' : 'no';
            h +=
                '<li><span class="badge ' + tone + '">' + esc(d.action) + '</span> ' +
                '<strong>' + esc(d.title) + '</strong> ' +
                '<span class="dim">' + esc(d.venue_name || '') + ' · ' + esc(ago(d.decided_at)) + '</span>';
            if (d.reason) h += '<br><span class="dim">' + esc(d.reason) + '</span>';
            if (d.reopenable && d.entity_type === 'deal') {
                h +=
                    ' <form method="POST" action="' + esc(APPLY) + '" class="inline">' + hiddenSince +
                    '<input type="hidden" name="deal_id" value="' + esc(d.entity_id) + '">' +
                    '<button type="submit" name="action" value="reopen" class="linkish">Undo' +
                    (d.deal_status === 'active' ? ' (unpublishes it)' : '') + '</button></form>';
            }
            h += '</li>';
        }
        return h + '</ul>';
    };

    // ── Page.
    let html = '<!doctype html><html lang="en"><head><meta charset="utf-8">';
    html += '<meta name="viewport" content="width=device-width,initial-scale=1">';
    html += '<meta name="robots" content="noindex,nofollow">';
    // Deliberately NO `<meta name="referrer" content="no-referrer">`. A
    // no-referrer document submits its forms with `Origin: null`, and Chrome then
    // reports the same-origin post as `Sec-Fetch-Site: cross-site` -- which is how
    // the confirm page spent a day refusing its own Approve button. The response
    // sends `Referrer-Policy: same-origin` instead: outbound links to venue sites
    // still leak nothing, and the form post keeps a real Origin for the
    // cross-site check in `Read Apply Request` to compare against.
    html += '<title>Happy Hour Finder — review console</title><style>' +
        'body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#fafaf9;color:#1c1917}' +
        'main{max-width:860px;margin:0 auto;padding:20px 16px 80px}' +
        'h1{font-size:20px;border-bottom:3px solid #f59e0b;padding-bottom:8px}' +
        'h2{font-size:15px;margin:26px 0 8px}h4{font-size:12px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em;color:#57534e}' +
        '.card{background:#fff;border:1px solid #e7e5e4;border-radius:8px;padding:14px;margin:12px 0}' +
        '.head{display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
        '.badge{font-size:11px;padding:1px 6px;border-radius:3px}' +
        '.badge.ok{background:#dcfce7;color:#166534}.badge.no{background:#fee2e2;color:#991b1b}' +
        '.badge.warn{background:#fef3c7;color:#92400e}.badge.info{background:#e0f2fe;color:#075985}' +
        '.dim{color:#57534e;font-size:12px}.desc{font-size:13px}' +
        '.evidence{background:#fafaf9;border-left:3px solid #d6d3d1;padding:8px 10px;margin:8px 0;font-size:12px}' +
        '.evidence ul{margin:0;padding-left:16px}.evidence li{margin-bottom:6px}' +
        '.row{display:block;margin:6px 0;font-size:12px;color:#57534e}' +
        '.row input,.row textarea{display:block;width:100%;box-sizing:border-box;padding:6px;font-size:14px;' +
        'border:1px solid #d6d3d1;border-radius:5px;color:#1c1917;background:#fff}' +
        '.days{display:inline-flex;flex-wrap:wrap;gap:8px}.days label{font-size:13px;color:#1c1917}' +
        '.days input,.pick input{width:auto;display:inline}' +
        'fieldset{border:1px solid #e7e5e4;border-radius:6px;margin:8px 0}legend{font-size:11px;color:#57534e}' +
        '.actions{margin-top:10px}button{border:0;border-radius:5px;padding:8px 14px;font-size:13px;cursor:pointer;color:#fff}' +
        'button.ok{background:#15803d}button.no{background:#b91c1c}button.neutral{background:#57534e}' +
        'button[disabled]{background:#d6d3d1;cursor:not-allowed}' +
        'button.linkish{background:none;color:#0369a1;text-decoration:underline;padding:0;font-size:12px}' +
        '.inline{display:inline}.warnline{color:#92400e;font-size:12px}' +
        '.shot{max-width:260px;border-radius:6px;border:1px solid #e7e5e4}' +
        '.decided li{margin-bottom:8px;font-size:13px}' +
        '.bar{background:#fff;border:1px solid #e7e5e4;border-radius:8px;padding:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
        '.bar input,.bar select{padding:6px;border:1px solid #d6d3d1;border-radius:5px;font-size:13px}' +
        '.flash{background:#dcfce7;border:1px solid #86efac;color:#166534;padding:10px;border-radius:6px;margin:12px 0;font-size:13px}' +
        'code{background:#f5f5f4;padding:1px 4px;border-radius:3px}' +
        '</style></head><body><main>';

    html += '<h1>Happy Hour Finder — review console</h1>';
    if (flash) html += '<p class="flash">' + esc(flash) + '</p>';
    html +=
        '<p class="dim">' + shown.length + ' deal(s) awaiting review · ' + shownProposals.length +
        ' proposed fix(es) · ' + decided.length + ' decided in this sitting.</p>';

    html += '<form method="GET" action="' + esc(CONSOLE) + '" class="bar">' + hiddenSince;
    html += '<input name="q" value="' + esc(filter) + '" placeholder="filter by venue or title">';
    html += '<select name="sort">';
    for (const [value, label] of [
        ['age', 'newest first'],
        ['confidence', 'least confident first'],
        ['venue', 'by venue'],
        ['status', 'by verification status'],
    ]) {
        html +=
            '<option value="' + value + '"' + (sort === value ? ' selected' : '') + '>' + label + '</option>';
    }
    html += '</select>';
    html += '<select name="group">';
    html += '<option value="none"' + (group === 'none' ? ' selected' : '') + '>flat list</option>';
    html += '<option value="venue"' + (group === 'venue' ? ' selected' : '') + '>group by venue</option>';
    html += '</select>';
    html += '<button class="neutral">Apply</button>';
    html += '<a class="dim" href="' + esc(CONSOLE) + '">start a fresh sitting</a>';
    html += '</form>';

    html += '<h2>Decided in this sitting</h2>' + decidedPanel();

    // The bulk form holds no cards — the checkboxes inside each card point at it
    // with form="bulk". Nesting a form inside a form is not legal HTML and the
    // per-card edit forms have to be the real ones.
    html += '<h2>Awaiting your review</h2>';
    if (!shown.length && !shownProposals.length) {
        html +=
            '<p class="dim">' +
            (deals.length || proposals.length
                ? 'Nothing matches that filter.'
                : 'The queue is empty. Nothing is waiting on you.') +
            '</p>';
    } else {
        html += '<form id="bulk" method="POST" action="' + esc(APPLY) + '" class="bar">' + hiddenSince;
        html += '<span class="dim">With the ticked rows:</span> ';
        html += '<button type="submit" name="action" value="batch_approve" class="ok">Approve selected</button> ';
        html += '<button type="submit" name="action" value="batch_reject" class="no">Reject selected</button>';
        html += '</form>';

        if (group === 'venue') {
            const venues = [...new Set(shown.map((d) => d.venue_name))].sort();
            for (const name of venues) {
                html += '<h2>' + esc(name) + '</h2>';
                for (const d of shown.filter((x) => x.venue_name === name)) html += dealCard(d);
            }
        } else {
            for (const d of shown) html += dealCard(d);
        }

        if (shownProposals.length) {
            html += '<h2>Proposed corrections</h2>';
            html +=
                '<p class="dim">Nothing below has been applied. Approving writes the hours to the ' +
                'deal; it does not publish a deal that is not already live.</p>';
            for (const p of shownProposals) html += proposalCard(p);
        }
    }

    html += '</main></body></html>';

    return [
        {
            json: {
                html,
                since,
                pendingCount: deals.length,
                proposalCount: proposals.length,
                decidedCount: decided.length,
            },
        },
    ];
}

// ─────────────────────────────────────────────────────────────────────────────

const deal = (over) => ({
    deal_id: '3405cd3d-d61f-4879-91eb-78194efe5222',
    title: "O'Malley's Happy Hour",
    description: 'Discounted spirits and beer.',
    time_window: '3:00pm - 6:00pm',
    days_active: [5],
    tags: ['Craft Beer'],
    price_level: 2,
    type: 'regular',
    confidence: '1.00',
    source: 'seed',
    source_url: null,
    image_url: null,
    verification_status: 'gone',
    created_at: '2026-03-12T02:20:36.083Z',
    window_ok: true,
    venue_id: 'ac5a429c-9cd9-44ec-b542-c8078d894542',
    venue_name: "O'Malley's Tap and Grill",
    venue_neighborhood: 'West Town (Chicago)',
    venue_address: '1135 W Laurel St',
    venue_website: 'http://www.omalleys.example/',
    venue_phone: null,
    venue_deals: [
        { deal_id: '3405cd3d-d61f-4879-91eb-78194efe5222', time_window: '3:00pm - 6:00pm', days_active: [5], status: 'pending' },
        { deal_id: 'ca024353-19be-4a14-a590-7e23f8c55e06', time_window: '6:00pm - 10:00pm', days_active: [0], status: 'pending' },
    ],
    review_notes: [
        {
            action: 'flag',
            source: 'validation',
            reason: "auto re-validation of O'Malley's Happy Hour (3 page(s) read, no reading matched this deal)",
            created_at: '2026-09-09T09:02:11.135Z',
        },
    ],
    open_issues: [{ issue: 'missing_description', detail: null }],
    ...over,
});

const proposal = (over) => ({
    proposal_id: 'fada6799-9ff1-406b-be44-9f116d20b290',
    deal_id: '3405cd3d-d61f-4879-91eb-78194efe5222',
    proposed_kind: 'correction',
    proposed: { time_window: '4:00 PM - 7:00 PM', days_active: [2, 3], confidence: 0.6 },
    evidence_url: 'https://example.com/evidence',
    evidence_kind: 'web_search',
    model_notes: 'read off a listing page',
    title: "O'Malley's Happy Hour",
    current_time_window: '3:00pm - 6:00pm',
    current_days_active: [5],
    venue_name: "O'Malley's Tap and Grill",
    venue_neighborhood: 'West Town (Chicago)',
    venue_website: 'http://www.omalleys.example/',
    ...over,
});

const decision = (over) => ({
    audit_id: '11111111-1111-1111-1111-111111111111',
    decided_at: new Date().toISOString(),
    entity_type: 'deal',
    entity_id: '5e5788f3-1e71-4070-8dc4-26ef39ba995a',
    action: 'approve',
    title: 'Brick Oven Happy Hour',
    venue_name: 'Brick Oven',
    deal_status: 'active',
    reopenable: true,
    reason: 'looked right',
    ...over,
});

const render = (rows, query) => buildConsoleHtml(rows.map((json) => ({ json })), query, {})[0].json.html;

describe('Build Console HTML — escaping', () => {
    it('escapes a script tag in a model-written title', () => {
        const html = render([deal({ title: '<script>alert(1)</script>' })]);
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('escapes a quote in a value that lands inside an attribute', () => {
        const html = render([deal({ time_window: '4 PM" autofocus onfocus="alert(1)' })]);
        expect(html).not.toContain('onfocus="alert(1)"');
        expect(html).toContain('&quot;');
    });

    it('escapes the audit reason, which is written by a model reading a stranger’s site', () => {
        const html = render([
            deal({ review_notes: [{ action: 'flag', source: 'validation', reason: '<img src=x onerror=alert(1)>' }] }),
        ]);
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('escapes model_notes on a proposal', () => {
        const html = render([proposal({ model_notes: '</p><script>x</script>' })]);
        expect(html).not.toContain('<script>x</script>');
    });
});

describe('Build Console HTML — the origin the forms post with', () => {
    it('does not null its own origin with a no-referrer meta', () => {
        // Re-adding this tag silently disables the cross-site check in
        // `Read Apply Request`, because every post then arrives as `Origin: null`
        // and null has to be allowed (privacy settings and curl produce it too).
        const html = render([deal()]);
        expect(html).not.toContain('name="referrer"');
        expect(html).not.toContain('no-referrer');
    });

    it('still asks not to be indexed', () => {
        const html = render([deal()]);
        expect(html).toContain('name="robots" content="noindex,nofollow"');
    });
});

describe('Build Console HTML — links', () => {
    it('renders an http(s) source as a real link', () => {
        const html = render([deal({ source_url: 'https://example.com/happy-hour' })]);
        expect(html).toContain('href="https://example.com/happy-hour"');
        expect(html).toContain('rel="noopener noreferrer"');
    });

    it('never turns a javascript: URL into a link', () => {
        const html = render([deal({ source_url: 'javascript:alert(1)' })]);
        expect(html).not.toContain('href="javascript:alert(1)"');
        expect(html).toContain('javascript:alert(1)');
    });

    it('never turns a javascript: venue website into a link', () => {
        const html = render([deal({ venue_website: 'javascript:alert(1)' })]);
        expect(html).not.toContain('href="javascript:alert(1)"');
    });

    it('never turns a javascript: evidence URL into a link', () => {
        const html = render([proposal({ evidence_url: 'JavaScript:alert(1)' })]);
        expect(html).not.toMatch(/href="[Jj]ava[Ss]cript:/);
    });

    it('never loads a non-http image as evidence', () => {
        const html = render([deal({ image_url: 'javascript:alert(1)' })]);
        expect(html).not.toContain('<img class="shot" src="javascript:');
    });
});

describe('Build Console HTML — the evidence that was missing', () => {
    it('shows the venue website, which the email never had', () => {
        const html = render([deal()]);
        expect(html).toContain('href="http://www.omalleys.example/"');
        expect(html).toContain('venue site');
    });

    it('shows why the deal is in the queue', () => {
        const html = render([deal()]);
        expect(html).toContain('Why it is here');
        expect(html).toContain('no reading matched this deal');
    });

    it('shows the whole venue group so windows are judged together', () => {
        const html = render([deal()]);
        expect(html).toContain('All 2 windows at this venue');
        expect(html).toContain('6:00pm - 10:00pm');
    });

    it('shows the verification status and the open data issues', () => {
        const html = render([deal()]);
        expect(html).toContain('gone');
        expect(html).toContain('missing description');
    });

    it('shows the photo a deal was read from, when there is one', () => {
        const html = render([deal({ image_url: 'https://example.com/menu.jpg' })]);
        expect(html).toContain('<img class="shot" src="https://example.com/menu.jpg"');
    });
});

describe('Build Console HTML — editing', () => {
    it('gives every deal an edit form pointed at the apply endpoint', () => {
        const html = render([deal()]);
        expect(html).toContain('action="https://n8n.example.com/webhook/hh-review-apply"');
        expect(html).toContain('name="time_window" value="3:00pm - 6:00pm"');
        expect(html).toContain('name="deal_id" value="3405cd3d-d61f-4879-91eb-78194efe5222"');
    });

    it('pre-ticks the days the deal actually runs', () => {
        const html = render([deal({ days_active: [1, 3] })]);
        expect(html).toContain('name="days" value="1" checked');
        expect(html).toContain('name="days" value="3" checked');
        expect(html).toContain('name="days" value="2">');
    });

    it('offers venue fields on the same card', () => {
        const html = render([deal()]);
        expect(html).toContain('name="venue_website"');
        expect(html).toContain('name="venue_phone"');
        expect(html).toContain('name="venue_id" value="ac5a429c-9cd9-44ec-b542-c8078d894542"');
    });

    it('lets a proposal be edited before it is accepted', () => {
        const html = render([proposal()]);
        expect(html).toContain('name="proposal_id"');
        expect(html).toContain('name="time_window" value="4:00 PM - 7:00 PM"');
        expect(html).toContain('name="days" value="2" checked');
    });

    it('offers save as well as approve and reject', () => {
        const html = render([deal()]);
        expect(html).toContain('value="save"');
        expect(html).toContain('value="approve"');
        expect(html).toContain('value="reject"');
    });
});

describe('Build Console HTML — approve is not offered where it cannot work', () => {
    it('disables approve on a window the app cannot read, and says why', () => {
        const html = render([deal({ window_ok: false, time_window: 'happy hour all day' })]);
        expect(html).toContain('<button disabled class="ok">Approve</button>');
        expect(html).toContain('The app cannot read');
        expect(html).not.toContain('name="action" value="approve" class="ok"');
    });

    it('still offers reject and save on that deal', () => {
        const html = render([deal({ window_ok: false })]);
        expect(html).toContain('value="reject"');
        expect(html).toContain('value="save"');
    });
});

describe('Build Console HTML — the sitting', () => {
    it('lists what has already been decided', () => {
        const html = render([deal(), decision()], { since: '2026-09-09T14:00:00.000Z' });
        expect(html).toContain('Decided in this sitting');
        expect(html).toContain('Brick Oven Happy Hour');
    });

    it('offers undo on a decided deal, and warns when undo unpublishes', () => {
        const html = render([decision({ deal_status: 'active' })]);
        expect(html).toContain('value="reopen"');
        expect(html).toContain('Undo (unpublishes it)');
    });

    it('does not offer undo on a decision that cannot be reopened', () => {
        const html = render([decision({ reopenable: false })]);
        expect(html).not.toContain('value="reopen"');
    });

    it('carries `since` into every form so the panel keeps growing', () => {
        const html = render([deal()], { since: '2026-09-09T14:00:00.000Z' });
        const carried = html.match(/name="since" value="2026-09-09T14:00:00.000Z"/g) || [];
        expect(carried.length).toBeGreaterThan(1);
    });

    it('stamps a fresh `since` when the page is opened without one', () => {
        const out = buildConsoleHtml([{ json: deal() }], {}, {})[0].json;
        expect(Date.parse(out.since)).toBeGreaterThan(0);
    });

    it('says so plainly when nothing has been decided yet', () => {
        const html = render([deal()]);
        expect(html).toContain('Nothing decided yet in this sitting');
    });
});

describe('Build Console HTML — filtering, sorting, grouping', () => {
    it('filters by venue name', () => {
        const html = render(
            [deal(), deal({ deal_id: 'aaaaaaaa-1111-1111-1111-111111111111', venue_name: 'Brick Oven', title: 'Brick Oven HH' })],
            { q: 'brick oven' },
        );
        expect(html).toContain('Brick Oven HH');
        expect(html).not.toContain("O'Malley's Happy Hour");
    });

    it('says a filter matched nothing, rather than looking like an empty queue', () => {
        const html = render([deal()], { q: 'zzzz' });
        expect(html).toContain('Nothing matches that filter');
    });

    it('sorts the least confident to the top when asked', () => {
        const html = render(
            [
                deal({ deal_id: 'aaaaaaaa-1111-1111-1111-111111111111', title: 'Confident', confidence: '0.95' }),
                deal({ deal_id: 'bbbbbbbb-1111-1111-1111-111111111111', title: 'Shaky', confidence: '0.30' }),
            ],
            { sort: 'confidence' },
        );
        expect(html.indexOf('Shaky')).toBeLessThan(html.indexOf('Confident'));
    });

    it('groups by venue when asked', () => {
        const html = render(
            [deal(), deal({ deal_id: 'aaaaaaaa-1111-1111-1111-111111111111', venue_name: 'Brick Oven' })],
            { group: 'venue' },
        );
        expect(html).toContain('<h2>Brick Oven</h2>');
        expect(html).toContain('<h2>O&#39;Malley&#39;s Tap and Grill</h2>');
    });
});

describe('Build Console HTML — bulk', () => {
    it('puts the checkboxes outside the edit forms, pointed at the bulk form', () => {
        const html = render([deal()]);
        expect(html).toContain('<form id="bulk"');
        expect(html).toContain('form="bulk" name="select" value="deal:3405cd3d-d61f-4879-91eb-78194efe5222"');
    });

    it('tags a proposal checkbox as a proposal', () => {
        const html = render([proposal()]);
        expect(html).toContain('form="bulk" name="select" value="proposal:fada6799-9ff1-406b-be44-9f116d20b290"');
    });

    it('offers no bulk bar when there is nothing to act on', () => {
        const html = render([]);
        expect(html).not.toContain('<form id="bulk"');
    });
});

describe('Build Console HTML — the empty-array trap', () => {
    it('renders a page when every query came back empty', () => {
        const out = buildConsoleHtml([], {}, {})[0].json;
        expect(out.html).toContain('<!doctype html>');
        expect(out.html).toContain('The queue is empty');
        expect(out.pendingCount).toBe(0);
    });

    it('survives an item whose json is an empty array', () => {
        const out = buildConsoleHtml([{ json: [] }, { json: [] }, { json: [] }], {}, {})[0].json;
        expect(out.html).toContain('The queue is empty');
    });

    it('survives rows arriving as arrays rather than one item each', () => {
        const out = buildConsoleHtml([{ json: [deal(), deal({ deal_id: 'aaaaaaaa-1111-1111-1111-111111111111' })] }], {}, {})[0].json;
        expect(out.pendingCount).toBe(2);
    });

    it('does not mistake a proposal for a pending deal, though it carries a deal_id', () => {
        const out = buildConsoleHtml([{ json: [proposal()] }], {}, {})[0].json;
        expect(out.proposalCount).toBe(1);
        expect(out.pendingCount).toBe(0);
    });

    it('does not mistake a decision for a pending deal', () => {
        const out = buildConsoleHtml([{ json: [decision()] }], {}, {})[0].json;
        expect(out.decidedCount).toBe(1);
        expect(out.pendingCount).toBe(0);
    });

    it('ignores a null row without throwing', () => {
        const out = buildConsoleHtml([{ json: [null, undefined, deal()] }], {}, {})[0].json;
        expect(out.pendingCount).toBe(1);
    });
});
