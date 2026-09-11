import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from '../context/LocationContext';
import { useLocationScope } from './useLocationScope';
import { searchVenues, VenueSearchResult } from '../services/dealService';

const DEBOUNCE_MS = 300;

interface UseVenueSearchOptions {
    /**
     * Overridable so tests exercise the debounce without spending the real
     * delay in wall-clock waiting.
     */
    debounceMs?: number;
}

/**
 * Venue suggestions for the submit form, debounced against what the user is
 * typing.
 *
 * Exists as its own hook because of the two things that make autocomplete
 * fiddly and worth testing on their own: the debounce timer, and the fact that
 * a slow earlier request must never overwrite a newer one's results.
 */
export function useVenueSearch(
    query: string,
    enabled: boolean = true,
    { debounceMs = DEBOUNCE_MS }: UseVenueSearchOptions = {},
) {
    const { scope } = useLocationScope();
    const { userLocation } = useLocation();

    // Keyed by the query they answer, so a result set is never shown against
    // text the user has since changed. That makes "is this list stale?" a
    // derivation rather than a second piece of state to keep in sync.
    const [answered, setAnswered] = useState<{ query: string; results: VenueSearchResult[] }>({
        query: '',
        results: [],
    });
    const [dismissedFor, setDismissedFor] = useState<string | null>(null);

    // Which query the newest in-flight request was for. A response for anything
    // else is stale by the time it lands and gets dropped.
    const latestQuery = useRef('');

    const trimmed = query.trim();
    const isActive = enabled && trimmed.length >= 2 && dismissedFor !== trimmed;

    useEffect(() => {
        latestQuery.current = trimmed;
        if (!isActive) return;

        const timer = setTimeout(() => {
            searchVenues(trimmed, scope, { near: userLocation ?? null }).then((found) => {
                // A slower earlier request must not overwrite a newer one.
                if (latestQuery.current !== trimmed) return;
                setAnswered({ query: trimmed, results: found });
            });
        }, debounceMs);

        return () => clearTimeout(timer);
    }, [trimmed, isActive, scope, userLocation, debounceMs]);

    const results = isActive && answered.query === trimmed ? answered.results : [];
    const isSearching = isActive && answered.query !== trimmed;

    /** Drop the list without waiting for a new query — used once a venue is picked. */
    const clearResults = useCallback(() => {
        latestQuery.current = '';
        setDismissedFor(query.trim());
    }, [query]);

    return { results, isSearching, clearResults };
}
