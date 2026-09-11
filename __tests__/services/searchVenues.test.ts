import { searchVenues } from '../../services/dealService';
import { supabase } from '../../services/supabase';

jest.mock('../../services/supabase', () => ({
    supabase: { from: jest.fn() },
}));

jest.mock('../../services/cacheService', () => ({
    cacheService: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
}));

const CHICAGO_SCOPE = {
    center: { latitude: 41.8781, longitude: -87.6298 },
    radiusKm: 60,
    metro: null,
    isFallback: false,
    distanceKm: null,
} as any;

const venueRow = (over: Partial<Record<string, any>> = {}) => ({
    id: 'v1',
    name: 'The Tap Room',
    address: '745 N Birch Ave',
    neighborhood: 'River North',
    latitude: 41.89,
    longitude: -87.63,
    ...over,
});

/** Builds the chainable query mock and hands back the spies worth asserting on. */
const mockVenues = (rows: any[] | null, error: any = null) => {
    const query: any = {
        select: jest.fn().mockReturnThis(),
        ilike: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        lte: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        then: undefined,
    };
    // The service awaits the built query, so make the terminal call thenable.
    query.limit = jest.fn(() => Object.assign(query, {
        then: (resolve: any) => resolve({ data: rows, error }),
    }));
    (supabase.from as jest.Mock).mockReturnValue(query);
    return query;
};

beforeEach(() => jest.clearAllMocks());

describe('searchVenues', () => {
    it('does not hit the network for a query shorter than two characters', async () => {
        expect(await searchVenues('t', CHICAGO_SCOPE)).toEqual([]);
        expect(await searchVenues('  ', CHICAGO_SCOPE)).toEqual([]);
        expect(supabase.from).not.toHaveBeenCalled();
    });

    it('escapes LIKE wildcards so a query of "%" cannot match every venue', async () => {
        const query = mockVenues([]);
        await searchVenues('100%', CHICAGO_SCOPE);
        expect(query.ilike).toHaveBeenCalledWith('name', '%100\\%%');
    });

    it('matches on substring, so "tap room" finds "The Tap Room"', async () => {
        const query = mockVenues([venueRow()]);
        await searchVenues('tap room', CHICAGO_SCOPE);
        expect(query.ilike).toHaveBeenCalledWith('name', '%tap room%');
    });

    it('constrains results to the active scope', async () => {
        // Without this a Phoenix submitter is offered a Chicago venue and,
        // tapping it, files the deal at a Chicago address.
        const query = mockVenues([venueRow()]);
        await searchVenues('tap', CHICAGO_SCOPE);
        expect(query.gte).toHaveBeenCalledWith('latitude', expect.any(Number));
        expect(query.lte).toHaveBeenCalledWith('latitude', expect.any(Number));
        expect(query.gte).toHaveBeenCalledWith('longitude', expect.any(Number));
        expect(query.lte).toHaveBeenCalledWith('longitude', expect.any(Number));
    });

    it('omits the bounds when no scope has resolved yet', async () => {
        const query = mockVenues([venueRow()]);
        await searchVenues('tap', null);
        expect(query.gte).not.toHaveBeenCalled();
        expect(query.lte).not.toHaveBeenCalled();
    });

    it('excludes venues that have closed for good', async () => {
        const query = mockVenues([]);
        await searchVenues('tap', CHICAGO_SCOPE);
        expect(query.eq).toHaveBeenCalledWith('permanently_closed', false);
    });

    it('over-fetches so the distance sort has more than an arbitrary page to choose from', async () => {
        const query = mockVenues([]);
        await searchVenues('tap', CHICAGO_SCOPE, { limit: 8 });
        expect(query.limit).toHaveBeenCalledWith(24);
    });

    it('sorts by distance and trims to the requested limit', async () => {
        mockVenues([
            venueRow({ id: 'far', latitude: 42.5, longitude: -87.63 }),
            venueRow({ id: 'near', latitude: 41.88, longitude: -87.63 }),
            venueRow({ id: 'middle', latitude: 42.0, longitude: -87.63 }),
        ]);

        const results = await searchVenues('tap', CHICAGO_SCOPE, {
            limit: 2,
            near: { latitude: 41.8781, longitude: -87.6298 },
        });

        expect(results.map(r => r.id)).toEqual(['near', 'middle']);
        expect(results[0].distanceKm).toBeLessThan(results[1].distanceKm as number);
    });

    it('falls back to name order when the user location is unknown', async () => {
        mockVenues([venueRow({ id: 'b', name: 'Zebra Bar' }), venueRow({ id: 'a', name: 'Alpha Bar' })]);
        const results = await searchVenues('bar', CHICAGO_SCOPE);
        expect(results.map(r => r.id)).toEqual(['a', 'b']);
        expect(results[0].distanceKm).toBeNull();
    });

    it('returns no suggestions rather than throwing when the lookup fails', async () => {
        // Typing must not be interrupted by a rejected promise.
        mockVenues(null, { message: 'network down' });
        await expect(searchVenues('tap', CHICAGO_SCOPE)).resolves.toEqual([]);
    });
});
