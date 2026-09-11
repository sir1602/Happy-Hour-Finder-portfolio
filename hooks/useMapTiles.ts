import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Network from 'expo-network';
import { Logger } from '../services/logger';

/**
 * Detects the one map failure the app previously had no signal for: the native
 * MapView mounts, draws its Google watermark, and then renders nothing at all.
 *
 * That is what a rejected Maps API key looks like from inside the app. It is
 * indistinguishable from a working map over empty water, it produces no JS
 * error, no `onError`, and nothing in Sentry — the only evidence is an
 * "Authorization failure" in `adb logcat`, which no alpha tester will ever run.
 * `docs/Device-Testing.md` documents the causes; this hook makes the app say
 * which one applies instead of showing a black rectangle.
 *
 * The signal is `onMapLoaded`, which react-native-maps fires only once the map
 * has finished rendering tiles. Tiles rejected -> it never fires. Because the
 * absence of a callback is not itself an event, the check is a timeout: if the
 * map has not reported tiles within `TILE_LOAD_TIMEOUT_MS` of being mounted,
 * something is wrong, and the reason is then narrowed from the network state
 * and the key baked into this build.
 *
 * Android only. `onMapLoaded` is a Google Maps callback, and this app does not
 * set `provider`, so iOS runs on Apple Maps and never fires it — arming the
 * timer there would report every healthy iOS map as broken. Nothing here ever
 * blocks the map from rendering: on a build whose tiles load, the callback
 * arrives, the timer is cleared, and the hook stays invisible.
 */

/**
 * Generous on purpose. A cold Google Maps SDK start on a slow connection can
 * take several seconds, and a false "map is broken" over a map that was merely
 * slow is worse than a late-but-correct one.
 */
export const TILE_LOAD_TIMEOUT_MS = 12_000;

export type MapTileStatus = 'pending' | 'loaded' | 'unavailable';

export type MapTileFailure =
    /** No key (or the .env.example placeholder) was compiled into this build. */
    | 'missing-key'
    /** No connectivity, so tiles could not be fetched. Not a build problem. */
    | 'offline'
    /** A real key is present, so Google refused it — restrictions, SDK, billing. */
    | 'rejected-key';

/** Values from `.env.example` and this repo's docs, copied through verbatim. */
const PLACEHOLDER_KEYS = new Set([
    'your_google_maps_key',
    'your-google-maps-key',
    'your_google_maps_api_key',
    'aiza...',
]);

/**
 * True when `key` could plausibly be a real Google Maps key. This only rules
 * out the values that are definitely not one — it cannot tell a valid key from
 * a revoked one, which is exactly why 'rejected-key' exists as a separate case.
 */
export function isUsableMapsKey(key: string | undefined | null): boolean {
    const trimmed = key?.trim() ?? '';
    if (!trimmed) return false;
    return !PLACEHOLDER_KEYS.has(trimmed.toLowerCase());
}

/**
 * The key this binary actually shipped with, as opposed to the one the build
 * machine had. Read from the embedded manifest first (that is the value written
 * into AndroidManifest/Info.plist at prebuild) and from the inlined
 * `EXPO_PUBLIC_` variable second.
 */
export function readConfiguredMapsKey(): string {
    const fromManifest =
        Platform.OS === 'android'
            ? Constants.expoConfig?.android?.config?.googleMaps?.apiKey
            : Constants.expoConfig?.ios?.config?.googleMapsApiKey;

    return (fromManifest || process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '').trim();
}

interface UseMapTilesArgs {
    /**
     * Whether the MapView is actually mounted. The screen shows a spinner while
     * deals load, so arming the timer on mount of the *hook* would start the
     * clock before the map existed and could time out a map that had not yet
     * had a chance to draw.
     */
    enabled: boolean;
}

export function useMapTiles({ enabled }: UseMapTilesArgs) {
    const [status, setStatus] = useState<MapTileStatus>('pending');
    const [failure, setFailure] = useState<MapTileFailure | null>(null);
    /** Bumped by `retry` and used as the MapView's `key`, to force a remount. */
    const [mapKey, setMapKey] = useState(0);

    const handleMapLoaded = useCallback(() => {
        setStatus('loaded');
        setFailure(null);
    }, []);

    const retry = useCallback(() => {
        setStatus('pending');
        setFailure(null);
        setMapKey(key => key + 1);
    }, []);

    useEffect(() => {
        if (!enabled) return;
        if (Platform.OS !== 'android') return;
        if (status !== 'pending') return;

        let cancelled = false;

        const timer = setTimeout(async () => {
            let offline = false;
            try {
                const state = await Network.getNetworkStateAsync();
                offline = !state.isConnected || state.isInternetReachable === false;
            } catch {
                // Assume online: a failed connectivity check is not evidence of
                // being offline, and blaming the network would hide a bad key.
            }
            if (cancelled) return;

            const key = readConfiguredMapsKey();
            const reason: MapTileFailure = offline
                ? 'offline'
                : isUsableMapsKey(key)
                    ? 'rejected-key'
                    : 'missing-key';

            setFailure(reason);
            setStatus('unavailable');

            const message = `[MapScreen] No map tiles after ${TILE_LOAD_TIMEOUT_MS}ms (${reason})`;
            if (reason === 'offline') {
                // Routine, and self-healing once connectivity returns.
                Logger.warn(message);
            } else {
                // A build-configuration fault: every user of this build sees a
                // blank map, so it warrants a Sentry event rather than a
                // breadcrumb that only surfaces alongside some later error.
                Logger.error(message, undefined, { hasMapsKey: isUsableMapsKey(key) });
            }
        }, TILE_LOAD_TIMEOUT_MS);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [enabled, status, mapKey]);

    return {
        status,
        failure,
        mapKey,
        /** Pass to `<MapView onMapLoaded={...} />`. */
        handleMapLoaded,
        retry,
    };
}
