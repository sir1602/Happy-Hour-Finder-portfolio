import {
    getDeals,
    getDealById,
    getHighlightDeals,
    searchDeals,
    filterDeals,
    getAllTags,
    getAllNeighborhoods,
} from '../../services/dealService';
import { supabase } from '../../services/supabase';
import { Deal } from '../../types';
import { cacheService } from '../../services/cacheService';

// Mock Supabase
jest.mock('../../services/supabase', () => ({
    supabase: {
        from: jest.fn()
    }
}));

// Test fixture data (previously in constants.ts, now inlined for tests)
const DEALS: Deal[] = [
    {
        id: '1', venueId: 'v1', name: 'The Draft House', deal: '$5 Craft Beers',
        image: 'https://picsum.photos/seed/drafthouse/600/400', neighborhood: 'River North',
        distance: '', price: 2, rating: 4.5, reviewCount: 182,
        tags: ['Craft Beer', 'Bar', 'Casual'], address: '745 N Birch Ave, Chicago, IL',
        website: 'thedrafthouse.com', phone: '(312) 555-1234', type: 'trending',
        time: '4 PM - 6 PM', latitude: 41.892, longitude: -87.6318,
        daysActive: [0, 1, 2, 3, 4, 5, 6],
    },
    {
        id: '2', venueId: 'v2', name: 'Amber & Ash', deal: 'Half-Price Appetizers',
        image: 'https://picsum.photos/seed/amberash/600/400', neighborhood: 'Wicker Park',
        distance: '', price: 3, rating: 4.7, reviewCount: 254,
        tags: ['Gastropub', 'Modern', 'Patio'], address: '220 N Oak St, Chicago, IL',
        website: 'amberandash.com', phone: '(773) 555-5678', type: 'ends-soon',
        endsIn: '2h', time: '5 PM - 7 PM', latitude: 41.9085, longitude: -87.6773,
        daysActive: [0, 1, 2, 3, 4, 5, 6],
    },
    {
        id: '3', venueId: 'v3', name: 'The Local Pour', deal: '2-for-1 Well Drinks',
        image: 'https://picsum.photos/seed/localpour/600/400', neighborhood: 'Logan Square',
        distance: '', price: 1, rating: 4.2, reviewCount: 98,
        tags: ['Dive Bar', 'Live Music'], address: '340 N Elm St, Chicago, IL',
        website: 'thelocalpour.com', phone: '(773) 555-9012', type: 'new',
        time: '3 PM - 5 PM', latitude: 41.9295, longitude: -87.7078,
        daysActive: [0, 1, 2, 3, 4, 5, 6],
    },
    {
        id: '4', venueId: 'v4', name: 'The Aviary', deal: 'Happy Hour Special',
        image: 'https://picsum.photos/seed/aviary/600/400', neighborhood: 'West Loop',
        distance: '', price: 4, rating: 4.8, reviewCount: 312,
        tags: ['Craft Cocktails', 'Patio', 'Upscale'], address: '410 W Maple Ave, Chicago, IL',
        website: 'theaviary.com', phone: '(312) 226-0868', type: 'regular',
        time: '4 PM - 6 PM', latitude: 41.885, longitude: -87.6515,
        daysActive: [0, 1, 2, 3, 4, 5, 6],
    },
    {
        id: '5', venueId: 'v5', name: 'Taco Bar', deal: '$3 Tacos & $5 Margaritas',
        image: 'https://picsum.photos/seed/tacobar/600/400', neighborhood: 'Wicker Park',
        distance: '', price: 2, rating: 4.6, reviewCount: 1204,
        tags: ['Tacos', 'Whiskey', 'Patio'], address: '100 N Main St, Chicago, IL',
        website: 'tacobar.example', phone: '(773) 235-4039', type: 'regular',
        time: '3 PM - 6 PM', latitude: 41.909, longitude: -87.6775,
        daysActive: [0, 1, 2, 3, 4, 5, 6],
    },
    {
        id: '6', venueId: 'v6', name: 'Parlor Pizza Bar', deal: 'Half-Price Pizzas',
        image: 'https://picsum.photos/seed/parlor/600/400', neighborhood: 'West Loop',
        distance: '', price: 2, rating: 4.4, reviewCount: 876,
        tags: ['Pizza', 'Beer Garden', 'Sports'], address: '525 N Cedar St, Chicago, IL',
        website: 'parlorchicago.com', phone: '(312) 600-6090', type: 'regular',
        time: '4 PM - 6 PM', latitude: 41.8856, longitude: -87.6534,
        daysActive: [0, 1, 2, 3, 4, 5, 6],
    },
    {
        id: '7', venueId: 'v7', name: 'The Reveler', deal: '$5 Drafts',
        image: 'https://picsum.photos/seed/reveler/600/400', neighborhood: 'Logan Square',
        distance: '', price: 1, rating: 4.1, reviewCount: 341,
        tags: ['Bar', 'American', 'Sports'], address: '630 N Pine St, Chicago, IL',
        website: 'revelerchicago.com', phone: '(773) 283-6500', type: 'regular',
        time: '4 PM - 6 PM', latitude: 41.9442, longitude: -87.7128,
        daysActive: [0, 1, 2, 3, 4, 5, 6],
    },
];

describe('dealService', () => {
    beforeEach(async () => {
        jest.clearAllMocks();
        await cacheService.clear();
    });

    // Helper mock matching the structure expected by mapSupabaseToDeal
    const mockDbRow = {
        id: '1',
        title: '$5 Craft Beers',
        price_level: 2,
        tags: ['Drafts', 'Craft Beer'],
        type: 'regular',
        venues: {
            name: 'The Draft House',
            neighborhood: 'River North',
            image_url: 'https://picsum.photos/seed/drafthouse/600/400'
        }
    };

    describe('getDeals', () => {
        it('returns mapped deals from Supabase via PostgREST (no query)', async () => {
            const queryMock: any = {
                eq: jest.fn().mockReturnThis(),
                contains: jest.fn().mockReturnThis(),
                ilike: jest.fn().mockReturnThis(),
                lte: jest.fn().mockReturnThis(),
                order: jest.fn().mockReturnThis(),
                range: jest.fn().mockReturnThis(),
                then: jest.fn((resolve) => resolve({ data: [mockDbRow], error: null })),
            };
            const selectMock = jest.fn().mockReturnValue(queryMock);
            (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });
            // Ensure rpc is not called on the no-query path
            (supabase as any).rpc = jest.fn();

            const deals = await getDeals();
            expect(supabase.from).toHaveBeenCalledWith('deals');
            expect(selectMock).toHaveBeenCalledWith(expect.stringContaining('venues'));
            expect(queryMock.eq).toHaveBeenCalledWith('status', 'active');
            expect((supabase as any).rpc).not.toHaveBeenCalled();
            expect(deals.length).toBe(1);
            expect(deals[0].name).toBe('The Draft House');
            expect(deals[0].deal).toBe('$5 Craft Beers');
        });

        // ── Cache key stability ──────────────────────────────────────────
        //
        // The key used to be `JSON.stringify(filters)`, and Explore passes the
        // user's raw GPS fix as `center`. Every reading therefore produced a
        // distinct key: the cache missed on every call, and each miss wrote an
        // entry that pushed a genuinely warm one out of the 60-entry LRU.
        //
        // Asserting on the key `cacheService.get` is called with, rather than
        // on network call counts -- a cache HIT still fires a background
        // refresh, so counting supabase.from() calls cannot tell a hit from a
        // miss.
        describe('cache key', () => {
            const keysUsedBy = async (...filterSets: Parameters<typeof getDeals>[0][]) => {
                const queryMock: any = {
                    eq: jest.fn().mockReturnThis(),
                    contains: jest.fn().mockReturnThis(),
                    ilike: jest.fn().mockReturnThis(),
                    lte: jest.fn().mockReturnThis(),
                    gte: jest.fn().mockReturnThis(),
                    order: jest.fn().mockReturnThis(),
                    range: jest.fn().mockReturnThis(),
                    then: jest.fn((resolve) => resolve({ data: [mockDbRow], error: null })),
                };
                (supabase.from as jest.Mock).mockReturnValue({ select: jest.fn().mockReturnValue(queryMock) });
                (supabase as any).rpc = jest.fn();

                const spy = jest.spyOn(cacheService, 'get');
                spy.mockClear();
                for (const filters of filterSets) {
                    await getDeals(filters);
                }
                const keys = spy.mock.calls.map((call) => call[0] as string);
                spy.mockRestore();
                return keys;
            };

            it('gives GPS jitter a single key instead of one per reading', async () => {
                // ~8m apart: the same viewport by any meaningful measure.
                const [first, second] = await keysUsedBy(
                    { limit: 30, radiusKm: 60, center: { latitude: 41.878100, longitude: -87.629800 } },
                    { limit: 30, radiusKm: 60, center: { latitude: 41.878172, longitude: -87.629844 } },
                );

                expect(second).toEqual(first);
            });

            it('keys separate cities separately', async () => {
                const [chicago, phoenix] = await keysUsedBy(
                    { radiusKm: 60, center: { latitude: 41.8781, longitude: -87.6298 } },
                    { radiusKm: 60, center: { latitude: 33.4484, longitude: -112.0740 } },
                );

                expect(phoenix).not.toEqual(chicago);
            });

            it('does not care what order the caller built the filter object in', async () => {
                const center = { latitude: 41.8781, longitude: -87.6298 };
                const [a, b] = await keysUsedBy(
                    { dayOfWeek: 3, limit: 30, center, radiusKm: 60 },
                    { radiusKm: 60, center, limit: 30, dayOfWeek: 3 },
                );

                expect(b).toEqual(a);
            });

            it('still distinguishes filters that genuinely differ', async () => {
                const center = { latitude: 41.8781, longitude: -87.6298 };
                const [monday, tuesday] = await keysUsedBy(
                    { dayOfWeek: 1, center, radiusKm: 60 },
                    { dayOfWeek: 2, center, radiusKm: 60 },
                );

                expect(tuesday).not.toEqual(monday);
            });
        });

        it('orders deterministically before paginating so pages cannot overlap', async () => {
            // Postgres gives no ordering guarantee without ORDER BY, so a
            // .range() applied to an unordered query can return the same row on
            // two pages and drop another entirely. Ordering must be applied, and
            // must include a unique tiebreaker to make the sort total.
            const queryMock: any = {
                eq: jest.fn().mockReturnThis(),
                contains: jest.fn().mockReturnThis(),
                ilike: jest.fn().mockReturnThis(),
                lte: jest.fn().mockReturnThis(),
                order: jest.fn().mockReturnThis(),
                range: jest.fn().mockReturnThis(),
                then: jest.fn((resolve) => resolve({ data: [mockDbRow], error: null })),
            };
            const selectMock = jest.fn().mockReturnValue(queryMock);
            (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });
            (supabase as any).rpc = jest.fn();

            await getDeals({ limit: 30, offset: 30 });

            expect(queryMock.order).toHaveBeenCalledWith('created_at', { ascending: false });
            expect(queryMock.order).toHaveBeenCalledWith('id', { ascending: true });
            expect(queryMock.range).toHaveBeenCalledWith(30, 59);

            // Ordering must be established before the range window is applied.
            const firstOrderCall = queryMock.order.mock.invocationCallOrder[0];
            const rangeCall = queryMock.range.mock.invocationCallOrder[0];
            expect(firstOrderCall).toBeLessThan(rangeCall);
        });

        it('uses search_deals RPC when a query string is provided', async () => {
            // RPC returns a jsonb array matching the shape mapSupabaseToDeal expects
            const rpcRow = {
                ...mockDbRow,
                time_window: '4 PM - 6 PM',
                days_active: [0, 1, 2, 3, 4, 5, 6],
                status: 'active',
                parent_deal_id: null,
            };
            (supabase as any).rpc = jest.fn().mockResolvedValue({ data: [rpcRow], error: null });

            const deals = await getDeals({ query: 'craft beer' });

            expect((supabase as any).rpc).toHaveBeenCalledWith(
                'search_deals',
                expect.objectContaining({ search_query: 'craft beer' }),
            );
            // PostgREST path should NOT be called
            expect(supabase.from).not.toHaveBeenCalled();
            expect(deals.length).toBe(1);
            expect(deals[0].name).toBe('The Draft House');
        });

        it('applies multi-neighborhood filters client-side to search_deals RPC results (RPC only accepts a single neighborhood)', async () => {
            const neighborhoods = ['Downtown', 'Midtown'];
            const rpcRows = [
                { ...mockDbRow, id: '1', venues: { ...mockDbRow.venues, neighborhood: 'Downtown' } },
                { ...mockDbRow, id: '2', venues: { ...mockDbRow.venues, neighborhood: 'Midtown' } },
                { ...mockDbRow, id: '3', venues: { ...mockDbRow.venues, neighborhood: 'River North' } },
            ];
            (supabase as any).rpc = jest.fn().mockResolvedValue({ data: rpcRows, error: null });

            const deals = await getDeals({ query: 'beer', neighborhoods });

            // The DB function only supports a single neighborhood string, so with
            // multiple neighborhoods selected the RPC gets no neighborhood filter...
            expect((supabase as any).rpc).toHaveBeenCalledWith(
                'search_deals',
                expect.objectContaining({ neighborhood_filter: undefined }),
            );
            // ...and matching is applied client-side to the returned rows instead.
            expect(deals.map(d => d.id).sort()).toEqual(['1', '2']);
        });

        it('forwards a single-neighborhood filter directly to search_deals RPC', async () => {
            (supabase as any).rpc = jest.fn().mockResolvedValue({ data: [], error: null });

            await getDeals({ query: 'beer', neighborhoods: ['Downtown'] });

            expect((supabase as any).rpc).toHaveBeenCalledWith(
                'search_deals',
                expect.objectContaining({ neighborhood_filter: 'Downtown' }),
            );
        });

        it('returns empty array when RPC returns null (no matches)', async () => {
            (supabase as any).rpc = jest.fn().mockResolvedValue({ data: null, error: null });
            const deals = await getDeals({ query: 'xyzzy' });
            expect(deals).toEqual([]);
        });

        it('falls back to PostgREST + local search when the RPC returns an error', async () => {
            (supabase as any).rpc = jest.fn().mockResolvedValue({
                data: null,
                error: { message: 'FTS failure' },
            });
            const deals = await getDeals({ query: 'beer' });
            expect(supabase.from).toHaveBeenCalledWith('deals');
            expect(deals).toHaveLength(1);
            expect(deals[0].deal).toContain('Beer');
        });

        it('throws when RPC and fallback query both fail', async () => {
            (supabase as any).rpc = jest.fn().mockResolvedValue({
                data: null,
                error: { message: 'FTS failure' },
            });
            (supabase.from as jest.Mock).mockReturnValue({
                select: jest.fn().mockReturnValue({
                    eq: jest.fn().mockReturnValue({
                        contains: jest.fn().mockResolvedValue({
                            data: null,
                            error: { message: 'PostgREST failure' },
                        }),
                    }),
                }),
            });

            await expect(getDeals({ query: 'beer' })).rejects.toThrow(
                'Full-text search failed: FTS failure. Fallback failed: PostgREST failure',
            );
        });
    });


    describe('getDealById', () => {
        it('returns a specific deal from Supabase', async () => {
            const singleMock = jest.fn().mockResolvedValue({ data: mockDbRow, error: null });
            const eqMock = jest.fn().mockReturnValue({ single: singleMock });
            const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
            (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

            const deal = await getDealById('1');
            expect(supabase.from).toHaveBeenCalledWith('deals');
            expect(selectMock).toHaveBeenCalledWith(expect.stringContaining('venues'));
            expect(eqMock).toHaveBeenCalledWith('id', '1');
            expect(deal).toBeDefined();
            expect(deal?.name).toBe('The Draft House');
        });

        it('returns undefined if not found', async () => {
            const singleMock = jest.fn().mockResolvedValue({ data: null, error: null });
            const eqMock = jest.fn().mockReturnValue({ single: singleMock });
            const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
            (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });

            const deal = await getDealById('999');
            expect(deal).toBeUndefined();
        });
    });

    describe('getHighlightDeals', () => {
        const buildHighlightQueryMock = () => {
            const queryMock: any = {
                eq: jest.fn().mockReturnThis(),
                neq: jest.fn().mockReturnThis(),
                contains: jest.fn().mockReturnThis(),
                gte: jest.fn().mockReturnThis(),
                lte: jest.fn().mockReturnThis(),
                limit: jest.fn().mockResolvedValue({ data: [{ ...mockDbRow, type: 'trending' }], error: null }),
            };
            const selectMock = jest.fn().mockReturnValue(queryMock);
            (supabase.from as jest.Mock).mockReturnValue({ select: selectMock });
            return queryMock;
        };

        it('fetches deals where type is not regular', async () => {
            const queryMock = buildHighlightQueryMock();

            const highlights = await getHighlightDeals();
            expect(supabase.from).toHaveBeenCalledWith('deals');
            expect(queryMock.eq).toHaveBeenCalledWith('status', 'active');
            expect(queryMock.neq).toHaveBeenCalledWith('type', 'regular');
            expect(highlights.length).toBe(1);
            expect(highlights[0].type).toBe('trending');
        });

        it('is always bounded, so one city cannot flood the home screen', async () => {
            const queryMock = buildHighlightQueryMock();

            await getHighlightDeals();
            expect(queryMock.limit).toHaveBeenCalledWith(expect.any(Number));
        });

        it('constrains the query to the scope it is given', async () => {
            const queryMock = buildHighlightQueryMock();

            await getHighlightDeals({
                center: { latitude: 41.8781, longitude: -87.6298 },
                radiusKm: 60,
                metro: null,
                isFallback: false,
                distanceKm: null,
            });

            // A 60km box around Chicago: bounds must bracket the centre and
            // must not be wide enough to reach another metro.
            const latLower = queryMock.gte.mock.calls.find((c: any[]) => c[0] === 'venues.latitude')?.[1];
            const latUpper = queryMock.lte.mock.calls.find((c: any[]) => c[0] === 'venues.latitude')?.[1];
            const lngLower = queryMock.gte.mock.calls.find((c: any[]) => c[0] === 'venues.longitude')?.[1];
            const lngUpper = queryMock.lte.mock.calls.find((c: any[]) => c[0] === 'venues.longitude')?.[1];

            expect(latLower).toBeLessThan(41.8781);
            expect(latUpper).toBeGreaterThan(41.8781);
            expect(lngLower).toBeLessThan(-87.6298);
            expect(lngUpper).toBeGreaterThan(-87.6298);

            // Phoenix (33.45, -112.07) must fall outside the Chicago box.
            expect(33.45 < latLower || 33.45 > latUpper).toBe(true);
            expect(-112.074 < lngLower || -112.074 > lngUpper).toBe(true);
        });

        it('does not constrain the query when no scope is given', async () => {
            const queryMock = buildHighlightQueryMock();

            await getHighlightDeals();
            expect(queryMock.gte).not.toHaveBeenCalled();
            expect(queryMock.lte).not.toHaveBeenCalled();
        });
    });

    describe('error surfacing', () => {
        // Both of these used to `return []` on failure. That made `hasError`
        // unreachable on the Home and Saved screens and their <ErrorState>
        // retry buttons dead code: an offline user was told "No highlights
        // today" and shown an empty Saved list, which reads as "there is
        // nothing here" rather than "this did not load".
        it('getHighlightDeals rethrows so the Home screen can show an error', async () => {
            await cacheService.clear();
            const queryMock: any = {
                eq: jest.fn().mockReturnThis(),
                neq: jest.fn().mockReturnThis(),
                contains: jest.fn().mockReturnThis(),
                limit: jest.fn().mockRejectedValue(new Error('network down')),
            };
            (supabase.from as jest.Mock).mockReturnValue({ select: jest.fn().mockReturnValue(queryMock) });

            await expect(getHighlightDeals()).rejects.toThrow('network down');
        });

        it('getHighlightDeals still prefers stale cache over throwing', async () => {
            await cacheService.clear();
            // Warm the cache with a good response...
            const okQuery: any = {
                eq: jest.fn().mockReturnThis(),
                neq: jest.fn().mockReturnThis(),
                contains: jest.fn().mockReturnThis(),
                limit: jest.fn().mockResolvedValue({ data: [{ ...mockDbRow, type: 'trending' }], error: null }),
            };
            (supabase.from as jest.Mock).mockReturnValue({ select: jest.fn().mockReturnValue(okQuery) });
            await getHighlightDeals();

            // ...then fail, with that entry expired.
            const badQuery: any = {
                eq: jest.fn().mockReturnThis(),
                neq: jest.fn().mockReturnThis(),
                contains: jest.fn().mockReturnThis(),
                limit: jest.fn().mockRejectedValue(new Error('network down')),
            };
            (supabase.from as jest.Mock).mockReturnValue({ select: jest.fn().mockReturnValue(badQuery) });
            jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60 * 1000);

            // Serving something beats an error screen, so this must NOT throw.
            await expect(getHighlightDeals()).resolves.toHaveLength(1);
            (Date.now as jest.Mock).mockRestore();
        });
    });

    describe('searchDeals', () => {
        it('returns all deals for an empty query', () => {
            const result = searchDeals(DEALS, '');
            expect(result.length).toBe(DEALS.length);
        });

        it('returns all deals for a whitespace-only query', () => {
            const result = searchDeals(DEALS, '   ');
            expect(result.length).toBe(DEALS.length);
        });

        it('finds deals by name (case insensitive)', () => {
            const result = searchDeals(DEALS, 'draft house');
            expect(result.length).toBeGreaterThan(0);
            expect(result[0].name).toBe('The Draft House');
        });

        it('finds deals by neighborhood', () => {
            const result = searchDeals(DEALS, 'Wicker Park');
            expect(result.length).toBeGreaterThan(0);
            expect(result.every(d => d.neighborhood === 'Wicker Park')).toBe(true);
        });

        it('finds deals by deal description', () => {
            const result = searchDeals(DEALS, 'Tacos');
            expect(result.length).toBeGreaterThan(0);
        });
    });

    describe('filterDeals', () => {
        it('returns all deals with empty filters', () => {
            const result = filterDeals(DEALS, {});
            expect(result.length).toBe(DEALS.length);
        });

        it('filters by query', () => {
            const result = filterDeals(DEALS, { query: 'draft' });
            expect(result.length).toBe(2);
        });

        it('filters by tag', () => {
            const result = filterDeals(DEALS, { tags: ['Patio'] });
            expect(result.length).toBeGreaterThan(0);
            expect(result.every(d => d.tags.includes('Patio'))).toBe(true);
        });

        it('filters by type', () => {
            const result = filterDeals(DEALS, { type: 'trending' });
            expect(result.every(d => d.type === 'trending')).toBe(true);
        });

        it('combines multiple filters', () => {
            const result = filterDeals(DEALS, { priceMax: 2, tags: ['Bar'] });
            expect(result.every(d => d.price !== undefined && d.price <= 2 && d.tags.some(t => t.includes('Bar')))).toBe(true);
        });
    });

    describe('getAllTags', () => {
        it('returns a sorted array of unique tags', () => {
            const tags = getAllTags(DEALS);
            expect(tags.length).toBeGreaterThan(0);
            const sorted = [...tags].sort();
            expect(tags).toEqual(sorted);
            expect(new Set(tags).size).toBe(tags.length);
        });
    });

    describe('getAllNeighborhoods', () => {
        it('returns a sorted array of unique neighborhoods', () => {
            const neighborhoods = getAllNeighborhoods(DEALS);
            expect(neighborhoods.length).toBeGreaterThan(0);
            const sorted = [...neighborhoods].sort();
            expect(neighborhoods).toEqual(sorted);
            expect(new Set(neighborhoods).size).toBe(neighborhoods.length);
        });
    });
});
