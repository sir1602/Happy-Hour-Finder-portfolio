import { resolveLocationScope, scopeCacheKey, DEFAULT_RADIUS_KM } from '../../services/metroService';
import { supabase } from '../../services/supabase';
import { cacheService } from '../../services/cacheService';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../../services/supabase', () => ({
    supabase: { from: jest.fn() },
}));

const CHICAGO = {
    id: 'm1', slug: 'chicago', name: 'Chicago, IL',
    center_lat: 41.8781, center_lng: -87.6298, radius_km: 60,
    geocode_suffix: ', Chicago, IL', timezone: 'America/Chicago',
};
const PHOENIX = {
    id: 'm2', slug: 'phoenix', name: 'Phoenix, AZ',
    center_lat: 33.4484, center_lng: -112.0740, radius_km: 60,
    geocode_suffix: ', Phoenix, AZ', timezone: 'America/Phoenix',
};

const mockMetroRows = (rows: unknown[]) => {
    const orderMock = jest.fn().mockResolvedValue({ data: rows, error: null });
    const selectMock = jest.fn().mockReturnValue({ order: orderMock });
    (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });
};

describe('resolveLocationScope', () => {
    beforeEach(async () => {
        jest.clearAllMocks();
        await cacheService.remove('metros');
        await AsyncStorage.clear();
        mockMetroRows([CHICAGO, PHOENIX]);
    });

    it('centres on the user when they are inside a covered metro', async () => {
        // Wrigleyville, comfortably inside Chicago's radius.
        const scope = await resolveLocationScope({ latitude: 41.9484, longitude: -87.6553 });

        expect(scope.metro?.slug).toBe('chicago');
        expect(scope.isFallback).toBe(false);
        expect(scope.center).toEqual({ latitude: 41.9484, longitude: -87.6553 });
        expect(scope.radiusKm).toBe(DEFAULT_RADIUS_KM);
    });

    it('picks the metro the user is actually in, not the first one listed', async () => {
        // Downtown Phoenix. Chicago is listed first, so this fails if the
        // lookup returns the head of the list rather than the nearest match.
        const scope = await resolveLocationScope({ latitude: 33.4484, longitude: -112.0740 });

        expect(scope.metro?.slug).toBe('phoenix');
        expect(scope.isFallback).toBe(false);
    });

    it('falls back to the nearest metro when the user is outside every radius', async () => {
        // Denver: not covered, and closer to Phoenix than to Chicago.
        const scope = await resolveLocationScope({ latitude: 39.7392, longitude: -104.9903 });

        expect(scope.isFallback).toBe(true);
        expect(scope.metro?.slug).toBe('phoenix');
        // Centred on the metro, not the user, so the user actually sees deals.
        expect(scope.center).toEqual({ latitude: PHOENIX.center_lat, longitude: PHOENIX.center_lng });
        expect(scope.distanceKm).toBeGreaterThan(100);
    });

    it('uses the remembered metro when there is no location fix', async () => {
        await resolveLocationScope({ latitude: 33.4484, longitude: -112.0740 });
        jest.clearAllMocks();
        mockMetroRows([CHICAGO, PHOENIX]);

        const scope = await resolveLocationScope(null);

        expect(scope.metro?.slug).toBe('phoenix');
        expect(scope.center).toEqual({ latitude: PHOENIX.center_lat, longitude: PHOENIX.center_lng });
    });

    it('still returns a usable scope when the metros table cannot be read', async () => {
        const orderMock = jest.fn().mockResolvedValue({ data: null, error: new Error('offline') });
        const selectMock = jest.fn().mockReturnValue({ order: orderMock });
        (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

        const scope = await resolveLocationScope(null);

        expect(scope.center.latitude).toEqual(expect.any(Number));
        expect(scope.radiusKm).toBeGreaterThan(0);
    });

    // ── Radius unit regression ───────────────────────────────────────────
    //
    // `distanceKmTo` used to call `calculateDistance`, which returns MILES,
    // and compare the result against `metros.radius_km`. That made a 60 km
    // metro behave as a 60 MILE one, so anyone up to ~96 km out was judged
    // "inside" it: centred on themselves, with a 60 km box that contains none
    // of the city's venues, and `isFallback` false so nothing could explain
    // the empty screen. Every case below sits in that 60-96 km band, which is
    // exactly where the two units disagree.
    it.each([
        ['Michigan City, IN', 41.7075, -86.8950, 63.8],
        ['Kenosha, WI', 42.5847, -87.8212, 80.1],
        ['DeKalb, IL', 41.9294, -88.7504, 92.9],
    ])('treats %s as outside the 60 km Chicago radius', async (_name, latitude, longitude, expectedKm) => {
        const scope = await resolveLocationScope({ latitude, longitude });

        // Real distance, in kilometres -- not miles wearing a km label.
        expect(scope.distanceKm).toBeCloseTo(expectedKm, 0);
        expect(scope.distanceKm).toBeGreaterThan(CHICAGO.radius_km);

        // So the user is out of coverage: re-centred on the city, and flagged
        // so the UI can say why it is showing deals from somewhere else.
        expect(scope.isFallback).toBe(true);
        expect(scope.metro?.slug).toBe('chicago');
        expect(scope.center).toEqual({ latitude: CHICAGO.center_lat, longitude: CHICAGO.center_lng });
    });

    it('still counts a point just inside the radius as covered', async () => {
        // ~52 km NW of the Loop: inside 60 km either way, so this pins the
        // boundary from the other side and fails if the fix over-corrects.
        const scope = await resolveLocationScope({ latitude: 42.1354, longitude: -88.1290 });

        expect(scope.distanceKm).toBeLessThan(CHICAGO.radius_km);
        expect(scope.isFallback).toBe(false);
        expect(scope.center).toEqual({ latitude: 42.1354, longitude: -88.1290 });
    });
});

describe('scopeCacheKey', () => {
    it('differs between cities so a cached response is not reused across them', () => {
        const chicago = scopeCacheKey({
            center: { latitude: 41.8781, longitude: -87.6298 },
            radiusKm: 60, metro: null, isFallback: false, distanceKm: null,
        });
        const phoenix = scopeCacheKey({
            center: { latitude: 33.4484, longitude: -112.0740 },
            radiusKm: 60, metro: null, isFallback: false, distanceKm: null,
        });

        expect(chicago).not.toEqual(phoenix);
    });

    it('is stable under small GPS jitter, so the cache is not thrashed', () => {
        const a = scopeCacheKey({
            center: { latitude: 41.87811, longitude: -87.62981 },
            radiusKm: 60, metro: null, isFallback: false, distanceKm: null,
        });
        const b = scopeCacheKey({
            center: { latitude: 41.87817, longitude: -87.62988 },
            radiusKm: 60, metro: null, isFallback: false, distanceKm: null,
        });

        expect(a).toEqual(b);
    });
});
