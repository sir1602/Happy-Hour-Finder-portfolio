/**
 * Mirror of the "Parse Google Hours" Code node in the n8n workflow
 * "HH Finder — Area Scan Engine (sub-workflow)".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: this is the third time-window parser in the
 * system. `canonicalTimeWindow()` already exists twice (WF1 and the OCR
 * sub-workflow), and audit finding 09 was about the crawler existing twice —
 * so adding a third parser without a mirror would be repeating the mistake the
 * audit is about. It gets one on the day it is written, before it is wired to
 * anything that writes.
 *
 * Google's format is not the app's, and two characters make that easy to miss.
 * Verbatim from a live scraper run, the separator is an EN DASH (U+2013) and
 * the space before the meridiem is a NARROW NO-BREAK SPACE (U+202F). The output
 * has to be a plain ASCII hyphen and ordinary spaces, because both gates
 * downstream are literal about it:
 *
 *   - the app's `parseDealTime()` splits on '-' and matches /(AM|PM)$/i
 *   - SQL `hh_is_valid_time_window()` requires the same shape
 *
 * Checked against the live database: '4 PM - 5:30 PM' passes that function and
 * the raw Google string '4–5:30 PM' does not.
 *
 * The genuinely hard part is that the meridiem is usually stated ONCE, at the
 * end, and has to be inferred backwards onto the start time — and inheriting it
 * blindly is wrong for '11–1 PM', where it would put the start after the end.
 */

const HAPPY_HOURS_KEY = 'Happy hours';

const DAY_INDEX = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
};

/**
 * @param {object} additionalOpeningHours The Apify `additionalOpeningHours` object.
 */
function parseGoogleHappyHours(additionalOpeningHours) {
    const refuse = (why) => ({
        ok: false, deals: [], droppedDays: [],
        unparsedDays: [], openDays: 0, refusedBecause: why,
    });

    const block = additionalOpeningHours && additionalOpeningHours[HAPPY_HOURS_KEY];
    if (!Array.isArray(block) || block.length === 0) {
        return refuse('no happy-hour hours published');
    }

    // Google writes an en dash and a narrow no-break space; every gate
    // downstream wants an ASCII hyphen and an ordinary space.
    const normalise = (s) => String(s ?? '')
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    /** One side of a range: the number, and the meridiem only if it was stated. */
    const readSide = (raw) => {
        let m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(raw);
        if (m) {
            const h = parseInt(m[1], 10);
            const min = m[2] ? parseInt(m[2], 10) : 0;
            if (h < 1 || h > 12 || min > 59) return null;
            return { h, min, mer: m[3].toUpperCase() };
        }
        m = /^(\d{1,2})(?::(\d{2}))?$/.exec(raw);
        if (m) {
            const h = parseInt(m[1], 10);
            const min = m[2] ? parseInt(m[2], 10) : 0;
            if (h < 1 || h > 12 || min > 59) return null;
            return { h, min, mer: null };
        }
        return null;
    };

    const minutesOf = (side) => {
        let h = side.h % 12;
        if (side.mer === 'P') h += 12;
        return h * 60 + side.min;
    };

    const flip = (side) => ({ ...side, mer: side.mer === 'A' ? 'P' : 'A' });

    const format = (side) =>
        side.min === 0
            ? side.h + ' ' + side.mer + 'M'
            : side.h + ':' + String(side.min).padStart(2, '0') + ' ' + side.mer + 'M';

    /** '4–5:30 PM' -> '4 PM - 5:30 PM'. Returns null when it cannot be trusted. */
    const parseRange = (rawHours) => {
        const s = normalise(rawHours);
        if (!s) return null;
        if (/^closed$/i.test(s)) return 'CLOSED';
        // "Open 24 hours" is not a window, and neither is anything else without
        // two sides.
        const parts = s.split('-').map((p) => p.trim()).filter(Boolean);
        if (parts.length !== 2) return null;

        let start = readSide(parts[0]);
        let end = readSide(parts[1]);
        if (!start || !end) return null;

        // Neither side stated a meridiem: '4-7' could be either, and guessing is
        // exactly the kind of confident wrongness this pipeline refuses.
        if (start.mer === null && end.mer === null) return null;

        if (start.mer === null) {
            start = { ...start, mer: end.mer };
            // Inheriting would put the start at or after the end ('11–1 PM'),
            // so the start belongs to the other half of the day.
            if (minutesOf(start) >= minutesOf(end)) start = flip(start);
        } else if (end.mer === null) {
            end = { ...end, mer: start.mer };
            if (minutesOf(end) <= minutesOf(start)) end = flip(end);
        }
        // When both were stated, an end before the start is a real overnight
        // window and the app handles it. Left alone on purpose.

        return format(start) + ' - ' + format(end);
    };

    const byWindow = new Map();
    const dropped = [];
    const unparsed = [];
    let openDays = 0;

    for (const entry of block) {
        const dayName = String((entry && entry.day) || '').trim().toLowerCase();
        const dayIndex = DAY_INDEX[dayName];
        if (dayIndex === undefined) continue;

        const parsed = parseRange(entry && entry.hours);
        if (parsed === 'CLOSED') continue;

        // Published as open, so it counts against the majority threshold below
        // whether or not we could read it.
        openDays += 1;
        if (parsed === null) {
            unparsed.push({ day: dayIndex, hours: normalise(entry && entry.hours) });
            continue;
        }
        if (!byWindow.has(parsed)) byWindow.set(parsed, []);
        byWindow.get(parsed).push(dayIndex);
    }

    if (openDays === 0) return refuse('every day is marked closed');
    if (byWindow.size === 0) {
        const out = refuse('no day published a window that could be read');
        out.unparsedDays = unparsed;
        out.openDays = openDays;
        return out;
    }

    // One deal per distinct window. This used to take the MODAL window, drop
    // every day that did not share it, and refuse outright on a tie or when the
    // majority covered under half the open days -- because the intake schema
    // held one time_window and one days_active, so Gallery's "4-5:30 PM Mon-Thu
    // and 12-3 PM Fri" had to become one or the other.
    //
    // Intake takes a deal group now, and the app has always stored day-varying
    // hours as sibling rows, so the lossy collapse has nothing left to justify
    // it: Google publishes the days and the hours per day, and that maps
    // straight onto the rows. A day whose hours could not be READ is still
    // dropped -- that is a different problem, and it is reported.
    const deals = [...byWindow.entries()]
        .map(([time_window, days]) => ({
            time_window,
            days_active: days.slice().sort((a, b) => a - b),
        }))
        .sort((a, b) => a.days_active[0] - b.days_active[0]);

    for (const u of unparsed) dropped.push({ day: u.day, window: u.hours });

    return {
        ok: true,
        deals,
        droppedDays: dropped.sort((a, b) => a.day - b.day),
        unparsedDays: unparsed,
        openDays,
        refusedBecause: null,
    };
}

// ---------------------------------------------------------------------------
// Fixtures copied verbatim from a live scraper run (1 Sep 2026, Wicker Park).
// These are the real characters Google sent, written as escapes so they stay visible.
// ---------------------------------------------------------------------------

const EN = '\u2013';   // en dash: the range separator Google uses
const NBSP = '\u202f'; // narrow no-break space: what sits before the meridiem

const g = (hours) => hours.replace(/-/g, EN).replace(/ (AM|PM)/g, NBSP + '$1');

const days = (map) => ({
    'Happy hours': Object.entries(map).map(([day, hours]) => ({ day, hours })),
});

/** Gallery Tavern & Grill — Mon-Thu 4-5:30 PM, Fri 12-3 PM, weekend closed. */
const GALLERY = days({
    Monday: g('4-5:30 PM'), Tuesday: g('4-5:30 PM'), Wednesday: g('4-5:30 PM'),
    Thursday: g('4-5:30 PM'), Friday: g('12-3 PM'), Saturday: 'Closed', Sunday: 'Closed',
});

/** Bowler's Corner Tavern — the venue with no website at all. */
const BOWLERS = days({
    Monday: 'Closed', Tuesday: g('4-7 PM'), Wednesday: g('4-7 PM'),
    Thursday: g('4-7 PM'), Friday: g('4-7 PM'), Saturday: 'Closed', Sunday: 'Closed',
});

/** Riverside Tavern — the clean case, one window five days. */
const RIVERSIDE = days({
    Monday: g('3-6 PM'), Tuesday: g('3-6 PM'), Wednesday: g('3-6 PM'),
    Thursday: g('3-6 PM'), Friday: g('3-6 PM'), Saturday: 'Closed', Sunday: 'Closed',
});

/** O'Malley's Tap and Grill — 2 days at one window, 1 at another. */
const OMALLEYS = days({
    Monday: 'Closed', Tuesday: g('6-10 PM'), Wednesday: 'Closed', Thursday: 'Closed',
    Friday: g('3-6 PM'), Saturday: 'Closed', Sunday: g('6-10 PM'),
});

/** The one window a single-schedule venue publishes, for the tests below. */
const only = (out) => (out.deals.length === 1 ? out.deals[0] : null);

describe('parseGoogleHappyHours — the four real venues in the sample', () => {
    // Gallery is the venue that motivated the change. It runs 4-5:30 PM Monday
    // to Thursday and 12-3 PM on Friday. The parser used to take the modal
    // window, drop Friday, and record what it had thrown away; now both windows
    // come through and intake writes them as two sibling rows -- which is how
    // the app has always stored a happy hour like this.
    it('reads both of Gallery windows instead of dropping Friday', () => {
        const out = parseGoogleHappyHours(GALLERY);
        expect(out.ok).toBe(true);
        expect(out.deals).toEqual([
            { time_window: '4 PM - 5:30 PM', days_active: [1, 2, 3, 4] },
            { time_window: '12 PM - 3 PM', days_active: [5] },
        ]);
        expect(out.droppedDays).toEqual([]);
    });

    it("reads Bowler's cleanly — the venue with no website", () => {
        const out = parseGoogleHappyHours(BOWLERS);
        expect(out.ok).toBe(true);
        expect(only(out)).toEqual({ time_window: '4 PM - 7 PM', days_active: [2, 3, 4, 5] });
        expect(out.droppedDays).toEqual([]);
    });

    it('reads Riverside, five days one window', () => {
        const out = parseGoogleHappyHours(RIVERSIDE);
        expect(out.ok).toBe(true);
        expect(only(out)).toEqual({ time_window: '3 PM - 6 PM', days_active: [1, 2, 3, 4, 5] });
    });

    it("reads both of O'Malley's windows", () => {
        const out = parseGoogleHappyHours(OMALLEYS);
        expect(out.ok).toBe(true);
        expect(out.deals).toEqual([
            { time_window: '6 PM - 10 PM', days_active: [0, 2] },
            { time_window: '3 PM - 6 PM', days_active: [5] },
        ]);
        expect(out.openDays).toBe(3);
        expect(out.droppedDays).toEqual([]);
    });

    // Every output has to survive both gates downstream, verified against the
    // live database for these exact strings.
    it.each([
        ['Gallery', GALLERY], ["Bowler's", BOWLERS], ['Riverside', RIVERSIDE], ["O'Malley's", OMALLEYS],
    ])('emits windows for %s that the app and SQL both accept', (_label, fixture) => {
        const out = parseGoogleHappyHours(fixture);
        expect(out.deals.length).toBeGreaterThan(0);
        for (const deal of out.deals) {
            expect(deal.time_window).toMatch(/^\d{1,2}(:\d{2})? (AM|PM) - \d{1,2}(:\d{2})? (AM|PM)$/);
            expect(deal.time_window).not.toContain(EN);
            expect(deal.time_window).not.toContain(NBSP);
            expect(deal.days_active.length).toBeGreaterThan(0);
        }
    });

    // Two rows that could both be shown on the same day is the collision the
    // whole deal-group design exists to prevent, so the parser must never
    // produce one.
    it.each([
        ['Gallery', GALLERY], ["Bowler's", BOWLERS], ['Riverside', RIVERSIDE], ["O'Malley's", OMALLEYS],
    ])('never gives %s two windows on the same day', (_label, fixture) => {
        const seen = new Set();
        for (const deal of parseGoogleHappyHours(fixture).deals) {
            for (const day of deal.days_active) {
                expect(seen.has(day)).toBe(false);
                seen.add(day);
            }
        }
    });
});

/**
 * A second sample, from a production run (4 Sep 2026, same area, different places).
 * Both of these parsed cleanly in the live dry run, and the first one is a case
 * the 1 Sep sample did not contain: minutes on BOTH sides of the range.
 */
const CORNER_11 = days({
    Monday: g('4:30-6:30 PM'), Tuesday: g('4:30-6:30 PM'), Wednesday: g('4:30-6:30 PM'),
    Thursday: g('4:30-6:30 PM'), Friday: g('4:30-6:30 PM'), Saturday: 'Closed', Sunday: 'Closed',
});

const DEPOT = days({
    Monday: g('5-6 PM'), Tuesday: g('5-6 PM'), Wednesday: g('5-6 PM'),
    Thursday: g('5-6 PM'), Friday: 'Closed', Saturday: 'Closed', Sunday: 'Closed',
});

describe('parseGoogleHappyHours — the second live sample', () => {
    it('reads minutes on both sides of the range', () => {
        const out = parseGoogleHappyHours(CORNER_11);
        expect(out.ok).toBe(true);
        expect(only(out)).toEqual({ time_window: '4:30 PM - 6:30 PM', days_active: [1, 2, 3, 4, 5] });
    });

    it('reads a single-hour window', () => {
        const out = parseGoogleHappyHours(DEPOT);
        expect(out.ok).toBe(true);
        expect(only(out).time_window).toBe('5 PM - 6 PM');
        expect(only(out).days_active).toEqual([1, 2, 3, 4]);
    });
});

describe('parseGoogleHappyHours — inferring the meridiem backwards', () => {
    const one = (hours) => {
        const out = parseGoogleHappyHours(days({ Monday: hours }));
        return out.deals.length ? out.deals[0].time_window : null;
    };

    it.each([
        ['4–5:30 PM', g('4-5:30 PM'), '4 PM - 5:30 PM'],
        ['12–3 PM (noon, no flip needed)', g('12-3 PM'), '12 PM - 3 PM'],
        ['6–10 PM', g('6-10 PM'), '6 PM - 10 PM'],
        ['11 AM–2 PM (both stated)', g('11 AM-2 PM'), '11 AM - 2 PM'],
    ])('parses %s', (_label, input, expected) => {
        expect(one(input)).toBe(expected);
    });

    // The case the whole inference rule exists for: inheriting PM would put the
    // start at 11 PM, three hours after the end.
    it('flips the start to AM when inheriting would invert the window', () => {
        expect(one(g('11-1 PM'))).toBe('11 AM - 1 PM');
    });

    it('infers forwards too, when only the start states a meridiem', () => {
        expect(one(g('11 AM-1'))).toBe('11 AM - 1 PM');
    });

    // Both meridiems stated and the end is earlier: a real overnight happy
    // hour, which the app already handles. Not something to "correct".
    it('leaves a stated overnight window alone', () => {
        expect(one(g('9 PM-2 AM'))).toBe('9 PM - 2 AM');
    });
});

describe('parseGoogleHappyHours — what it refuses', () => {
    const refusalFor = (hours) => parseGoogleHappyHours(days({ Monday: hours }));

    it.each([
        ['a bare range with no meridiem anywhere', g('4-7')],
        ['Open 24 hours', 'Open 24 hours'],
        ['free text', 'Call for details'],
        ['a 13 o clock hour', g('13-15 PM')],
        ['impossible minutes', g('4:75-6 PM')],
        ['one side only', g('4 PM')],
    ])('refuses %s rather than guessing', (_label, hours) => {
        const out = refusalFor(hours);
        expect(out.ok).toBe(false);
        expect(out.deals).toEqual([]);
        expect(out.refusedBecause).toBeTruthy();
    });

    it.each([
        ['no additionalOpeningHours at all', undefined],
        ['an empty object', {}],
        ['only a Kitchen block', { Kitchen: [{ day: 'Monday', hours: '4 PM–12 AM' }] }],
        ['an empty Happy hours array', { 'Happy hours': [] }],
    ])('refuses %s', (_label, input) => {
        const out = parseGoogleHappyHours(input);
        expect(out.ok).toBe(false);
        expect(out.refusedBecause).toBe('no happy-hour hours published');
    });

    it('refuses a venue whose every day is closed', () => {
        const out = parseGoogleHappyHours(days({ Monday: 'Closed', Tuesday: 'Closed' }));
        expect(out.ok).toBe(false);
        expect(out.refusedBecause).toContain('closed');
    });

    // Two windows one day each used to be refused as "no majority". There is
    // no majority to find any more -- both are simply true.
    it('keeps two windows of one day each', () => {
        const out = parseGoogleHappyHours(days({ Monday: g('4-6 PM'), Tuesday: g('7-9 PM') }));
        expect(out.ok).toBe(true);
        expect(out.deals).toEqual([
            { time_window: '4 PM - 6 PM', days_active: [1] },
            { time_window: '7 PM - 9 PM', days_active: [2] },
        ]);
    });

    // Four different windows across five days was refused outright, because
    // whichever one won covered under half the week. All four are kept now.
    it('keeps a week with a different window nearly every day', () => {
        const out = parseGoogleHappyHours(days({
            Monday: g('4-6 PM'), Tuesday: g('4-6 PM'), Wednesday: g('7-9 PM'),
            Thursday: g('1-3 PM'), Friday: g('8-10 PM'),
        }));
        expect(out.ok).toBe(true);
        expect(out.deals).toHaveLength(4);
        expect(out.deals.flatMap((d) => d.days_active).sort()).toEqual([1, 2, 3, 4, 5]);
    });

    // A day whose hours could not be READ is a different problem from a day
    // with different hours, and it is still dropped -- and still reported, so
    // the dry-run report can show what Google published that we could not use.
    it('reports a day it could not read rather than inventing hours for it', () => {
        const out = parseGoogleHappyHours(days({
            Monday: g('4-6 PM'), Tuesday: g('4-7'), Wednesday: g('5-8'),
            Thursday: g('6-9'), Friday: g('2-4'),
        }));
        expect(out.ok).toBe(true);
        expect(out.openDays).toBe(5);
        expect(out.unparsedDays).toHaveLength(4);
        expect(only(out)).toEqual({ time_window: '4 PM - 6 PM', days_active: [1] });
        expect(out.droppedDays).toHaveLength(4);
    });

    it('ignores a day name it does not recognise', () => {
        const out = parseGoogleHappyHours(days({ Monday: g('4-6 PM'), Funday: g('9-11 PM') }));
        expect(out.ok).toBe(true);
        expect(only(out).days_active).toEqual([1]);
    });
});

describe('parseGoogleHappyHours — day mapping', () => {
    it('maps Sunday to 0 and Saturday to 6, matching days_active everywhere else', () => {
        const out = parseGoogleHappyHours(days({
            Sunday: g('4-6 PM'), Monday: g('4-6 PM'), Tuesday: g('4-6 PM'),
            Wednesday: g('4-6 PM'), Thursday: g('4-6 PM'), Friday: g('4-6 PM'),
            Saturday: g('4-6 PM'),
        }));
        expect(only(out).days_active).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('is not case sensitive about day names', () => {
        const out = parseGoogleHappyHours({ 'Happy hours': [{ day: 'MONDAY', hours: g('4-6 PM') }] });
        expect(only(out).days_active).toEqual([1]);
    });
});
