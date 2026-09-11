import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import type BottomSheetType from '@gorhom/bottom-sheet';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getBoundingBoxDeals, getDealById } from '../services/dealService';
import { Deal, MapRegion } from '../types';
import { useMapClusters, MapClusterItem } from './useMapClusters';
import { useLocation } from '../context/LocationContext';
import { Logger } from '../services/logger';
import { resolveLocationScope } from '../services/metroService';
import {
    hasRegionMovedEnough,
    isFiniteCoordinate,
    isUsableRegion,
    reconcileDeals,
} from '../utils/mapRegion';

// Location is obtained through LocationContext. This hook used to `require`
// expo-location itself and keep a second copy of the permission state and the
// user's coordinates, so location was fetched twice and the app's prompt timing
// depended on which screen happened to load first.

// Pre-resolution placeholder only. On mount the map seeds itself from the
// cached viewport, then from the last metro the user was seen in; this value
// is what renders for the frame before either of those resolves.
const defaultRegion: MapRegion = {
    latitude: 41.8781,
    longitude: -87.6298,
    latitudeDelta: 0.0922,
    longitudeDelta: 0.0421,
};

/**
 * How old the deals on screen may be before returning to the Map tab re-fetches
 * them.
 *
 * Tab screens stay mounted for the life of the app, and this screen's only
 * other trigger is a camera move large enough to clear `hasRegionMovedEnough`.
 * So a deal added while the app was running — by the ingestion pipeline, or by
 * the user's own submission being approved — never appeared on the map at all:
 * not on returning to the tab, not on panning around the same neighbourhood,
 * only after a cold start. One minute is short enough that a tester who adds a
 * deal and switches tabs sees it, and long enough that ordinary tab-flicking
 * does not re-query on every touch.
 */
export const DEALS_STALE_AFTER_MS = 60_000;

interface UseMapScreenArgs {
    focusDealId?: string;
    focusLat?: number;
    focusLng?: number;
    /** Changes on every navigation, so re-focusing the same deal works. */
    focusNonce?: string;
}

/**
 * All state and business logic for the native map screen: deal fetching
 * (bounding-box, debounced, request-ID + AbortController sequenced),
 * clustering, user-location lookup, region-change caching, and the
 * bottom-sheet-driven active deal. Kept separate from the screen's JSX
 * (which owns the imperative MapView/BottomSheet refs' rendering) so the
 * fetch/location logic is testable independent of the native map view.
 */
export function useMapScreen({ focusDealId, focusLat, focusLng, focusNonce }: UseMapScreenArgs) {
    const router = useRouter();
    const [deals, setDeals] = useState<Deal[]>([]);
    const [isLoadingDeals, setIsLoadingDeals] = useState(true);
    const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
    const mapRef = useRef<InstanceType<typeof import('react-native-maps').default> | null>(null);
    const bottomSheetRef = useRef<BottomSheetType>(null);
    const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
    const snapPoints = useMemo(() => ['25%', '50%'], []);
    const { requestLocationPermission } = useLocation();
    const [currentRegion, setCurrentRegion] = useState<MapRegion>(defaultRegion);
    // Mirrors `currentRegion` for reads inside callbacks/effects that must not
    // re-run every time the user pans.
    const currentRegionRef = useRef<MapRegion>(defaultRegion);
    // Uncontrolled MapView only reads `initialRegion` once at mount; kept separate from
    // `currentRegion` (which tracks the live/panned viewport) so a cached region can seed
    // the initial camera position without fighting subsequent pan updates.
    const [initialMapRegion, setInitialMapRegion] = useState<MapRegion>(defaultRegion);
    const [locationStatus, setLocationStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [locationMessage, setLocationMessage] = useState<string | null>(null);
    const [hasInitialCentered, setHasInitialCentered] = useState(false);
    const [isFetchingRegion, setIsFetchingRegion] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const latestRegionRequestRef = useRef(0);
    const regionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    // P3: tracks the last region we actually fetched for, used to skip re-fetches on minor pans
    const lastFetchedRegionRef = useRef<MapRegion | null>(null);
    // When the last fetch was *attempted*, or 0 when none has been. Stamped on
    // attempt rather than on success so a failed request still counts as
    // recent — otherwise a screen that cannot reach the network re-queries on
    // every tab switch — and so the focus check below can tell "not started
    // yet" (0) from "just ran".
    const lastFetchedAtRef = useRef(0);
    const focusHandledRef = useRef<string | null>(null);
    // The deal the bottom sheet is showing, readable from inside a fetch
    // without making the fetch callback depend on it.
    const activeDealRef = useRef<Deal | null>(null);

    const clusters = useMapClusters(deals, currentRegion);

    useEffect(() => {
        activeDealRef.current = activeDeal;
    }, [activeDeal]);

    /**
     * `animateToRegion`, with the one check the native call does not do.
     *
     * Coordinates reach here from `parseFloat` on a router parameter and from
     * database rows, and a NaN passed down to the Google Maps SDK is a native
     * crash, not a JS error — so there is nowhere further down to catch it.
     */
    const animateTo = useCallback((region: MapRegion, durationMs: number) => {
        if (!mapRef.current) return;
        if (!isUsableRegion(region)) {
            Logger.warn('[MapScreen] Refusing to animate to a non-finite region', region);
            return;
        }
        mapRef.current.animateToRegion(region, durationMs);
    }, []);

    useEffect(() => {
        if (activeDeal && bottomSheetRef.current) {
            bottomSheetRef.current.snapToIndex(0);
        }
    }, [activeDeal]);

    // Handle incoming focus deal from card "Map" button.
    //
    // Keyed on `focusDealId` + `focusNonce` rather than the deal ID alone. Tab
    // screens stay mounted, so navigating to the map for the *same* deal twice
    // used to be a no-op twice over: the params were identical (so this effect
    // never re-ran) and `focusHandledRef` still held that ID (so it would have
    // bailed anyway). Callers pass a fresh nonce per navigation.
    useEffect(() => {
        if (!focusDealId) return;
        const focusKey = `${focusDealId}:${focusNonce ?? ''}`;
        if (focusHandledRef.current === focusKey) return;
        focusHandledRef.current = focusKey;

        const focusOnDeal = async () => {
            try {
                // Animate map to the deal's coordinates.
                //
                // `isFiniteCoordinate` rather than truthiness: 0 is a real
                // coordinate, and mapSupabaseToDeal defaults a venue with
                // missing coordinates to exactly 0, so a truthy test silently
                // skipped the animation for them. It also rules out the NaN a
                // malformed `lat=`/`lng=` parameter produces, which the native
                // animation would take the process down over.
                if (isFiniteCoordinate(focusLat) && isFiniteCoordinate(focusLng)) {
                    animateTo({
                        latitude: focusLat,
                        longitude: focusLng,
                        latitudeDelta: 0.01,
                        longitudeDelta: 0.01,
                    }, 800);
                }

                // Fetch the deal data and set it as active
                const deal = await getDealById(focusDealId);
                if (deal) {
                    setActiveDeal(deal);
                    // Also make sure it's in the local deals array for the marker
                    setDeals(prev => {
                        const exists = prev.some(d => d.id === deal.id);
                        return exists ? prev : [...prev, deal];
                    });
                }
            } catch (e) {
                Logger.error('Error focusing on deal', e);
            }
        };

        focusOnDeal();
    }, [focusDealId, focusLat, focusLng, focusNonce, animateTo]);

    // Initial load, in two independent phases.
    //
    // Phase 1 (region) must NOT wait on phase 2 (location). `hasInitialCentered`
    // gates the first deal fetch, and it used to be set only after the location
    // permission dialog resolved — so deals didn't start loading until the user
    // answered a modal prompt. Reading the cached region is fast and local, so
    // the map can render and populate straight away while the permission
    // request proceeds alongside it.
    useEffect(() => {
        let cancelled = false;

        const restoreRegion = async () => {
            let hasCachedRegion = false;
            try {
                // Q2: Load cached region if available
                const cachedRegionStr = await AsyncStorage.getItem('last_map_region');
                if (cachedRegionStr) {
                    const cached = JSON.parse(cachedRegionStr);
                    // A cached viewport is read back from disk, so it is only
                    // as trustworthy as whatever wrote it last. A partial or
                    // corrupt one seeds `initialRegion` and every later fetch.
                    if (isUsableRegion(cached)) {
                        if (!cancelled) {
                            setInitialMapRegion(cached);
                            // Seed the region ref too, so the initial fetch targets
                            // the cached viewport rather than the Chicago default.
                            setCurrentRegion(cached);
                            currentRegionRef.current = cached;
                        }
                        hasCachedRegion = true;
                    }
                }

                if (!hasCachedRegion) {
                    // No cached viewport: open on the metro the user was last
                    // seen in rather than a hardcoded city. centerOnUser() still
                    // overrides this when a live fix is available.
                    const scope = await resolveLocationScope(null);
                    if (!cancelled) {
                        const seeded: MapRegion = {
                            latitude: scope.center.latitude,
                            longitude: scope.center.longitude,
                            latitudeDelta: defaultRegion.latitudeDelta,
                            longitudeDelta: defaultRegion.longitudeDelta,
                        };
                        setInitialMapRegion(seeded);
                        setCurrentRegion(seeded);
                        currentRegionRef.current = seeded;
                    }
                }
            } catch (e) {
                Logger.warn('Failed to restore cached map region', e);
            } finally {
                if (!cancelled) {
                    setIsLoadingDeals(false);
                    setHasInitialCentered(true);
                }
            }
            return hasCachedRegion;
        };

        const centerOnUser = async (hasCachedRegion: boolean) => {
            try {
                const coords = await requestLocationPermission();
                if (cancelled || !coords) return;

                // Only auto-center on the user if we're NOT focusing a specific
                // deal and there's no cached region to preserve.
                if (!focusDealId && !hasCachedRegion) {
                    animateTo({
                        ...coords,
                        latitudeDelta: 0.0922,
                        longitudeDelta: 0.0421,
                    }, 1000);
                }
            } catch (e) {
                Logger.warn('Failed to initialize map location', e);
            }
        };

        restoreRegion().then(centerOnUser);

        return () => {
            cancelled = true;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => () => {
        timerRefs.current.forEach(clearTimeout);
        if (regionTimeoutRef.current) {
            clearTimeout(regionTimeoutRef.current);
        }
    }, []);

    const scheduleStatusReset = useCallback((callback: () => void, delayMs = 3000) => {
        const timer = setTimeout(() => {
            callback();
            timerRefs.current = timerRefs.current.filter(t => t !== timer);
        }, delayMs);
        timerRefs.current.push(timer);
    }, []);

    const scheduleToastClear = useCallback(() => {
        scheduleStatusReset(() => {
            setLocationMessage(null);
            setLocationStatus('idle');
        });
    }, [scheduleStatusReset]);

    const handleSelectDeal = useCallback((id: string) => {
        router.push(`/deal/${id}`);
    }, [router]);

    const handleMarkerPress = useCallback((deal: Deal) => {
        setActiveDeal(deal);
    }, []);

    const handleClusterPress = useCallback((item: Extract<MapClusterItem, { type: 'cluster' }>) => {
        animateTo({
            latitude: item.latitude,
            longitude: item.longitude,
            latitudeDelta: currentRegion.latitudeDelta / 2,
            longitudeDelta: currentRegion.longitudeDelta / 2,
        }, 400);
    }, [animateTo, currentRegion.latitudeDelta, currentRegion.longitudeDelta]);

    const handleFindMyLocation = useCallback(async () => {
        setLocationStatus('loading');
        setLocationMessage('Finding your location...');

        try {
            const coords = await requestLocationPermission();
            if (!coords) {
                setLocationStatus('error');
                setLocationMessage('Permission to access location was denied');
                return;
            }

            animateTo({
                ...coords,
                latitudeDelta: 0.0922,
                longitudeDelta: 0.0421,
            }, 1000);

            setLocationStatus('success');
            setLocationMessage('Location found!');
        } catch (error: unknown) {
            Logger.warn('Error finding location', error);
            setLocationStatus('error');
            setLocationMessage('Error finding location');
        } finally {
            scheduleToastClear();
        }
    }, [scheduleToastClear, requestLocationPermission, animateTo]);

    /**
     * Fetch the deals inside a region's bounding box.
     *
     * Sequenced with a request ID + AbortController so a slow response from an
     * earlier region can never overwrite a newer one. Pass `force` to skip the
     * "barely moved" threshold — used for the initial load, for the staleness
     * re-fetch, and for the manual refresh, none of which are about the camera
     * having moved.
     */
    const fetchDealsForRegion = useCallback(async (region: MapRegion, { force = false } = {}) => {
        // Skip the round trip when the user barely moved the map. The threshold
        // is a fraction of what is currently on screen rather than a fixed
        // number of degrees, so it means the same thing at every zoom level —
        // see `hasRegionMovedEnough`.
        if (!force && !hasRegionMovedEnough(lastFetchedRegionRef.current, region)) {
            return;
        }

        const requestId = ++latestRegionRequestRef.current;
        lastFetchedAtRef.current = Date.now();

        // Calculate bounding box from region
        const minLat = region.latitude - region.latitudeDelta / 2;
        const maxLat = region.latitude + region.latitudeDelta / 2;
        const minLng = region.longitude - region.longitudeDelta / 2;
        const maxLng = region.longitude + region.longitudeDelta / 2;

        try {
            setIsFetchingRegion(true);
            setFetchError(null);

            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            const abortController = new AbortController();
            abortControllerRef.current = abortController;

            const newDeals = await getBoundingBoxDeals(minLat, minLng, maxLat, maxLng, abortController.signal);
            if (requestId !== latestRegionRequestRef.current) {
                return;
            }
            lastFetchedRegionRef.current = region;
            setDeals(prev => {
                // Keep whatever the bottom sheet is currently showing, even if
                // this response no longer contains it (the user panned it out
                // of the box, or its schedule ended). Pulling that marker out
                // from under an open callout is both a confusing jump and the
                // native teardown react-native-maps is known to crash on.
                const pinned = activeDealRef.current;
                const withActive =
                    pinned && !newDeals.some(d => d.id === pinned.id)
                        ? [...newDeals, pinned]
                        : newDeals;
                return reconcileDeals(prev, withActive);
            });
        } catch (e: any) {
            if (e.name === 'AbortError' || e.message?.includes('AbortError')) {
                // Ignore abort errors from cancelled requests
                return;
            }
            Logger.error('Error fetching deals for region', e);
            setFetchError('Failed to load deals in this area');
        } finally {
            if (requestId === latestRegionRequestRef.current) {
                setIsFetchingRegion(false);
            }
        }
    }, []);

    const handleRegionChangeComplete = useCallback((region: MapRegion) => {
        setCurrentRegion(region);
        currentRegionRef.current = region;
        if (!hasInitialCentered) return;

        if (regionTimeoutRef.current) {
            clearTimeout(regionTimeoutRef.current);
        }

        regionTimeoutRef.current = setTimeout(() => {
            // Q2: Save current region to AsyncStorage for caching
            AsyncStorage.setItem('last_map_region', JSON.stringify(region)).catch(() => {});
            void fetchDealsForRegion(region);
        }, 400); // 400ms debounce
    }, [hasInitialCentered, fetchDealsForRegion]);

    /**
     * Initial load. `onRegionChangeComplete` is NOT a reliable first-fetch
     * trigger: the map settles (and fires its one initial region event) while
     * `initializeMap` is still awaiting the location permission dialog, so that
     * event is dropped by the `hasInitialCentered` guard above and no further
     * event arrives until the user manually pans — leaving the map empty.
     *
     * So fetch explicitly, exactly once, as soon as initialization finishes,
     * using whatever region the map has actually settled on (or the default if
     * it hasn't settled yet). Request-ID sequencing means a later region-change
     * fetch cleanly supersedes this one.
     */
    useEffect(() => {
        if (!hasInitialCentered) return;
        void fetchDealsForRegion(currentRegionRef.current, { force: true });
    }, [hasInitialCentered, fetchDealsForRegion]);

    /** Re-query the current viewport regardless of where the camera is. */
    const refresh = useCallback(() => {
        void fetchDealsForRegion(currentRegionRef.current, { force: true });
    }, [fetchDealsForRegion]);

    /**
     * Re-fetch on returning to the tab when what is on screen has gone stale.
     *
     * The map is mounted once and kept, so without this the only thing that
     * ever refreshed it was a large camera move: deals added while the app was
     * running stayed invisible until the next cold start. Guarded by an age
     * check so switching tabs back and forth does not re-query on every touch,
     * and by `hasInitialCentered` so it never races the initial load.
     */
    useFocusEffect(
        useCallback(() => {
            if (!hasInitialCentered) return;
            // Nothing has been requested yet. This fires in the same commit
            // as the initial-load effect above, and whichever of the two runs
            // first should be the only one to issue a request.
            if (lastFetchedAtRef.current === 0) return;
            if (Date.now() - lastFetchedAtRef.current < DEALS_STALE_AFTER_MS) return;
            void fetchDealsForRegion(currentRegionRef.current, { force: true });
        }, [hasInitialCentered, fetchDealsForRegion])
    );

    const toastColors = {
        idle: 'hidden',
        loading: 'bg-blue-500',
        success: 'bg-green-500',
        error: 'bg-red-500',
    };

    return {
        mapRef, bottomSheetRef,
        deals, isLoadingDeals, activeDeal, setActiveDeal,
        snapPoints,
        currentRegion, initialMapRegion,
        locationStatus, locationMessage,
        isFetchingRegion, fetchError,
        clusters,
        toastColors,
        handleSelectDeal, handleMarkerPress, handleClusterPress,
        handleFindMyLocation, handleRegionChangeComplete,
        refresh,
    };
}
