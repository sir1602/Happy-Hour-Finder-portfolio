import {
    normalizeTimeWindow,
    buildTimeWindow,
    formatTimeLabel,
    timeWindowToMinutes,
    parseDealTime,
    parseDealWindow,
} from '../../utils/dealTime';

/**
 * A literal copy of public.hh_is_valid_time_window()'s pattern, as widened by
 * scripts/migration_open_ended_time_windows.sql.
 *
 * Anything this normalizer emits has to satisfy the database as well as the
 * app: hh_review_deal() refuses to approve a deal whose window fails this
 * check, so a form that accepted something the server rejects would produce
 * submissions no moderator could ever publish.
 */
const POSTGRES_TIME_WINDOW =
    /^\s*\d{1,2}(:\d{2})?\s*(AM|PM)\s*-\s*(\d{1,2}(:\d{2})?\s*(AM|PM)|CLOSE)\s*$/i;

describe('normalizeTimeWindow', () => {
    describe('accepts what people and menu boards actually write', () => {
        const cases: [string, string][] = [
            // Already canonical
            ['4:00 PM - 6:00 PM', '4:00 PM - 6:00 PM'],
            // Terser 12-hour, the format the old placeholder suggested
            ['4 PM - 6 PM', '4:00 PM - 6:00 PM'],
            // No spaces, lowercase — what a person types in a hurry
            ['3pm-6pm', '3:00 PM - 6:00 PM'],
            ['3PM-6PM', '3:00 PM - 6:00 PM'],
            // Meridiem on the closing half only
            ['3-6pm', '3:00 PM - 6:00 PM'],
            ['4 - 7 pm', '4:00 PM - 7:00 PM'],
            // Meridiem on the opening half only
            ['11am-2', '11:00 AM - 2:00 PM'],
            // 24-hour, which the old validator rejected outright
            ['15:00-18:00', '3:00 PM - 6:00 PM'],
            ['15:00 - 18:30', '3:00 PM - 6:30 PM'],
            ['17-19', '5:00 PM - 7:00 PM'],
            // Bare numbers: PM is the happy-hour reading
            ['3-6', '3:00 PM - 6:00 PM'],
            ['4-7', '4:00 PM - 7:00 PM'],
            // ...unless PM would put the start after the end
            ['11-2', '11:00 AM - 2:00 PM'],
            // Word separators
            ['4pm to 6pm', '4:00 PM - 6:00 PM'],
            ['4 PM until 6 PM', '4:00 PM - 6:00 PM'],
            ['4pm till 6pm', '4:00 PM - 6:00 PM'],
            // En and em dashes, which copy-paste from a website produces
            ['4 PM – 6 PM', '4:00 PM - 6:00 PM'],
            ['4 PM — 6 PM', '4:00 PM - 6:00 PM'],
            // Dotted meridiem
            ['4 p.m. - 6 p.m.', '4:00 PM - 6:00 PM'],
            ['4p-6p', '4:00 PM - 6:00 PM'],
            // Minutes
            ['11:30am-2:00pm', '11:30 AM - 2:00 PM'],
            ['4:15 PM - 6:45 PM', '4:15 PM - 6:45 PM'],
            // Named times
            ['noon - 3pm', '12:00 PM - 3:00 PM'],
            ['9pm - midnight', '9:00 PM - 12:00 AM'],
            // Untrimmed
            ['  4pm-6pm  ', '4:00 PM - 6:00 PM'],
        ];

        it.each(cases)('normalizes %s', (input, expected) => {
            expect(normalizeTimeWindow(input)).toBe(expected);
        });
    });

    describe('preserves overnight windows', () => {
        // getDealStatus has dedicated branches for endHour < startHour and
        // dealTime.test.ts covers them; a normalizer that "corrected" these
        // would make late-night happy hours unenterable.
        const cases: [string, string][] = [
            ['10pm-2am', '10:00 PM - 2:00 AM'],
            ['9 PM - 1 AM', '9:00 PM - 1:00 AM'],
            ['11pm-2am', '11:00 PM - 2:00 AM'],
            ['22:00-02:00', '10:00 PM - 2:00 AM'],
        ];

        it.each(cases)('keeps %s pointing at the next morning', (input, expected) => {
            expect(normalizeTimeWindow(input)).toBe(expected);
        });
    });

    describe('rejects what cannot be stored as two clock times', () => {
        const cases = [
            '',
            '   ',
            'whenever',
            'happy hour',
            // No separator, or too many
            '4pm',
            '4pm-6pm-8pm',
            '-6pm',
            '4pm-',
            // Out of range
            '13pm-15pm',
            '4:70pm-6pm',
            '25:00-26:00',
            // A window of zero length is not a window
            '4pm-4pm',
            // No start time either, so there is nothing to store
            'all day',
            'varies',
        ];

        it.each(cases)('rejects %p', (input) => {
            expect(normalizeTimeWindow(input)).toBeNull();
        });

    });

    describe('accepts a window that runs until close', () => {
        // Plenty of happy hours advertise this way. Storing the start and
        // marking the end open costs the countdown, and only for these deals.
        const cases: [string, string][] = [
            ['4pm-close', '4:00 PM - Close'],
            ['4 PM - closing', '4:00 PM - Close'],
            ['5pm - late', '5:00 PM - Close'],
            ['5 PM until close', '5:00 PM - Close'],
            // A bare start reads as PM, same as any other happy hour
            ['4-close', '4:00 PM - Close'],
            ['11am-close', '11:00 AM - Close'],
            ['17:00-close', '5:00 PM - Close'],
        ];

        it.each(cases)('normalizes %s', (input, expected) => {
            expect(normalizeTimeWindow(input)).toBe(expected);
        });

        it('is idempotent, so re-normalizing a stored window is a no-op', () => {
            expect(normalizeTimeWindow('4:00 PM - Close')).toBe('4:00 PM - Close');
        });

        it('gives parseDealTime nothing to count down, but keeps the start', () => {
            const out = normalizeTimeWindow('4pm-close') as string;
            expect(parseDealTime(out)).toBeNull();
            expect(parseDealWindow(out)).toEqual({ startHour: 16, endHour: null });
        });
    });

    describe('invariants', () => {
        const accepted = [
            '3-6pm', '15:00-18:00', '11-2', '10pm-2am', 'noon - 3pm',
            '4 PM – 6 PM', '11:30am-2:00pm', '9pm - midnight', '4p-6p', '17-19',
            '4pm-close', '11am-close',
        ];

        it.each(accepted)('output of %p is readable by the app', (input) => {
            const out = normalizeTimeWindow(input);
            expect(out).not.toBeNull();
            // parseDealWindow, not parseDealTime: an open-ended window is
            // readable but deliberately has no end to count down to.
            expect(parseDealWindow(out as string)).not.toBeNull();
        });

        it.each(accepted.filter(i => !/close/i.test(i)))(
            'output of %p also parses under parseDealTime, so it keeps its countdown',
            (input) => {
                expect(parseDealTime(normalizeTimeWindow(input) as string)).not.toBeNull();
            },
        );

        it.each(accepted)('output of %p satisfies the Postgres validator', (input) => {
            expect(normalizeTimeWindow(input) as string).toMatch(POSTGRES_TIME_WINDOW);
        });

        it.each(accepted)('normalizing %p twice changes nothing', (input) => {
            const once = normalizeTimeWindow(input) as string;
            expect(normalizeTimeWindow(once)).toBe(once);
        });
    });
});

describe('formatTimeLabel', () => {
    it.each([
        [0, '12:00 AM'],
        [30, '12:30 AM'],
        [660, '11:00 AM'],
        [720, '12:00 PM'],
        [780, '1:00 PM'],
        [1410, '11:30 PM'],
    ])('renders %i minutes as %s', (minutes, expected) => {
        expect(formatTimeLabel(minutes)).toBe(expected);
    });

    it('wraps past midnight so an end picker can offer the next morning', () => {
        expect(formatTimeLabel(1440)).toBe('12:00 AM');
        expect(formatTimeLabel(1560)).toBe('2:00 AM');
    });
});

describe('buildTimeWindow / timeWindowToMinutes', () => {
    it('composes a canonical window from two picker slots', () => {
        expect(buildTimeWindow(16 * 60, 18 * 60)).toBe('4:00 PM - 6:00 PM');
    });

    it('composes an overnight window from an end past midnight', () => {
        expect(buildTimeWindow(22 * 60, 26 * 60)).toBe('10:00 PM - 2:00 AM');
    });

    it('round-trips a same-day window back to its slots', () => {
        expect(timeWindowToMinutes('4:00 PM - 6:00 PM')).toEqual({
            startMinutes: 16 * 60,
            endMinutes: 18 * 60,
        });
    });

    it('round-trips an overnight window with the end pushed past midnight', () => {
        // So the End picker seeds to "2 AM" rather than to a slot before the start.
        expect(timeWindowToMinutes('10:00 PM - 2:00 AM')).toEqual({
            startMinutes: 22 * 60,
            endMinutes: 26 * 60,
        });
    });

    it('returns null for a window that does not parse', () => {
        expect(timeWindowToMinutes('whenever')).toBeNull();
    });

    it('seeds the End picker as open for a window that runs until close', () => {
        expect(timeWindowToMinutes('4:00 PM - Close')).toEqual({
            startMinutes: 16 * 60,
            endMinutes: null,
        });
    });

    it('composes an open-ended window from a null end', () => {
        expect(buildTimeWindow(16 * 60, null)).toBe('4:00 PM - Close');
    });

    it('seeds the pickers from a scanned photo string', () => {
        // dealScanService hands back whatever the model read off the menu.
        const scanned = '3-6pm';
        const canonical = normalizeTimeWindow(scanned) as string;
        expect(timeWindowToMinutes(canonical)).toEqual({
            startMinutes: 15 * 60,
            endMinutes: 18 * 60,
        });
    });
});
