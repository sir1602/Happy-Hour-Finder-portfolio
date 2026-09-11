/**
 * Mirror of the "Resolve Metro" Code node in the n8n workflow
 * "HH Finder — 5. Burst Area Scan".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down, in order of how much damage getting it wrong does:
 *
 * 1. The `ok` flag is load-bearing. The form now answers the moment it is
 *    submitted, so this node can no longer throw a bad area onto a screen
 *    anybody is looking at — it returns a failure instead, and `Area Resolved?`
 *    routes on `ok`. Drop the flag from the success path and every scan is
 *    silently diverted to the "could not start" email instead of running.
 * 2. Metro reuse. Without it, scanning "Scottsdale" and then "Tempe" shatters
 *    Phoenix into three overlapping metros, and the app scopes the user's feed
 *    to whichever fragment they happen to be nearest.
 */

/**
 * @param {object} form The `Parse Form` item.
 * @param {unknown} geoRaw The `Geocode Area` response, in any of its shapes.
 * @param {Array<{json: unknown}>} metroItems The `Fetch Metros` output.
 */
function resolveMetro(form, geoRaw, metroItems) {
    let hit = null;
    if (Array.isArray(geoRaw)) hit = geoRaw[0];
    else if (Array.isArray(geoRaw.body)) hit = geoRaw.body[0];
    else if (geoRaw.lat !== undefined) hit = geoRaw;

    // A bad area is returned, not thrown — nobody is watching the form by the
    // time this runs, so a throw would fail in silence. The failure is emailed.
    const failed = (reason) => ({ ok: false, area: form.area, reason: reason });

    if (!hit) {
        return failed('That area could not be found. Try a more specific one, for example "Phoenix, Arizona".');
    }

    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return failed('The geocoder found that area but returned no usable coordinates for it.');
    }

    const metros = [];
    for (const item of metroItems) {
        const j = item.json;
        const rows = Array.isArray(j) ? j : [j];
        for (const r of rows) if (r && r.slug) metros.push(r);
    }

    const distanceKm = (aLat, aLng, bLat, bLng) => {
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(bLat - aLat);
        const dLng = toRad(bLng - aLng);
        const h =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
        return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
    };

    let matched = null;
    let matchedDistance = null;
    for (const m of metros) {
        const d = distanceKm(lat, lng, Number(m.center_lat), Number(m.center_lng));
        if (d <= Number(m.radius_km) && (matchedDistance === null || d < matchedDistance)) {
            matched = m;
            matchedDistance = d;
        }
    }

    const label = String(hit.display_name ?? form.area);
    const parts = label
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    const shortName = parts.length >= 2 ? parts[0] + ', ' + parts[parts.length - 1] : label;

    const slugify = (s) =>
        String(s)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40);

    return {
        ok: true,
        area: form.area,
        maxPlaces: form.maxPlaces,
        searchTerms: form.searchTerms,
        dryRun: form.dryRun,
        startedAt: form.startedAt,
        latitude: lat,
        longitude: lng,
        metroSlug: matched ? matched.slug : slugify(parts[0] ?? form.area),
        metroName: matched ? matched.name : shortName,
        reusedExistingMetro: Boolean(matched),
        reusedDistanceKm: matchedDistance === null ? null : Math.round(matchedDistance * 10) / 10,
        needsCreate: !matched,
    };
}

const formFixture = (overrides = {}) => ({
    area: 'Phoenix, Arizona',
    maxPlaces: 15,
    searchTerms: 'happy hour bar, cocktail bar, gastropub',
    dryRun: false,
    startedAt: '2026-08-31T19:00:00.000Z',
    ...overrides,
});

/** The one metro that actually exists in the corpus today. */
const CHICAGO = {
    json: [
        {
            id: 'm1',
            slug: 'chicago',
            name: 'Chicago, IL',
            center_lat: 41.8781,
            center_lng: -87.6298,
            radius_km: 60,
        },
    ],
};

const hit = (lat, lon, display_name) => [{ lat: String(lat), lon: String(lon), display_name }];

describe('Resolve Metro — the ok flag routes the whole workflow', () => {
    it('marks a resolved area ok so the scan proceeds', () => {
        const out = resolveMetro(formFixture(), hit(33.4484, -112.074, 'Phoenix, Maricopa County, Arizona, United States'), [CHICAGO]);
        expect(out.ok).toBe(true);
    });

    it.each([
        ['an empty geocoder array', []],
        ['an empty body array', { body: [] }],
        ['an object with no lat', { something: 'else' }],
    ])('marks %s not ok, with the area echoed back for the email', (_label, geoRaw) => {
        const out = resolveMetro(formFixture(), geoRaw, [CHICAGO]);
        expect(out.ok).toBe(false);
        expect(out.area).toBe('Phoenix, Arizona');
        expect(out.reason).toContain('could not be found');
    });

    it.each([
        ['non-numeric coordinates', hit('not-a-number', 'nope', 'Somewhere')],
        ['a missing longitude', [{ lat: '41.8', display_name: 'Somewhere' }]],
    ])('marks %s not ok with a distinct reason', (_label, geoRaw) => {
        const out = resolveMetro(formFixture(), geoRaw, [CHICAGO]);
        expect(out.ok).toBe(false);
        expect(out.reason).toContain('no usable coordinates');
    });

    it('reads the geocoder response wrapped in a body', () => {
        const out = resolveMetro(formFixture(), { body: hit(33.4484, -112.074, 'Phoenix, Arizona, United States') }, [CHICAGO]);
        expect(out.ok).toBe(true);
        expect(out.latitude).toBeCloseTo(33.4484);
    });
});

describe('Resolve Metro — metro reuse', () => {
    // Verified against the real data when the pipeline was audited: Naperville
    // sits 45.7 km from the Chicago metro centre, inside its 60 km radius.
    it('files a nearby area under the existing metro', () => {
        const out = resolveMetro(
            formFixture({ area: 'Naperville, Illinois' }),
            hit(41.7508, -88.1535, 'Naperville, DuPage County, Illinois, United States'),
            [CHICAGO]
        );
        expect(out.reusedExistingMetro).toBe(true);
        expect(out.metroSlug).toBe('chicago');
        expect(out.needsCreate).toBe(false);
        expect(out.reusedDistanceKm).toBeGreaterThan(40);
        expect(out.reusedDistanceKm).toBeLessThan(50);
    });

    it('creates a new metro for an area outside every radius', () => {
        const out = resolveMetro(
            formFixture(),
            hit(33.4484, -112.074, 'Phoenix, Maricopa County, Arizona, United States'),
            [CHICAGO]
        );
        expect(out.reusedExistingMetro).toBe(false);
        expect(out.needsCreate).toBe(true);
        expect(out.metroSlug).toBe('phoenix');
        expect(out.reusedDistanceKm).toBeNull();
    });

    it('picks the nearest metro when several contain the point', () => {
        const overlapping = {
            json: [
                { slug: 'far', name: 'Far', center_lat: 41.5, center_lng: -87.6298, radius_km: 90 },
                { slug: 'near', name: 'Near', center_lat: 41.88, center_lng: -87.63, radius_km: 90 },
            ],
        };
        const out = resolveMetro(formFixture(), hit(41.8781, -87.6298, 'Chicago'), [overlapping]);
        expect(out.metroSlug).toBe('near');
    });

    it('creates a metro when none are stored yet', () => {
        const out = resolveMetro(formFixture(), hit(33.4484, -112.074, 'Phoenix, Arizona, United States'), [{ json: [] }]);
        expect(out.needsCreate).toBe(true);
    });
});

describe('Resolve Metro — the form settings survive', () => {
    it('carries coverage, terms, dry run and start time through to the engine', () => {
        const form = formFixture({ maxPlaces: 50, dryRun: true });
        const out = resolveMetro(form, hit(33.4484, -112.074, 'Phoenix, Arizona, United States'), [CHICAGO]);
        expect(out).toMatchObject({
            maxPlaces: 50,
            dryRun: true,
            searchTerms: form.searchTerms,
            startedAt: form.startedAt,
        });
    });
});
