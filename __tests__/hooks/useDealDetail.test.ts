import { renderHook, act, waitFor } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';
import { useDealDetail } from '../../hooks/useDealDetail';
import { getDealById, getDealsByVenueId } from '../../services/dealService';
import { reviewService } from '../../services/reviewService';

const mockPush = jest.fn();
const mockCheckIn = jest.fn();
const mockGetVenueVisitStats = jest.fn();
const mockAwardCheckInPoints = jest.fn();
const mockAwardReviewPoints = jest.fn();

let mockUser: { id: string } | null = { id: 'user-1' };

jest.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: 'deal-1' }),
    useRouter: () => ({ push: mockPush }),
}));

jest.mock('expo-linking', () => ({
    createURL: jest.fn((path: string) => `happyhour://${path}`),
}));

jest.mock('expo-haptics', () => ({
    notificationAsync: jest.fn().mockResolvedValue(undefined),
    NotificationFeedbackType: { Success: 'success' },
}));

jest.mock('../../context/VisitsContext', () => ({
    useVisits: () => ({ checkIn: mockCheckIn, getVenueVisitStats: mockGetVenueVisitStats }),
}));

jest.mock('../../context/AuthContext', () => ({
    useAuth: () => ({ user: mockUser }),
}));

jest.mock('../../context/RewardsContext', () => ({
    useRewards: () => ({
        awardCheckInPoints: mockAwardCheckInPoints,
        awardReviewPoints: mockAwardReviewPoints,
    }),
}));

jest.mock('../../services/dealService', () => ({
    getDealById: jest.fn(),
    getDealsByVenueId: jest.fn(),
}));

jest.mock('../../services/reviewService', () => ({
    reviewService: {
        getReviewsForVenue: jest.fn(),
        submitReview: jest.fn(),
    },
}));

const mockedGetDealById = getDealById as jest.Mock;
const mockedGetDealsByVenueId = getDealsByVenueId as jest.Mock;
const mockedReviewService = reviewService as jest.Mocked<typeof reviewService>;

const baseDeal = {
    id: 'deal-1',
    venueId: 'venue-1',
    name: 'The Draft House',
    deal: '$5 Craft Beers',
    time: '4:00pm - 6:00pm',
    neighborhood: 'River North',
    image: 'https://example.com/image.jpg',
};

describe('useDealDetail', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
        mockUser = { id: 'user-1' };
        mockedGetDealById.mockResolvedValue(baseDeal);
        mockedGetDealsByVenueId.mockResolvedValue([baseDeal]);
        mockedReviewService.getReviewsForVenue.mockResolvedValue([]);
        mockGetVenueVisitStats.mockResolvedValue({ visitCount: 0, checkedInToday: false });
        mockAwardCheckInPoints.mockResolvedValue([]);
        mockAwardReviewPoints.mockResolvedValue([]);
    });

    const renderLoaded = async () => {
        const hook = await renderHook(() => useDealDetail());
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
        return hook;
    };

    it('fetches the deal, venue deals, reviews, and visit stats on mount', async () => {
        const { result } = await renderLoaded();
        expect(mockedGetDealById).toHaveBeenCalledWith('deal-1');
        expect(mockedGetDealsByVenueId).toHaveBeenCalledWith('venue-1');
        expect(mockedReviewService.getReviewsForVenue).toHaveBeenCalledWith('venue-1');
        expect(mockGetVenueVisitStats).toHaveBeenCalledWith('venue-1', 'deal-1');
        expect(result.current.deal).toEqual(baseDeal);
    });

    describe('handleCheckIn', () => {
        it('prompts to log in and does not check in when the user is signed out', async () => {
            mockUser = null;
            const { result } = await renderLoaded();

            await act(async () => {
                await result.current.handleCheckIn();
            });

            expect(Alert.alert).toHaveBeenCalledWith(
                'Log In Required',
                expect.any(String),
                expect.any(Array)
            );
            expect(mockCheckIn).not.toHaveBeenCalled();
        });

        it('does nothing if already checked in today', async () => {
            mockGetVenueVisitStats.mockResolvedValue({ visitCount: 2, checkedInToday: true });
            const { result } = await renderLoaded();

            await act(async () => {
                await result.current.handleCheckIn();
            });

            expect(mockCheckIn).not.toHaveBeenCalled();
        });

        it('checks in, increments the visit count, and awards first-visit points when this is the first visit', async () => {
            mockCheckIn.mockResolvedValue({ success: true, alreadyCheckedIn: false });
            const { result } = await renderLoaded();
            expect(result.current.visitCount).toBe(0);

            await act(async () => {
                await result.current.handleCheckIn();
            });

            expect(mockCheckIn).toHaveBeenCalledWith('venue-1', 'deal-1');
            expect(result.current.checkedInToday).toBe(true);
            expect(result.current.visitCount).toBe(1);
            expect(mockAwardCheckInPoints).toHaveBeenCalledWith(true); // isFirstVisit
        });

        it('awards non-first-visit points when the user has visited before', async () => {
            mockGetVenueVisitStats.mockResolvedValue({ visitCount: 3, checkedInToday: false });
            mockCheckIn.mockResolvedValue({ success: true, alreadyCheckedIn: false });
            const { result } = await renderLoaded();

            await act(async () => {
                await result.current.handleCheckIn();
            });

            expect(mockAwardCheckInPoints).toHaveBeenCalledWith(false);
            expect(result.current.visitCount).toBe(4);
        });

        it('does not increment the visit count or award points when the backend reports an existing check-in today', async () => {
            mockCheckIn.mockResolvedValue({ success: true, alreadyCheckedIn: true });
            const { result } = await renderLoaded();

            await act(async () => {
                await result.current.handleCheckIn();
            });

            expect(result.current.checkedInToday).toBe(true);
            expect(result.current.visitCount).toBe(0);
            expect(mockAwardCheckInPoints).not.toHaveBeenCalled();
        });

        it('shows an error alert when the check-in call reports failure', async () => {
            mockCheckIn.mockResolvedValue({ success: false, alreadyCheckedIn: false });
            const { result } = await renderLoaded();

            await act(async () => {
                await result.current.handleCheckIn();
            });

            expect(Alert.alert).toHaveBeenCalledWith('Error', expect.any(String));
            expect(result.current.checkedInToday).toBe(false);
        });
    });

    describe('handleSubmitReview', () => {
        it('redirects to login and does not submit when the user is signed out', async () => {
            mockUser = null;
            const { result } = await renderLoaded();

            await act(async () => {
                await result.current.handleSubmitReview();
            });

            expect(mockPush).toHaveBeenCalledWith('/login');
            expect(mockedReviewService.submitReview).not.toHaveBeenCalled();
        });

        it('submits a new review, awards points only for a "created" result, and resets the form', async () => {
            mockedReviewService.submitReview.mockResolvedValue('created');
            const { result } = await renderLoaded();

            await act(() => {
                result.current.setNewRating(4);
            });
            await act(() => {
                result.current.setNewComment('Great spot!');
            });

            await act(async () => {
                await result.current.handleSubmitReview();
            });

            expect(mockedReviewService.submitReview).toHaveBeenCalledWith('venue-1', 'user-1', 4, 'Great spot!');
            expect(mockAwardReviewPoints).toHaveBeenCalled();
            expect(result.current.showReviewForm).toBe(false);
            expect(result.current.newComment).toBe('');
            expect(result.current.newRating).toBe(5);
        });

        it('does not award points when an existing review is merely updated', async () => {
            mockedReviewService.submitReview.mockResolvedValue('updated');
            const { result } = await renderLoaded();

            await act(async () => {
                await result.current.handleSubmitReview();
            });

            expect(mockAwardReviewPoints).not.toHaveBeenCalled();
            expect(Alert.alert).toHaveBeenCalledWith('Success', expect.stringContaining('updated'));
        });

        it('shows a failure alert and keeps the form open when submission fails', async () => {
            mockedReviewService.submitReview.mockResolvedValue(false);
            const { result } = await renderLoaded();

            await act(() => {
                result.current.setShowReviewForm(true);
            });

            await act(async () => {
                await result.current.handleSubmitReview();
            });

            expect(Alert.alert).toHaveBeenCalledWith('Error', expect.any(String));
            expect(result.current.showReviewForm).toBe(true);
        });
    });

    describe('handleShare', () => {
        it('shares the venue name and deal text', async () => {
            const { result } = await renderLoaded();

            await act(async () => {
                await result.current.handleShare();
            });

            expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({
                title: expect.stringContaining('The Draft House'),
                message: expect.stringContaining('$5 Craft Beers'),
            }));
        });

        it('omits the URL entirely when no public web origin is configured', async () => {
            // The old behavior attached `happyhourfinder://deal/<id>`, a
            // custom-scheme link that is unopenable for any recipient who does
            // not already have the app installed. No link beats a dead link.
            const { result } = await renderLoaded();

            await act(async () => {
                await result.current.handleShare();
            });

            const payload = (Share.share as jest.Mock).mock.calls[0][0];
            expect(payload.url).toBeUndefined();
            expect(payload.message).not.toContain('://');
        });

    });
});
