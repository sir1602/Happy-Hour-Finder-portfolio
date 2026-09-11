import { submitUserDeal } from '../../services/dealService';
import { supabase } from '../../services/supabase';
import { resolveLocationScope } from '../../services/metroService';
import { geocodeAddress } from '../../utils/geocoding';

jest.mock('../../services/supabase', () => ({
    supabase: { from: jest.fn(), rpc: jest.fn(), auth: { getUser: jest.fn() } },
}));

jest.mock('../../services/metroService', () => ({
    ...jest.requireActual('../../services/metroService'),
    resolveLocationScope: jest.fn(),
}));

jest.mock('../../utils/geocoding', () => ({
    geocodeAddress: jest.fn().mockResolvedValue({ latitude: 41.89, longitude: -87.63, resolved: true }),
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000000' }));

const mockResolveScope = resolveLocationScope as jest.MockedFunction<typeof resolveLocationScope>;

const CHICAGO_SCOPE = {
    center: { latitude: 41.8781, longitude: -87.6298 },
    radiusKm: 60,
    metro: {
        id: 'm1', slug: 'chicago', name: 'Chicago, IL',
        centerLat: 41.8781, centerLng: -87.6298, radiusKm: 60,
        geocodeSuffix: ', Chicago, IL', timezone: 'America/Chicago',
    },
    isFallback: false,
    distanceKm: null,
};

const SUBMISSION = {
    venueName: 'The Tap Room',
    neighborhood: 'River North',
    address: '745 N Birch Ave',
    priceLevel: 2,
    tags: ['Beer'],
    type: 'regular' as const,
    schedules: [{ days: [1], timeWindow: '4 PM - 6 PM', dealTitle: '$5 drafts' }],
};

/** Captures the venue-lookup query so the test can inspect how it was built. */
const mockVenueLookup = (existingVenue: { id: string } | null) => {
    const venueQuery: any = {
        select: jest.fn().mockReturnThis(),
        ilike: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        lte: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: existingVenue, error: null }),
        insert: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: { id: 'new-venue' }, error: null }),
    };
    const dealsInsert = jest.fn().mockResolvedValue({ error: null });

    (supabase.from as jest.Mock).mockImplementation((table: string) =>
        table === 'venues' ? venueQuery : { insert: dealsInsert }
    );
    return { venueQuery, dealsInsert };
};

beforeEach(() => {
    jest.clearAllMocks();
    (supabase.auth.getUser as jest.Mock).mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: { attached: true }, error: null });
    mockResolveScope.mockResolvedValue(CHICAGO_SCOPE as any);
});

describe('submitUserDeal — venue de-duplication', () => {
    // `%` and `_` are LIKE wildcards. The neighborhood filter elsewhere in this
    // file escapes them; this call site was missed, so a submission named "%"
    // matched the first venue in the table and silently attached itself to it.
    it('escapes LIKE wildcards in the submitted venue name', async () => {
        const { venueQuery } = mockVenueLookup(null);

        await submitUserDeal({ ...SUBMISSION, venueName: '100% Bar_Grill' });

        const [, pattern] = venueQuery.ilike.mock.calls[0];
        expect(pattern).toBe('100\\% Bar\\_Grill');
    });

    it('leaves an ordinary name untouched', async () => {
        const { venueQuery } = mockVenueLookup(null);

        await submitUserDeal(SUBMISSION);

        expect(venueQuery.ilike).toHaveBeenCalledWith('name', 'The Tap Room');
    });

    // The lookup was global. With more than one metro that means submitting
    // "The Tap Room" in Phoenix attaches the deal to a Chicago venue of the
    // same name, at the Chicago address, with Chicago coordinates.
    it('constrains the match to the active scope', async () => {
        const { venueQuery } = mockVenueLookup(null);

        await submitUserDeal(SUBMISSION);

        const latLower = venueQuery.gte.mock.calls.find((c: any[]) => c[0] === 'latitude')?.[1];
        const latUpper = venueQuery.lte.mock.calls.find((c: any[]) => c[0] === 'latitude')?.[1];
        const lngLower = venueQuery.gte.mock.calls.find((c: any[]) => c[0] === 'longitude')?.[1];
        const lngUpper = venueQuery.lte.mock.calls.find((c: any[]) => c[0] === 'longitude')?.[1];

        // Brackets Chicago...
        expect(latLower).toBeLessThan(41.8781);
        expect(latUpper).toBeGreaterThan(41.8781);
        expect(lngLower).toBeLessThan(-87.6298);
        expect(lngUpper).toBeGreaterThan(-87.6298);

        // ...and cannot reach Phoenix.
        expect(33.4484 < latLower || 33.4484 > latUpper).toBe(true);
        expect(-112.074 < lngLower || -112.074 > lngUpper).toBe(true);
    });

    it('reuses a venue already inside the scope instead of duplicating it', async () => {
        const { venueQuery } = mockVenueLookup({ id: 'existing-venue' });

        await expect(submitUserDeal(SUBMISSION)).resolves.toBe(true);

        expect(venueQuery.insert).not.toHaveBeenCalled();
    });

    it('attributes the submission to the caller', async () => {
        const { dealsInsert } = mockVenueLookup({ id: 'existing-venue' });

        await submitUserDeal(SUBMISSION);

        const rows = dealsInsert.mock.calls[0][0];
        expect(rows[0]).toEqual(expect.objectContaining({ submitted_by: 'user-1', status: 'pending' }));
    });

    it('skips the venue lookup and the geocode when the submitter picked a venue', async () => {
        // Autocomplete already resolved the venue, so there is nothing for the
        // name match to find and no address to geocode.
        const { venueQuery, dealsInsert } = mockVenueLookup(null);

        await submitUserDeal({ ...SUBMISSION, venueId: 'picked-venue' });

        expect(venueQuery.ilike).not.toHaveBeenCalled();
        expect(venueQuery.insert).not.toHaveBeenCalled();
        expect(geocodeAddress).not.toHaveBeenCalled();
        expect(dealsInsert.mock.calls[0][0][0]).toEqual(
            expect.objectContaining({ venue_id: 'picked-venue' }),
        );
    });

    it('refuses to submit without an authenticated user', async () => {
        mockVenueLookup(null);
        (supabase.auth.getUser as jest.Mock).mockResolvedValue({ data: { user: null }, error: null });

        await expect(submitUserDeal(SUBMISSION)).resolves.toBe(false);
    });
});

describe('submitUserDeal — what represents the venue', () => {
    it('records no artwork rather than a stock photo when none was offered', async () => {
        // The stock URL that used to go here was written as though it were a
        // real photograph of the place, which hid the venue from
        // hh_venues_needing_image -- the queue that exists to find it one.
        const { venueQuery } = mockVenueLookup(null);

        await submitUserDeal(SUBMISSION);

        expect(venueQuery.insert).toHaveBeenCalledWith(
            expect.objectContaining({ image_url: null, image_source: null }),
        );
    });

    it('does not use the menu photo as the venue artwork', async () => {
        // A photo of a menu is evidence for a moderator, not a picture of the
        // bar. It belongs on the deal rows, and only there.
        const { venueQuery, dealsInsert } = mockVenueLookup(null);

        await submitUserDeal({ ...SUBMISSION, imageUrl: 'https://p.supabase.co/storage/v1/object/public/venue-images/user-1/menu.jpg' });

        expect(venueQuery.insert).toHaveBeenCalledWith(
            expect.objectContaining({ image_url: null }),
        );
        expect(dealsInsert.mock.calls[0][0][0]).toEqual(
            expect.objectContaining({ image_url: 'https://p.supabase.co/storage/v1/object/public/venue-images/user-1/menu.jpg' }),
        );
    });

    it('writes the venue photo straight onto a venue it is creating', async () => {
        const { venueQuery } = mockVenueLookup(null);

        await submitUserDeal({ ...SUBMISSION, venuePhotoUrl: 'https://p.supabase.co/storage/v1/object/public/venue-images/user-1/place.jpg' });

        expect(venueQuery.insert).toHaveBeenCalledWith(
            expect.objectContaining({ image_url: 'https://p.supabase.co/storage/v1/object/public/venue-images/user-1/place.jpg', image_source: 'user' }),
        );
        expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('attaches the venue photo through the RPC when the venue already exists', async () => {
        // `venues` has an INSERT policy and no UPDATE one, so this is the only
        // route open to the client -- and with autocomplete it is the common one.
        mockVenueLookup({ id: 'existing-venue' });

        await submitUserDeal({ ...SUBMISSION, venuePhotoUrl: 'https://p.supabase.co/storage/v1/object/public/venue-images/user-1/place.jpg' });

        expect(supabase.rpc).toHaveBeenCalledWith('hh_attach_venue_image', {
            p_venue_id: 'existing-venue',
            p_image_url: 'https://p.supabase.co/storage/v1/object/public/venue-images/user-1/place.jpg',
        });
    });

    it('attaches through the RPC for a venue picked out of autocomplete too', async () => {
        mockVenueLookup(null);

        await submitUserDeal({ ...SUBMISSION, venueId: 'picked-venue', venuePhotoUrl: 'https://p.supabase.co/storage/v1/object/public/venue-images/user-1/place.jpg' });

        expect(supabase.rpc).toHaveBeenCalledWith('hh_attach_venue_image', {
            p_venue_id: 'picked-venue',
            p_image_url: 'https://p.supabase.co/storage/v1/object/public/venue-images/user-1/place.jpg',
        });
    });

    it('still files the deal when the photo could not be attached', async () => {
        // The deal is the submission. A venue that keeps the picture it already
        // had, or a rate-limited attach, is not a reason to lose it.
        mockVenueLookup({ id: 'existing-venue' });
        (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: { message: 'nope' } });

        await expect(
            submitUserDeal({ ...SUBMISSION, venuePhotoUrl: 'https://p.supabase.co/storage/v1/object/public/venue-images/user-1/place.jpg' }),
        ).resolves.toBe(true);
    });

    it('does not call the RPC when there is no venue photo', async () => {
        mockVenueLookup({ id: 'existing-venue' });

        await submitUserDeal({ ...SUBMISSION, imageUrl: 'https://p.supabase.co/storage/v1/object/public/venue-images/user-1/menu.jpg' });

        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});
