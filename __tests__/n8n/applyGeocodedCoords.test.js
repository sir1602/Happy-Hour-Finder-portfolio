/**
 * Mirror of the "Apply Geocoded Coords" Code node in the n8n workflow
 * "HH Finder — 1. Deal Intake API".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: this is the last thing between an address nobody
 * can find and a row in the only table the app reads.
 *
 * It used to invent coordinates. A miss fell back to Chicago's centre
 * (41.8781, -87.6298) and zeroed the confidence. Zeroing was the right instinct
 * and it does stop auto-publication — but the deal still reached the pending
 * queue carrying Chicago's coordinates, and the digest's Approve button does
 * not check confidence. One click published a Phoenix bar into the Chicago
 * feed, and the app scopes by radius around the user, so it showed up.
 *
 * Two rules came out of that, and both are asserted below:
 *
 * 1. Nothing is invented. A venue that cannot be placed is refused, and the
 *    upsert is never reached. The metro centre was the other candidate and is
 *    no better in kind — still a venue pinned somewhere it is not.
 * 2. "No such address" and "the geocoder was unreachable" get different
 *    answers. Returning 400 for an outage blames a payload that was fine, and
 *    the caller would edit an address that was already correct.
 */

/**
 * @param {object} base The `Normalize & Validate` item.
 * @param {object} res  The `Geocode via Nominatim` response item.
 */
function applyGeocodedCoords(base, res) {
    const intake = base.intake;

    // The node sends the full response, so "there is no such address" can be
    // told from "the geocoder was unreachable".
    const code = res.statusCode;
    const payload = code === undefined ? res : res.body;

    let hits = null;
    if (Array.isArray(payload)) hits = payload;
    else if (payload && Array.isArray(payload.body)) hits = payload.body;
    else if (payload && payload.lat !== undefined) hits = [payload];

    const reachable = (code === undefined || (code >= 200 && code < 300)) && hits !== null;

    const hit = (hits && hits.length) ? hits[0] : null;
    const lat = hit ? Number(hit.lat) : NaN;
    const lon = hit ? Number(hit.lon) : NaN;
    const resolved = Number.isFinite(lat) && Number.isFinite(lon);

    if (resolved) {
        intake.venue.latitude = lat;
        intake.venue.longitude = lon;
        return { json: { ok: true, errors: [], geocoded: true, status: 200, intake: intake } };
    }

    const query = String(base.geocodeQuery || intake.venue.address || '(no address given)');

    if (!reachable) {
        return {
            json: {
                ok: false, geocoded: false, status: 503, errors: [
                    'The geocoder could not be reached, so this venue could not be placed. ' +
                    'Nothing was written -- retry shortly.'
                ]
            }
        };
    }

    return {
        json: {
            ok: false, geocoded: false, status: 400, errors: [
                'venue.address could not be geocoded: "' + query.slice(0, 200) + '". ' +
                'Send venue.latitude and venue.longitude, or correct the address.'
            ]
        }
    };
}

const baseFixture = (overrides = {}) => ({
    ok: true,
    errors: [],
    needsGeocode: true,
    geocodeQuery: '100 N Main St, Chicago, IL 60622',
    intake: {
        source: 'webhook',
        metro_slug: 'chicago',
        venue: {
            name: 'Taco Bar',
            address: '100 N Main St, Chicago, IL 60622',
            neighborhood: 'Wicker Park',
            latitude: null,
            longitude: null,
        },
        deal: { title: '$3 Tacos & $5 Margaritas', time_window: '4 PM - 6 PM', confidence: 0.9 },
    },
    ...overrides,
});

/** A 2xx carrying the array Nominatim actually returns. */
const found = (lat, lon) => ({ statusCode: 200, body: [{ lat: String(lat), lon: String(lon) }] });

/** A 2xx carrying the empty array Nominatim returns for an address it cannot find. */
const notFound = () => ({ statusCode: 200, body: [] });

describe('Apply Geocoded Coords — a venue that resolves', () => {
    it('takes the coordinates the geocoder gave', () => {
        const base = baseFixture();
        const out = applyGeocodedCoords(base, found(41.9096, -87.6773)).json;
        expect(out.geocoded).toBe(true);
        expect(out.ok).toBe(true);
        expect(out.intake.venue.latitude).toBeCloseTo(41.9096);
        expect(out.intake.venue.longitude).toBeCloseTo(-87.6773);
    });

    it('carries the whole intake payload through untouched', () => {
        const base = baseFixture();
        const out = applyGeocodedCoords(base, found(41.9096, -87.6773)).json;
        expect(out.intake.deal.title).toBe('$3 Tacos & $5 Margaritas');
        expect(out.intake.deal.confidence).toBe(0.9);
        expect(out.intake.metro_slug).toBe('chicago');
    });

    // Nominatim returns coordinates as strings.
    it('accepts string coordinates', () => {
        const out = applyGeocodedCoords(baseFixture(), found('41.9096', '-87.6773')).json;
        expect(out.intake.venue.latitude).toBeCloseTo(41.9096);
    });

    it('accepts a response with no statusCode, for a node not sending the full response', () => {
        const out = applyGeocodedCoords(baseFixture(), [{ lat: '41.9', lon: '-87.6' }]).json;
        expect(out.geocoded).toBe(true);
    });

    it('accepts a single object rather than an array', () => {
        const out = applyGeocodedCoords(baseFixture(), { lat: '41.9', lon: '-87.6' }).json;
        expect(out.geocoded).toBe(true);
    });
});

describe('Apply Geocoded Coords — nothing is ever invented', () => {
    // The regression this file was added for. Chicago's centre is 41.8781,
    // -87.6298; it must not appear on any path.
    it.each([
        ['an address with no match', notFound()],
        ['a 500 from the geocoder', { statusCode: 500, body: { message: 'boom' } }],
        ['an error item from onError=continueRegularOutput', { error: 'ETIMEDOUT' }],
        ['a hit with unusable coordinates', { statusCode: 200, body: [{ lat: 'nope', lon: 'nope' }] }],
    ])('refuses %s rather than placing the venue', (_label, res) => {
        const base = baseFixture();
        const out = applyGeocodedCoords(base, res).json;
        expect(out.geocoded).toBe(false);
        expect(out.ok).toBe(false);
        // No coordinates are handed downstream at all...
        expect(out.intake).toBeUndefined();
        // ...and in particular not Chicago's.
        expect(JSON.stringify(out)).not.toContain('41.8781');
        expect(JSON.stringify(out)).not.toContain('-87.6298');
    });

    it('leaves the venue unplaced on the payload it was given', () => {
        const base = baseFixture();
        applyGeocodedCoords(base, notFound());
        expect(base.intake.venue.latitude).toBeNull();
        expect(base.intake.venue.longitude).toBeNull();
    });
});

describe('Apply Geocoded Coords — a bad address and a broken geocoder are different', () => {
    // A 2xx with an empty array is the geocoder working correctly and saying
    // "no such place". That is the caller's address to fix.
    it('answers 400 when the geocoder ran and found nothing', () => {
        const out = applyGeocodedCoords(baseFixture(), notFound()).json;
        expect(out.status).toBe(400);
        expect(out.errors[0]).toContain('could not be geocoded');
    });

    it('names the address it could not find, so the caller knows what to correct', () => {
        const base = baseFixture({ geocodeQuery: 'zzqq9999 Nonexistent Blvd' });
        const out = applyGeocodedCoords(base, notFound()).json;
        expect(out.errors[0]).toContain('zzqq9999 Nonexistent Blvd');
        expect(out.errors[0]).toContain('venue.latitude');
    });

    it('falls back to the stored address when there is no geocode query', () => {
        const base = baseFixture({ geocodeQuery: '' });
        const out = applyGeocodedCoords(base, notFound()).json;
        expect(out.errors[0]).toContain('100 N Main St');
    });

    it.each([
        ['a 500', { statusCode: 500, body: { message: 'boom' } }],
        ['a 429', { statusCode: 429, body: { message: 'slow down' } }],
        ['a request that never returned', { error: 'ECONNRESET' }],
        ['a 2xx carrying something that is not a result list', { statusCode: 200, body: { unexpected: true } }],
    ])('answers 503 on %s, so a good payload is not blamed', (_label, res) => {
        const out = applyGeocodedCoords(baseFixture(), res).json;
        expect(out.status).toBe(503);
        expect(out.errors[0]).toContain('could not be reached');
        expect(out.errors[0]).toContain('retry');
    });

    // A 5xx whose body happens to be an array must still read as an outage:
    // the status is the authority, not the shape of what came back.
    it('does not trust an array body on a non-2xx', () => {
        const out = applyGeocodedCoords(baseFixture(), { statusCode: 503, body: [] }).json;
        expect(out.status).toBe(503);
    });

    it('truncates an absurdly long address rather than echoing it whole', () => {
        const base = baseFixture({ geocodeQuery: 'x'.repeat(500) });
        const out = applyGeocodedCoords(base, notFound()).json;
        expect(out.errors[0].length).toBeLessThan(400);
    });
});
