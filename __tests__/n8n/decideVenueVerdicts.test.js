/**
 * Mirror of the "Decide Verdict" Code node in the n8n workflow
 * "HH Finder — 2. Daily Deal Re-Validation".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * It replaces decideVerdict.test.js's one-deal-at-a-time node. The sweep now
 * reads a whole VENUE per iteration and returns one verdict per stored deal,
 * because the old shape could not answer the question it was being asked.
 *
 * What it exists to pin down, in order of how much damage getting it wrong does:
 *
 * 1. It is still the only thing between a model reading a web page and a live
 *    deal being unpublished. `gone` must never be reachable from "the pages we
 *    happened to fetch did not mention happy hour".
 * 2. A reading must land on the RIGHT sibling. The old node was handed one
 *    stored deal and no days, so at a venue with two windows it read the more
 *    prominent one off the shared page, called the other one `changed`, and
 *    rewrote it into a copy. Cantina Verde — West Town would have lost its Friday
 *    3:00pm–6:00pm window that way. A row the model did not place is `unclear`,
 *    never `changed` and never `gone`.
 * 3. `confirmed` vs `changed` is compared on meaning, not spelling: 315 of the
 *    342 stored windows are lowercase ("4:00pm - 7:00pm") while the prompt asks
 *    for "4:00 PM - 7:00 PM", so `===` never matched and every deal read came
 *    back `changed` with an audit entry logged for a no-op.
 * 4. A failed model call is not a verdict. It must leave every deal untouched.
 */

/**
 * @param {unknown} extractorOutput Output of the Information Extractor node.
 * @param {object} venue The `Merge Evidence` item: the venue and its deal group.
 */
function decideVenueVerdicts(extractorOutput, venue) {
    const raw = extractorOutput ?? {};

    // The Information Extractor returns its fields nested under `output`.
    // Reading $json directly leaves every field undefined, which silently
    // collapses every reading -- including outright model failures -- to
    // `unclear`, so the sweep would write `conflict` across the whole corpus no
    // matter what the model said.
    const ai = raw && typeof raw.output === 'object' && raw.output !== null ? raw.output : raw;
    const stored = Array.isArray(venue.deals) ? venue.deals : [];

    // A model failure is not a verdict about any of these deals: the page
    // loaded fine, we simply could not ask. Recording `unreachable` would be a
    // lie in the database AND would bump last_verified_at, rotating deals that
    // were never checked to the back of the queue for another 30 days.
    if (raw.error !== undefined && ai.mentions_happy_hour === undefined) {
        const why =
            typeof raw.error === 'string'
                ? raw.error
                : raw.error && raw.error.message
                  ? raw.error.message
                  : 'unknown model error';
        return stored.map((d) => ({
            deal_id: d.deal_id,
            recordable: false,
            verdict: 'skipped',
            notes: 'model call failed, deal left untouched: ' + String(why).slice(0, 200),
        }));
    }

    // Compare hours by meaning, not by spelling. Deliberately NOT
    // canonicalTimeWindow() from WF1's Normalize & Validate: that one produces
    // the STORAGE format and preserves ":00" as written, so "4 PM" and
    // "4:00 PM" still differ under it. This produces a COMPARISON key in
    // minutes, where they collapse to the same value.
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
        // hh_is_valid_time_window() accepts "4:00 PM - Close" since
        // migration_open_ended_time_windows.sql, and the extraction prompt now
        // asks for it. Without an arm here both sides key to null, the
        // readKey !== null guard rejects the match, and an unchanged window is
        // reported `changed` -- a no-op rewrite plus a spurious audit entry.
        // Only ever valid on the right: "Close - 9 PM" is not a window.
        const b = /^close$/i.test(parts[1]) ? 'close' : minutes(parts[1]);
        return a === null || b === null ? null : a + '-' + b;
    };

    const dayList = (value) => {
        if (!Array.isArray(value)) return [];
        const seen = new Set();
        for (const entry of value) {
            const n = Number(entry);
            if (Number.isInteger(n) && n >= 0 && n <= 6) seen.add(n);
        }
        return [...seen].sort((a, b) => a - b);
    };
    const shared = (a, b) => a.filter((d) => b.includes(d)).length;

    const confOf = (value) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
    };

    // The model answers with `deals: [...]`. A flat single-deal reply is also
    // read, so rolling either the prompt or this node back a version cannot
    // silently produce zero verdicts for the whole corpus.
    const read = (Array.isArray(ai.deals) ? ai.deals : ai.time_window !== undefined ? [ai] : [])
        .map((entry) => ({
            deal_id: typeof entry.deal_id === 'string' ? entry.deal_id : null,
            window: typeof entry.time_window === 'string' ? entry.time_window.trim() : '',
            days: dayList(entry.days_active),
            description: typeof entry.description === 'string' ? entry.description : null,
            confidence: entry.confidence === undefined ? confOf(ai.confidence) : confOf(entry.confidence),
        }))
        .filter((entry) => entry.window !== '');

    // Place each reading against a stored row. The prompt lists the ids and
    // asks the model to copy one back, but that is untrusted output: an id we
    // did not send is discarded, one row is never claimed twice, and anything
    // left unplaced falls back to day-set overlap.
    const storedIds = new Set(stored.map((d) => d.deal_id));
    const placed = new Map();
    let unplaced = [];

    for (const entry of read) {
        if (entry.deal_id && storedIds.has(entry.deal_id) && !placed.has(entry.deal_id)) {
            placed.set(entry.deal_id, entry);
        } else {
            unplaced.push(entry);
        }
    }

    for (const entry of unplaced.slice()) {
        let best = null;
        let bestShared = 0;
        for (const d of stored) {
            if (placed.has(d.deal_id)) continue;
            const n = shared(entry.days, dayList(d.days_active));
            if (n > bestShared) {
                bestShared = n;
                best = d;
            }
        }
        if (best) {
            placed.set(best.deal_id, entry);
            unplaced = unplaced.filter((e) => e !== entry);
        }
    }

    const closed = ai.venue_permanently_closed === true;
    const silent = ai.mentions_happy_hour === false;
    const pagesChecked = Number(venue.pagesChecked) || 1;

    // "These pages do not mention happy hour" is only evidence a deal is gone
    // if we actually reached the page that would carry it. Read against a
    // homepage alone it is near-worthless -- and mapping it to `gone` is what
    // would have unpublished Taco Bar on the very first sweep. A stated
    // permanent closure is exempt: that is a claim about the venue, not about
    // which page we happened to open.
    const goneIsCredible = closed || venue.foundHappyHourPage === true || pagesChecked >= 3;

    // Only a URL we ourselves fetched is trusted, and only a reading that
    // supported the deal may write it -- a `gone`/`unclear` result must not
    // overwrite a known-good source_url, so it sends null and the RPC coalesces
    // back to the stored value.
    const checkedUrls = Array.isArray(venue.sourcesChecked) ? venue.sourcesChecked : [];
    const claimed = typeof ai.evidence_url === 'string' ? ai.evidence_url.trim() : '';
    const evidence = checkedUrls.includes(claimed) ? claimed : venue.primaryUrl;

    const verdicts = stored.map((deal) => {
        const entry = placed.get(deal.deal_id);
        let verdict;
        let extracted;

        if (closed) {
            verdict = 'gone';
            extracted = { time_window: '', days_active: [], description: null, confidence: confOf(ai.confidence) };
        } else if (entry) {
            const readKey = windowKey(entry.window);
            // readKey must be non-null in its own right: two windows this
            // function cannot parse are not evidence of agreement, and
            // `null === null` would have called a stored "All Day" confirmed by
            // a read "All Day".
            const windowMatches = readKey !== null && readKey === windowKey(deal.time_window);
            verdict = windowMatches ? 'confirmed' : 'changed';
            extracted = {
                time_window: entry.window,
                days_active: entry.days,
                description: entry.description,
                confidence: entry.confidence,
            };
        } else if (silent && goneIsCredible) {
            verdict = 'gone';
            extracted = { time_window: '', days_active: [], description: null, confidence: confOf(ai.confidence) };
        } else {
            // Nothing the model read could be placed against this row. At a
            // venue with one deal that means the pages were vague; at a venue
            // with several it usually means the model was looking at a sibling.
            // Either way, "I read a different window" is not evidence that THIS
            // window ended -- that inference is exactly what rewrote one
            // schedule into a copy of another.
            verdict = 'unclear';
            extracted = { time_window: '', days_active: [], description: null, confidence: confOf(ai.confidence) };
        }

        return {
            deal_id: deal.deal_id,
            recordable: true,
            verdict,
            source_url: verdict === 'confirmed' || verdict === 'changed' ? evidence : null,
            extracted,
            notes:
                'auto re-validation of ' +
                deal.title +
                ' (' +
                pagesChecked +
                ' page(s) read' +
                (venue.foundHappyHourPage ? ', happy-hour page reached' : '') +
                (entry
                    ? verdict === 'confirmed'
                        ? ', hours unchanged'
                        : ', hours differ from stored'
                    : ', no reading matched this deal') +
                (stored.length > 1 ? ', ' + stored.length + ' deals at this venue' : '') +
                ')',
        };
    });

    // A window the venue advertises that no stored row covers. The sweep
    // VERIFIES, it does not discover, so this is filed as a proposal against
    // the group and waits for a click in the digest -- the same treatment a
    // Tier 4 finding gets.
    for (const entry of unplaced) {
        if (stored.length === 0 || entry.days.length === 0) continue;
        verdicts.push({
            deal_id: stored[0].deal_id,
            recordable: false,
            propose: true,
            verdict: 'new_sibling',
            source_url: evidence,
            proposed: {
                kind: 'new_sibling',
                time_window: entry.window,
                days_active: entry.days,
                description: entry.description,
                confidence: entry.confidence,
            },
            notes:
                'a window at ' +
                (venue.venue_name || 'this venue') +
                ' that no stored deal covers: ' +
                entry.window,
        });
    }

    return verdicts;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// Cantina Verde — West Town, exactly as it sits in the live corpus. This is the
// venue the old node would have broken.
const cantinaVerde = () => ({
    venue_id: 'v-cantina',
    venue_name: 'Cantina Verde – West Town',
    primaryUrl: 'https://cantinaverde.example/happy-hour',
    sourcesChecked: ['https://cantinaverde.example/happy-hour'],
    pagesChecked: 2,
    foundHappyHourPage: true,
    deals: [
        { deal_id: 'd-fri', title: 'Cantina Verde Happy Hour', time_window: '3:00pm - 6:00pm', days_active: [5] },
        {
            deal_id: 'd-mon',
            title: 'Cantina Verde Happy Hour',
            time_window: '5:00pm - 6:00pm',
            days_active: [1, 2, 3, 4],
        },
    ],
});

const tacoBar = () => ({
    venue_id: 'v-tacobar',
    venue_name: 'Taco Bar',
    primaryUrl: 'https://tacobar.example/',
    sourcesChecked: ['https://tacobar.example/'],
    pagesChecked: 1,
    foundHappyHourPage: false,
    deals: [
        {
            deal_id: 'd-tacobar',
            title: '$3 Tacos & $5 Margaritas',
            time_window: '3:00pm - 6:00pm',
            days_active: [0, 1, 2, 3, 4, 5, 6],
        },
    ],
});

const byId = (verdicts, id) => verdicts.find((v) => v.deal_id === id && !v.propose);

describe('decideVenueVerdicts', () => {
    describe('the regression it exists to prevent', () => {
        it('does not rewrite one sibling with another sibling hours', () => {
            // The model reads the whole board and places each window itself.
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        venue_permanently_closed: false,
                        evidence_url: 'https://cantinaverde.example/happy-hour',
                        confidence: 0.95,
                        deals: [
                            { deal_id: 'd-mon', time_window: '5:00 PM - 6:00 PM', days_active: [1, 2, 3, 4] },
                            { deal_id: 'd-fri', time_window: '3:00 PM - 6:00 PM', days_active: [5] },
                        ],
                    },
                },
                cantinaVerde(),
            );

            expect(byId(verdicts, 'd-fri').verdict).toBe('confirmed');
            expect(byId(verdicts, 'd-mon').verdict).toBe('confirmed');
        });

        it('leaves a sibling alone when the model only read the other one', () => {
            // The old node was handed d-fri on its own, was told nothing about
            // its days, read the more prominent Mon-Thu window, and called it
            // `changed` -- which rewrote Friday into a copy of Mon-Thu.
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.95,
                        deals: [{ deal_id: 'd-mon', time_window: '5:00 PM - 6:00 PM', days_active: [1, 2, 3, 4] }],
                    },
                },
                cantinaVerde(),
            );

            expect(byId(verdicts, 'd-mon').verdict).toBe('confirmed');
            expect(byId(verdicts, 'd-fri').verdict).toBe('unclear');
            expect(byId(verdicts, 'd-fri').extracted.time_window).toBe('');
            expect(byId(verdicts, 'd-fri').source_url).toBeNull();
        });

        it('places a reading by its days when the model forgets the id', () => {
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        deals: [{ time_window: '2:00 PM - 6:00 PM', days_active: [5] }],
                    },
                },
                cantinaVerde(),
            );

            expect(byId(verdicts, 'd-fri').verdict).toBe('changed');
            expect(byId(verdicts, 'd-fri').extracted.time_window).toBe('2:00 PM - 6:00 PM');
            expect(byId(verdicts, 'd-mon').verdict).toBe('unclear');
        });

        it('discards a deal_id we never sent rather than trusting it', () => {
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        deals: [
                            { deal_id: 'd-somewhere-else', time_window: '3:00 PM - 6:00 PM', days_active: [5] },
                        ],
                    },
                },
                cantinaVerde(),
            );

            // Falls back to day overlap and still lands on Friday.
            expect(byId(verdicts, 'd-fri').verdict).toBe('confirmed');
            expect(verdicts.every((v) => v.deal_id !== 'd-somewhere-else')).toBe(true);
        });

        it('never claims one stored row twice', () => {
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        deals: [
                            { deal_id: 'd-fri', time_window: '3:00 PM - 6:00 PM', days_active: [5] },
                            { deal_id: 'd-fri', time_window: '9:00 PM - 11:00 PM', days_active: [5] },
                        ],
                    },
                },
                cantinaVerde(),
            );

            const forFri = verdicts.filter((v) => v.deal_id === 'd-fri' && !v.propose);
            expect(forFri).toHaveLength(1);
            expect(forFri[0].extracted.time_window).toBe('3:00 PM - 6:00 PM');
        });
    });

    describe('unpublishing stays as hard as it was', () => {
        it('will not call a deal gone off a homepage that simply never says happy hour', () => {
            const verdicts = decideVenueVerdicts(
                { output: { mentions_happy_hour: false, confidence: 0.95 } },
                tacoBar(),
            );
            expect(verdicts[0].verdict).toBe('unclear');
        });

        it('calls it gone once a happy-hour page was actually reached', () => {
            const venue = { ...tacoBar(), foundHappyHourPage: true };
            const verdicts = decideVenueVerdicts(
                { output: { mentions_happy_hour: false, confidence: 0.95 } },
                venue,
            );
            expect(verdicts[0].verdict).toBe('gone');
        });

        it('calls it gone after three pages all came back silent', () => {
            const venue = { ...tacoBar(), pagesChecked: 3 };
            const verdicts = decideVenueVerdicts(
                { output: { mentions_happy_hour: false, confidence: 0.95 } },
                venue,
            );
            expect(verdicts[0].verdict).toBe('gone');
        });

        it('takes a stated permanent closure at face value, for every deal', () => {
            const verdicts = decideVenueVerdicts(
                { output: { mentions_happy_hour: true, venue_permanently_closed: true, confidence: 0.95 } },
                cantinaVerde(),
            );
            expect(verdicts.map((v) => v.verdict)).toEqual(['gone', 'gone']);
        });
    });

    describe('confirmed vs changed is decided on meaning', () => {
        it('does not call a lowercase stored window changed', () => {
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        deals: [{ deal_id: 'd-tacobar', time_window: '3:00 PM - 6:00 PM', days_active: [1] }],
                    },
                },
                tacoBar(),
            );
            expect(verdicts[0].verdict).toBe('confirmed');
        });

        it.each([
            ['9:00pm - Close', '9 PM - Close'],
            ['4:00pm - Close', '4:00 PM - Close'],
            ['9:00pm - Close', '9 PM - close'],
        ])('reads %s and %s as the same window', (stored, read) => {
            const venue = tacoBar();
            venue.deals[0].time_window = stored;
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        deals: [{ deal_id: 'd-tacobar', time_window: read, days_active: [1] }],
                    },
                },
                venue,
            );
            expect(verdicts[0].verdict).toBe('confirmed');
        });

        it('does not match an open-ended window against one with a real end time', () => {
            const venue = tacoBar();
            venue.deals[0].time_window = '9:00pm - Close';
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        deals: [{ deal_id: 'd-tacobar', time_window: '9 PM - 11 PM', days_active: [1] }],
                    },
                },
                venue,
            );
            expect(verdicts[0].verdict).toBe('changed');
        });

        it('refuses a window that opens with Close', () => {
            const venue = tacoBar();
            venue.deals[0].time_window = 'Close - 9:00pm';
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        deals: [{ deal_id: 'd-tacobar', time_window: 'Close - 9 PM', days_active: [1] }],
                    },
                },
                venue,
            );
            expect(verdicts[0].verdict).toBe('changed');
        });

        it('does not call two unreadable windows a match', () => {
            const venue = tacoBar();
            venue.deals[0].time_window = 'All Day';
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        deals: [{ deal_id: 'd-tacobar', time_window: 'All Day', days_active: [1] }],
                    },
                },
                venue,
            );
            expect(verdicts[0].verdict).toBe('changed');
        });
    });

    describe('a window nobody has stored', () => {
        it('is proposed, never written', () => {
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        evidence_url: 'https://cantinaverde.example/happy-hour',
                        deals: [
                            { deal_id: 'd-fri', time_window: '3:00 PM - 6:00 PM', days_active: [5] },
                            { deal_id: 'd-mon', time_window: '5:00 PM - 6:00 PM', days_active: [1, 2, 3, 4] },
                            { time_window: '10:00 PM - 12:00 AM', days_active: [6] },
                        ],
                    },
                },
                cantinaVerde(),
            );

            const proposal = verdicts.find((v) => v.propose);
            expect(proposal).toBeDefined();
            expect(proposal.recordable).toBe(false);
            expect(proposal.proposed.kind).toBe('new_sibling');
            expect(proposal.proposed.days_active).toEqual([6]);
            expect(proposal.deal_id).toBe('d-fri');
        });

        it('is dropped when it does not say which days it runs', () => {
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        deals: [
                            { deal_id: 'd-fri', time_window: '3:00 PM - 6:00 PM', days_active: [5] },
                            { deal_id: 'd-mon', time_window: '5:00 PM - 6:00 PM', days_active: [1, 2, 3, 4] },
                            { time_window: '10:00 PM - 12:00 AM', days_active: [] },
                        ],
                    },
                },
                cantinaVerde(),
            );
            expect(verdicts.some((v) => v.propose)).toBe(false);
        });
    });

    describe('a failed model call is not a verdict', () => {
        it('leaves every deal at the venue untouched', () => {
            const verdicts = decideVenueVerdicts(
                { error: { message: 'quota exceeded' } },
                cantinaVerde(),
            );
            expect(verdicts).toHaveLength(2);
            expect(verdicts.every((v) => v.recordable === false && v.verdict === 'skipped')).toBe(true);
            expect(verdicts[0].notes).toContain('quota exceeded');
        });
    });

    describe('back-compat', () => {
        it('still reads a flat single-deal reply', () => {
            const verdicts = decideVenueVerdicts(
                {
                    output: {
                        mentions_happy_hour: true,
                        confidence: 0.9,
                        time_window: '3:00 PM - 6:00 PM',
                        days_active: [1],
                    },
                },
                tacoBar(),
            );
            expect(verdicts[0].verdict).toBe('confirmed');
        });
    });
});
