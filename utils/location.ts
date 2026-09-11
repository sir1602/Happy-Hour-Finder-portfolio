const EARTH_RADIUS_KM = 6371;

/**
 * Miles per kilometre. Kept as the literal the mile formatter has always used,
 * so converting a distance to miles produces exactly the value it did before
 * `calculateDistanceKm` was split out below.
 */
const MILES_PER_KM = 0.621371;

/**
 * Great-circle distance between two points, in KILOMETRES, unrounded.
 *
 * This is the primitive; `calculateDistance` below converts it for display.
 * Anything comparing against a radius, a bounding box, or a `*_km` column from
 * the database wants this one — the server's own `hh_distance_km()` returns
 * kilometres, and mixing the two units silently inflates every comparison by
 * 1.61x. `metroService` did exactly that: it called the mile-returning function,
 * named the result `distanceKm`, and compared it to `metros.radius_km`, so a
 * 60 km metro behaved as a 60 MILE one and users up to 96 km out were treated
 * as inside it — centred on themselves, with no venues in range and no
 * out-of-coverage fallback, because the containment check had "matched".
 */
export const calculateDistanceKm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_KM * c;
};

/**
 * Great-circle distance in MILES, rounded to one decimal place.
 *
 * This is the display unit — `getDistanceTo` renders it as "0.8 mi". Do not use
 * it for radius maths; see `calculateDistanceKm`.
 */
export const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const distanceMiles = calculateDistanceKm(lat1, lon1, lat2, lon2) * MILES_PER_KM;
    return parseFloat(distanceMiles.toFixed(1));
};
