import { localDayBounds } from '../../services/visitService';

jest.mock('../../services/supabase', () => ({
    supabase: { from: jest.fn() },
}));

describe('localDayBounds', () => {
    it('spans exactly 24 hours', () => {
        const { startMs, endMs } = localDayBounds(new Date('2026-08-07T22:30:00Z'));
        expect(endMs - startMs).toBe(24 * 60 * 60 * 1000);
    });

    it('brackets the given instant', () => {
        const now = new Date('2026-08-07T22:30:00Z');
        const { startMs, endMs } = localDayBounds(now);
        expect(now.getTime()).toBeGreaterThanOrEqual(startMs);
        expect(now.getTime()).toBeLessThan(endMs);
    });

    it('starts at local midnight, not UTC midnight', () => {
        const start = new Date(localDayBounds(new Date('2026-08-07T22:30:00Z')).startMs);
        expect(start.getHours()).toBe(0);
        expect(start.getMinutes()).toBe(0);
        expect(start.getSeconds()).toBe(0);
        expect(start.getMilliseconds()).toBe(0);
    });

    /**
     * The regression this fix exists for. Deriving the day from
     * `new Date().toISOString().split('T')[0]` yields the UTC date, which for
     * US-Central rolls over at 6-7 PM local — inside happy hour. Two check-ins
     * on the same local evening then land on different "days", so the duplicate
     * guard misses and points are awarded twice.
     */
    it('puts two check-ins on the same local evening in the same day window', () => {
        // 5 PM and 8 PM on the same local calendar day.
        const early = new Date(2026, 7, 7, 17, 0, 0);
        const late = new Date(2026, 7, 7, 20, 0, 0);

        const bounds = localDayBounds(early);
        expect(late.getTime()).toBeGreaterThanOrEqual(bounds.startMs);
        expect(late.getTime()).toBeLessThan(bounds.endMs);

        // Both instants must agree on the same window.
        expect(localDayBounds(late)).toEqual(bounds);

        // Contrast with the old UTC-date approach, which is what broke: in any
        // timezone behind UTC these two produce different date strings.
        if (early.getTimezoneOffset() > 0) {
            expect(early.toISOString().split('T')[0]).not.toBe(late.toISOString().split('T')[0]);
        }
    });

    it('separates instants that fall on different local days', () => {
        const tonight = new Date(2026, 7, 7, 23, 30, 0);
        const tomorrow = new Date(2026, 7, 8, 0, 30, 0);
        expect(localDayBounds(tonight)).not.toEqual(localDayBounds(tomorrow));

        const bounds = localDayBounds(tonight);
        expect(tomorrow.getTime()).toBeGreaterThanOrEqual(bounds.endMs);
    });

    it('exposes ISO strings matching the numeric bounds for query use', () => {
        const { start, end, startMs, endMs } = localDayBounds(new Date('2026-08-07T22:30:00Z'));
        expect(Date.parse(start)).toBe(startMs);
        expect(Date.parse(end)).toBe(endMs);
    });
});
