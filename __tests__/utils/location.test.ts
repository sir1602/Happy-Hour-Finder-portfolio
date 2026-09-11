import { calculateDistance, calculateDistanceKm } from '../../utils/location';

describe('calculateDistance', () => {
    it('returns 0 for the same coordinates', () => {
        const dist = calculateDistance(41.8781, -87.6298, 41.8781, -87.6298);
        expect(dist).toBe(0);
    });

    it('calculates a known distance between two Chicago landmarks', () => {
        // Willis Tower (41.8789, -87.6359) to Navy Pier (41.8917, -87.6086)
        // Real distance is approximately 1.6 miles
        const dist = calculateDistance(41.8789, -87.6359, 41.8917, -87.6086);
        expect(dist).toBeGreaterThan(1.0);
        expect(dist).toBeLessThan(2.5);
    });

    it('calculates distance between two hardcoded deals correctly', () => {
        // The Draft House (41.8920, -87.6318) to The Local Pour (41.9295, -87.7078)
        // Should be a few miles apart
        const dist = calculateDistance(41.8920, -87.6318, 41.9295, -87.7078);
        expect(dist).toBeGreaterThan(2.0);
        expect(dist).toBeLessThan(5.0);
    });

    it('returns the same distance regardless of direction', () => {
        const dist1 = calculateDistance(41.8781, -87.6298, 41.9000, -87.6500);
        const dist2 = calculateDistance(41.9000, -87.6500, 41.8781, -87.6298);
        expect(dist1).toEqual(dist2);
    });

    it('handles cross-hemisphere coordinates', () => {
        // New York to London (approximate)
        const dist = calculateDistance(40.7128, -74.0060, 51.5074, -0.1278);
        expect(dist).toBeGreaterThan(3400);
        expect(dist).toBeLessThan(3500);
    });

    it('returns a number with one decimal place', () => {
        const dist = calculateDistance(41.8781, -87.6298, 41.9000, -87.6500);
        const decimalPlaces = dist.toString().split('.')[1]?.length || 0;
        expect(decimalPlaces).toBeLessThanOrEqual(1);
    });
});

describe('calculateDistanceKm', () => {
    it('returns kilometres, not miles', () => {
        // Chicago Loop -> Kenosha WI is ~80 km / ~50 mi. The two units are far
        // enough apart here that a regression to miles cannot pass this.
        const km = calculateDistanceKm(41.8781, -87.6298, 42.5847, -87.8212);

        expect(km).toBeGreaterThan(78);
        expect(km).toBeLessThan(82);
    });

    it('is the mile figure divided by the conversion factor', () => {
        const args = [41.8781, -87.6298, 42.5847, -87.8212] as const;

        expect(calculateDistance(...args)).toBeCloseTo(calculateDistanceKm(...args) * 0.621371, 1);
    });

    it('is unrounded, so callers can round at their own precision', () => {
        const km = calculateDistanceKm(41.8781, -87.6298, 41.9, -87.65);

        expect(km % 1).not.toBe(0);
    });

    it('returns 0 for the same coordinates', () => {
        expect(calculateDistanceKm(41.8781, -87.6298, 41.8781, -87.6298)).toBe(0);
    });
});
