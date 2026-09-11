import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { getDeals, getFilterOptions, DealFilters } from '../services/dealService';
import { useLocationScope } from './useLocationScope';
import { Deal } from '../types';
import { useLocation } from '../context/LocationContext';
import { Analytics } from '../services/analytics';
import { Logger } from '../services/logger';

const PAGE_SIZE = 30;

/**
 * All state and business logic for the Explore screen: search/filter state,
 * paginated deal fetching (initial/refresh/load-more), the filter-chip option
 * lists, and the location-filter dropdown. Kept separate from the screen's
 * JSX so the fetch/filter logic is testable independent of layout.
 */
export function useExploreScreen() {
    // Compute TODAY inside the hook so it refreshes if the day changes
    // (the component remounts when the tab is focused).
    const TODAY = new Date().getDay(); // 0 = Sun … 6 = Sat
    const router = useRouter();
    const { sortByDistance } = useLocation();
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState(''); // QOL: only debounce text search
    const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
    const [selectedNeighborhoods, setSelectedNeighborhoods] = useState<Set<string>>(new Set());
    const [selectedDay, setSelectedDay] = useState<number>(TODAY);
    const [refreshing, setRefreshing] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [deals, setDeals] = useState<Deal[]>([]);
    const [hasMore, setHasMore] = useState(true);
    const [locationDropdownOpen, setLocationDropdownOpen] = useState(false);
    const { scope } = useLocationScope();
    // B3 fix: track deals.length via ref so fetchDeals callback doesn't become
    // stale and re-recreate on every page load (which caused subtle re-fetch loops).
    const dealsLengthRef = useRef(0);

    // Keep sortByDistance in a ref so we can use it in callbacks without causing re-fetches
    const sortByDistanceRef = useRef(sortByDistance);
    useEffect(() => {
        sortByDistanceRef.current = sortByDistance;
    }, [sortByDistance]);

    // For the filter chips, we'll keep a cached list of all possibilities
    const [allTags, setAllTags] = useState<string[]>([]);
    const [allNeighborhoods, setAllNeighborhoods] = useState<string[]>([]);
    const [hasLoadedChips, setHasLoadedChips] = useState(false);

    // Serialized versions of Set state, used as stable dependency-array values.
    //
    // JSON rather than `.join(',')`: a tag or neighborhood containing a comma
    // (e.g. "Beer, Wine") used to split into two bogus filter values when the
    // string was re-parsed with `.split(',')` below.
    const selectedTagsSerialized = useMemo(() => JSON.stringify([...selectedTags].sort()), [selectedTags]);
    const selectedNeighborhoodsSerialized = useMemo(() => JSON.stringify([...selectedNeighborhoods].sort()), [selectedNeighborhoods]);

    // Debounce the search query input
    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedQuery(query);
            if (query.trim().length > 0) {
                Analytics.track('search_performed', { query: query.trim() });
            }
        }, 300);
        return () => clearTimeout(handler);
    }, [query]);

    const fetchDeals = useCallback(async (options: { isRefresh?: boolean; loadMore?: boolean } = {}) => {
        const { isRefresh = false, loadMore = false } = options;
        // Without a scope the query would be global and mix cities together,
        // so hold off until it resolves rather than showing the wrong ones.
        if (!scope) return;
        if (isRefresh) setRefreshing(true);
        if (loadMore) setIsLoadingMore(true);
        if (!loadMore) setFetchError(null);

        try {
            // Build filters
            // B3 fix: use dealsLengthRef.current instead of deals.length so this
            // callback is not recreated on every page load (avoids re-fetch loops).
            const filters: DealFilters = {
                query: debouncedQuery || undefined,
                dayOfWeek: selectedDay,
                limit: PAGE_SIZE,
                offset: loadMore ? dealsLengthRef.current : 0,
            };

            const tagsArray: string[] = JSON.parse(selectedTagsSerialized);
            if (tagsArray.length > 0) {
                filters.tags = tagsArray;
            }

            const neighborhoodsArray: string[] = JSON.parse(selectedNeighborhoodsSerialized);
            if (neighborhoodsArray.length > 0) {
                filters.neighborhoods = neighborhoodsArray;
            }

            const data = await getDeals({ ...filters, center: scope.center, radiusKm: scope.radiusKm });
            const sortedData = sortByDistanceRef.current(data);

            if (loadMore) {
                setDeals(prev => {
                    const merged = [...prev, ...sortedData];
                    dealsLengthRef.current = merged.length;
                    return merged;
                });
            } else {
                dealsLengthRef.current = sortedData.length;
                setDeals(sortedData);
            }
            setHasMore(data.length >= PAGE_SIZE);
        } catch (error) {
            Logger.error('Failed to fetch deals', error);
            if (loadMore) {
                // Stop paginating. `fetchError` is only set on the initial
                // path (it swaps the whole list for an error state, which
                // would throw away the pages already loaded), so a failed page
                // used to leave hasMore true, fetchError null and
                // isLoadingMore false -- every subsequent scroll gesture
                // re-fired onEndReached and re-issued the same failing
                // request. Keep what loaded; pull-to-refresh retries.
                setHasMore(false);
            } else {
                setFetchError(error instanceof Error ? error.message : 'Failed to load deals');
                dealsLengthRef.current = 0;
                setDeals([]);
            }
        } finally {
            setIsLoading(false);
            if (isRefresh) setRefreshing(false);
            if (loadMore) setIsLoadingMore(false);
        }
    }, [debouncedQuery, selectedTagsSerialized, selectedNeighborhoodsSerialized, selectedDay, scope]);

    // B2 fix: Load filter chips using lightweight getFilterOptions() which fetches
    // only `tags` and `neighborhood` columns instead of pulling full deal objects.
    useEffect(() => {
        if (hasLoadedChips || !scope) return;
        const loadChips = async () => {
            try {
                const { tags, neighborhoods } = await getFilterOptions(scope);
                setAllTags(tags);
                setAllNeighborhoods(neighborhoods);
            } catch {
                // Non-critical: chips just stay empty
            } finally {
                setHasLoadedChips(true);
            }
        };
        loadChips();
    }, [hasLoadedChips, scope]);

    // Re-fetch immediately when query, tags, neighborhoods, or day changes
    useEffect(() => {
        setIsLoading(true);
        setHasMore(true);
        fetchDeals();
    }, [fetchDeals]);

    // Sort existing deals in-memory when location loaded/changed, avoiding redundant network/cache queries
    useEffect(() => {
        setDeals(prev => {
            if (prev.length === 0) return prev;
            return sortByDistanceRef.current(prev);
        });
    }, [sortByDistance]);

    const onRefresh = useCallback(() => {
        setHasMore(true);
        fetchDeals({ isRefresh: true });
    }, [fetchDeals]);

    const onEndReached = useCallback(() => {
        if (!isLoadingMore && hasMore && !fetchError) {
            fetchDeals({ loadMore: true });
        }
    }, [isLoadingMore, hasMore, fetchError, fetchDeals]);

    const handleToggleTag = useCallback((tag: string) => {
        Haptics.selectionAsync().catch(() => {});
        setSelectedTags(prev => {
            const next = new Set(prev);
            const isAdding = !next.has(tag);
            if (next.has(tag)) {
                next.delete(tag);
            } else {
                next.add(tag);
            }
            Analytics.track('filter_applied', { filterType: 'tag', filterValue: tag, action: isAdding ? 'add' : 'remove' });
            return next;
        });
    }, []);

    const handleToggleNeighborhood = useCallback((neighborhood: string) => {
        Haptics.selectionAsync().catch(() => {});
        setSelectedNeighborhoods(prev => {
            const next = new Set(prev);
            const isAdding = !next.has(neighborhood);
            if (next.has(neighborhood)) {
                next.delete(neighborhood);
            } else {
                next.add(neighborhood);
            }
            Analytics.track('filter_applied', { filterType: 'neighborhood', filterValue: neighborhood, action: isAdding ? 'add' : 'remove' });
            return next;
        });
    }, []);

    const handleClearNeighborhoods = useCallback(() => {
        setSelectedNeighborhoods(new Set());
    }, []);

    const handleClearTags = useCallback(() => {
        setSelectedTags(new Set());
    }, []);

    const handleToggleDay = useCallback((day: number) => {
        Haptics.selectionAsync().catch(() => {});
        // Tapping the currently-selected day resets to today
        setSelectedDay(prev => {
            const next = prev === day ? TODAY : day;
            Analytics.track('filter_applied', { filterType: 'day', filterValue: next });
            return next;
        });
    }, [TODAY]);

    const handleSelectDeal = useCallback((id: string) => {
        router.push(`/deal/${id}`);
    }, [router]);

    const hasActiveFilters = query.length > 0 || selectedTags.size > 0 || selectedNeighborhoods.size > 0 || selectedDay !== TODAY;

    const handleClearAllFilters = useCallback(() => {
        setQuery('');
        setSelectedTags(new Set());
        setSelectedNeighborhoods(new Set());
        setSelectedDay(TODAY);
    }, [TODAY]);

    const locationButtonLabel = selectedNeighborhoods.size > 0
        ? `Location (${selectedNeighborhoods.size})`
        : 'Location';

    return {
        TODAY,
        query, setQuery,
        selectedTags, selectedNeighborhoods, selectedDay,
        refreshing, isLoading, isLoadingMore, fetchError,
        deals, hasMore,
        locationDropdownOpen, setLocationDropdownOpen,
        allTags, allNeighborhoods,
        fetchDeals, onRefresh, onEndReached,
        handleToggleTag, handleToggleNeighborhood, handleClearNeighborhoods, handleClearTags, handleToggleDay,
        handleSelectDeal,
        hasActiveFilters, handleClearAllFilters,
        locationButtonLabel,
    };
}
