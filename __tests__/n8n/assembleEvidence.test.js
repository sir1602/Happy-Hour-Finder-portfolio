/**
 * Mirror of the "Assemble Evidence" Code node in the n8n workflow
 * "HH Finder — Site Crawler (sub-workflow)".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * Why this one earned a mirror: it had none, and it decides four things the two
 * callers stake real writes on.
 *
 * 1. `foundHappyHourPage` is the gate on `goneIsCredible` in WF2's Decide
 *    Verdict. If it says true when we never read a happy-hour page, a silent
 *    page can unpublish a live deal.
 * 2. Non-2xx bodies must never become a source. A 404's boilerplate landing in
 *    the evidence is the other way that happens.
 * 3. The character budget. The model sees `pageText` and nothing else, so a
 *    truncation that cuts before the hours is indistinguishable from a venue
 *    that stopped running a happy hour.
 * 4. `bodyLength` and `hasSignal` are reported raw because re-validation and
 *    discovery apply different bars to them. Deciding here would silently
 *    change one of those.
 */

function assembleEvidence(base, items) {
    const strip = (html) => String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, ' ')
        .trim();

    const SIGNAL = /happy hour|drink special|food special|specials|deals/i;

    const focus = (text) => {
        if (text.length <= 4000) return text;
        const needles = new RegExp(SIGNAL.source, 'gi');
        const spans = [];
        let m;
        while ((m = needles.exec(text)) !== null && spans.length < 8) {
            spans.push(text.slice(Math.max(0, m.index - 600), m.index + 900));
        }
        return spans.length ? spans.join(' ... ') : text.slice(0, 4000);
    };

    // On the "no candidates" branch the Pick Deep Pages item flows straight
    // through and carries no `body`, so the deep loop below simply adds nothing.
    const deepUrls = Array.isArray(base.candidates) ? base.candidates : [];

    const sources = [];
    if (base.primaryText) sources.push({ url: base.primaryUrl, text: base.primaryText });
    for (const p of base.preFetched || []) if (p && p.text) sources.push(p);
    deepUrls.forEach((url, i) => {
        const r = items[i];
        // A probed path that 404s is not a page we read; dropping it here keeps
        // its boilerplate from satisfying the happy-hour check the callers apply.
        const ok = r && typeof r.body === 'string' &&
            (r.statusCode === undefined || (r.statusCode >= 200 && r.statusCode < 300));
        const t = ok ? strip(r.body) : '';
        if (t) sources.push({ url, text: t });
    });

    // Split the character budget across sources so one chatty homepage cannot
    // crowd out the page that actually answers the question. Raised with
    // MAX_DEEP so the extra reach does not starve every source down to the floor.
    const BUDGET = 15000;
    const per = Math.max(2000, Math.floor(BUDGET / Math.max(sources.length, 1)));
    const pageText = sources
        .map((s) => '--- SOURCE: ' + s.url + ' ---\n' + focus(s.text).slice(0, per))
        .join('\n\n');

    // Did we actually reach a page that would carry a happy hour, and does it
    // read like one? Re-validation needs this before it may believe a deal is
    // gone. The URL half used to be narrower than Pick Deep Pages' own scoring
    // vocabulary, so a page reached via `menu`, `cocktails` or a neighborhood
    // match could be read in full and still never count as reached.
    //
    // Deliberately NOT bare /events?/: a private-events page that happens to say
    // "specials" must not be what makes a `gone` verdict credible.
    const HH_URL = /happy.?hour|hh-?menu|specials?|deals?|drinks?|cocktails?|happenings?|whats-?on/i;
    const foundHappyHourPage = sources.some(
        (s) => HH_URL.test(s.url) && SIGNAL.test(s.text));

    // Measured on the page text itself, never on the decorated blob -- the
    // "--- SOURCE: ---" headers alone would clear any length threshold.
    const body = sources.map((s) => s.text).join(' ');

    return [{
        json: {
            website: base.website,
            primaryUrl: base.primaryUrl,
            sourcesChecked: sources.map((s) => s.url),
            pagesChecked: sources.length,
            foundHappyHourPage,
            bodyLength: body.length,
            hasSignal: SIGNAL.test(body),
            pageText,
        }
    }];
}

/** Builds the (base, items) pair as Pick Deep Pages and Fetch Deep Pages hand it over. */
const assemble = ({
    website = 'https://tacobar.example',
    primaryUrl = 'https://tacobar.example',
    primaryText = '',
    preFetched = [],
    candidates = [],
    responses = [],
} = {}) => assembleEvidence(
    { website, primaryUrl, primaryText, preFetched, candidates },
    responses,
)[0].json;

const ok = (body) => ({ statusCode: 200, body });

describe('Assemble Evidence — which pages become evidence', () => {
    it('puts the homepage first, then the known page, then the deep pages in order', () => {
        const out = assemble({
            primaryText: 'Taco Bar',
            preFetched: [{ url: 'https://tacobar.example/menu/happy-hour/', text: 'Happy hour 4-6' }],
            candidates: ['https://tacobar.example/specials/', 'https://tacobar.example/drinks/'],
            responses: [ok('<p>Specials</p>'), ok('<p>Drinks</p>')],
        });
        expect(out.sourcesChecked).toEqual([
            'https://tacobar.example',
            'https://tacobar.example/menu/happy-hour/',
            'https://tacobar.example/specials/',
            'https://tacobar.example/drinks/',
        ]);
        expect(out.pagesChecked).toBe(4);
    });

    it('omits the homepage entirely when its body was discarded', () => {
        const out = assemble({
            primaryText: '',
            candidates: ['https://tacobar.example/happy-hour/'],
            responses: [ok('<p>Happy hour 4-6</p>')],
        });
        expect(out.sourcesChecked).toEqual(['https://tacobar.example/happy-hour/']);
    });

    it('returns a usable shape when nothing was read at all', () => {
        const out = assemble({});
        expect(out).toMatchObject({
            sourcesChecked: [], pagesChecked: 0,
            foundHappyHourPage: false, bodyLength: 0, hasSignal: false, pageText: '',
        });
    });

    // The "no candidates" branch wires Pick Deep Pages straight into this node,
    // so the single item it receives is that node's own output, not a response.
    it('adds nothing from the no-candidates branch', () => {
        const out = assemble({
            primaryText: 'Taco Bar',
            candidates: [],
            responses: [{ website: 'https://tacobar.example', candidates: [] }],
        });
        expect(out.sourcesChecked).toEqual(['https://tacobar.example']);
    });

    it('skips a preFetched entry that carries no text', () => {
        const out = assemble({
            primaryText: 'Taco Bar',
            preFetched: [{ url: 'https://tacobar.example/gone/', text: '' }, null],
        });
        expect(out.sourcesChecked).toEqual(['https://tacobar.example']);
    });
});

describe('Assemble Evidence — a response that is not a page', () => {
    it.each([
        ['a 404', { statusCode: 404, body: '<p>Not found — see our happy hour specials</p>' }],
        ['a 500', { statusCode: 500, body: '<p>Server error: specials</p>' }],
        ['a redirect body', { statusCode: 301, body: '<p>Moved — specials</p>' }],
        ['an error item', { error: 'ETIMEDOUT' }],
        ['a non-string body', { statusCode: 200, body: { parsed: true } }],
        ['a missing item', undefined],
        ['an empty body', ok('   ')],
    ])('drops %s rather than counting it as a page read', (_label, res) => {
        const out = assemble({
            candidates: ['https://tacobar.example/happy-hour/'],
            responses: [res],
        });
        expect(out.sourcesChecked).toEqual([]);
        expect(out.pagesChecked).toBe(0);
        expect(out.foundHappyHourPage).toBe(false);
    });

    it('accepts a body with no statusCode at all', () => {
        const out = assemble({
            candidates: ['https://tacobar.example/happy-hour/'],
            responses: [{ body: '<p>Happy hour 4-6</p>' }],
        });
        expect(out.pagesChecked).toBe(1);
    });

    // Fetch Deep Pages emits one item per candidate in order, so a dropped page
    // must not shift the ones after it onto the wrong URL.
    it('keeps url-to-response alignment when a middle page is dropped', () => {
        const out = assemble({
            candidates: [
                'https://tacobar.example/happy-hour/',
                'https://tacobar.example/menus/',
                'https://tacobar.example/specials/',
            ],
            responses: [
                { statusCode: 404, body: 'not found' },
                ok('<p>Dinner menu</p>'),
                ok('<p>Half price drafts</p>'),
            ],
        });
        expect(out.sourcesChecked).toEqual([
            'https://tacobar.example/menus/',
            'https://tacobar.example/specials/',
        ]);
        expect(out.pageText).toContain('--- SOURCE: https://tacobar.example/menus/ ---\nDinner menu');
        expect(out.pageText).toContain('--- SOURCE: https://tacobar.example/specials/ ---\nHalf price drafts');
    });
});

describe('Assemble Evidence — foundHappyHourPage', () => {
    it.each([
        ['a happy-hour path', 'https://tacobar.example/happy-hour/'],
        ['an hh-menu path', 'https://tacobar.example/hh-menu/'],
        ['a specials path', 'https://tacobar.example/specials/'],
        ['a drinks path', 'https://tacobar.example/drinks/'],
        // Widened with Pick Deep Pages' events tier: these used to read in full
        // and still never count as a happy-hour page reached.
        ['a cocktails path', 'https://tacobar.example/cocktails/'],
        ['a happenings path', 'https://rooftoplounge.example/happenings/'],
        ['a whats-on path', 'https://tacobar.example/whats-on/'],
    ])('is true for %s that reads like one', (_label, url) => {
        const out = assemble({ candidates: [url], responses: [ok('<p>Happy hour 4-6 PM</p>')] });
        expect(out.foundHappyHourPage).toBe(true);
    });

    it('is false for a happy-hour URL whose text says nothing of the kind', () => {
        const out = assemble({
            candidates: ['https://tacobar.example/happy-hour/'],
            responses: [ok('<p>Reserve a table for dinner</p>')],
        });
        expect(out.foundHappyHourPage).toBe(false);
    });

    it('is false for a homepage that mentions happy hour but is not one', () => {
        const out = assemble({ primaryText: 'Join us for happy hour!' });
        expect(out.hasSignal).toBe(true);
        expect(out.foundHappyHourPage).toBe(false);
    });

    // The reason bare /events?/ is not in HH_URL: this page must not be what
    // makes a `gone` verdict credible in WF2's Decide Verdict.
    it('is false for a private-events page that happens to say specials', () => {
        const out = assemble({
            candidates: ['https://rooftoplounge.example/private-events/'],
            responses: [ok('<p>Ask about our banquet specials</p>')],
        });
        expect(out.foundHappyHourPage).toBe(false);
    });
});

describe('Assemble Evidence — what the model actually gets', () => {
    it('labels every source with the url it came from', () => {
        const out = assemble({
            primaryText: 'Taco Bar',
            candidates: ['https://tacobar.example/happy-hour/'],
            responses: [ok('<p>4-6 PM</p>')],
        });
        expect(out.pageText).toBe(
            '--- SOURCE: https://tacobar.example ---\nTaco Bar\n\n' +
            '--- SOURCE: https://tacobar.example/happy-hour/ ---\n4-6 PM');
    });

    it('splits the budget across sources rather than letting one crowd the rest out', () => {
        const long = (label) => label + ' ' + 'x'.repeat(9000);
        const out = assemble({
            primaryText: long('home'),
            candidates: ['https://tacobar.example/happy-hour/', 'https://tacobar.example/menus/'],
            responses: [ok(long('hh')), ok(long('menu'))],
        });
        const bodies = out.pageText.split('\n\n').map((block) => block.split('\n')[1]);
        // 15000 / 3 sources = 5000 each, and no source exceeds its share.
        expect(bodies).toHaveLength(3);
        for (const b of bodies) expect(b.length).toBeLessThanOrEqual(5000);
    });

    it('never squeezes a source below the 2000-character floor', () => {
        const long = 'y'.repeat(9000);
        const out = assemble({
            primaryText: long,
            candidates: Array.from({ length: 9 }, (_, i) => 'https://tacobar.example/p' + i),
            responses: Array.from({ length: 9 }, () => ok('<p>' + long + '</p>')),
        });
        const bodies = out.pageText.split('\n\n').map((block) => block.split('\n')[1]);
        expect(bodies).toHaveLength(10);
        for (const b of bodies) expect(b.length).toBe(2000);
    });

    it('windows a long page around the happy-hour mentions instead of cutting at 4000', () => {
        const filler = 'z'.repeat(5000);
        const out = assemble({ primaryText: filler + ' happy hour 4-6 PM ' + filler });
        expect(out.pageText).toContain('happy hour 4-6 PM');
    });

    it('falls back to the first 4000 characters when nothing in the page signals', () => {
        const out = assemble({ primaryText: 'a'.repeat(5000) + 'TAIL' });
        expect(out.pageText).not.toContain('TAIL');
        expect(out.pageText.split('\n')[1]).toHaveLength(4000);
    });
});

describe('Assemble Evidence — bodyLength and hasSignal are reported raw', () => {
    // The two callers disagree about what these mean: re-validation believes a
    // page at 200 characters of anything (or 60 with a signal), discovery only
    // spends a model call at 60 WITH a signal. Deciding here would force one of
    // them to change meaning.
    it('measures length on the page text, not the decorated blob', () => {
        const out = assemble({ primaryText: 'short' });
        expect(out.bodyLength).toBe(5);
        expect(out.pageText.length).toBeGreaterThan(40);
    });

    it('joins every source before testing for a signal', () => {
        const out = assemble({
            primaryText: 'Taco Bar',
            candidates: ['https://tacobar.example/menus/'],
            responses: [ok('<p>Half price deals all week</p>')],
        });
        expect(out.hasSignal).toBe(true);
        expect(out.bodyLength).toBe('Taco Bar Half price deals all week'.length);
    });

    it('reports no signal for a site that never mentions one', () => {
        const out = assemble({ primaryText: 'Reserve a table for dinner' });
        expect(out.hasSignal).toBe(false);
    });
});

describe('Assemble Evidence — the stripped page text', () => {
    it('drops scripts, styles and tags, and decodes the entities that matter', () => {
        const out = assemble({
            candidates: ['https://tacobar.example/happy-hour/'],
            responses: [ok(
                '<html><head><style>.a{color:red}</style><script>var happy="hour";</script></head>' +
                '<body><noscript>Enable JS</noscript>' +
                '<h1>Joe&#39;s&nbsp;Bar</h1><p>Half&amp;half &quot;specials&quot;</p></body></html>')],
        });
        expect(out.pageText.split('\n')[1]).toBe('Joe\'s Bar Half&half "specials"');
    });

    it('passes the website and primaryUrl through untouched', () => {
        const out = assemble({ website: 'https://rooftoplounge.example/', primaryUrl: 'https://rooftoplounge.example/' });
        expect(out.website).toBe('https://rooftoplounge.example/');
        expect(out.primaryUrl).toBe('https://rooftoplounge.example/');
    });
});
