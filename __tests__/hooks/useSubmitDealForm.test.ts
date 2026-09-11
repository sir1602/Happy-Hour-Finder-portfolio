import { renderHook, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSubmitDealForm } from '../../hooks/useSubmitDealForm';
import { submitUserDeal, DealSubmissionRateLimitError, searchVenues } from '../../services/dealService';
import { scanDealPhoto, DealScanRateLimitError } from '../../services/dealScanService';
import { storageService, ImageTooLargeError } from '../../services/storageService';

const mockBack = jest.fn();
const mockAwardDealSubmittedPoints = jest.fn();

jest.mock('expo-router', () => ({
    useRouter: () => ({ back: mockBack }),
}));

jest.mock('../../context/RewardsContext', () => ({
    useRewards: () => ({ awardDealSubmittedPoints: mockAwardDealSubmittedPoints }),
}));

// The form reaches location through venue autocomplete (scope for the search
// bounds, coordinates for the distance sort). Neither has a provider here.
jest.mock('../../context/LocationContext', () => ({
    useLocation: () => ({ userLocation: null }),
}));

jest.mock('../../hooks/useLocationScope', () => ({
    useLocationScope: () => ({ scope: null, isResolving: false }),
}));

jest.mock('../../services/dealService', () => ({
    submitUserDeal: jest.fn(),
    searchVenues: jest.fn().mockResolvedValue([]),
    getFilterOptions: jest.fn().mockResolvedValue({ tags: [], neighborhoods: [] }),
    // Real class, not a stub: handleSubmit branches on `instanceof`.
    DealSubmissionRateLimitError: class DealSubmissionRateLimitError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'DealSubmissionRateLimitError';
        }
    },
}));

jest.mock('../../services/storageService', () => ({
    storageService: { uploadLocalImage: jest.fn(), deleteVenueImage: jest.fn() },
    // Real class, not a stub: the upload and scan paths both branch on
    // `instanceof` to tell "too big" from "something went wrong".
    ImageTooLargeError: class ImageTooLargeError extends Error {
        constructor() {
            super('Image is larger than 5MB');
            this.name = 'ImageTooLargeError';
        }
    },
}));

jest.mock('../../services/dealScanService', () => ({
    scanDealPhoto: jest.fn(),
    isDealScanConfigured: () => true,
    DealScanRateLimitError: class DealScanRateLimitError extends Error {
        readonly retryAfterSeconds: number;
        constructor(message: string, retryAfterSeconds: number) {
            super(message);
            this.name = 'DealScanRateLimitError';
            this.retryAfterSeconds = retryAfterSeconds;
        }
    },
    DealScanUnavailableError: class DealScanUnavailableError extends Error {
        constructor() {
            super('Photo scanning is not configured');
            this.name = 'DealScanUnavailableError';
        }
    },
}));

jest.mock('expo-image-picker', () => ({
    MediaTypeOptions: { Images: 'Images' },
    requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
    requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
    launchImageLibraryAsync: jest.fn().mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file:///tmp/menu.jpg', width: 3024, height: 4032 }],
    }),
    launchCameraAsync: jest.fn().mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file:///tmp/menu.jpg', width: 3024, height: 4032 }],
    }),
}));

// Override the global AsyncStorage mock: getItem must return null by default
// in every test (not the previous test's stored rate-limit timestamp), since
// the shared in-memory mock otherwise persists across tests in this file and
// would spuriously rate-limit a later successful-submission test.
jest.mock('@react-native-async-storage/async-storage', () => ({
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
}));

const mockedSubmitUserDeal = submitUserDeal as jest.Mock;
const mockedScanDealPhoto = scanDealPhoto as jest.Mock;
const mockedUploadLocalImage = storageService.uploadLocalImage as jest.Mock;
const mockedDeleteVenueImage = storageService.deleteVenueImage as jest.Mock;

const PHOTO_URL = 'https://example.supabase.co/storage/v1/object/public/venue-images/uid/menu.jpg';

/** A scan that read a complete deal off the photo. */
const usableScan = (overrides = {}) => {
    const deal = {
        title: '$4 Drafts & Half-Price Apps',
        description: 'Discounted drafts at the bar',
        timeWindow: '4:00 PM - 6:30 PM',
        daysActive: [1, 2, 3, 4, 5],
        tags: ['beer', 'appetizers'],
        priceLevel: 2,
        venueName: 'Parson\'s Chicken & Fish',
        confidence: 0.75,
        ...overrides,
    };
    // The service always fills `deals`; `deal` rides along as deals[0] for the
    // shipped binaries, and the mock mirrors that so the hook is exercised
    // against the shape it really receives.
    return { usable: true, reason: null, deals: [deal], deal };
};

/** A board listing two different sets of hours -- Mon-Thu and Fri. */
const multiScan = () => {
    const deals = [
        {
            title: '$4 Drafts & Half-Price Apps',
            description: 'Discounted drafts at the bar',
            timeWindow: '4:00 PM - 6:30 PM',
            daysActive: [1, 2, 3, 4],
            tags: ['beer', 'appetizers'],
            priceLevel: 2,
            venueName: 'Parson\'s Chicken & Fish',
            confidence: 0.75,
        },
        {
            title: '$6 Frozen Negronis',
            description: 'Friday afternoons on the patio',
            timeWindow: '12:00 PM - 3:00 PM',
            daysActive: [5],
            tags: ['cocktails'],
            priceLevel: 2,
            venueName: null,
            confidence: 0.75,
        },
    ];
    return { usable: true, reason: null, deals, deal: deals[0] };
};
const mockedAsyncStorage = AsyncStorage as unknown as { getItem: jest.Mock; setItem: jest.Mock };

describe('useSubmitDealForm', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        mockAwardDealSubmittedPoints.mockResolvedValue([]);
        mockedAsyncStorage.getItem.mockResolvedValue(null);
        mockedUploadLocalImage.mockResolvedValue(PHOTO_URL);
        mockedDeleteVenueImage.mockResolvedValue(undefined);
    });

    it('starts with one empty schedule and default price/type', async () => {
        const { result } = await renderHook(() => useSubmitDealForm());
        expect(result.current.schedules).toEqual([{ days: [], timeWindow: '', dealTitle: '' }]);
        // $$ rather than $: most happy hours are not in the cheapest bucket.
        expect(result.current.priceLevel).toBe(2);
        expect(result.current.isSubmitting).toBe(false);
    });

    describe('schedule management', () => {
        it('addSchedule appends a new blank schedule', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.addSchedule());
            expect(result.current.schedules).toHaveLength(2);
            expect(result.current.schedules[1]).toEqual({ days: [], timeWindow: '', dealTitle: '' });
        });

        it('removeSchedule removes only the schedule at the given index', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.addSchedule());
            await act(() => result.current.updateSchedule(0, { dealTitle: 'first' }));
            await act(() => result.current.updateSchedule(1, { dealTitle: 'second' }));

            await act(() => result.current.removeSchedule(0));
            expect(result.current.schedules).toHaveLength(1);
            expect(result.current.schedules[0].dealTitle).toBe('second');
        });

        it('updateSchedule merges partial updates into the schedule at that index without touching others', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.addSchedule());
            await act(() => result.current.updateSchedule(0, { timeWindow: '4 PM - 6 PM' }));
            expect(result.current.schedules[0].timeWindow).toBe('4 PM - 6 PM');
            expect(result.current.schedules[0].dealTitle).toBe('');
            expect(result.current.schedules[1]).toEqual({ days: [], timeWindow: '', dealTitle: '' });
        });

        it('toggleScheduleDay adds a day when absent and removes it when present, leaving other days untouched', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.toggleScheduleDay(0, 1)); // Monday
            await act(() => result.current.toggleScheduleDay(0, 3)); // Wednesday
            expect(result.current.schedules[0].days.sort()).toEqual([1, 3]);

            await act(() => result.current.toggleScheduleDay(0, 1)); // untoggle Monday
            expect(result.current.schedules[0].days).toEqual([3]);
        });

        it('toggleScheduleDay on one schedule does not affect another schedule\'s days', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.addSchedule());
            await act(() => result.current.toggleScheduleDay(0, 1));
            expect(result.current.schedules[0].days).toEqual([1]);
            expect(result.current.schedules[1].days).toEqual([]);
        });
    });

    describe('validateForm / handleSubmit gating', () => {
        it('rejects submission when venue fields are missing', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => {
                await result.current.handleSubmit();
            });
            expect(result.current.errors.venueName).toBeTruthy();
            expect(result.current.errors.address).toBeTruthy();
            expect(result.current.errors.neighborhood).toBeTruthy();
            expect(mockedSubmitUserDeal).not.toHaveBeenCalled();
        });

        it('rejects submission when a schedule has no days selected', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.setVenueName('The Draft House'));
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Wicker Park'));
            await act(async () => {
                await result.current.handleSubmit();
            });
            expect(result.current.errors.schedules?.[0]?.days).toBeTruthy();
            expect(mockedSubmitUserDeal).not.toHaveBeenCalled();
        });

        it('rejects submission with an invalid time-window format', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.setVenueName('The Draft House'));
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Wicker Park'));
            await act(() => result.current.toggleScheduleDay(0, 1));
            await act(() => result.current.updateSchedule(0, { timeWindow: 'whenever', dealTitle: '$5 beers' }));
            await act(async () => {
                await result.current.handleSubmit();
            });
            expect(result.current.errors.schedules?.[0]?.timeWindow).toBeTruthy();
            expect(mockedSubmitUserDeal).not.toHaveBeenCalled();
        });

        it('rejects submission when the deal title is missing', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.setVenueName('The Draft House'));
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Wicker Park'));
            await act(() => result.current.toggleScheduleDay(0, 1));
            await act(() => result.current.updateSchedule(0, { timeWindow: '4 PM - 6 PM' }));
            await act(async () => {
                await result.current.handleSubmit();
            });
            expect(result.current.errors.schedules?.[0]?.dealTitle).toBeTruthy();
            expect(mockedSubmitUserDeal).not.toHaveBeenCalled();
        });

        it('submits a fully valid single-schedule form and navigates back on success', async () => {
            mockedSubmitUserDeal.mockResolvedValue(true);
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.setVenueName('The Draft House'));
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Wicker Park'));
            await act(() => result.current.toggleScheduleDay(0, 1));
            await act(() => result.current.updateSchedule(0, { timeWindow: '4:00 PM - 6:00 PM', dealTitle: '$5 beers' }));

            await act(async () => {
                await result.current.handleSubmit();
            });

            expect(mockedSubmitUserDeal).toHaveBeenCalledWith(expect.objectContaining({
                venueName: 'The Draft House',
                address: '123 Main St',
                neighborhood: 'Wicker Park',
                schedules: [{ days: [1], timeWindow: '4:00 PM - 6:00 PM', dealTitle: '$5 beers' }],
            }));
            expect(mockAwardDealSubmittedPoints).toHaveBeenCalled();
            expect(Alert.alert).toHaveBeenCalledWith('Deal Submitted', expect.any(String), expect.any(Array));
            expect(result.current.isSubmitting).toBe(false);
        });

        it('parses the comma-separated tags input into a trimmed array', async () => {
            mockedSubmitUserDeal.mockResolvedValue(true);
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.setVenueName('The Draft House'));
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Wicker Park'));
            await act(() => result.current.toggleScheduleDay(0, 1));
            await act(() => result.current.updateSchedule(0, { timeWindow: '4:00 PM - 6:00 PM', dealTitle: '$5 beers' }));
            await act(() => result.current.setTagsInput('Craft Beer,  Patio ,, Dive Bar'));

            await act(async () => {
                await result.current.handleSubmit();
            });

            expect(mockedSubmitUserDeal).toHaveBeenCalledWith(expect.objectContaining({
                tags: ['Craft Beer', 'Patio', 'Dive Bar'],
            }));
        });

        it('shows a failure alert and re-enables the form when submission fails', async () => {
            mockedSubmitUserDeal.mockResolvedValue(false);
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.setVenueName('The Draft House'));
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Wicker Park'));
            await act(() => result.current.toggleScheduleDay(0, 1));
            await act(() => result.current.updateSchedule(0, { timeWindow: '4:00 PM - 6:00 PM', dealTitle: '$5 beers' }));

            await act(async () => {
                await result.current.handleSubmit();
            });

            expect(Alert.alert).toHaveBeenCalledWith('Submission Failed', expect.any(String));
            expect(mockAwardDealSubmittedPoints).not.toHaveBeenCalled();
            expect(result.current.isSubmitting).toBe(false);
        });

        it('re-enables the form when submitUserDeal throws', async () => {
            mockedSubmitUserDeal.mockRejectedValue(new Error('network error'));
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.setVenueName('The Draft House'));
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Wicker Park'));
            await act(() => result.current.toggleScheduleDay(0, 1));
            await act(() => result.current.updateSchedule(0, { timeWindow: '4:00 PM - 6:00 PM', dealTitle: '$5 beers' }));

            await act(async () => {
                await result.current.handleSubmit();
            });

            expect(Alert.alert).toHaveBeenCalledWith('Submission Failed', expect.any(String));
            expect(result.current.isSubmitting).toBe(false);
        });

        /**
         * The 60s AsyncStorage cooldown is a double-tap guard, not a security
         * control — it's cleared by wiping app data and absent entirely for
         * direct REST calls. The real limit is a Postgres trigger, and its
         * rejection needs to read as a rate limit rather than a generic failure.
         */
        it('shows a rate-limit specific message when the server rejects the submission', async () => {
            mockedSubmitUserDeal.mockRejectedValue(
                new DealSubmissionRateLimitError('Rate limit exceeded: at most 10 deal submissions per hour')
            );
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.setVenueName('The Draft House'));
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Wicker Park'));
            await act(() => result.current.toggleScheduleDay(0, 1));
            await act(() => result.current.updateSchedule(0, { timeWindow: '4:00 PM - 6:00 PM', dealTitle: '$5 beers' }));

            await act(async () => {
                await result.current.handleSubmit();
            });

            expect(Alert.alert).toHaveBeenCalledWith('Too Many Submissions', expect.any(String));
            expect(Alert.alert).not.toHaveBeenCalledWith('Submission Failed', expect.any(String));
            expect(mockAwardDealSubmittedPoints).not.toHaveBeenCalled();
            expect(result.current.isSubmitting).toBe(false);
        });
    });

    /**
     * Scanning a photo fills the form in; it does not submit. The user is the
     * last check on a model that misreads menu boards, so everything the scan
     * produces has to land in editable fields and nothing may overwrite what
     * they already typed.
     */

    describe('speed shortcuts', () => {
        const fill = async (result: any) => {
            await act(async () => {
                result.current.setVenueName('The Tap Room');
                result.current.setAddress('745 N Birch Ave');
                result.current.setNeighborhood('River North');
                result.current.updateSchedule(0, { dealTitle: '$5 drafts' });
            });
        };

        it('always submits the regular type, which is no longer the submitter\'s to choose', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await fill(result);
            await act(async () => {
                result.current.applyDayPreset(0, { label: 'Weekdays', days: [1, 2, 3, 4, 5] });
                result.current.applyTimePreset(0, { label: '4–6 PM', startMinutes: 960, endMinutes: 1080 });
            });
            (submitUserDeal as jest.Mock).mockResolvedValue(true);

            await act(async () => { await result.current.handleSubmit(); });

            expect(submitUserDeal).toHaveBeenCalledWith(expect.objectContaining({ type: 'regular' }));
        });

        it('fills a whole schedule from one day preset and one time preset', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => {
                result.current.applyDayPreset(0, { label: 'Weekdays', days: [1, 2, 3, 4, 5] });
                result.current.applyTimePreset(0, { label: '4–6 PM', startMinutes: 960, endMinutes: 1080 });
            });

            expect(result.current.schedules[0].days).toEqual([1, 2, 3, 4, 5]);
            expect(result.current.schedules[0].timeWindow).toBe('4:00 PM - 6:00 PM');
        });

        it('composes an overnight window from the pickers', async () => {
            // 10 PM to 2 AM: the end slot is expressed past midnight, and the
            // stored string is what getDealStatus reads as an overnight deal.
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.setScheduleTimeRange(0, 22 * 60, 26 * 60); });

            expect(result.current.schedules[0].timeWindow).toBe('10:00 PM - 2:00 AM');
            expect(result.current.scheduleTimeRange('10:00 PM - 2:00 AM')).toEqual({
                startMinutes: 22 * 60, endMinutes: 26 * 60,
            });
        });

        it('normalizes a typed time window on blur', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.updateSchedule(0, { timeWindow: '15:00-18:00' }); });
            await act(async () => { result.current.normalizeScheduleTime(0); });

            expect(result.current.schedules[0].timeWindow).toBe('3:00 PM - 6:00 PM');
        });

        it('appends deal snippets rather than making the user type them', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.appendDealSnippet(0, '$X Drafts'); });
            await act(async () => { result.current.appendDealSnippet(0, 'Half-Price Apps'); });

            expect(result.current.schedules[0].dealTitle).toBe('$X Drafts, Half-Price Apps');
        });

        it('refuses a snippet that would overflow the deal description', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.updateSchedule(0, { dealTitle: 'x'.repeat(195) }); });
            await act(async () => { result.current.appendDealSnippet(0, 'Half-Price Apps'); });

            // Dropping the addition beats truncating what they already wrote.
            expect(result.current.schedules[0].dealTitle).toBe('x'.repeat(195));
        });

        it('toggles tags through the same comma-separated field the input owns', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.toggleTag('patio'); });
            await act(async () => { result.current.toggleTag('beer'); });
            expect(result.current.tagsInput).toBe('patio, beer');
            expect(result.current.selectedTags).toEqual(['patio', 'beer']);

            await act(async () => { result.current.toggleTag('patio'); });
            expect(result.current.tagsInput).toBe('beer');
        });
    });

    describe('venue autocomplete', () => {
        const VENUE = {
            id: 'venue-1', name: 'The Tap Room', address: '745 N Birch Ave',
            neighborhood: 'River North', latitude: 41.89, longitude: -87.63, distanceKm: 0.4,
        };

        const readyToSubmit = async (result: any) => {
            await act(async () => {
                result.current.updateSchedule(0, { dealTitle: '$5 drafts' });
                result.current.applyDayPreset(0, { label: 'Weekdays', days: [1, 2, 3, 4, 5] });
                result.current.applyTimePreset(0, { label: '4–6 PM', startMinutes: 960, endMinutes: 1080 });
            });
        };

        it('fills all three venue fields from one tap', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.selectVenue(VENUE); });

            expect(result.current.venueName).toBe('The Tap Room');
            expect(result.current.address).toBe('745 N Birch Ave');
            expect(result.current.neighborhood).toBe('River North');
            expect(result.current.resolvedVenueId).toBe('venue-1');
        });

        it('sends the picked venue so the server can skip the lookup and the geocode', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.selectVenue(VENUE); });
            await readyToSubmit(result);
            (submitUserDeal as jest.Mock).mockResolvedValue(true);

            await act(async () => { await result.current.handleSubmit(); });

            expect(submitUserDeal).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'venue-1' }));
        });

        it('drops the picked venue as soon as the address is edited', async () => {
            // venues has no UPDATE policy, so a submission carrying a venueId
            // ignores the address entirely. Keeping the id here would throw the
            // correction away without saying so.
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.selectVenue(VENUE); });
            await act(async () => { result.current.setAddress('456 W Fulton Market'); });

            expect(result.current.resolvedVenueId).toBeUndefined();

            await readyToSubmit(result);
            (submitUserDeal as jest.Mock).mockResolvedValue(true);
            await act(async () => { await result.current.handleSubmit(); });

            expect(submitUserDeal).toHaveBeenCalledWith(
                expect.objectContaining({ venueId: undefined, address: '456 W Fulton Market' }),
            );
        });

        it('drops the picked venue when the venue name itself is edited', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.selectVenue(VENUE); });
            await act(async () => { result.current.setVenueName('The Tap Room II'); });

            expect(result.current.resolvedVenueId).toBeUndefined();
        });
    });

    describe('inline validation', () => {
        it('says nothing until the first submit attempt', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            expect(result.current.errors).toEqual({});
            expect(result.current.hasAttemptedSubmit).toBe(false);
        });

        it('reports every problem at once rather than one popup at a time', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { await result.current.handleSubmit(); });

            expect(result.current.errors.venueName).toBeTruthy();
            expect(result.current.errors.address).toBeTruthy();
            expect(result.current.errors.neighborhood).toBeTruthy();
            expect(result.current.errors.schedules?.[0]?.days).toBeTruthy();
            expect(result.current.errors.schedules?.[0]?.timeWindow).toBeTruthy();
            expect(result.current.errors.schedules?.[0]?.dealTitle).toBeTruthy();
        });

        it('clears a field error as soon as it is fixed', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { await result.current.handleSubmit(); });
            expect(result.current.errors.venueName).toBeTruthy();

            await act(async () => { result.current.setVenueName('The Tap Room'); });
            expect(result.current.errors.venueName).toBeUndefined();
        });

        it('accepts a window that runs until close', async () => {
            // It costs that deal its countdown, not its submission.
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.updateSchedule(0, { timeWindow: '4pm - close' }); });
            await act(async () => { await result.current.handleSubmit(); });

            expect(result.current.errors.schedules?.[0]?.timeWindow).toBeUndefined();
        });

        it('stores an until-close window in canonical form', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => {
                result.current.setVenueName('The Tap Room');
                result.current.setAddress('745 N Birch Ave');
                result.current.setNeighborhood('River North');
                result.current.updateSchedule(0, { timeWindow: '4pm-close', dealTitle: '$5 drafts' });
                result.current.applyDayPreset(0, { label: 'Weekdays', days: [1, 2, 3, 4, 5] });
            });
            (submitUserDeal as jest.Mock).mockResolvedValue(true);

            await act(async () => { await result.current.handleSubmit(); });

            expect(submitUserDeal).toHaveBeenCalledWith(expect.objectContaining({
                schedules: [expect.objectContaining({ timeWindow: '4:00 PM - Close' })],
            }));
        });

        it('explains a window with no start time either', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(async () => { result.current.updateSchedule(0, { timeWindow: 'all day' }); });
            await act(async () => { await result.current.handleSubmit(); });

            expect(result.current.errors.schedules?.[0]?.timeWindow).toContain('start time');
        });
    });

    describe('photo scanning', () => {
        const pickPhoto = async (result: { current: ReturnType<typeof useSubmitDealForm> }) => {
            await act(async () => {
                await result.current.handlePickImage();
            });
        };

        it('fills empty fields from a usable scan', async () => {
            mockedScanDealPhoto.mockResolvedValue(usableScan());
            const { result } = await renderHook(() => useSubmitDealForm());
            await pickPhoto(result);

            await act(async () => {
                await result.current.handleScanPhoto();
            });

            expect(result.current.venueName).toBe("Parson's Chicken & Fish");
            expect(result.current.schedules[0]).toEqual({
                days: [1, 2, 3, 4, 5],
                timeWindow: '4:00 PM - 6:30 PM',
                dealTitle: '$4 Drafts & Half-Price Apps',
            });
            expect(result.current.priceLevel).toBe(2);
            expect(result.current.tagsInput).toBe('beer, appetizers');
            expect(result.current.scanNotice).toContain('Check every field');
        });

        it('seeds one schedule per set of hours on the board', async () => {
            mockedScanDealPhoto.mockResolvedValue(multiScan());
            const { result } = await renderHook(() => useSubmitDealForm());
            await pickPhoto(result);

            await act(async () => {
                await result.current.handleScanPhoto();
            });

            // A board reading "Mon-Thu 4-6:30, Fri 12-3" is two schedules. The
            // form has always been able to hold several; it was the scan that
            // could only ever fill the first, so the Friday hours had to be
            // typed in by hand or were simply lost.
            expect(result.current.schedules).toHaveLength(2);
            expect(result.current.schedules[0]).toEqual({
                days: [1, 2, 3, 4],
                timeWindow: '4:00 PM - 6:30 PM',
                dealTitle: '$4 Drafts & Half-Price Apps',
            });
            expect(result.current.schedules[1]).toEqual({
                days: [5],
                timeWindow: '12:00 PM - 3:00 PM',
                dealTitle: '$6 Frozen Negronis',
            });
            expect(result.current.scanNotice).toContain('2 sets of hours');
        });

        it('keeps a schedule the user added that the photo says nothing about', async () => {
            mockedScanDealPhoto.mockResolvedValue(usableScan());
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.addSchedule());
            await act(() => result.current.updateSchedule(1, { dealTitle: 'Late night' }));
            await pickPhoto(result);

            await act(async () => {
                await result.current.handleScanPhoto();
            });

            expect(result.current.schedules).toHaveLength(2);
            expect(result.current.schedules[0].dealTitle).toBe('$4 Drafts & Half-Price Apps');
            expect(result.current.schedules[1].dealTitle).toBe('Late night');
        });

        it('never overwrites what the user already typed', async () => {
            mockedScanDealPhoto.mockResolvedValue(usableScan());
            const { result } = await renderHook(() => useSubmitDealForm());
            await act(() => result.current.setVenueName('My Own Bar'));
            await act(() => result.current.setTagsInput('patio'));
            await act(() => result.current.toggleScheduleDay(0, 6));
            await act(() => result.current.updateSchedule(0, { dealTitle: 'my own title' }));
            await pickPhoto(result);

            await act(async () => {
                await result.current.handleScanPhoto();
            });

            expect(result.current.venueName).toBe('My Own Bar');
            expect(result.current.tagsInput).toBe('patio');
            expect(result.current.schedules[0].days).toEqual([6]);
            expect(result.current.schedules[0].dealTitle).toBe('my own title');
            // The one field they left blank is still filled in.
            // Normalized on the way in: the model writes whatever the menu
            // board said, and the old code stored it verbatim for the
            // validator to then reject.
            expect(result.current.schedules[0].timeWindow).toBe('4:00 PM - 6:30 PM');
        });

        it('explains an unreadable photo instead of filling anything in', async () => {
            mockedScanDealPhoto.mockResolvedValue({
                usable: false,
                reason: 'the photo is too blurred, dark or cropped to read',
                deals: [],
                deal: null,
            });
            const { result } = await renderHook(() => useSubmitDealForm());
            await pickPhoto(result);

            await act(async () => {
                await result.current.handleScanPhoto();
            });

            expect(result.current.scanNotice).toContain('too blurred');
            expect(result.current.schedules[0]).toEqual({ days: [], timeWindow: '', dealTitle: '' });
            expect(result.current.venueName).toBe('');
        });

        it('surfaces the quota message when scanning is rate limited', async () => {
            mockedScanDealPhoto.mockRejectedValue(
                new DealScanRateLimitError('Scan limit reached. Try again in about 25 minutes.', 1500)
            );
            const { result } = await renderHook(() => useSubmitDealForm());
            await pickPhoto(result);

            await act(async () => {
                await result.current.handleScanPhoto();
            });

            expect(result.current.scanNotice).toContain('Scan limit reached');
            expect(result.current.isScanning).toBe(false);
        });

        it('uploads the photo once across a scan and the submission that follows', async () => {
            mockedScanDealPhoto.mockResolvedValue(usableScan());
            mockedSubmitUserDeal.mockResolvedValue(true);
            const { result } = await renderHook(() => useSubmitDealForm());
            await pickPhoto(result);

            await act(async () => {
                await result.current.handleScanPhoto();
            });
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Logan Square'));
            await act(async () => {
                await result.current.handleSubmit();
            });

            expect(mockedUploadLocalImage).toHaveBeenCalledTimes(1);
            expect(mockedSubmitUserDeal).toHaveBeenCalledWith(
                expect.objectContaining({ imageUrl: PHOTO_URL })
            );
        });

        /**
         * The uploader resizes on whichever axis is longer, and only when the
         * photo is actually too big — passing a bare width would enlarge a
         * portrait shot instead of shrinking it. It can only do that with the
         * dimensions the picker already knows.
         */
        it('hands the picker dimensions to the uploader', async () => {
            mockedSubmitUserDeal.mockResolvedValue(true);
            const { result } = await renderHook(() => useSubmitDealForm());
            await pickPhoto(result);
            await act(() => result.current.setVenueName('The Draft House'));
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Logan Square'));
            await act(() => result.current.toggleScheduleDay(0, 1));
            await act(() => result.current.updateSchedule(0, { timeWindow: '4:00 PM - 6:00 PM', dealTitle: '$5 beers' }));

            await act(async () => {
                await result.current.handleSubmit();
            });

            expect(mockedUploadLocalImage).toHaveBeenCalledWith('file:///tmp/menu.jpg', {
                width: 3024,
                height: 4032,
            });
        });

        /**
         * A scanned photo is already in the bucket by the time the user changes
         * their mind, so discarding it here has to take it back out. Otherwise
         * every abandoned scan leaves an object nobody will ever clean up.
         */
        it('deletes an already-uploaded photo when the user removes it', async () => {
            mockedScanDealPhoto.mockResolvedValue(usableScan());
            const { result } = await renderHook(() => useSubmitDealForm());
            await pickPhoto(result);
            await act(async () => {
                await result.current.handleScanPhoto();
            });

            await act(() => result.current.handleRemoveImage());

            expect(mockedDeleteVenueImage).toHaveBeenCalledWith(PHOTO_URL);
            expect(result.current.selectedImage).toBeNull();
            expect(result.current.scanNotice).toBeNull();
        });

        it('does not carry a previous scan over to a newly picked photo', async () => {
            mockedScanDealPhoto.mockResolvedValue(usableScan());
            const { result } = await renderHook(() => useSubmitDealForm());
            await pickPhoto(result);
            await act(async () => {
                await result.current.handleScanPhoto();
            });
            expect(result.current.scanNotice).not.toBeNull();

            await pickPhoto(result);

            expect(result.current.scanNotice).toBeNull();
            // The new photo has not been uploaded yet, so submitting must upload
            // it rather than reuse the URL of the one it replaced.
            mockedSubmitUserDeal.mockResolvedValue(true);
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Logan Square'));
            await act(async () => {
                await result.current.handleSubmit();
            });
            expect(mockedUploadLocalImage).toHaveBeenCalledTimes(2);
        });
    });

    describe('the venue photo', () => {
        /** The minimum a submission needs to get past validation. */
        const fillValidForm = async (result: any) => {
            await act(() => result.current.setVenueName('The Draft House'));
            await act(() => result.current.setAddress('123 Main St'));
            await act(() => result.current.setNeighborhood('Wicker Park'));
            await act(() => result.current.toggleScheduleDay(0, 1));
            await act(() => result.current.updateSchedule(0, { timeWindow: '4:00 PM - 6:00 PM', dealTitle: '$5 beers' }));
        };

        it('is a separate picker from the menu photo', async () => {
            // One photo doing both jobs is what used to put a picture of a
            // chalkboard on the feed as though it were the bar.
            const { result } = await renderHook(() => useSubmitDealForm());

            await act(async () => { await result.current.handlePickVenuePhoto(); });

            expect(result.current.selectedVenuePhoto).toBe('file:///tmp/menu.jpg');
            expect(result.current.selectedImage).toBeNull();
        });

        it('leaves the venue photo alone when the menu photo is picked', async () => {
            const { result } = await renderHook(() => useSubmitDealForm());

            await act(async () => { await result.current.handlePickImage(); });

            expect(result.current.selectedImage).toBe('file:///tmp/menu.jpg');
            expect(result.current.selectedVenuePhoto).toBeNull();
        });

        it('uploads it once, and hands the URL to the submission', async () => {
            mockedSubmitUserDeal.mockResolvedValue(true);
            mockedUploadLocalImage.mockResolvedValue(PHOTO_URL);
            const { result } = await renderHook(() => useSubmitDealForm());
            await fillValidForm(result);
            await act(async () => { await result.current.handleTakeVenuePhoto(); });

            await act(async () => { await result.current.handleSubmit(); });

            expect(mockedUploadLocalImage).toHaveBeenCalledTimes(1);
            expect(mockedSubmitUserDeal).toHaveBeenCalledWith(
                expect.objectContaining({ venuePhotoUrl: PHOTO_URL, imageUrl: undefined }),
            );
        });

        it('uploads both photos when both were given', async () => {
            mockedSubmitUserDeal.mockResolvedValue(true);
            mockedUploadLocalImage.mockResolvedValue(PHOTO_URL);
            const { result } = await renderHook(() => useSubmitDealForm());
            await fillValidForm(result);
            await act(async () => { await result.current.handlePickImage(); });
            await act(async () => { await result.current.handlePickVenuePhoto(); });

            await act(async () => { await result.current.handleSubmit(); });

            expect(mockedUploadLocalImage).toHaveBeenCalledTimes(2);
            expect(mockedSubmitUserDeal).toHaveBeenCalledWith(
                expect.objectContaining({ imageUrl: PHOTO_URL, venuePhotoUrl: PHOTO_URL }),
            );
        });

        it('takes an abandoned photo back out of the bucket', async () => {
            // Otherwise every changed mind leaves an object nobody can delete.
            mockedUploadLocalImage.mockResolvedValue(PHOTO_URL);
            mockedSubmitUserDeal.mockResolvedValue(false);
            const { result } = await renderHook(() => useSubmitDealForm());
            await fillValidForm(result);
            await act(async () => { await result.current.handlePickVenuePhoto(); });
            await act(async () => { await result.current.handleSubmit(); });

            await act(() => result.current.handleRemoveVenuePhoto());

            expect(mockedDeleteVenueImage).toHaveBeenCalledWith(PHOTO_URL);
            expect(result.current.selectedVenuePhoto).toBeNull();
        });

        it('stops the submission when the venue photo will not upload', async () => {
            mockedUploadLocalImage.mockRejectedValue(new ImageTooLargeError());
            const { result } = await renderHook(() => useSubmitDealForm());
            await fillValidForm(result);
            await act(async () => { await result.current.handlePickVenuePhoto(); });

            await act(async () => { await result.current.handleSubmit(); });

            expect(Alert.alert).toHaveBeenCalledWith('Upload Failed', expect.stringContaining('venue'));
            expect(mockedSubmitUserDeal).not.toHaveBeenCalled();
            expect(result.current.isSubmitting).toBe(false);
        });

        it('submits without one, since it is optional', async () => {
            mockedSubmitUserDeal.mockResolvedValue(true);
            const { result } = await renderHook(() => useSubmitDealForm());
            await fillValidForm(result);

            await act(async () => { await result.current.handleSubmit(); });

            expect(mockedSubmitUserDeal).toHaveBeenCalledWith(
                expect.objectContaining({ venuePhotoUrl: undefined }),
            );
        });
    });
});
