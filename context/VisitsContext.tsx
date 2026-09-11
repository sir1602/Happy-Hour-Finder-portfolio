import React, { createContext, useContext, useCallback, useMemo, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { visitService, Visit, VenueVisitStats } from '../services/visitService';
import { useAuth } from './AuthContext';

interface VisitsContextType {
    /** Set of venue IDs the current user has ever checked into (for card badges) */
    visitedVenueIds: Set<string>;
    /** Whether the initial load of visited venues is complete */
    isLoaded: boolean;
    /**
     * Check in to a venue. Updates visitedVenueIds on success.
     * Returns the result from the service (success, alreadyCheckedIn).
     */
    checkIn: (venueId: string, dealId: string | null, notes?: string) => Promise<{ success: boolean; alreadyCheckedIn: boolean }>;
    /** Quick O(1) lookup — has the user ever visited this venue? */
    hasVisited: (venueId: string) => boolean;
    /**
     * Fetch detailed visit stats for a specific venue + deal.
     * Used by the deal detail screen.
     */
    getVenueVisitStats: (venueId: string, dealId?: string | null) => Promise<VenueVisitStats>;
    /** Full visit history for the visits tab */
    visits: Visit[];
    refreshVisits: () => Promise<void>;
}

const VisitsContext = createContext<VisitsContextType | undefined>(undefined);

export const VisitsProvider = ({ children }: { children: ReactNode }) => {
    const { user } = useAuth();
    const queryClient = useQueryClient();

    // visitService's fetch methods already catch their own errors and return
    // safe defaults ([]), so there's nothing for these queryFns to rethrow —
    // isError/error will effectively never fire, matching prior behavior.
    const {
        data: visitedVenueIdsData,
        isPending: visitedVenueIdsPending,
    } = useQuery({
        queryKey: ['visitedVenueIds', user?.id],
        queryFn: () => visitService.getVisitedVenueIds(user!.id),
        enabled: !!user,
    });

    const { data: visitsData, refetch: refetchVisits } = useQuery({
        queryKey: ['visits', user?.id],
        queryFn: () => visitService.getUserVisits(user!.id),
        enabled: !!user,
    });

    const visitedVenueIds = useMemo(
        () => new Set(user ? visitedVenueIdsData ?? [] : []),
        [user, visitedVenueIdsData]
    );
    const visits = useMemo(() => (user ? visitsData ?? [] : []), [user, visitsData]);
    // Disabled queries (logged out) never leave `isPending`, so isLoaded must
    // account for that case explicitly rather than relying on query state.
    const isLoaded = !user || !visitedVenueIdsPending;

    const refreshVisits = useCallback(async () => {
        if (!user) return;
        await refetchVisits();
    }, [user, refetchVisits]);

    const checkIn = useCallback(async (
        venueId: string,
        dealId: string | null,
        notes?: string
    ): Promise<{ success: boolean; alreadyCheckedIn: boolean }> => {
        if (!user) return { success: false, alreadyCheckedIn: false };

        const result = await visitService.checkIn(user.id, venueId, dealId, notes);

        if (result.success && !result.alreadyCheckedIn) {
            queryClient.setQueryData<string[]>(['visitedVenueIds', user.id], (old) =>
                old ? Array.from(new Set([...old, venueId])) : [venueId]
            );
        }

        return result;
    }, [user, queryClient]);

    const hasVisited = useCallback((venueId: string) => visitedVenueIds.has(venueId), [visitedVenueIds]);

    const getVenueVisitStats = useCallback(async (venueId: string, dealId?: string | null): Promise<VenueVisitStats> => {
        if (!user) return { visitCount: 0, lastVisitedAt: null, checkedInToday: false };
        return visitService.getVenueVisitStats(user.id, venueId, dealId);
    }, [user]);

    const value = useMemo(
        () => ({
            visitedVenueIds,
            isLoaded,
            checkIn,
            hasVisited,
            getVenueVisitStats,
            visits,
            refreshVisits,
        }),
        [visitedVenueIds, isLoaded, checkIn, hasVisited, getVenueVisitStats, visits, refreshVisits]
    );

    return (
        <VisitsContext.Provider value={value}>
            {children}
        </VisitsContext.Provider>
    );
};

export const useVisits = () => {
    const context = useContext(VisitsContext);
    if (!context) {
        throw new Error('useVisits must be used within a VisitsProvider');
    }
    return context;
};
