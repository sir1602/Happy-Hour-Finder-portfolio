/**
 * Mirror of the "Pick Deep Pages" Code node in the n8n workflow
 * "HH Finder — Site Crawler (sub-workflow)".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * Why this one earned a mirror: until the Site Crawler existed, these ~200
 * lines lived in full in BOTH "2. Daily Deal Re-Validation" and the "Area Scan
 * Engine", and the two copies had already drifted — the engine's `bodyOf` had
 * been refactored around an `okBody` helper the sweep's had not, and only the
 * sweep's knew about a stored `source_url`. Nothing failed when they diverged,
 * because nothing compared them. Now there is one copy, and this is what pins
 * its behaviour.
 *
 * What it decides, in order of how much damage getting it wrong does:
 *
 * 1. Which pages get fetched at all. Everything downstream — the model call,
 *    the verdict, the intake row — can only be as good as the three or four
 *    URLs chosen here. 280 of 342 deals store a bare domain, so if this picks
 *    badly the model reads a homepage and learns nothing.
 * 2. Non-2xx bodies must never count as pages read. A 404's boilerplate landing
 *    in the evidence is how a live deal gets marked `gone`.
 * 3. Same-page-two-hostnames dedupe. The nav links relatively and the sitemap
 *    links absolutely with "www."; without canonicalisation the same page
 *    burns two of the three slots.
 */

function pickDeepPages(plan, responses) {
    const target = plan[0];

    const bodyOf = (kind) => {
        const idx = plan.findIndex((p) => p.fetchKind === kind);
        if (idx < 0) return '';
        const r = responses[idx];
        if (!r || typeof r.body !== 'string') return '';
        if (r.statusCode !== undefined && (r.statusCode < 200 || r.statusCode >= 300)) return '';
        return r.body;
    };

    // This Code sandbox does not expose the WHATWG `URL` global, so links are
    // resolved with plain string handling.
    const parseUrl = (raw) => {
        const m = /^(https?:)\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(String(raw || '').trim());
        if (!m) return null;
        return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), path: m[3] || '/', search: m[4] || '' };
    };
    const resolveUrl = (href, b) => {
        const h = String(href || '').trim();
        if (!h) return null;
        if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return parseUrl(h); // absolute; null for mailto:/tel:
        if (!b) return null;
        if (h.startsWith('//')) return parseUrl(b.scheme + h);
        const noHash = h.split('#')[0];
        if (!noHash) return null;
        const qi = noHash.indexOf('?');
        const path = qi >= 0 ? noHash.slice(0, qi) : noHash;
        const search = qi >= 0 ? noHash.slice(qi) : '';
        if (path.startsWith('/')) return { scheme: b.scheme, host: b.host, path, search };
        const trailing = path.endsWith('/') ? '/' : '';
        const parts = [];
        for (const seg of (b.path.replace(/[^/]*$/, '') + path).split('/')) {
            if (seg === '' || seg === '.') continue;
            if (seg === '..') parts.pop();
            else parts.push(seg);
        }
        return { scheme: b.scheme, host: b.host, path: '/' + parts.join('/') + trailing, search };
    };
    const formatUrl = (u) => u.scheme + '//' + u.host + u.path + u.search;
    const bareHost = (h) => String(h || '').replace(/^www\./i, '').toLowerCase();

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

    const html = bodyOf('page');
    const sitemap = bodyOf('sitemap');
    const knownHtml = bodyOf('known');

    const site = String(target.website || '').trim();
    const base = parseUrl(site);
    const host = base ? bareHost(base.host) : '';

    const WEIGHT = [
        [/happy.?hour|hh-?menu/i, 100],
        [/specials?|deals?|promo/i, 60],
        // Plenty of restaurants file the happy hour under "what's happening"
        // rather than under a menu. Rooftop Lounge's is on /happenings/, which scored zero
        // here and was dropped outright -- see the regression test below.
        [/happenings?|whats-?on|what-?s-?on|events?|calendar/i, 45],
        [/drinks?|cocktails?|bar-?menu/i, 40],
        [/menus?/i, 25],
        [/late.?night/i, 20],
    ];
    const slugScore = (s) => {
        let score = 0;
        for (const [rx, pts] of WEIGHT) if (rx.test(String(s || ''))) score = Math.max(score, pts);
        return score;
    };
    // The other half of the events tier: a private-events page is where a buyout
    // inquiry form lives, not a happy hour. Without this, Rooftop Lounge's /private-events/
    // scores 45 and burns the slot /happenings/ needs.
    const PRIVATE = /private|banquet|wedding|buy.?out|corporate|group.?dining|rental|event.?space/i;
    const SKIP = /\.(jpe?g|png|gif|svg|webp|ico|css|js|pdf|zip|mp4|woff2?)(\?|$)|^(mailto:|tel:|javascript:)/i;

    const hood = String(target.neighborhood || '').replace(/\s*\(.*\)\s*$/, '').trim();
    const hoodRe = hood ? new RegExp(hood.replace(/[^a-z0-9]+/gi, '.?'), 'i') : null;

    const scored = new Map();
    const consider = (rawHref, anchorText) => {
        if (!base || !rawHref || SKIP.test(rawHref)) return;
        const u = resolveUrl(rawHref, base);
        if (!u) return;
        if (bareHost(u.host) !== host) return; // same site only
        u.host = base.host;
        const key = bareHost(u.host) + u.path.replace(/\/+$/, '') + u.search;
        if (key === host) return; // the homepage is already fetched
        const hay = u.path + ' ' + String(anchorText || '');
        let score = slugScore(hay);
        if (score < 60 && PRIVATE.test(hay)) return;
        if (hoodRe && hoodRe.test(hay)) score = score ? score + 30 : 70;
        if (!score) return;
        const prev = scored.get(key);
        if (!prev || prev.score < score) scored.set(key, { url: formatUrl(u), score });
    };

    // Tier 1 -- nav links, read from raw HTML before tags are stripped.
    const aTag = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = aTag.exec(html)) !== null) consider(m[1], m[2].replace(/<[^>]+>/g, ' '));

    // Tier 2 -- the sitemap, which survives a JS-rendered nav.
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
    while ((m = loc.exec(sitemap)) !== null) consider(m[1], '');

    const preFetched = [];
    if (knownHtml) {
        const t = strip(knownHtml);
        if (t) preFetched.push({ url: plan.find((p) => p.fetchKind === 'known').fetchUrl, text: t });
    }

    // ...and keep round 2 off it.
    const dedupeKey = (u) => String(u).replace(/\/+$/, '').toLowerCase();
    const alreadyRead = new Set(preFetched.map((p) => dedupeKey(p.url)));

    const ranked = [...scored.values()]
        .filter((c) => !alreadyRead.has(dedupeKey(c.url)))
        .sort((a, b) => b.score - a.score);
    const candidates = ranked.slice(0, 4).map((c) => c.url);

    // Tier 3 -- conventional paths. PROBES carried /menus/ and /menu/happy-hour/
    // but not /menus/happy-hour/, so a site whose menu index is plural -- Rooftop Lounge's
    // is -- missed its own happy-hour menu by one character.
    const PROBES = ['/happy-hour/', '/menu/happy-hour/', '/menus/happy-hour/',
        '/specials/', '/happenings/', '/menus/'];
    const MAX_DEEP = 6;
    const haveHappyHourPage = ranked.some((c) => c.score >= 100) ||
        preFetched.some((p) => slugScore(p.url) >= 100);
    if (base && !haveHappyHourPage) {
        const seenUrl = new Set([...alreadyRead, ...candidates.map(dedupeKey)]);
        for (const p of PROBES) {
            if (candidates.length >= MAX_DEEP) break;
            const u = formatUrl({ scheme: base.scheme, host: base.host, path: p, search: '' });
            const k = dedupeKey(u);
            if (seenUrl.has(k)) continue;
            seenUrl.add(k);
            candidates.push(u);
        }
    }

    return [{
        json: {
            website: site, primaryUrl: site, primaryText: strip(html),
            preFetched, candidates,
        }
    }];
}

/**
 * Builds the (plan, responses) pair exactly as `Build Fetch Plan` and
 * `Fetch Round 1` hand it over: one plan entry per fetch, one response per
 * plan entry, in the same order.
 */
const crawl = ({ website = 'https://tacobar.example', neighborhood = '', sourceUrl = '', page, sitemap, known } = {}) => {
    const plan = [];
    const responses = [];
    const push = (fetchKind, fetchUrl, res) => {
        plan.push({ website, source_url: sourceUrl, neighborhood, fetchKind, fetchUrl });
        responses.push(res);
    };
    if (sourceUrl) push('known', sourceUrl, known ?? { statusCode: 200, body: '' });
    push('page', website, page ?? { statusCode: 200, body: '' });
    push('sitemap', website + '/sitemap.xml', sitemap ?? { statusCode: 404, body: 'not found' });
    return pickDeepPages(plan, responses)[0].json;
};

const nav = (...links) =>
    '<html><body><nav>' +
    links.map(([href, text]) => `<a href="${href}">${text ?? href}</a>`).join('') +
    '</nav></body></html>';

/** The full tier-3 probe list, in order, on the default fixture site. */
const PROBED = [
    'https://tacobar.example/happy-hour/',
    'https://tacobar.example/menu/happy-hour/',
    'https://tacobar.example/menus/happy-hour/',
    'https://tacobar.example/specials/',
    'https://tacobar.example/happenings/',
    'https://tacobar.example/menus/',
];

const sitemapOf = (...urls) =>
    '<urlset>' + urls.map((u) => `<url><loc>${u}</loc></url>`).join('') + '</urlset>';

describe('Pick Deep Pages — scoring decides what the model gets to read', () => {
    it('ranks a happy-hour page above every other kind', () => {
        const out = crawl({
            page: {
                statusCode: 200,
                body: nav(
                    ['/menus/'],
                    ['/drinks/'],
                    ['/specials/'],
                    ['/happy-hour/']
                ),
            },
        });
        expect(out.candidates[0]).toBe('https://tacobar.example/happy-hour/');
    });

    it('orders the rest specials > drinks > menu', () => {
        const out = crawl({
            page: { statusCode: 200, body: nav(['/menus/'], ['/cocktails/'], ['/deals/']) },
        });
        expect(out.candidates).toEqual([
            'https://tacobar.example/deals/',
            'https://tacobar.example/cocktails/',
            'https://tacobar.example/menus/',
            // Nothing scored 100, so the remaining slots go to the top probes.
            'https://tacobar.example/happy-hour/',
            'https://tacobar.example/menu/happy-hour/',
            'https://tacobar.example/menus/happy-hour/',
        ]);
    });

    it('scores on the anchor text too, not just the slug', () => {
        const out = crawl({
            page: { statusCode: 200, body: nav(['/the-list/', 'Happy Hour']) },
        });
        expect(out.candidates).toContain('https://tacobar.example/the-list/');
    });

    it('fetches at most four discovered pages', () => {
        const out = crawl({
            page: {
                statusCode: 200,
                body: nav(['/happy-hour/'], ['/specials/'], ['/drinks/'], ['/menus/'], ['/late-night/']),
            },
        });
        expect(out.candidates).toHaveLength(4);
    });

    // The regression the neighborhood rule was added for: Taco Bar's happy hour
    // lives on a per-location page whose slug says "location", not "happy-hour",
    // so under slug scoring alone the crawl came back empty-handed.
    it('treats a neighborhood match as evidence in its own right', () => {
        const out = crawl({
            neighborhood: 'Wicker Park',
            page: { statusCode: 200, body: nav(['/location/wicker-park/'], ['/about/']) },
        });
        expect(out.candidates).toContain('https://tacobar.example/location/wicker-park/');
    });

    it('lifts a page that scores on both slug and neighborhood above one that scores on slug alone', () => {
        const out = crawl({
            neighborhood: 'Wicker Park',
            page: { statusCode: 200, body: nav(['/specials/wicker-park/'], ['/specials/']) },
        });
        expect(out.candidates[0]).toBe('https://tacobar.example/specials/wicker-park/');
    });

    it('ignores the parenthetical qualifier stored on suburban neighborhoods', () => {
        const out = crawl({
            website: 'https://arcadebar.example',
            neighborhood: 'Oak Brook (Chicago Suburbs)',
            page: { statusCode: 200, body: nav(['/visit/oak-brook/']) },
        });
        expect(out.candidates).toContain('https://arcadebar.example/visit/oak-brook/');
    });

    // A production run, 2026-09-10. Rooftop Lounge publishes its happy hour on
    // https://rooftoplounge.example/happenings/. Under the old vocabulary that link
    // scored zero on both slug and anchor text and was dropped outright by
    // `if (!score) return`, so the crawl fetched the homepage and the dinner
    // menu, Gemini saw the words "Happy Hour" in a tab strip with no times, and
    // both stored deals were written to `conflict`.
    it('reaches a happy hour published on an events page', () => {
        const out = crawl({
            website: 'https://rooftoplounge.example',
            neighborhood: 'West Loop (Chicago)',
            page: {
                statusCode: 200,
                body: nav(
                    ['/menus/', 'Menus'],
                    ['/happenings/', 'Happenings'],
                    ['/private-events/', 'Private Events'],
                    ['/gallery/', 'Gallery'],
                    ['/about-us/', 'About Us']
                ),
            },
        });
        expect(out.candidates).toContain('https://rooftoplounge.example/happenings/');
        // ...and ranked above the dinner menu, which is where the old crawl stopped.
        expect(out.candidates.indexOf('https://rooftoplounge.example/happenings/'))
            .toBeLessThan(out.candidates.indexOf('https://rooftoplounge.example/menus/'));
    });

    // The events tier has to earn its slot back: /private-events/ matches the
    // same regex and is never where a happy hour lives.
    it.each([
        ['a private events page', '/private-events/', 'Private Events'],
        ['an event spaces page', '/event-spaces/', 'Event Spaces'],
        ['a group dining page', '/group-dining/', 'Group Dining'],
    ])('does not spend a slot on %s', (_label, href, text) => {
        const out = crawl({ page: { statusCode: 200, body: nav([href, text]) } });
        expect(out.candidates).not.toContain('https://tacobar.example' + href);
    });

    // ...but a page that says outright that it carries the happy hour still
    // wins, however the rest of the slug reads.
    it('keeps a private-sounding page that scores on happy hour itself', () => {
        const out = crawl({
            page: { statusCode: 200, body: nav(['/private-events/happy-hour/', 'Happy Hour']) },
        });
        expect(out.candidates).toContain('https://tacobar.example/private-events/happy-hour/');
    });

    it('does not score a page on nothing', () => {
        const out = crawl({ page: { statusCode: 200, body: nav(['/about/'], ['/careers/']) } });
        // Only the tier-3 probes survive; neither /about/ nor /careers/ is among them.
        expect(out.candidates).not.toContain('https://tacobar.example/about/');
        expect(out.candidates).not.toContain('https://tacobar.example/careers/');
    });
});

describe('Pick Deep Pages — URL handling without a URL parser', () => {
    it.each([
        ['a root-relative link', '/happy-hour/', 'https://tacobar.example/happy-hour/'],
        ['an absolute same-site link', 'https://tacobar.example/happy-hour/', 'https://tacobar.example/happy-hour/'],
        ['a protocol-relative link', '//tacobar.example/happy-hour/', 'https://tacobar.example/happy-hour/'],
        ['a relative link', 'happy-hour/', 'https://tacobar.example/happy-hour/'],
        ['a dot-segment link', './happy-hour/', 'https://tacobar.example/happy-hour/'],
        ['a query string', '/menu/?section=happy-hour', 'https://tacobar.example/menu/?section=happy-hour'],
    ])('resolves %s', (_label, href, expected) => {
        const out = crawl({ page: { statusCode: 200, body: nav([href]) } });
        expect(out.candidates).toContain(expected);
    });

    it('drops the fragment but keeps the path', () => {
        const out = crawl({ page: { statusCode: 200, body: nav(['/specials/#drinks']) } });
        expect(out.candidates).toContain('https://tacobar.example/specials/');
    });

    it('never leaves the site', () => {
        const out = crawl({
            page: {
                statusCode: 200,
                body: nav(['https://opentable.com/happy-hour/'], ['https://facebook.com/tacobar/specials/']),
            },
        });
        expect(out.candidates.every((u) => u.startsWith('https://tacobar.example/'))).toBe(true);
    });

    it.each([
        ['mailto:', 'mailto:hello@tacobar.example?subject=happy-hour'],
        ['tel:', 'tel:+13125551234'],
        ['javascript:', 'javascript:openHappyHour()'],
    ])('ignores a %s link', (_label, href) => {
        const out = crawl({ page: { statusCode: 200, body: nav([href]) } });
        expect(out.candidates.some((u) => u.includes('mailto') || u.includes('tel:') || u.includes('javascript'))).toBe(false);
    });

    it.each([
        ['a PDF menu', '/menus/happy-hour.pdf'],
        ['an image', '/img/happy-hour.jpg'],
        ['a stylesheet', '/assets/specials.css'],
        ['a script', '/assets/drinks.js'],
        ['a PDF behind a query string', '/menu.pdf?v=3'],
    ])('skips %s — fetched as text it is noise, not a page', (_label, href) => {
        const out = crawl({ page: { statusCode: 200, body: nav([href]) } });
        expect(out.candidates).not.toContain('https://tacobar.example' + href);
    });

    it('never re-fetches the homepage a nav links back to', () => {
        const out = crawl({
            website: 'https://happyhourbar.example',
            page: { statusCode: 200, body: nav(['/', 'Home'], ['/specials/']) },
        });
        expect(out.candidates).not.toContain('https://happyhourbar.example/');
    });
});

describe('Pick Deep Pages — the sitemap is the way in when the nav is JS-rendered', () => {
    it('finds pages the HTML never linked', () => {
        const out = crawl({
            page: { statusCode: 200, body: '<html><body><div id="root"></div></body></html>' },
            sitemap: { statusCode: 200, body: sitemapOf('https://tacobar.example/menu/happy-hour/') },
        });
        expect(out.candidates).toContain('https://tacobar.example/menu/happy-hour/');
    });

    // The dedupe bug this canonicalisation was written for: the nav links
    // relatively and the sitemap absolutely with "www.", so the same page
    // arrived twice and burned two of the three fetch slots.
    it('counts one page once when the nav and the sitemap spell it differently', () => {
        const out = crawl({
            page: { statusCode: 200, body: nav(['/happy-hour/'], ['/specials/'], ['/drinks/']) },
            sitemap: {
                statusCode: 200,
                body: sitemapOf(
                    'https://www.tacobar.example/happy-hour/',
                    'https://www.tacobar.example/menus/'
                ),
            },
        });
        const happyHour = out.candidates.filter((u) => u.includes('/happy-hour/'));
        expect(happyHour).toHaveLength(1);
        expect(out.candidates).toEqual([
            'https://tacobar.example/happy-hour/',
            'https://tacobar.example/specials/',
            'https://tacobar.example/drinks/',
            'https://tacobar.example/menus/',
        ]);
    });

    it('is ignored when the site does not serve one', () => {
        const out = crawl({
            page: { statusCode: 200, body: nav(['/specials/']) },
            sitemap: { statusCode: 404, body: '<html>404 — not found — see our happy hour</html>' },
        });
        expect(out.candidates).toEqual(expect.arrayContaining(['https://tacobar.example/specials/']));
        expect(out.candidates.length).toBeLessThanOrEqual(6);
    });
});

describe('Pick Deep Pages — tier 3 path probing', () => {
    it('probes the conventional paths when link discovery named no happy-hour page', () => {
        const out = crawl({ page: { statusCode: 200, body: nav(['/about/']) } });
        expect(out.candidates).toEqual(PROBED);
    });

    // Probing is free of model quota but not of time, so a site that already
    // links its happy hour pays nothing for it.
    it('does not probe when a link already scored a happy-hour page', () => {
        const out = crawl({ page: { statusCode: 200, body: nav(['/happy-hour/']) } });
        expect(out.candidates).toEqual(['https://tacobar.example/happy-hour/']);
    });

    it('still probes when the best link only scored on specials', () => {
        const out = crawl({ page: { statusCode: 200, body: nav(['/specials/']) } });
        expect(out.candidates[0]).toBe('https://tacobar.example/specials/');
        expect(out.candidates).toContain('https://tacobar.example/happy-hour/');
    });

    it('never fetches more than six pages in total', () => {
        const out = crawl({
            page: { statusCode: 200, body: nav(['/specials/'], ['/drinks/'], ['/menus/'], ['/late-night/']) },
        });
        expect(out.candidates).toHaveLength(6);
    });

    it('does not probe a path a link already found', () => {
        const out = crawl({ page: { statusCode: 200, body: nav(['/specials/'], ['/menus/']) } });
        const specials = out.candidates.filter((u) => u.endsWith('/specials/'));
        expect(specials).toHaveLength(1);
    });

    it('probes on the site scheme and host, not a hardcoded one', () => {
        const out = crawl({ website: 'http://oldschoolbar.example', page: { statusCode: 200, body: '' } });
        expect(out.candidates[0]).toBe('http://oldschoolbar.example/happy-hour/');
    });
});

describe('Pick Deep Pages — a response that is not a page', () => {
    // The rail that keeps a 404's boilerplate out of the evidence: read as a
    // page it can satisfy the happy-hour check and let a `gone` verdict stand
    // against a deal that is alive.
    it.each([
        ['a 404', 404],
        ['a 500', 500],
        ['a 301 body', 301],
    ])('discards the homepage body on %s', (_label, statusCode) => {
        const out = crawl({
            // `/hh-menu/` scores 100 but is not one of the tier-3 probes, so it
            // can only appear if the discarded body was read.
            page: { statusCode, body: nav(['/hh-menu/']) },
        });
        expect(out.primaryText).toBe('');
        expect(out.candidates).not.toContain('https://tacobar.example/hh-menu/');
        expect(out.candidates).toEqual(PROBED);
    });

    it('accepts a body with no statusCode at all', () => {
        const out = crawl({ page: { body: nav(['/hh-menu/']) } });
        expect(out.candidates).toEqual(['https://tacobar.example/hh-menu/']);
    });

    it.each([
        ['an error item with no body', { error: 'ETIMEDOUT' }],
        ['a non-string body', { statusCode: 200, body: { parsed: true } }],
    ])('survives %s', (_label, res) => {
        const out = crawl({ page: res });
        expect(out.primaryText).toBe('');
        // Still probes, because a site that would not load has told us nothing.
        expect(out.candidates).toEqual(PROBED);
    });

    it('returns a usable shape for a venue with no website at all', () => {
        const out = crawl({ website: '', page: { error: 'invalid URL' } });
        expect(out).toMatchObject({ website: '', primaryUrl: '', primaryText: '', candidates: [] });
    });
});

describe('Pick Deep Pages — the page a previous run already proved', () => {
    it('carries the known page text forward rather than fetching it twice', () => {
        const out = crawl({
            sourceUrl: 'https://tacobar.example/menu/happy-hour/',
            known: { statusCode: 200, body: '<html><body><h1>Happy Hour</h1><p>4 PM - 6 PM</p></body></html>' },
            page: { statusCode: 200, body: nav(['/about/']) },
        });
        expect(out.preFetched).toEqual([
            { url: 'https://tacobar.example/menu/happy-hour/', text: 'Happy Hour 4 PM - 6 PM' },
        ]);
        // Round 2 must not ask for it again: read twice, its text would land in
        // the evidence twice and take a double share of the character budget.
        expect(out.candidates).not.toContain('https://tacobar.example/menu/happy-hour/');
        // And since we already hold a happy-hour page, nothing is probed at all.
        expect(out.candidates).toEqual([]);
    });

    it('drops a link to the known page as well as the probe for it', () => {
        const out = crawl({
            sourceUrl: 'https://tacobar.example/specials/',
            known: { statusCode: 200, body: '<p>Half price drafts</p>' },
            page: { statusCode: 200, body: nav(['/specials/', 'Specials'], ['/drinks/']) },
        });
        expect(out.candidates).not.toContain('https://tacobar.example/specials/');
        expect(out.candidates[0]).toBe('https://tacobar.example/drinks/');
    });

    it('still probes when the known page is not itself a happy-hour page', () => {
        const out = crawl({
            sourceUrl: 'https://tacobar.example/about/',
            known: { statusCode: 200, body: '<p>We have specials</p>' },
            page: { statusCode: 200, body: nav(['/careers/']) },
        });
        expect(out.candidates).toEqual(PROBED);
    });

    it('carries nothing when the known page has gone', () => {
        const out = crawl({
            sourceUrl: 'https://tacobar.example/menu/happy-hour/',
            known: { statusCode: 404, body: 'Page not found' },
            page: { statusCode: 200, body: nav(['/about/']) },
        });
        expect(out.preFetched).toEqual([]);
        // ...and the path is probed again, in case it simply moved.
        expect(out.candidates).toContain('https://tacobar.example/menu/happy-hour/');
    });

    // Discovery has no stored page and sends an empty source_url, so the plan
    // has no `known` leg at all. Everything else must behave identically.
    it('behaves the same when the caller passes no known page', () => {
        const withKnown = crawl({
            sourceUrl: 'https://tacobar.example/menu/happy-hour/',
            known: { statusCode: 404, body: '' },
            page: { statusCode: 200, body: nav(['/specials/']) },
        });
        const without = crawl({ page: { statusCode: 200, body: nav(['/specials/']) } });
        expect(withKnown.candidates).toEqual(without.candidates);
        expect(withKnown.preFetched).toEqual(without.preFetched);
    });
});

describe('Pick Deep Pages — the stripped homepage text', () => {
    it('drops scripts, styles and tags, and decodes the entities that matter', () => {
        const out = crawl({
            page: {
                statusCode: 200,
                body:
                    '<html><head><style>.a{color:red}</style><script>var happy="hour";</script></head>' +
                    '<body><noscript>Enable JS</noscript>' +
                    '<h1>Joe&#39;s&nbsp;Bar</h1><p>Half&amp;half &quot;specials&quot;</p></body></html>',
            },
        });
        expect(out.primaryText).toBe('Joe\'s Bar Half&half "specials"');
    });

    it('reports the site it was given as the primary URL', () => {
        const out = crawl({ website: 'https://tacobar.example', page: { statusCode: 200, body: '<p>hi</p>' } });
        expect(out.primaryUrl).toBe('https://tacobar.example');
        expect(out.website).toBe('https://tacobar.example');
    });
});
