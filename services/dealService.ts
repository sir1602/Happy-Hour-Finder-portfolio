
import { Deal, Schedule, SubmitDealData } from '../types';
import { supabase } from './supabase';
import { geocodeAddress } from '../utils/geocoding';
import { Logger } from './logger';
import { calculateDistanceKm } from '../utils/location';
import { cacheService } from './cacheService';
import { DEFAULT_RADIUS_KM, resolveLocationScope, scopeCacheKey, type LocationScope } from './metroService';
import * as Crypto from 'expo-crypto';
import { VENUE_FALLBACK_IMAGE } from '../constants/images';

/**
 * Data service layer for deal operations.
 * Now backed by a real Supabase PostgreSQL database.
 */

export interface DealFilters {
    query?: string;
    tags?: string[];
    priceMax?: number;
    type?: Deal['type'];
    neighborhood?: string;
    /** Filter by multiple neighborhoods at once. */
    neighborhoods?: string[];
    /** 0 = Sunday … 6 = Saturday (matches JS Date.getDay()). Defaults to today when omitted. */
    dayOfWeek?: number;
    /** Pagination: max rows to return (defaults to 50). */
    limit?: number;
    /** Pagination: row offset (defaults to 0). */
    offset?: number;
    /**
     * Restrict results to venues near this point. Without it the query is
     * global, which mixes cities together once more than one metro has data.
     */
    center?: { latitude: number; longitude: number };
    /** Radius in km around `center`. Defaults to DEFAULT_RADIUS_KM. */
    radiusKm?: number;
}



/**
 * Bounding box around a point, for use as an index-friendly geographic filter.
 *
 * A box is up to ~27% larger than the circle it encloses, so a venue just past
 * a corner can slip through. That tolerance is deliberate: the box exists to
 * keep other cities out, where the margin is hundreds of kilometres, and it
 * lets Postgres use the plain lat/lng indexes. `search_deals` refines to a true
 * circle server-side because there it is free.
 */
/**
 * Escape the wildcards LIKE/ILIKE treats as syntax, so user text matches
 * literally. Without it a query of "%" matches every row -- a bug this file
 * has already had once, in the submission venue lookup.
 */
const escapeLikePattern = (value: string): string => value.replace(/[%_\\]/g, '\\$&');

const boundsForRadius = (
    center: { latitude: number; longitude: number },
    radiusKm: number,
) => {
    const latDelta = radiusKm / 111.045;
    const lngDelta =
        radiusKm / (111.045 * Math.max(Math.cos((center.latitude * Math.PI) / 180), 0.01));
    return {
        minLat: center.latitude - latDelta,
        maxLat: center.latitude + latDelta,
        minLng: center.longitude - lngDelta,
        maxLng: center.longitude + lngDelta,
    };
};

/**
 * Client-side substring fallback used by filterDeals() for in-memory filtering
 * of already-loaded data. For live search, getDeals() uses the search_deals RPC
 * which provides stemming, prefix matching, and relevance ranking server-side.
 */
const matchesSearchQueryLocal = (deal: Deal, normalizedQuery: string): boolean => {
    return (
        (deal.name && deal.name.toLowerCase().includes(normalizedQuery)) ||
        (deal.neighborhood && deal.neighborhood.toLowerCase().includes(normalizedQuery)) ||
        (deal.deal && deal.deal.toLowerCase().includes(normalizedQuery))
    );
};
/**
 * Helper function to map a Supabase response tuple into a uniform Deal interface
 */
const mapSupabaseToDeal = (dbRow: any): Deal => {
    return {
        id: dbRow.id,
        venueId: dbRow.venue_id,
        name: dbRow.venues?.name || 'Unknown Venue',
        deal: dbRow.title,
        image: dbRow.venues?.image_url || VENUE_FALLBACK_IMAGE,
        neighborhood: dbRow.venues?.neighborhood || 'Unknown',
        distance: '', // Populated client-side when user location is available
        price: dbRow.price_level,
        rating: dbRow.venues?.rating || 0,
        reviewCount: dbRow.venues?.review_count || 0,
        tags: dbRow.tags || [],
        address: dbRow.venues?.address || '',
        website: dbRow.venues?.website || '',
        phone: dbRow.venues?.phone || '',
        type: dbRow.type as Deal['type'],
        endsIn: dbRow.ends_in,
        time: dbRow.time_window,
        latitude: dbRow.venues?.latitude || 0,
        longitude: dbRow.venues?.longitude || 0,
        status: dbRow.status,
        daysActive: dbRow.days_active || [],
        parentDealId: dbRow.parent_deal_id || undefined,
        description: dbRow.description || null,
        verificationStatus: dbRow.verification_status ?? null,
    };
};

/**
 * Fetch deals from Supabase, applying optional filters server-side.
 */
const fetchDealsFromNetwork = async (filters?: DealFilters): Promise<Deal[]> => {
    const targetDay = filters?.dayOfWeek !== undefined ? filters.dayOfWeek : new Date().getDay();
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;

    const buildBaseDealsQuery = () => {
        let query = supabase
            .from('deals')
            .select(`
                *,
                venues!inner (*)
            `)
            .eq('status', 'active')
            .contains('days_active', [targetDay]);

        if (filters?.type) {
            query = query.eq('type', filters.type);
        }

        if (filters?.priceMax !== undefined) {
            query = query.lte('price_level', filters.priceMax);
        }

        if (filters?.tags && filters.tags.length > 0) {
            query = query.contains('tags', filters.tags);
        }

        if (filters?.neighborhoods && filters.neighborhoods.length > 0) {
            query = query.in('venues.neighborhood', filters.neighborhoods);
        } else if (filters?.neighborhood) {
            // Escape SQL LIKE wildcards to prevent pattern injection from user input
            const escaped = escapeLikePattern(filters.neighborhood);
            query = query.ilike('venues.neighborhood', `%${escaped}%`);
        }

        if (filters?.center) {
            const b = boundsForRadius(filters.center, filters.radiusKm ?? DEFAULT_RADIUS_KM);
            query = query
                .gte('venues.latitude', b.minLat)
                .lte('venues.latitude', b.maxLat)
                .gte('venues.longitude', b.minLng)
                .lte('venues.longitude', b.maxLng);
        }

        return query;
    };

    // ── Full-text search path ────────────────────────────────────────────────
    // When a text query is present, delegate entirely to the search_deals RPC
    // which uses a tsvector GIN index with stemming, prefix matching (:*), and
    // ts_rank ordering. All other filters are forwarded to the RPC as well.
    if (filters?.query?.trim()) {
        // search_deals only accepts a single neighborhood string. When multiple
        // neighborhoods are selected, skip the DB-side filter and apply it
        // client-side to the RPC results below instead.
        const multiNeighborhoods = filters.neighborhoods?.length ? filters.neighborhoods : null;
        const neighborhoodFilter =
            multiNeighborhoods && multiNeighborhoods.length === 1
                ? multiNeighborhoods[0]
                : multiNeighborhoods
                    ? null
                    : (filters.neighborhood ?? null);

        const { data: rpcData, error: rpcError } = await supabase.rpc('search_deals', {
            search_query:        filters.query.trim(),
            day_filter:          targetDay,
            deal_type:           filters.type           ?? null,
            price_max:           filters.priceMax       ?? null,
            tag_filter:          filters.tags?.length   ? filters.tags : null,
            neighborhood_filter: neighborhoodFilter ?? undefined,
            row_limit:           filters.limit          ?? 50,
            row_offset:          filters.offset         ?? 0,
            center_lat:          filters.center?.latitude  ?? undefined,
            center_lng:          filters.center?.longitude ?? undefined,
            radius_km:           filters.center ? (filters.radiusKm ?? DEFAULT_RADIUS_KM) : undefined,
        });

        if (rpcError) {
            Logger.warn(`[getDeals] search_deals RPC failed, falling back to PostgREST + local filtering: ${rpcError.message}`);

            const { data: fallbackData, error: fallbackError } = await buildBaseDealsQuery();
            if (fallbackError) {
                throw new Error(`Full-text search failed: ${rpcError.message}. Fallback failed: ${fallbackError.message}`);
            }

            const fallbackDeals = (fallbackData ?? []).map(mapSupabaseToDeal);
            const filteredDeals = searchDeals(fallbackDeals, filters.query);
            return filteredDeals.slice(offset, offset + limit);
        }

        // RPC returns a jsonb array (or null when there are no matches)
        if (!rpcData) return [];
        let rows: any[] = Array.isArray(rpcData) ? rpcData : [];
        if (multiNeighborhoods && multiNeighborhoods.length > 1) {
            rows = rows.filter((row) => multiNeighborhoods.includes(row.venues?.neighborhood));
        }
        return rows.map(mapSupabaseToDeal);
    }

    // ── Standard PostgREST path (no text query) ──────────────────────────────
    let query = supabase
        .from('deals')
        .select(`
            *,
            venues!inner (*)
        `)
        .eq('status', 'active')
        .contains('days_active', [targetDay]);

    if (filters?.type) {
        query = query.eq('type', filters.type);
    }

    if (filters?.priceMax !== undefined) {
        query = query.lte('price_level', filters.priceMax);
    }

    if (filters?.tags && filters.tags.length > 0) {
        query = query.contains('tags', filters.tags);
    }

    if (filters?.neighborhoods && filters.neighborhoods.length > 0) {
        query = query.in('venues.neighborhood', filters.neighborhoods);
    } else if (filters?.neighborhood) {
        // Escape SQL LIKE wildcards to prevent pattern injection from user input
        const escaped = escapeLikePattern(filters.neighborhood);
        query = query.ilike('venues.neighborhood', `%${escaped}%`);
    }

    // Deterministic ordering is REQUIRED before .range(): Postgres gives no
    // ordering guarantee without ORDER BY, so paginating an unordered query lets
    // the same row appear on two pages while another appears on none. `id` is
    // the tiebreaker that makes the sort total.
    query = query
        .order('created_at', { ascending: false })
        .order('id', { ascending: true });

    // Apply pagination (limit/offset already declared above)
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
        throw new Error(`Failed to fetch deals: ${error.message}`);
    }
    if (!data) return [];

    return data.map(mapSupabaseToDeal);
};

/**
 * Deterministic cache key for a getDeals() call.
 *
 * Two things the plain `JSON.stringify(filters)` it replaces got wrong:
 *
 *  - `center` carries the user's raw GPS fix, so every reading produced a
 *    different key. The cache missed on every call, and each miss wrote a new
 *    entry that pushed a genuinely warm one out of the 60-entry LRU -- so the
 *    Explore screen not only got no benefit from the cache, it degraded it for
 *    everything else. Rounding to ~1km matches what `scopeCacheKey` already
 *    does for the highlight and filter-option caches.
 *  - Key order in the serialized object followed insertion order, so two
 *    equivalent filter sets built in different orders got separate entries.
 *
 * Sorting keys at every level fixes the second; the arrays here (`tags`,
 * `neighborhoods`) are left in caller order because they are already
 * canonicalised by useExploreScreen before they arrive.
 */
const dealsCacheKey = (filters?: DealFilters): string => {
    const { center, ...rest } = filters ?? {};
    const normalized = {
        ...rest,
        ...(center
            ? { center: { lat: center.latitude.toFixed(2), lng: center.longitude.toFixed(2) } }
            : {}),
    };
    const stable = JSON.stringify(normalized, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value
    );
    return `deals_${stable}`;
};

export const getDeals = async (filters?: DealFilters): Promise<Deal[]> => {
    const cacheKey = dealsCacheKey(filters);
    
    // 1. Try to get unexpired cached data first
    const cached = await cacheService.get<Deal[]>(cacheKey);

    if (cached) {
        // Refresh cache in the background (fire-and-forget) — lazily start the request
        fetchDealsFromNetwork(filters).then(async (resultDeals) => {
            await cacheService.set(cacheKey, resultDeals, 5 * 60 * 1000); // 5 mins TTL
        }).catch((e) => {
            Logger.warn('[getDeals] Background refresh failed:', e);
        });
        return cached;
    }

    // 2. No unexpired cache, wait for network request
    try {
        const resultDeals = await fetchDealsFromNetwork(filters);
        await cacheService.set(cacheKey, resultDeals, 5 * 60 * 1000);
        return resultDeals;
    } catch (e: unknown) {
        // Fallback to expired cached data if offline/network fails
        const fallback = await cacheService.get<Deal[]>(cacheKey, true);
        if (fallback) {
            Logger.warn('[getDeals] Network fetch failed, fell back to expired cached data');
            return fallback;
        }
        const message = e instanceof Error ? e.message : String(e);
        Logger.error('Failed to fetch deals', e);
        throw new Error(message);
    }
};

/**
 * Ceiling on a single map fetch.
 *
 * The bounding box is whatever the user has zoomed to, so without a bound a
 * zoomed-out viewport asks for every active deal in it -- joined to venues, in
 * one response, straight into supercluster. Harmless at 342 deals in one city;
 * the multi-metro work is exactly what makes it not stay that way. Well above
 * what is legible on a map at any zoom, so it only ever truncates a view that
 * was already an undifferentiated mass of pins.
 */
const MAP_DEAL_LIMIT = 500;

/**
 * Fetch deals within a specific map bounding box
 */
export const getBoundingBoxDeals = async (minLat: number, minLng: number, maxLat: number, maxLng: number, abortSignal?: AbortSignal): Promise<Deal[]> => {
    try {
        let query = supabase
            .from('deals')
            .select(`
                *,
                venues!inner (*)
            `)
            .eq('status', 'active')
            .gte('venues.latitude', minLat)
            .lte('venues.latitude', maxLat)
            .gte('venues.longitude', minLng)
            .lte('venues.longitude', maxLng)
            .contains('days_active', [new Date().getDay()])
            .limit(MAP_DEAL_LIMIT);

        if (abortSignal) {
            query = query.abortSignal(abortSignal) as any;
        }

        const { data, error } = await query;

        if (error) throw error;
        if (!data) return [];

        return data.map(mapSupabaseToDeal);
    } catch (e: unknown) {
        Logger.error('Failed to fetch bounding box deals', e);
        throw e;
    }
};

/**
 * Fetch a single deal by ID.
 */
export const getDealsByVenueId = async (venueId: string): Promise<Deal[]> => {
    try {
        const { data, error } = await supabase
            .from('deals')
            .select(`
                *,
                venues!inner (*)
            `)
            .eq('status', 'active')
            .eq('venue_id', venueId)
            .order('parent_deal_id', { ascending: true }) // Optional ordering
            .order('time_window', { ascending: true }); // Optional ordering

        if (error) {
            throw new Error(`Failed to fetch deals for venue ${venueId}: ${error.message}`);
        }

        if (!data) return [];
        return data.map(mapSupabaseToDeal);
    } catch (e: unknown) {
        Logger.error('Failed to fetch venue deals', e);
        return [];
    }
};

/**
 * Fetch a single deal by ID.
 */
export const getDealById = async (id: string): Promise<Deal | undefined> => {
    try {
        const { data, error } = await supabase
            .from('deals')
            .select(`*, venues (*)`)
            .eq('id', id)
            .single();

        if (error) {
            throw new Error(`Failed to fetch deal ${id}: ${error.message}`);
        }
        if (!data) return undefined;

        return mapSupabaseToDeal(data);
    } catch (e: unknown) {
        Logger.error('Failed to fetch deal by ID', e);
        return undefined;
    }
};

/** Highlights are a home-screen teaser, not a full listing. */
const HIGHLIGHT_LIMIT = 50;

/**
 * Fetch deals flagged as highlights (non-regular type).
 *
 * `scope` keeps the home screen to the user's own city. Without it every
 * metro's highlights are returned and merely sorted by distance, so a trip to
 * one city permanently changes what the home screen shows in the other.
 */
export const getHighlightDeals = async (scope?: LocationScope | null): Promise<Deal[]> => {
    const cacheKey = `highlight_deals_${scopeCacheKey(scope)}`;

    const fetchHighlightsFromNetwork = async (): Promise<Deal[]> => {
        let query = supabase
            .from('deals')
            .select(`*, venues!inner (*)`)
            .eq('status', 'active')
            .neq('type', 'regular')
            .contains('days_active', [new Date().getDay()]);

        if (scope) {
            const b = boundsForRadius(scope.center, scope.radiusKm);
            query = query
                .gte('venues.latitude', b.minLat)
                .lte('venues.latitude', b.maxLat)
                .gte('venues.longitude', b.minLng)
                .lte('venues.longitude', b.maxLng);
        }

        const { data, error } = await query.limit(HIGHLIGHT_LIMIT);

        if (error) throw error;
        if (!data) return [];

        return data.map(mapSupabaseToDeal);
    };

    // 1. Try to get unexpired cached data first
    const cached = await cacheService.get<Deal[]>(cacheKey);

    if (cached) {
        // Refresh cache in the background (fire-and-forget) — lazily start
        fetchHighlightsFromNetwork().then(async (resultDeals) => {
            await cacheService.set(cacheKey, resultDeals, 5 * 60 * 1000); // 5 mins TTL
        }).catch((e) => {
            Logger.warn('[getHighlightDeals] Background refresh failed:', e);
        });
        return cached;
    }

    // 2. No unexpired cache, wait for network request
    try {
        const resultDeals = await fetchHighlightsFromNetwork();
        await cacheService.set(cacheKey, resultDeals, 5 * 60 * 1000);
        return resultDeals;
    } catch (e: unknown) {
        // Fallback to expired cached data if offline/network fails
        const fallback = await cacheService.get<Deal[]>(cacheKey, true);
        if (fallback) {
            Logger.warn('[getHighlightDeals] Network fetch failed, fell back to expired cached data');
            return fallback;
        }
        // Rethrow rather than returning []. Swallowing the error here made
        // `hasError` on the Home screen unreachable and its <ErrorState>
        // retry button dead code -- an offline user with no warm cache was
        // told "No highlights today", which reads as "this city has nothing"
        // rather than "you are offline". The stale-cache fallback above still
        // runs first, so this only fires when there is genuinely nothing to
        // show. The sole caller already wraps this in try/catch.
        Logger.error('Failed to fetch highlight deals', e);
        throw e;
    }
};

/**
 * Filter deals by multiple criteria dynamically in code
 * In production this should be converted to entirely SQL-side filtering for performance.
 */
export const filterDeals = (deals: Deal[], filters: DealFilters): Deal[] => {
    const { query, tags, priceMax, type, neighborhood, dayOfWeek } = filters;

    const normalizedQuery = query?.toLowerCase().trim();
    const nbFilter = neighborhood?.toLowerCase();

    return deals.filter(d => {
        // Search query filter
        if (normalizedQuery && !matchesSearchQueryLocal(d, normalizedQuery)) {
            return false;
        }

        // Tags filter
        if (tags && tags.length > 0) {
            if (!d.tags || !tags.some(tag => d.tags.includes(tag))) {
                return false;
            }
        }

        // Price filter
        if (priceMax !== undefined) {
            if (d.price === undefined || d.price > priceMax) {
                return false;
            }
        }

        // Deal type filter
        if (type && d.type !== type) {
            return false;
        }

        // Neighborhood filter
        if (nbFilter) {
            if (!d.neighborhood || d.neighborhood.toLowerCase() !== nbFilter) {
                return false;
            }
        }

        // Day of week filter
        if (dayOfWeek !== undefined) {
            if (!d.daysActive || !d.daysActive.includes(dayOfWeek)) {
                return false;
            }
        }

        return true;
    });
};

/**
 * Local in-memory substring search — used as a fallback when filtering an
 * already-fetched deal array (e.g. in tests or offline mode).
 * For live server search, use getDeals({ query }) which calls the
 * search_deals RPC with full-text stemming and ranking.
 */
export const searchDeals = (deals: Deal[], query: string): Deal[] => {
    if (!query || !query.trim()) return deals;
    const normalizedQuery = query.toLowerCase().trim();
    return deals.filter(d => matchesSearchQueryLocal(d, normalizedQuery));
};

/**
 * Get all unique tags from the deals data.
 */
export const getAllTags = (deals: Deal[]): string[] => {
    const tagSet = new Set<string>();
    deals.forEach(d => {
        if (d.tags) {
            d.tags.forEach(tag => tagSet.add(tag));
        }
    });
    return Array.from(tagSet).sort();
};

/**
 * Get all unique neighborhoods from the deals data.
 */
export const getAllNeighborhoods = (deals: Deal[]): string[] => {
    const nbSet = new Set<string>();
    deals.forEach(d => {
        if (d.neighborhood) {
            nbSet.add(d.neighborhood);
        }
    });
    return Array.from(nbSet).sort();
};

/**
 * Fetch distinct tags and neighborhoods directly from Supabase, fetching only
 * the minimal columns needed. Use this instead of `getDeals()` + `getAllTags()`
 * to avoid pulling the entire deals dataset just to populate filter chips.
 */
export const getFilterOptions = async (
    scope?: LocationScope | null,
): Promise<{ tags: string[]; neighborhoods: string[] }> => {
    // The cache key must carry the scope. This response has a 24h TTL, so a
    // key shared across cities would keep offering Chicago neighbourhoods for
    // a whole day after arriving somewhere else.
    const cacheKey = `filter_options_${scopeCacheKey(scope)}`;

    const fetchOptionsFromNetwork = async () => {
        let optionsQuery = supabase
            .from('deals')
            .select('tags, venues!inner(neighborhood, latitude, longitude)')
            .eq('status', 'active');

        if (scope) {
            const b = boundsForRadius(scope.center, scope.radiusKm);
            optionsQuery = optionsQuery
                .gte('venues.latitude', b.minLat)
                .lte('venues.latitude', b.maxLat)
                .gte('venues.longitude', b.minLng)
                .lte('venues.longitude', b.maxLng);
        }

        const { data, error } = await optionsQuery;

        if (error || !data) {
            throw new Error(error?.message || 'No data fetched');
        }

        const tagSet = new Set<string>();
        const neighborhoodSet = new Set<string>();

        for (const row of data) {
            (row.tags as string[] | null)?.forEach(t => tagSet.add(t));
            const nb = (row.venues as { neighborhood?: string } | null)?.neighborhood;
            if (nb) neighborhoodSet.add(nb);
        }

        return {
            tags: [...tagSet].sort(),
            neighborhoods: [...neighborhoodSet].sort(),
        };
    };
    
    // 1. Try to get unexpired cached data first
    const cached = await cacheService.get<{ tags: string[]; neighborhoods: string[] }>(cacheKey);

    if (cached) {
        // Refresh cache in the background (fire-and-forget) — lazily start
        fetchOptionsFromNetwork().then(async (result) => {
            await cacheService.set(cacheKey, result, 24 * 60 * 60 * 1000); // 24 hours TTL for options
        }).catch((e) => {
            Logger.warn('[getFilterOptions] Background refresh failed:', e);
        });
        return cached;
    }

    // 2. No unexpired cache, wait for network request
    try {
        const result = await fetchOptionsFromNetwork();
        await cacheService.set(cacheKey, result, 24 * 60 * 60 * 1000);
        return result;
    } catch (e: unknown) {
        // Fallback to expired cached data if offline/network fails
        const fallback = await cacheService.get<{ tags: string[]; neighborhoods: string[] }>(cacheKey, true);
        if (fallback) {
            Logger.warn('[getFilterOptions] Network fetch failed, fell back to expired cached data');
            return fallback;
        }
        Logger.error('[getFilterOptions] Unexpected error', e);
        return { tags: [], neighborhoods: [] };
    }
};

/**
 * Fetch deals by a specific set of IDs (used by Saved screen to avoid fetching all deals).
 */
export const getDealsByIds = async (ids: string[]): Promise<Deal[]> => {
    if (ids.length === 0) return [];
    try {
        const { data, error } = await supabase
            .from('deals')
            .select(`*, venues (*)`)
            .in('id', ids);

        if (error) throw error;
        if (!data) return [];
        return data.map(mapSupabaseToDeal);
    } catch (e: unknown) {
        // Rethrow for the same reason as getHighlightDeals above: returning []
        // made the Saved screen's error state unreachable, so a failed fetch
        // rendered as "no saved deals" -- indistinguishable from having none,
        // on a screen whose whole purpose is holding things the user chose to
        // keep. The sole caller already wraps this in try/catch.
        Logger.error('Failed to fetch deals by IDs', e);
        throw e;
    }
};

/**
 * Get saved deal IDs for a user
 */
export const getUserSavedDealIds = async (userId: string): Promise<string[]> => {
    try {
        const { data, error } = await supabase
            .from('user_deals')
            .select('deal_id')
            .eq('user_id', userId);

        if (error) {
            Logger.error('Error fetching user saved deals', error);
            return [];
        }

        return data.map(row => row.deal_id);
    } catch (e: unknown) {
        Logger.error('Exception fetching user saved deals', e);
        return [];
    }
};

/**
 * Toggle a saved deal for a user
 */
export const toggleUserSavedDeal = async (userId: string, dealId: string, isCurrentlySaved: boolean): Promise<boolean> => {
    try {
        if (isCurrentlySaved) {
            // Delete
            const { error } = await supabase
                .from('user_deals')
                .delete()
                .eq('user_id', userId)
                .eq('deal_id', dealId);

            if (error) {
                Logger.error('Error removing saved deal', error);
                return false;
            }
        } else {
            // Insert
            const { error } = await supabase
                .from('user_deals')
                .insert({ user_id: userId, deal_id: dealId });

            if (error) {
                Logger.error('Error adding saved deal', error);
                return false;
            }
        }
        return true;
    } catch (e: unknown) {
        Logger.error('Exception toggling saved deal', e);
        return false;
    }
};

/**
 * Thrown when Postgres rejects a submission for exceeding the per-user rate
 * limit enforced by the `enforce_deal_submission_rate_limit` trigger.
 */
export class DealSubmissionRateLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DealSubmissionRateLimitError';
    }
}

const isRateLimitError = (e: unknown): boolean => {
    const message = (e as { message?: string } | null)?.message;
    return typeof message === 'string' && message.includes('Rate limit exceeded');
};

export interface SubmittedDeal {
    id: string;
    title: string;
    timeWindow: string;
    status: string;
    createdAt: string;
    venueName: string;
    /** The photo the submission was read from, if one was attached. */
    imageUrl: string | null;
}

/**
 * Fetch the deals the current user has submitted, newest first.
 *
 * Only reachable because `deals` now carries a `submitted_by` column with a
 * matching SELECT policy. Previously the table was readable only where
 * `status = 'active'`, so a submitter got a "pending approval" message and then
 * had no way to see their submission — or confirm it was received — ever again.
 *
 * Only the group representative of each submission is returned (child schedule
 * rows carry a `parent_deal_id`), so a multi-schedule submission shows as one
 * entry rather than several.
 */
export const getMySubmittedDeals = async (userId: string): Promise<SubmittedDeal[]> => {
    try {
        const { data, error } = await supabase
            .from('deals')
            .select('id, title, time_window, status, created_at, image_url, venues (name)')
            .eq('submitted_by', userId)
            .is('parent_deal_id', null)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;
        if (!data) return [];

        return data.map((row: any) => ({
            id: row.id,
            title: row.title,
            timeWindow: row.time_window,
            status: row.status,
            createdAt: row.created_at,
            venueName: row.venues?.name ?? 'Unknown Venue',
            imageUrl: row.image_url ?? null,
        }));
    } catch (e: unknown) {
        Logger.error('Failed to fetch submitted deals', e);
        return [];
    }
};

/**
 * A venue the submitter can pick instead of typing an address out.
 */
export interface VenueSearchResult {
    id: string;
    name: string;
    address: string;
    neighborhood: string;
    latitude: number;
    longitude: number;
    /** Kilometres from the user, when we know where they are. */
    distanceKm: number | null;
}

/** How many extra rows to pull so the distance sort has something to choose from. */
const VENUE_SEARCH_OVERFETCH = 3;

/**
 * Venues matching `query`, nearest first, for the submit form's autocomplete.
 *
 * Scoped to `scope`'s bounding box for the same reason submitUserDeal()'s
 * lookup is: without it, searching "The Tap Room" in Phoenix offers a Chicago
 * venue, and tapping it files the deal at a Chicago address with Chicago
 * coordinates. A suggestion list is a worse place for that bug than the silent
 * dedupe was, because here the user is being invited to confirm it.
 *
 * Matches on substring rather than prefix -- people type "tap room" for
 * "The Tap Room" -- and over-fetches before sorting, because the database's
 * LIMIT returns an arbitrary N rather than the nearest N.
 *
 * Never throws: an autocomplete that rejects would interrupt typing, so a
 * failed lookup just means no suggestions.
 */
export const searchVenues = async (
    query: string,
    scope: LocationScope | null,
    options?: {
        limit?: number;
        near?: { latitude: number; longitude: number } | null;
    },
): Promise<VenueSearchResult[]> => {
    const trimmed = query.trim();
    // One or two characters match most of the table; not worth the round trip.
    if (trimmed.length < 2) return [];

    const limit = options?.limit ?? 8;
    const near = options?.near ?? null;

    try {
        let venueQuery = supabase
            .from('venues')
            .select('id, name, address, neighborhood, latitude, longitude')
            .ilike('name', `%${escapeLikePattern(trimmed)}%`)
            .eq('permanently_closed', false)
            .limit(limit * VENUE_SEARCH_OVERFETCH);

        if (scope) {
            const b = boundsForRadius(scope.center, scope.radiusKm);
            venueQuery = venueQuery
                .gte('latitude', b.minLat)
                .lte('latitude', b.maxLat)
                .gte('longitude', b.minLng)
                .lte('longitude', b.maxLng);
        }

        const { data, error } = await venueQuery;
        if (error) throw error;
        if (!data) return [];

        const results: VenueSearchResult[] = data.map((row: any) => ({
            id: row.id,
            name: row.name,
            address: row.address ?? '',
            neighborhood: row.neighborhood ?? '',
            latitude: row.latitude,
            longitude: row.longitude,
            distanceKm: near
                ? calculateDistanceKm(near.latitude, near.longitude, row.latitude, row.longitude)
                : null,
        }));

        results.sort((a, b) =>
            a.distanceKm !== null && b.distanceKm !== null
                ? a.distanceKm - b.distanceKm
                : a.name.localeCompare(b.name),
        );

        return results.slice(0, limit);
    } catch (e: unknown) {
        Logger.warn('[searchVenues] Could not fetch venue suggestions', e);
        return [];
    }
};

// The submission payload lives in types.ts, alongside Deal and Schedule.
// It used to be declared here as well, and the two copies had already
// drifted apart; re-exporting keeps this module's existing importers
// working without a second definition to keep in sync.
export type { SubmitDealData, Schedule };

/**
 * Submit a deal to the database with a pending status
 */
export const submitUserDeal = async (data: SubmitDealData): Promise<boolean> => {
    try {
        // Submissions must be attributed to the caller: the deals INSERT policy
        // requires `submitted_by = auth.uid()`, and it's what lets the submitter
        // read their own pending row back afterwards.
        const { data: authData, error: authError } = await supabase.auth.getUser();
        if (authError || !authData?.user) {
            Logger.error('Cannot submit deal: no authenticated user', authError);
            return false;
        }
        const submittedBy = authData.user.id;

        // Resolve the scope up front: it decides both which venues count as
        // "already known" and, further down, what a bare address is geocoded
        // against.
        const scope = await resolveLocationScope(null);

        // A venue picked out of autocomplete is already resolved, so neither
        // the name match below nor the geocode after it has anything to find.
        let venueId = data.venueId;
        // Whether this submission is what brought the venue into existence.
        // Only the insert below can set artwork directly; every other route to
        // a venue has to go through the RPC further down, because `venues` has
        // an INSERT policy and no UPDATE one.
        let venueCreated = false;
        // Two things were wrong with the previous lookup.
        //
        // `%` and `_` in a submitted name act as LIKE wildcards -- the
        // neighborhood filter earlier in this file escapes exactly these, and
        // this call site was missed -- so a submission named "%" matched the
        // first venue in the table and silently attached itself to it.
        //
        // And the match was global. With more than one metro that means
        // submitting "The Tap Room" in Phoenix attaches the deal to a Chicago
        // venue of the same name, at the Chicago address, with Chicago
        // coordinates. Constraining to the active scope's bounding box keeps
        // same-named venues in different cities distinct, and reuses the same
        // index-friendly box the feed queries already rely on.
        if (!venueId) {
            const escapedVenueName = escapeLikePattern(data.venueName);
            const venueBounds = boundsForRadius(scope.center, scope.radiusKm);

            const { data: existingVenue, error: existingVenueError } = await supabase
                .from('venues')
                .select('id')
                .ilike('name', escapedVenueName)
                .gte('latitude', venueBounds.minLat)
                .lte('latitude', venueBounds.maxLat)
                .gte('longitude', venueBounds.minLng)
                .lte('longitude', venueBounds.maxLng)
                .limit(1)
                .maybeSingle();

            if (existingVenueError) throw existingVenueError;

            if (existingVenue) {
                venueId = existingVenue.id;
            } else {
                const submittedCoords = await geocodeAddress(data.address, {
                    suffix: scope.metro?.geocodeSuffix ?? null,
                    fallback: scope.center,
                });

                if (!submittedCoords.resolved) {
                    Logger.warn(
                        `[submitUserDeal] Could not geocode "${data.address}"; placing at ${scope.metro?.name ?? 'scope centre'} until reviewed`,
                    );
                }

                const { data: newVenue, error: venueError } = await supabase
                    .from('venues')
                    .insert({
                        name: data.venueName,
                        neighborhood: data.neighborhood,
                        address: data.address,
                        // No artwork is recorded as no artwork. The stock URL
                        // that used to go here was written into the row as
                        // though it were a real photograph of the place, which
                        // hid the venue from the very queue that exists to find
                        // it one (hh_venues_needing_image). The menu photo is
                        // deliberately not used here either: it is evidence for
                        // a reviewer, and it goes on the deal rows below.
                        image_url: data.venuePhotoUrl ?? null,
                        image_source: data.venuePhotoUrl ? 'user' : null,
                        // Required by the venues INSERT policy, and what the
                        // server-side rate limit counts against.
                        submitted_by: submittedBy,
                        // Geocode against the metro the user is currently in, so a
                        // submission made while travelling is not placed at home.
                        latitude: submittedCoords.latitude,
                        longitude: submittedCoords.longitude,
                    })
                    .select('id')
                    .single();
                
                if (venueError) throw venueError;
                venueId = newVenue.id;
                venueCreated = true;
            }
        }

        // A photo of the place, offered for a venue the app already knew. This
        // is the common case now that the venue field is an autocomplete, and
        // it is the case the client cannot write itself: there is no UPDATE
        // policy on `venues`, so the photo used to be uploaded, paid for, and
        // then dropped. hh_attach_venue_image is SECURITY DEFINER and fills the
        // column only when it is still empty.
        //
        // Best effort on purpose. The deal rows below are the submission; a
        // venue that keeps the picture it already had is not a reason to lose
        // them.
        if (!venueCreated && data.venuePhotoUrl) {
            const { error: attachError } = await supabase.rpc('hh_attach_venue_image', {
                p_venue_id: venueId,
                p_image_url: data.venuePhotoUrl,
            });

            if (attachError) {
                Logger.warn('[submitUserDeal] Could not attach the venue photo', attachError);
            }
        }

        if (data.schedules.length === 0) {
            Logger.warn('No schedules provided for deal submission');
            return false;
        }

        // parent_deal_id is a self-referencing FK, so every row needs a real,
        // already-known id. Rather than insert-then-select-back to discover a
        // real id (which fails RLS: pending deals aren't SELECT-able, only
        // 'active' ones are, and there's no submitter column to grant that),
        // generate an id client-side for every row — including the group
        // representative itself — and insert them all in a single batch insert.
        const groupId = Crypto.randomUUID();
        const dealsToInsert = data.schedules.map((schedule, index) => ({
            id: index === 0 ? groupId : Crypto.randomUUID(),
            venue_id: venueId,
            title: schedule.dealTitle,
            time_window: schedule.timeWindow,
            price_level: data.priceLevel,
            tags: data.tags,
            type: data.type,
            status: 'pending' as const,
            days_active: schedule.days,
            parent_deal_id: index === 0 ? null : groupId,
            submitted_by: submittedBy,
            // The photo goes on every row of the group, not just the venue.
            // It used to be applied only where a *new* venue was inserted, so
            // adding a deal to a venue already in the app — the common case —
            // uploaded the photo, paid for it, and then dropped it on the
            // floor. `venues` has no UPDATE policy, so backfilling artwork from
            // here is not an option either: attaching it to the deal is both
            // the fix and the right place, since the deal is what a moderator
            // reviews and the photo is what they check it against.
            image_url: data.imageUrl ?? null,
        }));

        const { error: dealError } = await supabase
            .from('deals')
            .insert(dealsToInsert);

        if (dealError) throw dealError;
        return true;
    } catch (e: unknown) {
        Logger.error('Error submitting user deal', e);
        // Surface the server-side rate limit distinctly so the UI can say
        // something more useful than "there was an error".
        if (isRateLimitError(e)) {
            throw new DealSubmissionRateLimitError(
                (e as { message?: string }).message ?? 'Rate limit exceeded',
            );
        }
        return false;
    }
};
