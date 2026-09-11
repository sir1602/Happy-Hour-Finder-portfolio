import { Deal, MapRegion } from '../types';

/**
 * Pure geometry/identity helpers for the map screen.
 *
 * They live outside `useMapScreen`/`useMapClusters` because both of the bugs
 * they exist to fix are arithmetic, not React: deciding when a camera move is
 * worth a re-fetch, and deciding when two fetches produced the same deals.
 * Kept here they are testable without a native map, a navigator, or a network.
 */

/**
 * Coordinates handed to react-native-maps end up in the Google Maps SDK
 * unchecked. A NaN or an Infinity there is not a JS error to catch — it is a
 * native exception that takes the process down. Every coordinate in this app
 * arrives from either a URL parameter (`parseFloat` on an arbitrary string) or
 * a database row, so both need screening before they reach a `<Marker>` or
 * `animateToRegion`.
 */
export const isFiniteCoordinate = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

/** True when `region` is safe to animate to, cluster against, or fetch for. */
export const isUsableRegion = (region: MapRegion | null | undefined): region is MapRegion =>
    !!region &&
    isFiniteCoordinate(region.latitude) &&
    isFiniteCoordinate(region.longitude) &&
    isFiniteCoordinate(region.latitudeDelta) &&
    isFiniteCoordinate(region.longitudeDelta) &&
    region.latitudeDelta > 0 &&
    region.longitudeDelta > 0;

/** True when this deal has coordinates a marker can actually be placed at. */
export const isPlottableDeal = (deal: Deal | null | undefined): deal is Deal =>
    !!deal &&
    isFiniteCoordinate(deal.latitude) &&
    isFiniteCoordinate(deal.longitude) &&
    Math.abs(deal.latitude) <= 90 &&
    Math.abs(deal.longitude) <= 180;

/**
 * How far the camera must move, as a fraction of what is currently on screen,
 * before the deals are re-fetched.
 *
 * This used to be an absolute 0.002° (~200 m) in latitude, longitude *and*
 * zoom, which is only meaningful at one zoom level. Zoomed in to a couple of
 * blocks — where a user actually reads a map — the whole viewport is narrower
 * than the threshold, so panning across it, and every zoom step, compared as
 * "barely moved" and no fetch was ever issued again. Expressed as a fraction of
 * the current span the same rule means the same thing at every zoom.
 */
export const REGION_MOVE_FRACTION = 0.25;
export const REGION_ZOOM_FRACTION = 0.2;

/** Whether the move from `prev` to `next` is worth a network round trip. */
export const hasRegionMovedEnough = (prev: MapRegion | null | undefined, next: MapRegion): boolean => {
    // No previous fetch, or a region we cannot reason about: fetch and find out.
    if (!isUsableRegion(prev) || !isUsableRegion(next)) return true;

    const movedLat = Math.abs(next.latitude - prev.latitude) >= prev.latitudeDelta * REGION_MOVE_FRACTION;
    const movedLng = Math.abs(next.longitude - prev.longitude) >= prev.longitudeDelta * REGION_MOVE_FRACTION;
    const zoomed =
        Math.abs(next.latitudeDelta - prev.latitudeDelta) >= prev.latitudeDelta * REGION_ZOOM_FRACTION ||
        Math.abs(next.longitudeDelta - prev.longitudeDelta) >= prev.longitudeDelta * REGION_ZOOM_FRACTION;

    return movedLat || movedLng || zoomed;
};

/** Field-by-field comparison, with the two array-valued fields handled in order. */
const dealsAreEquivalent = (a: Deal, b: Deal): boolean => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Deal>;

    for (const key of keys) {
        const left = a[key];
        const right = b[key];

        if (Array.isArray(left) || Array.isArray(right)) {
            if (!Array.isArray(left) || !Array.isArray(right)) return false;
            if (left.length !== right.length) return false;
            if (left.some((value, index) => value !== right[index])) return false;
            continue;
        }

        if (left !== right) return false;
    }

    return true;
};

/**
 * Fold a fresh fetch into the deals already on screen, keeping the *object*
 * for every deal that did not change, and returning `prev` itself when nothing
 * changed at all.
 *
 * `setDeals(await getBoundingBoxDeals(...))` looks harmless and is not: every
 * response is a fresh array of freshly-built objects, so panning back over the
 * same block replaced all ~100 identical deals with equal-but-new ones. That
 * re-rendered every memoized `<DealMarker>`, which pushes a property update
 * into every native Google Maps marker — including whichever one has its info
 * window open, which is precisely the state react-native-maps is known to
 * crash in on Android. Preserving identity makes the common "same deals came
 * back" case a no-op all the way down to the native view.
 */
export const reconcileDeals = (prev: Deal[], next: Deal[]): Deal[] => {
    const previousById = new Map(prev.map((deal) => [deal.id, deal]));
    let changed = prev.length !== next.length;

    const merged = next.map((deal, index) => {
        const existing = previousById.get(deal.id);
        if (existing && dealsAreEquivalent(existing, deal)) {
            // Same deal, same values — but it may have moved position in the
            // array, which still makes the array itself a different one.
            if (prev[index] !== existing) changed = true;
            return existing;
        }
        changed = true;
        return deal;
    });

    return changed ? merged : prev;
};
