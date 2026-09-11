import { Logger } from '../services/logger';
/**
 * Geocoding utility using the free OpenStreetMap Nominatim API.
 * No API key required. Rate limited to 1 request per second.
 * https://nominatim.org/release-docs/develop/api/Search/
 */

export interface GeocodingResult {
    latitude: number;
    longitude: number;
}

export interface GeocodeOutcome extends GeocodingResult {
    /**
     * False when the lookup failed and `fallback` coordinates were returned
     * instead. Callers should surface or log this rather than treating the
     * result as a real location — a silently placed venue is worse than a
     * rejected one.
     */
    resolved: boolean;
}

export interface GeocodeContext {
    /**
     * City/state appended to a bare street address to disambiguate it, e.g.
     * ", Chicago, IL". Comes from the active metro, so a Phoenix address is
     * never resolved against Illinois.
     */
    suffix?: string | null;
    /** Where to place the venue if the lookup fails. Usually the metro centre. */
    fallback: GeocodingResult;
}

/**
 * Geocode an address string to latitude/longitude coordinates.
 *
 * The caller supplies the city context and the fallback, so this function has
 * no opinion about which city the app is serving.
 */
export async function geocodeAddress(
    address: string,
    context: GeocodeContext,
): Promise<GeocodeOutcome> {
    const fallback = { ...context.fallback, resolved: false };

    if (!address || address.trim().length === 0) {
        Logger.warn('[Geocoding] Empty address, using fallback coordinates');
        return fallback;
    }

    // Only append the city context when the address does not already carry it,
    // so "1 N Central Ave, Phoenix, AZ" is not turned into a double-city query.
    const suffix = context.suffix?.trim();
    const suffixToken = suffix?.replace(/^,\s*/, '').split(',')[0]?.trim().toLowerCase();
    const alreadyScoped = suffixToken
        ? address.toLowerCase().includes(suffixToken)
        : true;
    const query = alreadyScoped || !suffix ? address : `${address}${suffix.startsWith(',') ? '' : ', '}${suffix}`;

    try {
        const encoded = encodeURIComponent(query);
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encoded}&limit=1&countrycodes=us`;

        const response = await fetch(url, {
            headers: {
                // Nominatim requires a User-Agent header
                'User-Agent': 'HappyHourFinder/1.0',
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            Logger.warn(`[Geocoding] HTTP ${response.status} for address: ${address}`);
            return fallback;
        }

        const results = await response.json();

        if (results && results.length > 0) {
            const { lat, lon } = results[0];
            const latitude = parseFloat(lat);
            const longitude = parseFloat(lon);

            if (!isNaN(latitude) && !isNaN(longitude)) {
                return { latitude, longitude, resolved: true };
            }
        }

        Logger.warn(`[Geocoding] No results found for: ${address}`);
        return fallback;
    } catch (error) {
        Logger.error('[Geocoding] Failed to geocode address', error);
        return fallback;
    }
}
