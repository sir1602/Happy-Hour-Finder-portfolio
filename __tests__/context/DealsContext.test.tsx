import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { DealsProvider, useDeals } from '../../context/DealsContext';
import { getUserSavedDealIds, toggleUserSavedDeal } from '../../services/dealService';
import { useAuth } from '../../context/AuthContext';

jest.mock('../../services/dealService', () => ({
    getUserSavedDealIds: jest.fn(),
    toggleUserSavedDeal: jest.fn(),
}));

jest.mock('../../services/notificationService', () => ({
    scheduleSavedDealReminder: jest.fn().mockResolvedValue('notif-1'),
    cancelDealReminder: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../context/AuthContext', () => ({
    useAuth: jest.fn(),
}));

jest.mock('../../services/analytics', () => ({
    Analytics: { track: jest.fn(), identify: jest.fn(), reset: jest.fn() },
}));

const mockGetUserSavedDealIds = getUserSavedDealIds as jest.MockedFunction<typeof getUserSavedDealIds>;
const mockToggleUserSavedDeal = toggleUserSavedDeal as jest.MockedFunction<typeof toggleUserSavedDeal>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

const USER = { id: 'user-1', email: 'tester@example.com' } as any;

const signedIn = () => mockUseAuth.mockReturnValue({ user: USER, session: null, isLoading: false } as any);
const guest = () => mockUseAuth.mockReturnValue({ user: null, session: null, isLoading: false } as any);

type DealsApi = ReturnType<typeof useDeals>;

/**
 * Renders the provider around a probe that captures the context value on every
 * render, and hands back a `{ current }` view of it.
 *
 * `renderHook` and `render` from @testing-library/react-native 14.0.1 are
 * ASYNC in this project — they return a Promise, so the queries and
 * `result.current` only exist once awaited. An earlier version of this comment
 * claimed `renderHook` "returns an empty object under React 19"; that was
 * wrong, and the object being inspected was the un-awaited Promise.
 *
 * This suite keeps the probe-component pattern anyway: it reads the context
 * exactly as a screen does, and works the same whether or not render resolves
 * synchronously. `await renderHook(...)` is the simpler route for a new suite.
 */
const renderDeals = () => {
    const ref: { current: DealsApi } = { current: null as unknown as DealsApi };
    const Probe = () => {
        ref.current = useDeals();
        return null;
    };
    // retry:false so a rejected query surfaces immediately instead of being
    // retried three times behind the test's waitFor.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    render(
        <QueryClientProvider client={queryClient}>
            <DealsProvider>
                <Probe />
            </DealsProvider>
        </QueryClientProvider>
    );

    return { result: ref };
};

beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
});

describe('DealsContext — guest→account migration', () => {
    it('migrates guest saves into the account and clears local storage', async () => {
        await AsyncStorage.setItem('savedDeals', JSON.stringify(['deal-a', 'deal-b']));
        mockGetUserSavedDealIds.mockResolvedValue([]);
        mockToggleUserSavedDeal.mockResolvedValue(true);
        signedIn();

        const { result } = renderDeals();

        await waitFor(() => expect(result.current.savedDealIds).toHaveLength(2));
        expect(result.current.savedDealIds).toEqual(expect.arrayContaining(['deal-a', 'deal-b']));
        expect(await AsyncStorage.getItem('savedDeals')).toBeNull();
    });

    // The regression this whole file exists for.
    //
    // toggleUserSavedDeal returns false on failure rather than throwing, so
    // Promise.all resolved even when every insert was rejected. The local copy
    // was then deleted unconditionally and the returned array claimed the deals
    // were saved — so the UI showed them bookmarked for the rest of the session
    // and, on next launch, they were gone from the database AND local storage.
    it('does not delete the local copy when every migration write fails', async () => {
        await AsyncStorage.setItem('savedDeals', JSON.stringify(['deal-a', 'deal-b']));
        mockGetUserSavedDealIds.mockResolvedValue([]);
        mockToggleUserSavedDeal.mockResolvedValue(false); // silent failure
        signedIn();

        const { result } = renderDeals();

        await waitFor(() => expect(mockToggleUserSavedDeal).toHaveBeenCalledTimes(2));

        // The only surviving record of these saves must still be there.
        const stored = await AsyncStorage.getItem('savedDeals');
        expect(stored).not.toBeNull();
        expect(JSON.parse(stored as string)).toEqual(expect.arrayContaining(['deal-a', 'deal-b']));

        // And the UI must not claim they are saved when they are not.
        await waitFor(() => expect(result.current.savedDealIds).toEqual([]));
    });

    it('keeps only the failures locally on a partial migration', async () => {
        await AsyncStorage.setItem('savedDeals', JSON.stringify(['ok-1', 'bad-1', 'ok-2']));
        mockGetUserSavedDealIds.mockResolvedValue([]);
        mockToggleUserSavedDeal.mockImplementation(async (_userId, dealId) => dealId !== 'bad-1');
        signedIn();

        const { result } = renderDeals();

        await waitFor(() => expect(result.current.savedDealIds).toHaveLength(2));

        // Reported as saved: exactly what landed.
        expect(result.current.savedDealIds).toEqual(expect.arrayContaining(['ok-1', 'ok-2']));
        expect(result.current.savedDealIds).not.toContain('bad-1');

        // Retained locally: exactly what did not, so the next launch retries
        // only that one rather than the whole list.
        expect(JSON.parse((await AsyncStorage.getItem('savedDeals')) as string)).toEqual(['bad-1']);
    });

    it('does not touch local storage when there is nothing to migrate', async () => {
        await AsyncStorage.setItem('savedDeals', JSON.stringify(['deal-a']));
        mockGetUserSavedDealIds.mockResolvedValue(['deal-a']); // already on the account
        signedIn();

        const { result } = renderDeals();

        await waitFor(() => expect(result.current.savedDealIds).toEqual(['deal-a']));
        expect(mockToggleUserSavedDeal).not.toHaveBeenCalled();
    });
});

describe('DealsContext — toggleSave', () => {
    it('reverts the optimistic update when the database write fails', async () => {
        mockGetUserSavedDealIds.mockResolvedValue([]);
        mockToggleUserSavedDeal.mockResolvedValue(false);
        signedIn();

        const { result } = renderDeals();
        await waitFor(() => expect(result.current.savedDealIds).toEqual([]));

        await act(async () => {
            await result.current.toggleSave('deal-x', {
                deal: '$5 beers', time: '4 PM - 6 PM', name: 'The Draft House', daysActive: [1],
            });
        });

        await waitFor(() => expect(result.current.isSaved('deal-x')).toBe(false));
    });

    it('keeps the save when the database write succeeds', async () => {
        mockGetUserSavedDealIds.mockResolvedValue([]);
        mockToggleUserSavedDeal.mockResolvedValue(true);
        signedIn();

        const { result } = renderDeals();
        await waitFor(() => expect(result.current.savedDealIds).toEqual([]));

        await act(async () => {
            await result.current.toggleSave('deal-x', {
                deal: '$5 beers', time: '4 PM - 6 PM', name: 'The Draft House', daysActive: [1],
            });
        });

        await waitFor(() => expect(result.current.isSaved('deal-x')).toBe(true));
    });

    it('persists guest saves to local storage without hitting the database', async () => {
        guest();

        const { result } = renderDeals();
        await waitFor(() => expect(result.current.savedDealIds).toEqual([]));

        await act(async () => {
            await result.current.toggleSave('deal-x');
        });

        await waitFor(async () => {
            expect(JSON.parse((await AsyncStorage.getItem('savedDeals')) as string)).toEqual(['deal-x']);
        });
        expect(mockToggleUserSavedDeal).not.toHaveBeenCalled();
    });
});
