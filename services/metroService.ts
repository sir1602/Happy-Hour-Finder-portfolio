import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { Logger } from './logger';
import { cacheService } from './cacheService';
import { calculateDistanceKm } from '../utils/location';

/**
 * Metro (city) coverage and the location scope derived from it.
 *
 * Two different jobs, deliberately kept apart:
 *   - The n8n pipeline scopes by *metro*, because discovery and geocoding need
 *     per-city configuration.
 *   - The app scopes by *radius around the user*, because "what's near me" does
 *     not need city identity at all.
 *
 * Metros exist here only to answer two questions the radius cannot: where to
 * centre the map when we have no fix on the user, and which city's context to
 * geocode a submitted address against.
 */

export interface Metro {
    id: string;
    slug: string;
    name: string;
    centerLat: number;
    centerLng: number;
    radiusKm: number;
    geocodeSuffix: string | null;
    timezone: string;
}

export interface LocationScope {
    /** Centre of the search area — the user when we know where they are, else a metro centre. */
    center: { latitude: number; longitude: number };
    radiusKm: number;
    /** The metro this scope belongs to, when one could be determined. */
    metro: Metro | null;
    /** Set when the user is outside every metro's radius and we fell back to the nearest. */
    isFallback: boolean;
    /** Distance from the user to `metro`, in km. Only meaningful when isFallback. */
    distanceKm: number | null;
}

/** How far around the user still counts as "near me". */
export const DEFAULT_RADIUS_KM = 60;

const METROS_CACHE_KEY = 'metros';
const METROS_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_METRO_STORAGE_KEY = '@happy_hour_active_metro';

/** Last-resort centre when there is no location fix, no stored metro, and no rows. */
const FALLBACK_METRO: Metro = {
    id: 'fallback',
    slug: 'chicago',
    name: 'Chicago, IL',
    centerLat: 41.8781,
    centerLng: -87.6298,
    radiusKm: DEFAULT_RADIUS_KM,
    geocodeSuffix: ', Chicago, IL',
    timezone: 'America/Chicago',
};

const mapMetro = (row: any): Metro => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    centerLat: Number(row.center_lat),
    centerLng: Number(row.center_lng),
    radiusKm: Number(row.radius_km),
    geocodeSuffix: row.geocode_suffix ?? null,
    timezone: row.timezone,
});

/**
 * All covered metros. Cached for a day — this table changes only when a new
 * city is scanned for the first time.
 */
export const getMetros = async (): Promise<Metro[]> => {
    const cached = await cacheService.get<Metro[]>(METROS_CACHE_KEY);
    if (cached && cached.length > 0) return cached;

    try {
        const { data, error } = await supabase
            .from('metros')
            .select('id, slug, name, center_lat, center_lng, radius_km, geocode_suffix, timezone')
            .order('name');

        if (error) throw error;

        const metros = (data ?? []).map(mapMetro);
        if (metros.length > 0) {
            await cacheService.set(METROS_CACHE_KEY, metros, METROS_TTL_MS);
        }
        return metros;
    } catch (e) {
        Logger.warn('[getMetros] Fetch failed, falling back to expired cache', e);
        const stale = await cacheService.get<Metro[]>(METROS_CACHE_KEY, true);
        return stale ?? [];
    }
};

const readStoredMetroSlug = async (): Promise<string | null> => {
    try {
        return await AsyncStorage.getItem(ACTIVE_METRO_STORAGE_KEY);
    } catch (e) {
        Logger.warn('[metroService] Could not read stored metro', e);
        return null;
    }
};

/**
 * Remember which metro the user was last in, so a cold start without a location
 * fix still shows the right city rather than defaulting to Chicago.
 */
export const rememberActiveMetro = async (slug: string): Promise<void> => {
    try {
        await AsyncStorage.setItem(ACTIVE_METRO_STORAGE_KEY, slug);
    } catch (e) {
        Logger.warn('[metroService] Could not persist active metro', e);
    }
};

const distanceKmTo = (
    from: { latitude: number; longitude: number },
    metro: Metro,
): number => calculateDistanceKm(from.latitude, from.longitude, metro.centerLat, metro.centerLng);

/**
 * Work out which area to show deals for.
 *
 * Precedence:
 *   1. A live location fix inside a covered metro — centre on the user.
 *   2. A live fix outside every metro — centre on the *nearest* metro and flag
 *      it, so the UI can say "showing Chicago, 300 km away" instead of an
 *      empty screen.
 *   3. No fix — the metro the user was last seen in, else the first covered
 *      metro, else Chicago.
 */
export const resolveLocationScope = async (
    userLocation: { latitude: number; longitude: number } | null,
): Promise<LocationScope> => {
    const metros = await getMetros();

    if (userLocation) {
        // Nearest first, so "inside a metro" and "nearest metro" are one lookup.
        const ranked = metros
            .map((metro) => ({ metro, distance: distanceKmTo(userLocation, metro) }))
            .sort((a, b) => a.distance - b.distance);

        const containing = ranked.find(({ metro, distance }) => distance <= metro.radiusKm);

        if (containing) {
            await rememberActiveMetro(containing.metro.slug);
            return {
                center: userLocation,
                radiusKm: DEFAULT_RADIUS_KM,
                metro: containing.metro,
                isFallback: false,
                distanceKm: containing.distance,
            };
        }

        if (ranked.length > 0) {
            const nearest = ranked[0];
            return {
                center: { latitude: nearest.metro.centerLat, longitude: nearest.metro.centerLng },
                radiusKm: nearest.metro.radiusKm,
                metro: nearest.metro,
                isFallback: true,
                distanceKm: nearest.distance,
            };
        }

        // No metros configured at all — show what is near the user rather than nothing.
        return {
            center: userLocation,
            radiusKm: DEFAULT_RADIUS_KM,
            metro: null,
            isFallback: false,
            distanceKm: null,
        };
    }

    const storedSlug = await readStoredMetroSlug();
    const metro =
        metros.find((m) => m.slug === storedSlug) ?? metros[0] ?? FALLBACK_METRO;

    return {
        center: { latitude: metro.centerLat, longitude: metro.centerLng },
        radiusKm: metro.radiusKm,
        metro,
        isFallback: false,
        distanceKm: null,
    };
};

/**
 * Stable, short identifier for a scope. Used in cache keys so a cached Chicago
 * response is never served in Phoenix. Rounded to ~1km so small GPS jitter does
 * not blow the cache on every reading.
 */
export const scopeCacheKey = (scope: LocationScope | null | undefined): string => {
    if (!scope) return 'noscope';
    const lat = scope.center.latitude.toFixed(2);
    const lng = scope.center.longitude.toFixed(2);
    return `${lat},${lng},${scope.radiusKm}`;
};
