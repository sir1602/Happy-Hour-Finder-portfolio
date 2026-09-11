import { parseDealTime, parseDealWindow, getDealStatus } from '../../utils/dealTime';

describe('parseDealTime', () => {
    it('parses a valid "X PM - Y PM" time string', () => {
        const result = parseDealTime('4 PM - 6 PM');
        expect(result).toEqual({ startHour: 16, endHour: 18 });
    });

    it('parses a mixed AM/PM string', () => {
        const result = parseDealTime('11 AM - 2 PM');
        expect(result).toEqual({ startHour: 11, endHour: 14 });
    });

    it('handles 12 PM correctly', () => {
        const result = parseDealTime('12 PM - 3 PM');
        expect(result).toEqual({ startHour: 12, endHour: 15 });
    });

    it('handles 12 AM correctly', () => {
        const result = parseDealTime('12 AM - 2 AM');
        expect(result).toEqual({ startHour: 0, endHour: 2 });
    });

    it('returns null for invalid format', () => {
        expect(parseDealTime('anytime')).toBeNull();
        expect(parseDealTime('')).toBeNull();
    });

    it('parses overnight deal time correctly', () => {
        const result = parseDealTime('10 PM - 2 AM');
        expect(result).toEqual({ startHour: 22, endHour: 2 });
    });
});

describe('getDealStatus', () => {
    it('returns active when current time is within deal hours', () => {
        const now = new Date(2026, 0, 1, 17, 0); // 5:00 PM
        const result = getDealStatus('4 PM - 7 PM', [], now);
        expect(result.status).toBe('active');
        expect(result.label).toContain('Active');
    });

    it('returns upcoming when current time is before deal hours', () => {
        const now = new Date(2026, 0, 1, 14, 0); // 2:00 PM
        const result = getDealStatus('4 PM - 7 PM', [], now);
        expect(result.status).toBe('upcoming');
        expect(result.label).toContain('Starts in');
    });

    it('returns ended when current time is past deal hours', () => {
        const now = new Date(2026, 0, 1, 20, 0); // 8:00 PM
        const result = getDealStatus('4 PM - 7 PM', [], now);
        expect(result.status).toBe('ended');
        expect(result.label).toContain('Ended');
    });

    it('shows hours and minutes remaining for active deals', () => {
        const now = new Date(2026, 0, 1, 16, 30); // 4:30 PM
        const result = getDealStatus('4 PM - 7 PM', [], now);
        expect(result.status).toBe('active');
        expect(result.label).toContain('2h');
        expect(result.label).toContain('30m');
    });

    it('shows minutes-only for upcoming deals less than an hour away', () => {
        const now = new Date(2026, 0, 1, 15, 30); // 3:30 PM
        const result = getDealStatus('4 PM - 7 PM', [], now);
        expect(result.status).toBe('upcoming');
        expect(result.label).toContain('30m');
    });

    it('returns original text for unparseable deal times', () => {
        const result = getDealStatus('All Day');
        expect(result.status).toBe('active');
        expect(result.label).toBe('All Day');
    });

    // Failing Case for Overnight Deals
    it('handles overnight deals correctly (active just before midnight)', () => {
        const now = new Date(2026, 0, 1, 23, 0); // 11:00 PM
        const result = getDealStatus('10 PM - 2 AM', [], now);
        expect(result.status).toBe('active');
    });

    it('handles overnight deals correctly (active just after midnight)', () => {
        const now = new Date(2026, 0, 2, 1, 0); // 1:00 AM (next day logically)
        const result = getDealStatus('10 PM - 2 AM', [], now);
        expect(result.status).toBe('active');
    });

     it('handles overnight deals correctly (upcoming)', () => {
        const now = new Date(2026, 0, 1, 21, 0); // 9:00 PM
        const result = getDealStatus('10 PM - 2 AM', [], now);
        expect(result.status).toBe('upcoming');
    });

    it('handles overnight deals correctly (gap/upcoming)', () => {
        const now = new Date(2026, 0, 2, 3, 0); // 3:00 AM (After 2 AM end, before 10 PM start)
        const result = getDealStatus('10 PM - 2 AM', [], now);
        // For overnight deals, the gap between end and start is technically "upcoming" for the next cycle
        expect(result.status).toBe('upcoming');
    });

    // Day-of-week tests
    it('shows schedule info when deal is not for today', () => {
        // Thursday Jan 1, 2026 is a Thursday (day 4)
        const now = new Date(2026, 0, 1, 17, 0); // 5 PM Thursday
        const result = getDealStatus('4 PM - 7 PM', [1, 2, 3], now); // Mon-Wed only
        expect(result.status).toBe('ended');
        expect(result.label).toContain('Mon');
        expect(result.label).toContain('Tue');
        expect(result.label).toContain('Wed');
    });

    it('evaluates time normally when today is in activeDays', () => {
        // Thursday Jan 1, 2026 is a Thursday (day 4)
        const now = new Date(2026, 0, 1, 17, 0); // 5 PM Thursday
        const result = getDealStatus('4 PM - 7 PM', [4, 5], now); // Thu-Fri
        expect(result.status).toBe('active');
        expect(result.label).toContain('Active');
    });

    it('evaluates time normally when activeDays is empty (all days)', () => {
        const now = new Date(2026, 0, 1, 17, 0); // 5 PM
        const result = getDealStatus('4 PM - 7 PM', [], now);
        expect(result.status).toBe('active');
    });

    it('handles overnight deal with day check: active before midnight on correct day', () => {
        // Thursday (day 4) at 11 PM, deal is 10 PM - 2 AM on [4, 5]
        const now = new Date(2026, 0, 1, 23, 0); // 11 PM Thursday
        const result = getDealStatus('10 PM - 2 AM', [4, 5], now);
        expect(result.status).toBe('active');
    });

    it('handles overnight deal with day check: active after midnight, deal started yesterday', () => {
        // Friday (day 5) at 1 AM, deal is 10 PM - 2 AM on [4] (Thu only)
        // dealDay should adjust to Thursday (4) since we are in overnight after-midnight window
        const now = new Date(2026, 0, 2, 1, 0); // 1 AM Friday
        const result = getDealStatus('10 PM - 2 AM', [4], now);
        expect(result.status).toBe('active'); // deal started on Thursday, still running
    });

    it('shows schedule info for overnight deal when day does not match', () => {
        // Wednesday (day 3) at 11 PM, deal runs Thu only
        const now = new Date(2025, 11, 31, 23, 0); // 11 PM Wednesday
        const result = getDealStatus('10 PM - 2 AM', [4], now); // Thu only
        expect(result.status).toBe('ended');
        expect(result.label).toContain('Thu');
    });
});

describe('a deal that runs until close', () => {
    // The countdown is lost for these deals and these deals only: every other
    // deal on the card list still counts down as before.
    const at = (hour: number, minute = 0) => new Date(2026, 0, 5, hour, minute);

    it('parses the start and leaves the end open', () => {
        expect(parseDealWindow('4:00 PM - Close')).toEqual({ startHour: 16, endHour: null });
    });

    it('gives parseDealTime nothing, so callers needing an end degrade', () => {
        expect(parseDealTime('4:00 PM - Close')).toBeNull();
    });

    it('counts down to the start before it opens', () => {
        const result = getDealStatus('4:00 PM - Close', [], at(14, 30));
        expect(result.status).toBe('upcoming');
        expect(result.label).toBe('⏳ Starts in 1h 30m');
    });

    it('says active without a countdown once it has started', () => {
        const result = getDealStatus('4:00 PM - Close', [], at(18));
        expect(result.status).toBe('active');
        expect(result.label).toBe('🟢 Active · until close');
        expect(result.label).not.toMatch(/left|Ends in/);
    });

    it('still respects the days it runs on', () => {
        // 2026-01-05 is a Monday; this deal is Tue-Wed only.
        const result = getDealStatus('4:00 PM - Close', [2, 3], at(18));
        expect(result.status).toBe('ended');
        expect(result.label).toContain('Tue, Wed');
    });

    it('leaves a normal window counting down as it always did', () => {
        const result = getDealStatus('4 PM - 6 PM', [], at(17));
        expect(result.status).toBe('active');
        expect(result.label).toBe('🟢 Active · 1h 0m left');
    });

    it('still shows a genuinely unreadable window as written', () => {
        expect(getDealStatus('whenever', [], at(18))).toEqual({
            status: 'active',
            label: 'whenever',
        });
    });
});
