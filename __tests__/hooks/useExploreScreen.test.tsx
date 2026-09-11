import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';

import { useExploreScreen } from '../../hooks/useExploreScreen';
import { getDeals, getFilterOptions } from '../../services/dealService';
import { Deal } from '../../types';

jest.mock('../../services/dealService', () => ({
    getDeals: jest.fn(),
    getFilterOptions: jest.fn(),
}));

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-haptics', () => ({ selectionAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/analytics', () => ({ Analytics: { track: jest.fn() } }));

// A resolved scope, so fetchDeals is not gated waiting for one.
//
// The returned objects are built ONCE in the factory, not per call. The hook
// keys `fetchDeals` on the scope object and re-sorts on the `sortByDistance`
// identity, so handing back a fresh object each render makes the effects
// re-fire on every render — an infinite loop in the test, and a latent
// fragility worth knowing about in the hook.
jest.mock('../../hooks/useLocationScope', () => {
    const scope = {
        center: { latitude: 41.8781, longitude: -87.6298 },
        radiusKm: 60,
        metro: null,
        isFallback: false,
        distanceKm: null,
    };
    const value = { scope, isResolving: false };
    return { useLocationScope: () => value };
});

// sortByDistance as identity: ordering is not what these tests are about.
jest.mock('../../context/LocationContext', () => {
    const sortByDistance = (deals: unknown[]) => deals;
    const value = { sortByDistance };
    return { useLocation: () => value };
});

const mockGetDeals = getDeals as jest.MockedFunction<typeof getDeals>;
const mockGetFilterOptions = getFilterOptions as jest.MockedFunction<typeof getFilterOptions>;

const PAGE_SIZE = 30;
const page = (prefix: string, count = PAGE_SIZE): Deal[] =>
    Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`, venueId: `v-${prefix}-${i}`, name: `Venue ${prefix}${i}`,
        deal: '$5 beers', image: '', neighborhood: 'River North', distance: '',
        price: 2, rating: 4, reviewCount: 10, tags: [], address: '', website: '',
        phone: '', type: 'regular', time: '4 PM - 6 PM',
        latitude: 41.89, longitude: -87.63, daysActive: [0, 1, 2, 3, 4, 5, 6],
    })) as Deal[];

type ExploreApi = ReturnType<typeof useExploreScreen>;

const renderExplore = () => {
    const ref: { current: ExploreApi } = { current: null as unknown as ExploreApi };
    const Probe = () => {
        ref.current = useExploreScreen();
        return null;
    };
    render(<Probe />);
    return { result: ref };
};

beforeEach(() => {
    jest.clearAllMocks();
    mockGetFilterOptions.mockResolvedValue({ tags: [], neighborhoods: [] });
});

describe('useExploreScreen — pagination', () => {
    it('loads a first page and offers more when the page came back full', async () => {
        mockGetDeals.mockResolvedValue(page('a'));

        const { result } = renderExplore();

        await waitFor(() => expect(result.current.deals).toHaveLength(PAGE_SIZE));
        expect(result.current.hasMore).toBe(true);
        expect(result.current.fetchError).toBeNull();
    });

    it('stops offering more once a short page comes back', async () => {
        mockGetDeals.mockResolvedValue(page('a', 5));

        const { result } = renderExplore();

        await waitFor(() => expect(result.current.deals).toHaveLength(5));
        expect(result.current.hasMore).toBe(false);
    });

    it('appends the next page on load-more', async () => {
        mockGetDeals.mockResolvedValueOnce(page('a')).mockResolvedValueOnce(page('b', 4));

        const { result } = renderExplore();
        await waitFor(() => expect(result.current.deals).toHaveLength(PAGE_SIZE));

        await act(async () => { result.current.onEndReached(); });

        await waitFor(() => expect(result.current.deals).toHaveLength(PAGE_SIZE + 4));
        // The second request must ask for the *next* window, not page 0 again.
        expect(mockGetDeals).toHaveBeenLastCalledWith(expect.objectContaining({ offset: PAGE_SIZE }));
    });

    // The regression.
    //
    // `fetchError` is only set on the initial path, so a failed load-more left
    // hasMore true, fetchError null and isLoadingMore false — and onEndReached's
    // guard (`!isLoadingMore && hasMore && !fetchError`) passed again on every
    // subsequent scroll gesture, re-issuing the same failing request forever.
    it('stops paginating after a failed load-more instead of retrying forever', async () => {
        mockGetDeals.mockResolvedValueOnce(page('a')).mockRejectedValue(new Error('network down'));

        const { result } = renderExplore();
        await waitFor(() => expect(result.current.deals).toHaveLength(PAGE_SIZE));

        await act(async () => { result.current.onEndReached(); });
        await waitFor(() => expect(result.current.hasMore).toBe(false));

        const callsAfterFailure = mockGetDeals.mock.calls.length;

        // Three more scroll gestures. None may reach the network.
        await act(async () => {
            result.current.onEndReached();
            result.current.onEndReached();
            result.current.onEndReached();
        });

        expect(mockGetDeals.mock.calls.length).toBe(callsAfterFailure);
    });

    it('keeps the pages already loaded when load-more fails', async () => {
        mockGetDeals.mockResolvedValueOnce(page('a')).mockRejectedValue(new Error('network down'));

        const { result } = renderExplore();
        await waitFor(() => expect(result.current.deals).toHaveLength(PAGE_SIZE));

        await act(async () => { result.current.onEndReached(); });
        await waitFor(() => expect(result.current.hasMore).toBe(false));

        // A failed *extra* page must not wipe the list the user is reading.
        expect(result.current.deals).toHaveLength(PAGE_SIZE);
        expect(result.current.fetchError).toBeNull();
    });

    it('does show a full-screen error when the FIRST page fails', async () => {
        mockGetDeals.mockRejectedValue(new Error('network down'));

        const { result } = renderExplore();

        await waitFor(() => expect(result.current.fetchError).toBe('network down'));
        expect(result.current.deals).toEqual([]);
    });
});
