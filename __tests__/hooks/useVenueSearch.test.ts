import { renderHook, waitFor, act, cleanup } from '@testing-library/react-native';
import { useVenueSearch } from '../../hooks/useVenueSearch';
import { searchVenues } from '../../services/dealService';

jest.mock('../../services/dealService', () => ({
    searchVenues: jest.fn().mockResolvedValue([]),
}));

const CHICAGO_SCOPE = { center: { latitude: 41.87, longitude: -87.62 }, radiusKm: 60 };
let mockScope: any = CHICAGO_SCOPE;
let mockUserLocation: any = null;

jest.mock('../../hooks/useLocationScope', () => ({
    useLocationScope: () => ({ scope: mockScope, isResolving: false }),
}));

jest.mock('../../context/LocationContext', () => ({
    useLocation: () => ({ userLocation: mockUserLocation }),
}));

const mockedSearch = searchVenues as jest.Mock;

// A short debounce keeps the coalescing under test without the suite paying
// the real 300ms per case in wall-clock waiting.
const DEBOUNCE_MS = 10;
// Named as a hook so rules-of-hooks recognises it as one.
const useSearch = (query: string, enabled = true) =>
    useVenueSearch(query, enabled, { debounceMs: DEBOUNCE_MS });

/** Comfortably past the debounce, for asserting that nothing was searched. */
const settle = () => new Promise(r => setTimeout(r, DEBOUNCE_MS * 10));

const venue = (id: string, name = 'The Tap Room') => ({
    id, name, address: '745 N Birch Ave', neighborhood: 'River North',
    latitude: 41.89, longitude: -87.63, distanceKm: null,
});

// A search resolving after its test returns lands in the next test's render.
afterEach(cleanup);

beforeEach(() => {
    jest.clearAllMocks();
    mockedSearch.mockResolvedValue([]);
    mockScope = CHICAGO_SCOPE;
    mockUserLocation = null;
});

describe('useVenueSearch', () => {
    it('does not search for a query under two characters', async () => {
        const { result } = await renderHook(() => useSearch('t'));
        await waitFor(() => expect(result.current.isSearching).toBe(false));
        expect(mockedSearch).not.toHaveBeenCalled();
        expect(result.current.results).toEqual([]);
    });

    it('passes the resolved scope and the user location through', async () => {
        mockUserLocation = { latitude: 41.9, longitude: -87.6 };
        const rendered = await renderHook(() => useSearch('tap room'));
        const { result } = rendered;
        await waitFor(() => expect(mockedSearch).toHaveBeenCalled());
        expect(mockedSearch).toHaveBeenCalledWith(
            'tap room',
            CHICAGO_SCOPE,
            { near: { latitude: 41.9, longitude: -87.6 } },
        );
        await waitFor(() => expect(result.current.isSearching).toBe(false));
    });

    it('does not let a slow earlier response overwrite a newer one', async () => {
        // The user keeps typing while the first request is in flight; the
        // stale answer must not repopulate the list under the new text.
        let resolveSlow: (v: any) => void = () => {};
        mockedSearch
            .mockImplementationOnce(() => new Promise(res => { resolveSlow = res; }))
            .mockResolvedValueOnce([venue('new-result')]);

        const { result, rerender } = await renderHook(({ q }) => useSearch(q), {
            initialProps: { q: 'tap' },
        });
        await waitFor(() => expect(mockedSearch).toHaveBeenCalledTimes(1));

        await act(async () => { rerender({ q: 'tap room' }); });
        await waitFor(() => expect(mockedSearch).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(result.current.results).toHaveLength(1));

        await act(async () => { resolveSlow([venue('stale-result')]); });
        await waitFor(() => expect(result.current.results[0].id).toBe('new-result'));
    });

    it('stops searching once the caller disables it', async () => {
        // Which is what happens the moment a venue is picked.
        await renderHook(() => useSearch('tap room', false));
        await settle();
        expect(mockedSearch).not.toHaveBeenCalled();
    });

    it('drops the list when the caller dismisses it, without a new query', async () => {
        mockedSearch.mockResolvedValue([venue('v1')]);
        const { result } = await renderHook(() => useSearch('tap room'));
        await waitFor(() => expect(result.current.results).toHaveLength(1));

        await act(async () => { result.current.clearResults(); });
        await waitFor(() => expect(result.current.results).toEqual([]));
    });

    it('waits for typing to settle before querying', async () => {
        const { result, rerender } = await renderHook(({ q }) => useSearch(q), {
            initialProps: { q: 'ta' },
        });
        // Each keystroke replaces the pending request rather than adding one.
        await act(async () => {
            rerender({ q: 'tap' });
            rerender({ q: 'tap ' });
            rerender({ q: 'tap r' });
        });

        await waitFor(() => expect(mockedSearch).toHaveBeenCalled());
        expect(mockedSearch).toHaveBeenCalledTimes(1);
        expect(mockedSearch.mock.calls[0][0]).toBe('tap r');
        await waitFor(() => expect(result.current.isSearching).toBe(false));
    });
});
