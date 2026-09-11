/**
 * Mirror of the "Extract Artwork Candidate" Code node in the n8n workflow
 * "HH Finder — 6. Venue Artwork Backfill".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: this node decides what picture ends up on a deal
 * card, from HTML nobody here controls. Two things make it worth a mirror.
 *
 * The n8n Code sandbox has no WHATWG `URL` global (README, "Code sandbox
 * constraints"), so every relative `og:image` — and most of them are relative —
 * has to be resolved by hand. Getting that wrong does not throw; it writes a
 * plausible-looking URL that 404s, into a column the app renders.
 *
 * And `Fetch Venue Homepage` sends the full response with neverError, so a
 * transport failure arrives with NO statusCode at all. Reading that as success
 * would hand this node an undefined body and record a venue as "checked, no
 * artwork" for thirty days on the strength of a DNS blip.
 */

/**
 * @param {Array<{json: unknown}>} pageItems Output of `Fetch Venue Homepage`.
 * @param {{venue_id: string, name: string, website: string}} venue The row from
 *   `Fetch Venues Needing Artwork` this fetch was for.
 */
function extractArtworkCandidate(pageItems, venue) {
    const miss = (outcome) => ({
        venue_id: venue.venue_id,
        name: venue.name,
        website: venue.website,
        imageUrl: null,
        sourceUrl: null,
        outcome,
    });

    const response = Array.isArray(pageItems) && pageItems.length > 0 ? pageItems[0].json : null;

    // No statusCode means the request never completed — DNS, TLS, timeout. Not
    // a page that turned out to have no picture on it.
    if (!response || typeof response.statusCode !== 'number') return miss('fetch_failed');
    if (response.statusCode < 200 || response.statusCode >= 300) return miss('fetch_failed');

    const html = typeof response.body === 'string' ? response.body : '';
    if (!html) return miss('fetch_failed');

    // The page we actually landed on, which is what a relative URL is relative
    // to. A venue whose site redirects http -> https -> www is the normal case,
    // and resolving against the pre-redirect address builds a dead link.
    const base = typeof response.url === 'string' && response.url ? response.url : venue.website;

    const candidate =
        firstMeta(html, ['og:image', 'og:image:secure_url', 'og:image:url']) ||
        firstMeta(html, ['twitter:image', 'twitter:image:src']) ||
        firstLinkRel(html, ['apple-touch-icon', 'apple-touch-icon-precomposed']);

    if (!candidate) return miss('no_candidate');

    const resolved = resolveUrl(candidate, base);
    if (!resolved) return miss('no_candidate');

    return {
        venue_id: venue.venue_id,
        name: venue.name,
        website: venue.website,
        imageUrl: resolved,
        sourceUrl: base,
        outcome: 'found',
    };
}

/** One attribute off a single tag, quoted either way or bare. */
function attr(tag, name) {
    const m = tag.match(
        new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i'),
    );
    if (!m) return '';
    return decodeEntities((m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) || '').trim();
}

/**
 * `&amp;` is the one that matters: a query string in an og:image is escaped in
 * the source and has to be unescaped before it is fetched, or the CDN gets a
 * parameter literally named `amp;w`.
 */
function decodeEntities(value) {
    return value
        .replace(/&amp;/gi, '&')
        .replace(/&#38;/g, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'");
}

/**
 * The first usable value among several meta names, in the order given.
 *
 * Matched on the whole tag rather than by attribute order: `content` legally
 * comes before `property`, and half the CMSes in the world emit it that way.
 */
function firstMeta(html, names) {
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const name of names) {
        for (const tag of tags) {
            const key = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
            if (key !== name) continue;
            const value = attr(tag, 'content');
            if (isUsable(value)) return value;
        }
    }
    return '';
}

function firstLinkRel(html, rels) {
    const tags = html.match(/<link\b[^>]*>/gi) || [];
    for (const rel of rels) {
        for (const tag of tags) {
            const key = attr(tag, 'rel').toLowerCase();
            if (key !== rel) continue;
            const value = attr(tag, 'href');
            if (isUsable(value)) return value;
        }
    }
    return '';
}

/**
 * A data: URI is already the bytes and would be re-hosted as a copy of itself;
 * SVG is not in the bucket's MIME allowlist and would be rejected on upload
 * anyway, after paying for the download.
 */
function isUsable(value) {
    if (!value) return false;
    if (/^data:/i.test(value)) return false;
    const path = value.split('?')[0].split('#')[0];
    if (/\.svgz?$/i.test(path)) return false;
    return true;
}

/**
 * Resolve `href` against `base` without the `URL` global.
 *
 * Handles the four shapes that actually occur: absolute, protocol-relative,
 * root-relative, and path-relative.
 */
function resolveUrl(href, base) {
    const value = String(href).trim();
    if (!value) return null;

    if (/^https?:\/\//i.test(value)) return value;

    const baseMatch = String(base || '').match(/^(https?:)\/\/([^/?#]+)([^?#]*)/i);
    if (!baseMatch) return null;
    const scheme = baseMatch[1];
    const host = baseMatch[2];
    const basePath = baseMatch[3] || '/';

    if (value.startsWith('//')) return scheme + value;
    if (value.startsWith('/')) return scheme + '//' + host + value;

    // Relative to the directory of the base path, not to the document itself.
    const dir = basePath.slice(0, basePath.lastIndexOf('/') + 1) || '/';
    return scheme + '//' + host + dir + value;
}

// ── Tests ───────────────────────────────────────────────────────────────────

const VENUE = { venue_id: 'v1', name: 'The Tap Room', website: 'https://taproom.example/' };

const page = (body, overrides = {}) => [{ json: { statusCode: 200, body, ...overrides } }];

describe('extractArtworkCandidate — the fetch has to have worked', () => {
    it('treats a response with no statusCode as a failed fetch, not an empty page', () => {
        // neverError + a transport failure: the item arrives with an error and
        // no statusCode. Recording 'no_candidate' here would park the venue for
        // 30 days over a DNS blip.
        const result = extractArtworkCandidate([{ json: { error: 'ENOTFOUND' } }], VENUE);
        expect(result.outcome).toBe('fetch_failed');
        expect(result.imageUrl).toBeNull();
    });

    it('treats a non-2xx as a failed fetch', () => {
        const result = extractArtworkCandidate(page('<meta property="og:image" content="/a.jpg">', { statusCode: 403 }), VENUE);
        expect(result.outcome).toBe('fetch_failed');
    });

    it('treats an empty item list as a failed fetch', () => {
        expect(extractArtworkCandidate([], VENUE).outcome).toBe('fetch_failed');
    });

    it('distinguishes a page that simply has no picture', () => {
        const result = extractArtworkCandidate(page('<html><head><title>Bar</title></head></html>'), VENUE);
        expect(result.outcome).toBe('no_candidate');
        expect(result.imageUrl).toBeNull();
    });
});

describe('extractArtworkCandidate — which picture', () => {
    it('prefers og:image', () => {
        const html = `
            <meta name="twitter:image" content="https://taproom.example/twitter.jpg">
            <meta property="og:image" content="https://taproom.example/og.jpg">
            <link rel="apple-touch-icon" href="https://taproom.example/icon.png">`;
        expect(extractArtworkCandidate(page(html), VENUE).imageUrl)
            .toBe('https://taproom.example/og.jpg');
    });

    it('falls back to twitter:image, then to apple-touch-icon', () => {
        const twitter = `
            <meta name="twitter:image" content="https://taproom.example/twitter.jpg">
            <link rel="apple-touch-icon" href="https://taproom.example/icon.png">`;
        expect(extractArtworkCandidate(page(twitter), VENUE).imageUrl)
            .toBe('https://taproom.example/twitter.jpg');

        const iconOnly = '<link rel="apple-touch-icon" href="https://taproom.example/icon.png">';
        expect(extractArtworkCandidate(page(iconOnly), VENUE).imageUrl)
            .toBe('https://taproom.example/icon.png');
    });

    it('reads content that comes before property, and single-quoted attributes', () => {
        const html = `<meta content='https://taproom.example/og.jpg' property='og:image'>`;
        expect(extractArtworkCandidate(page(html), VENUE).imageUrl)
            .toBe('https://taproom.example/og.jpg');
    });

    it('unescapes &amp; in a query string', () => {
        const html = '<meta property="og:image" content="https://cdn.example/i.jpg?w=1200&amp;q=80">';
        expect(extractArtworkCandidate(page(html), VENUE).imageUrl)
            .toBe('https://cdn.example/i.jpg?w=1200&q=80');
    });

    it('skips a data: URI and an SVG, and keeps looking', () => {
        const html = `
            <meta property="og:image" content="data:image/png;base64,iVBORw0KG">
            <meta name="twitter:image" content="/logo.svg">
            <link rel="apple-touch-icon" href="/icon.png">`;
        const result = extractArtworkCandidate(page(html), VENUE);
        expect(result.imageUrl).toBe('https://taproom.example/icon.png');
    });

    it('skips an SVG even behind a query string', () => {
        const html = '<meta property="og:image" content="/logo.svg?v=3">';
        expect(extractArtworkCandidate(page(html), VENUE).outcome).toBe('no_candidate');
    });
});

describe('extractArtworkCandidate — resolving without the URL global', () => {
    it('leaves an absolute URL alone', () => {
        const html = '<meta property="og:image" content="https://cdn.example/a.jpg">';
        expect(extractArtworkCandidate(page(html), VENUE).imageUrl).toBe('https://cdn.example/a.jpg');
    });

    it('gives a protocol-relative URL the base scheme', () => {
        const html = '<meta property="og:image" content="//cdn.example/a.jpg">';
        expect(extractArtworkCandidate(page(html), VENUE).imageUrl).toBe('https://cdn.example/a.jpg');
    });

    it('resolves a root-relative URL against the host, not the path', () => {
        const html = '<meta property="og:image" content="/img/a.jpg">';
        const venue = { ...VENUE, website: 'https://taproom.example/menu/happy-hour' };
        expect(extractArtworkCandidate(page(html), venue).imageUrl)
            .toBe('https://taproom.example/img/a.jpg');
    });

    it('resolves a path-relative URL against the directory of the base path', () => {
        const html = '<meta property="og:image" content="a.jpg">';
        const venue = { ...VENUE, website: 'https://taproom.example/menu/happy-hour' };
        expect(extractArtworkCandidate(page(html), venue).imageUrl)
            .toBe('https://taproom.example/menu/a.jpg');
    });

    it('resolves against the URL actually landed on, not the one requested', () => {
        // http -> https -> www is the ordinary case. Resolving against the
        // pre-redirect address builds a link to a host that may not serve it.
        const html = '<meta property="og:image" content="/a.jpg">';
        const items = page(html, { url: 'https://www.taproom.example/' });
        const venue = { ...VENUE, website: 'http://taproom.example' };
        expect(extractArtworkCandidate(items, venue).imageUrl)
            .toBe('https://www.taproom.example/a.jpg');
    });

    it('reports the page it read as the source', () => {
        const html = '<meta property="og:image" content="/a.jpg">';
        const result = extractArtworkCandidate(page(html, { url: 'https://www.taproom.example/' }), VENUE);
        expect(result.sourceUrl).toBe('https://www.taproom.example/');
        expect(result.outcome).toBe('found');
    });

    it('gives up rather than guessing when the base is not a URL', () => {
        const html = '<meta property="og:image" content="/a.jpg">';
        const venue = { ...VENUE, website: 'taproom.example' };
        expect(extractArtworkCandidate(page(html), venue).outcome).toBe('no_candidate');
    });
});

describe('extractArtworkCandidate — it always identifies the venue', () => {
    it('carries the venue through every outcome, so Record Attempt can write one', () => {
        for (const items of [[], [{ json: { error: 'x' } }], page('<html></html>'), page('<meta property="og:image" content="/a.jpg">')]) {
            const result = extractArtworkCandidate(items, VENUE);
            expect(result.venue_id).toBe('v1');
            expect(result.name).toBe('The Tap Room');
        }
    });
});
