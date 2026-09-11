/**
 * Mirror of the "Decide Verdict" Code node in the n8n workflow
 * "HH Finder — 2. Daily Deal Re-Validation".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down, in order of how much damage getting it wrong does:
 *
 * 1. This node is the only thing standing between a model reading a web page
 *    and a live deal being unpublished. `gone` must never be reachable from
 *    "the pages we happened to fetch did not mention happy hour".
 * 2. It decides `confirmed` vs `changed`, which is the entire signal the sweep
 *    exists to produce. That comparison used to be `===` on the raw strings,
 *    and 315 of the 342 stored windows are lowercase ("4:00pm - 7:00pm") while
 *    the prompt asks the model for "4:00 PM - 7:00 PM" — so nothing ever
 *    matched. Every deal read came back `changed`, its row was rewritten with
 *    an identical time, and an audit entry was logged for a no-op. Exactly one
 *    deal in the corpus had ever reached `verified`.
 * 3. A failed model call is not a verdict. It must leave the deal untouched.
 */

/**
 * @param {unknown} extractorOutput Output of the Information Extractor node.
 * @param {object} deal The `Merge Evidence` item for the deal being checked.
 */
function decideVerdict(extractorOutput, deal) {
    const raw = extractorOutput ?? {};

    // The Information Extractor returns its fields nested under `output`. Reading
    // $json directly leaves every field undefined, which silently collapses every
    // reading -- including outright model failures -- to `unclear`.
    const ai = raw && typeof raw.output === 'object' && raw.output !== null ? raw.output : raw;

    if (raw.error !== undefined && ai.mentions_happy_hour === undefined) {
        const why =
            typeof raw.error === 'string'
                ? raw.error
                : raw.error && raw.error.message
                  ? raw.error.message
                  : 'unknown model error';
        return {
            deal_id: deal.deal_id,
            recordable: false,
            verdict: 'skipped',
            notes: 'model call failed, deal left untouched: ' + String(why).slice(0, 200),
        };
    }

    // Compare hours by meaning, not by spelling. Deliberately NOT
    // canonicalTimeWindow() from WF1: that produces the STORAGE format and
    // preserves ":00" as written, so "4 PM" and "4:00 PM" still differ under it.
    // This produces a COMPARISON key in minutes, where they collapse. It writes
    // nothing, so the two do not have to be kept in step.
    const windowKey = (input) => {
        if (!input) return null;
        const s = String(input)
            .trim()
            .replace(/[‐-―−]/g, '-')
            .replace(/\bto\b/gi, '-')
            .replace(/\s+/g, ' ');
        const parts = s
            .split('-')
            .map((p) => p.trim())
            .filter(Boolean);
        if (parts.length !== 2) return null;

        const minutes = (side) => {
            let m = side.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
            if (m) {
                let h = parseInt(m[1], 10);
                const mins = m[2] ? parseInt(m[2], 10) : 0;
                if (h < 1 || h > 12 || mins > 59) return null;
                if (h === 12) h = 0;
                return (h + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + mins;
            }
            m = side.match(/^(\d{1,2}):(\d{2})$/);
            if (m) {
                const h = parseInt(m[1], 10);
                const mins = parseInt(m[2], 10);
                if (h > 23 || mins > 59) return null;
                return h * 60 + mins;
            }
            return null;
        };

        const a = minutes(parts[0]);
        const b = minutes(parts[1]);
        return a === null || b === null ? null : a + '-' + b;
    };

    const conf = Number(ai.confidence);
    const confidence = Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1) : 0;
    const window = typeof ai.time_window === 'string' ? ai.time_window.trim() : '';
    const days = Array.isArray(ai.days_active) ? ai.days_active : [];

    const readKey = windowKey(window);
    const storedKey = windowKey(deal.time_window);
    // readKey must be non-null in its own right: two windows this function
    // cannot parse are not evidence of agreement, and `null === null` would
    // have called a stored "All Day" confirmed by a read "All Day".
    const windowMatches = readKey !== null && readKey === storedKey;

    let verdict;
    if (ai.venue_permanently_closed === true) {
        verdict = 'gone';
    } else if (ai.mentions_happy_hour === false) {
        verdict = 'gone';
    } else if (window) {
        verdict = windowMatches ? 'confirmed' : 'changed';
    } else {
        verdict = 'unclear';
    }

    // "These pages do not mention happy hour" is only evidence the deal is gone
    // if we actually reached the page that would carry it.
    const checked = Number(deal.pagesChecked) || 1;
    if (
        verdict === 'gone' &&
        ai.venue_permanently_closed !== true &&
        !deal.foundHappyHourPage &&
        checked < 3
    ) {
        verdict = 'unclear';
    }

    const checkedUrls = Array.isArray(deal.sourcesChecked) ? deal.sourcesChecked : [];
    const claimed = typeof ai.evidence_url === 'string' ? ai.evidence_url.trim() : '';
    const evidence = checkedUrls.includes(claimed) ? claimed : deal.primaryUrl;
    const sourceUrl = verdict === 'confirmed' || verdict === 'changed' ? evidence : null;

    return {
        deal_id: deal.deal_id,
        recordable: true,
        verdict,
        source_url: sourceUrl,
        extracted: {
            time_window: window,
            days_active: days,
            description: typeof ai.description === 'string' ? ai.description : null,
            confidence,
        },
        notes:
            'auto re-validation of ' +
            deal.title +
            ' (' +
            checked +
            ' page(s) read' +
            (deal.foundHappyHourPage ? ', happy-hour page reached' : '') +
            (window ? (windowMatches ? ', hours unchanged' : ', hours differ from stored') : '') +
            ')',
    };
}

/** A deal as `Merge Evidence` hands it over, with the stored window overridable. */
const dealFixture = (overrides = {}) => ({
    deal_id: 'f261474c-1702-47f1-bd4c-f1c073c689f7',
    title: 'Taco Bar Happy Hour',
    time_window: '4:00pm - 7:00pm',
    venue_name: 'Taco Bar',
    primaryUrl: 'https://tacobar.example',
    sourcesChecked: ['https://tacobar.example', 'https://tacobar.example/menu/happy-hour/'],
    pagesChecked: 2,
    foundHappyHourPage: true,
    ...overrides,
});

/** The extractor's reply, wrapped the way the node actually emits it. */
const wrapped = (fields) => ({ output: { mentions_happy_hour: true, confidence: 0.9, ...fields } });

describe('Decide Verdict — hours are compared by meaning, not spelling', () => {
    // The regression this file was added for. The stored corpus is 92%
    // lowercase; the prompt asks for uppercase. Under `===` these never matched.
    it('confirms a deal whose stored hours differ only in case', () => {
        const out = decideVerdict(
            wrapped({ time_window: '4:00 PM - 7:00 PM' }),
            dealFixture({ time_window: '4:00pm - 7:00pm' })
        );
        expect(out.verdict).toBe('confirmed');
        expect(out.notes).toContain('hours unchanged');
    });

    it.each([
        ['4:00pm - 7:00pm', '4 PM - 7 PM', 'minutes omitted on the read side'],
        ['4 PM - 7 PM', '4:00 PM - 7:00 PM', 'minutes omitted on the stored side'],
        ['16:00-19:00', '4 PM - 7 PM', '24-hour stored value'],
        ['4pm to 7pm', '4 PM - 7 PM', '"to" used as the separator'],
        ['4:00pm – 7:00pm', '4 PM - 7 PM', 'en-dash separator'],
        ['12:00pm - 3:00pm', '12 PM - 3 PM', 'noon boundary'],
        ['12:00am - 2:00am', '12 AM - 2 AM', 'midnight boundary'],
        ['11:00am - 1:00pm', '11 AM - 1 PM', 'window crossing midday'],
    ])('confirms %s read back as %s (%s)', (stored, read) => {
        const out = decideVerdict(wrapped({ time_window: read }), dealFixture({ time_window: stored }));
        expect(out.verdict).toBe('confirmed');
    });

    it.each([
        ['4:00pm - 7:00pm', '3:00 PM - 6:00 PM', 'both ends moved'],
        ['4:00pm - 7:00pm', '4:00 PM - 6:30 PM', 'end time moved'],
        ['4:00pm - 7:00pm', '4:30 PM - 7:00 PM', 'start time moved'],
    ])('reports %s read back as %s as changed (%s)', (stored, read) => {
        const out = decideVerdict(wrapped({ time_window: read }), dealFixture({ time_window: stored }));
        expect(out.verdict).toBe('changed');
        expect(out.extracted.time_window).toBe(read);
        expect(out.notes).toContain('hours differ from stored');
    });

    // The dangerous edge: two values the key cannot parse are not agreement.
    // `null === null` would otherwise mark an unparseable window "verified" and
    // retire it from the queue with the app still unable to render it.
    it.each([
        ['All Day', 'All Day'],
        ['4:00pm - Close', '4:00 PM - Close'],
        ['Open to close', 'Open to close'],
    ])('never confirms the unparseable pair %s / %s', (stored, read) => {
        const out = decideVerdict(wrapped({ time_window: read }), dealFixture({ time_window: stored }));
        expect(out.verdict).toBe('changed');
    });

    it('treats a real reading against an unparseable stored window as changed', () => {
        const out = decideVerdict(
            wrapped({ time_window: '4 PM - 7 PM' }),
            dealFixture({ time_window: 'All Day' })
        );
        expect(out.verdict).toBe('changed');
    });
});

describe('Decide Verdict — a live deal is never unpublished on weak evidence', () => {
    it('downgrades "no happy hour here" to unclear when no happy-hour page was reached', () => {
        const out = decideVerdict(
            wrapped({ mentions_happy_hour: false, time_window: '' }),
            dealFixture({ foundHappyHourPage: false, pagesChecked: 2 })
        );
        expect(out.verdict).toBe('unclear');
    });

    it('allows gone once a happy-hour page was actually read', () => {
        const out = decideVerdict(
            wrapped({ mentions_happy_hour: false, time_window: '' }),
            dealFixture({ foundHappyHourPage: true, pagesChecked: 2 })
        );
        expect(out.verdict).toBe('gone');
    });

    it('allows gone once three pages have all come back silent', () => {
        const out = decideVerdict(
            wrapped({ mentions_happy_hour: false, time_window: '' }),
            dealFixture({ foundHappyHourPage: false, pagesChecked: 3 })
        );
        expect(out.verdict).toBe('gone');
    });

    it('exempts a stated permanent closure from the page requirement', () => {
        const out = decideVerdict(
            wrapped({ venue_permanently_closed: true, time_window: '' }),
            dealFixture({ foundHappyHourPage: false, pagesChecked: 1 })
        );
        expect(out.verdict).toBe('gone');
    });

    // Taco Bar: happy hour alive, stored details stale. Calling this `gone`
    // both removed a live deal and discarded the hours just read off the page.
    it('calls drifted hours changed, never gone', () => {
        const out = decideVerdict(
            wrapped({ mentions_happy_hour: true, matching_deal_found: false, time_window: '4 PM - 6 PM' }),
            dealFixture({ time_window: '3:00pm - 6:00pm' })
        );
        expect(out.verdict).toBe('changed');
    });

    it('records unclear when a happy hour is advertised in hours it cannot express', () => {
        const out = decideVerdict(wrapped({ time_window: '' }), dealFixture());
        expect(out.verdict).toBe('unclear');
        expect(out.source_url).toBeNull();
    });
});

describe('Decide Verdict — a failed model call is not a verdict', () => {
    it.each([
        ['a string error', 'Service unavailable'],
        ['an Error-shaped object', { message: '429 quota exceeded' }],
    ])('leaves the deal untouched on %s', (_label, error) => {
        const out = decideVerdict({ error }, dealFixture());
        expect(out.recordable).toBe(false);
        expect(out.verdict).toBe('skipped');
        expect(out.notes).toContain('deal left untouched');
    });

    it('still reads a valid reply that happens to carry an error field', () => {
        const out = decideVerdict(
            { error: 'warning', output: { mentions_happy_hour: true, time_window: '4:00 PM - 7:00 PM', confidence: 0.9 } },
            dealFixture()
        );
        expect(out.recordable).toBe(true);
        expect(out.verdict).toBe('confirmed');
    });
});

describe('Decide Verdict — only a page we fetched may become source_url', () => {
    it('accepts an evidence url the crawl actually read', () => {
        const out = decideVerdict(
            wrapped({ time_window: '4:00 PM - 7:00 PM', evidence_url: 'https://tacobar.example/menu/happy-hour/' }),
            dealFixture()
        );
        expect(out.source_url).toBe('https://tacobar.example/menu/happy-hour/');
    });

    it('falls back to the primary url when the model invents one', () => {
        const out = decideVerdict(
            wrapped({ time_window: '4:00 PM - 7:00 PM', evidence_url: 'https://not-a-page-we-read.example/' }),
            dealFixture()
        );
        expect(out.source_url).toBe('https://tacobar.example');
    });

    it('never overwrites a known-good source_url from a gone or unclear reading', () => {
        const gone = decideVerdict(
            wrapped({ mentions_happy_hour: false, time_window: '' }),
            dealFixture({ foundHappyHourPage: true })
        );
        expect(gone.source_url).toBeNull();
    });
});

describe('Decide Verdict — the extractor wrapper', () => {
    // Reading $json directly instead of $json.output left every field
    // undefined, which collapsed every reading to `unclear`.
    it('reads fields nested under output', () => {
        const out = decideVerdict({ output: { mentions_happy_hour: true, time_window: '4:00 PM - 7:00 PM', confidence: 0.9 } }, dealFixture());
        expect(out.verdict).toBe('confirmed');
    });

    it('reads fields at the top level too', () => {
        const out = decideVerdict({ mentions_happy_hour: true, time_window: '4:00 PM - 7:00 PM', confidence: 0.9 }, dealFixture());
        expect(out.verdict).toBe('confirmed');
    });

    it('clamps confidence into 0..1', () => {
        expect(decideVerdict(wrapped({ time_window: '4 PM - 7 PM', confidence: 7 }), dealFixture()).extracted.confidence).toBe(1);
        expect(decideVerdict(wrapped({ time_window: '4 PM - 7 PM', confidence: -3 }), dealFixture()).extracted.confidence).toBe(0);
        expect(decideVerdict(wrapped({ time_window: '4 PM - 7 PM', confidence: 'x' }), dealFixture()).extracted.confidence).toBe(0);
    });
});
