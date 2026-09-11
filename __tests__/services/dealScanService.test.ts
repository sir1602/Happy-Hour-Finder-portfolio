import { supabase } from '../../services/supabase';

jest.mock('../../services/supabase', () => ({
    supabase: {
        auth: { getSession: jest.fn() },
    },
}));

const SCAN_URL = 'https://n8n.example.org/webhook/hh-deal-scan';
const PHOTO_URL = 'https://example.supabase.co/storage/v1/object/public/venue-images/uid/menu.jpg';

/**
 * The endpoint URL is read once at module load, so each test loads the module
 * fresh with the environment it means to exercise.
 */
const loadService = (scanUrl: string | undefined) => {
    let mod: typeof import('../../services/dealScanService');
    jest.isolateModules(() => {
        if (scanUrl === undefined) {
            delete process.env.EXPO_PUBLIC_HH_SCAN_URL;
        } else {
            process.env.EXPO_PUBLIC_HH_SCAN_URL = scanUrl;
        }
        // The module reads its endpoint from the environment at load time, so it
        // has to be re-required per test; a static import is hoisted above the
        // env assignment above and would always see the same value.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require('../../services/dealScanService');
    });
    return mod!;
};

const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
});

const mockedGetSession = supabase.auth.getSession as jest.Mock;

describe('dealScanService', () => {
    const originalUrl = process.env.EXPO_PUBLIC_HH_SCAN_URL;
    const originalFetch = global.fetch;

    beforeEach(() => {
        jest.clearAllMocks();
        mockedGetSession.mockResolvedValue({
            data: { session: { access_token: 'user-access-token' } },
            error: null,
        });
        global.fetch = jest.fn() as unknown as typeof fetch;
    });

    afterAll(() => {
        global.fetch = originalFetch;
        if (originalUrl === undefined) delete process.env.EXPO_PUBLIC_HH_SCAN_URL;
        else process.env.EXPO_PUBLIC_HH_SCAN_URL = originalUrl;
    });

    describe('isDealScanConfigured', () => {
        it('is off when no endpoint is configured, so the button can be hidden', () => {
            expect(loadService(undefined).isDealScanConfigured()).toBe(false);
            expect(loadService('   ').isDealScanConfigured()).toBe(false);
        });

        it('is on once an endpoint is set', () => {
            expect(loadService(SCAN_URL).isDealScanConfigured()).toBe(true);
        });
    });

    describe('scanDealPhoto', () => {
        it('sends the photo under the user own access token and no shared secret', async () => {
            const { scanDealPhoto } = loadService(SCAN_URL);
            (global.fetch as jest.Mock).mockResolvedValue(
                jsonResponse(200, { success: true, usable: true, reason: null, deal: { title: 'x', time_window: '4 PM - 6 PM' } })
            );

            await scanDealPhoto({ imageUrl: PHOTO_URL, venueName: 'The Draft House' });

            const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
            expect(url).toBe(SCAN_URL);
            expect(init.headers.Authorization).toBe('Bearer user-access-token');
            // Nothing else may be sent as a credential: every EXPO_PUBLIC_* value
            // is inlined into the app binary and can be read out of it.
            expect(Object.keys(init.headers)).toEqual(['Content-Type', 'Authorization']);
            expect(JSON.parse(init.body)).toEqual({
                image_url: PHOTO_URL,
                venue_name: 'The Draft House',
                neighborhood: '',
                address: '',
            });
        });

        it('refuses to call the endpoint when nobody is signed in', async () => {
            const { scanDealPhoto } = loadService(SCAN_URL);
            mockedGetSession.mockResolvedValue({ data: { session: null }, error: null });

            await expect(scanDealPhoto({ imageUrl: PHOTO_URL })).rejects.toThrow('signed-in user');
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('reports the feature as unavailable rather than calling an empty URL', async () => {
            const { scanDealPhoto, DealScanUnavailableError } = loadService(undefined);
            await expect(scanDealPhoto({ imageUrl: PHOTO_URL })).rejects.toBeInstanceOf(DealScanUnavailableError);
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('maps the workflow reply onto the form field names', async () => {
            const { scanDealPhoto } = loadService(SCAN_URL);
            (global.fetch as jest.Mock).mockResolvedValue(
                jsonResponse(200, {
                    success: true,
                    usable: true,
                    reason: null,
                    deal: {
                        title: '$4 Drafts',
                        description: 'At the bar',
                        time_window: '4 PM - 6:30 PM',
                        days_active: [1, 2, 3],
                        tags: ['beer'],
                        price_level: 2,
                        venue_name: 'Parsons',
                        confidence: 0.75,
                    },
                })
            );

            const result = await scanDealPhoto({ imageUrl: PHOTO_URL });

            expect(result.usable).toBe(true);
            expect(result.reason).toBeNull();
            expect(result.deal).toEqual({
                title: '$4 Drafts',
                description: 'At the bar',
                timeWindow: '4 PM - 6:30 PM',
                daysActive: [1, 2, 3],
                tags: ['beer'],
                priceLevel: 2,
                venueName: 'Parsons',
                confidence: 0.75,
            });
        });

        it('reads every set of hours the board listed', async () => {
            const { scanDealPhoto } = loadService(SCAN_URL);
            (global.fetch as jest.Mock).mockResolvedValue(
                jsonResponse(200, {
                    usable: true,
                    reason: null,
                    deals: [
                        { title: '$4 Drafts', time_window: '4 PM - 6:30 PM', days_active: [1, 2, 3, 4] },
                        { title: '$6 Negronis', time_window: '12 PM - 3 PM', days_active: [5] },
                    ],
                    // Sent alongside for installs running an older binary.
                    deal: { title: '$4 Drafts', time_window: '4 PM - 6:30 PM', days_active: [1, 2, 3, 4] },
                })
            );

            const result = await scanDealPhoto({ imageUrl: PHOTO_URL });

            expect(result.deals).toHaveLength(2);
            expect(result.deals[1].timeWindow).toBe('12 PM - 3 PM');
            expect(result.deals[1].daysActive).toEqual([5]);
            // `deal` stays the first entry, so anything still reading it is
            // unaffected by the endpoint gaining an array.
            expect(result.deal).toEqual(result.deals[0]);
        });

        it('still reads a workflow that only sends the singular deal', async () => {
            const { scanDealPhoto } = loadService(SCAN_URL);
            (global.fetch as jest.Mock).mockResolvedValue(
                jsonResponse(200, {
                    usable: true,
                    deal: { title: '$4 Drafts', time_window: '4 PM - 6:30 PM', days_active: [1] },
                })
            );

            // The app ships ahead of the workflow, or behind it, so neither
            // side may assume the other has been deployed.
            const result = await scanDealPhoto({ imageUrl: PHOTO_URL });
            expect(result.usable).toBe(true);
            expect(result.deals).toHaveLength(1);
            expect(result.deals[0].title).toBe('$4 Drafts');
        });

        it('drops day numbers the workflow should never have sent', async () => {
            const { scanDealPhoto } = loadService(SCAN_URL);
            (global.fetch as jest.Mock).mockResolvedValue(
                jsonResponse(200, { usable: true, deal: { days_active: [1, 42, -1, 'x'], tags: 'beer' } })
            );

            const result = await scanDealPhoto({ imageUrl: PHOTO_URL });
            expect(result.deal?.daysActive).toEqual([1]);
            expect(result.deal?.tags).toEqual([]);
        });

        it('carries the reason through when the photo was read but says nothing usable', async () => {
            const { scanDealPhoto } = loadService(SCAN_URL);
            (global.fetch as jest.Mock).mockResolvedValue(
                jsonResponse(200, { usable: false, reason: 'the photo is too blurred to read', deal: null })
            );

            const result = await scanDealPhoto({ imageUrl: PHOTO_URL });
            expect(result.usable).toBe(false);
            expect(result.reason).toBe('the photo is too blurred to read');
            expect(result.deals).toEqual([]);
            expect(result.deal).toBeNull();
        });

        it('raises a rate-limit error carrying the retry hint', async () => {
            const { scanDealPhoto, DealScanRateLimitError } = loadService(SCAN_URL);
            (global.fetch as jest.Mock).mockResolvedValue(
                jsonResponse(429, { success: false, message: 'Scan limit reached.', retry_after_seconds: 1500 })
            );

            await expect(scanDealPhoto({ imageUrl: PHOTO_URL })).rejects.toMatchObject({
                name: 'DealScanRateLimitError',
                message: 'Scan limit reached.',
                retryAfterSeconds: 1500,
            });
            await expect(scanDealPhoto({ imageUrl: PHOTO_URL })).rejects.toBeInstanceOf(DealScanRateLimitError);
        });

        it('defaults the retry hint when the workflow omits one', async () => {
            const { scanDealPhoto } = loadService(SCAN_URL);
            (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(429, { message: 'Too many.' }));

            await expect(scanDealPhoto({ imageUrl: PHOTO_URL })).rejects.toMatchObject({
                retryAfterSeconds: 3600,
            });
        });

        it('surfaces the server message on a failure status', async () => {
            const { scanDealPhoto } = loadService(SCAN_URL);
            (global.fetch as jest.Mock).mockResolvedValue(
                jsonResponse(401, { success: false, message: 'Sign in again to scan a photo.' })
            );

            await expect(scanDealPhoto({ imageUrl: PHOTO_URL })).rejects.toThrow('Sign in again to scan a photo.');
        });

        /**
         * A proxy or gateway in front of the workflow answers with HTML, not
         * JSON. That has to read as a failed scan, not as a JSON parse error
         * shown to the user as the reason their photo was rejected.
         */
        it('treats a non-JSON body as a failed scan', async () => {
            const { scanDealPhoto } = loadService(SCAN_URL);
            (global.fetch as jest.Mock).mockResolvedValue({
                ok: false,
                status: 502,
                json: jest.fn().mockRejectedValue(new Error('Unexpected token <')),
            });

            await expect(scanDealPhoto({ imageUrl: PHOTO_URL })).rejects.toThrow('Scan failed (502)');
        });
    });
});
