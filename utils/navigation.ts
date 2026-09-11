import { Linking, Platform } from 'react-native';

/**
 * Opens the native maps app with turn-by-turn directions to a given location.
 * Falls back to a Google Maps web URL if the native app is unavailable or
 * if coordinates are missing (lat === 0 && lng === 0).
 *
 * @param name   Human-readable place name (used as the map pin label)
 * @param address Street address — used as fallback search query when coords are absent
 * @param neighborhood Neighborhood — appended to fallback search query
 * @param latitude   Geocoded latitude (0 signals missing/unavailable)
 * @param longitude  Geocoded longitude (0 signals missing/unavailable)
 */
export function openDirections(
    name: string,
    address: string | undefined,
    neighborhood: string,
    latitude: number,
    longitude: number
): void {
    const label = encodeURIComponent(name);

    // If we don't have real coordinates, fall back to a text search
    if (latitude === 0 && longitude === 0) {
        const q = encodeURIComponent(`${name} ${address || neighborhood}`);
        // Every other openURL on this path is guarded; this branch was not, so
        // a device with no handler for the URL produced an unhandled rejection
        // instead of a no-op.
        Linking.openURL(`https://maps.google.com/?q=${q}`).catch(() => {});
        return;
    }

    const url = Platform.select({
        ios: `maps://0,0?daddr=${latitude},${longitude}&q=${label}`,
        android: `google.navigation:q=${latitude},${longitude}&label=${label}`,
        default: `https://maps.google.com/maps?daddr=${latitude},${longitude}`,
    });

    Linking.openURL(url!).catch(() => {
        // Fallback: open Google Maps in browser if native app fails. Guarded
        // too -- if the fallback also fails there is nothing further to try,
        // and an unhandled rejection helps nobody.
        Linking.openURL(`https://maps.google.com/maps?daddr=${latitude},${longitude}`).catch(() => {});
    });
}
