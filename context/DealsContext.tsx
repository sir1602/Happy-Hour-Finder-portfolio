import React, { createContext, useContext, useCallback, useMemo, useEffect, ReactNode, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { dealsReducer } from './dealsReducer';
import { validateSavedDeals } from '../utils/validation';
import { useAuth } from './AuthContext';
import { getUserSavedDealIds, toggleUserSavedDeal } from '../services/dealService';
import { scheduleSavedDealReminder, cancelDealReminder } from '../services/notificationService';
import { Analytics } from '../services/analytics';
import { Logger } from '../services/logger';

interface DealsContextType {
    savedDealIds: string[];
    toggleSave: (id: string, dealData?: { deal: string; time: string; name: string; daysActive?: number[] }) => void;
    isSaved: (id: string) => boolean;
}

const DealsContext = createContext<DealsContextType | undefined>(undefined);

async function loadLocalSavedDeals(): Promise<string[]> {
    const storedDeals = await AsyncStorage.getItem('savedDeals');
    if (!storedDeals) return [];
    try {
        return validateSavedDeals(JSON.parse(storedDeals));
    } catch (e) {
        Logger.error('Failed to parse saved deals from local storage', e);
        return [];
    }
}

export const DealsProvider = ({ children }: { children: ReactNode }) => {
    const { user, isLoading: authLoading } = useAuth();
    const queryClient = useQueryClient();
    const pendingTogglesRef = useRef<Set<string>>(new Set());

    // 'guest' rather than undefined/null so the key is stable and serializable
    // across the logged-out state consistently.
    const queryKey = useMemo(() => ['savedDealIds', user?.id ?? 'guest'] as const, [user]);

    const savedDealIdsQuery = useQuery({
        queryKey,
        queryFn: async (): Promise<string[]> => {
            if (!user) {
                return loadLocalSavedDeals();
            }

            // Logged in: fetch from DB, then migrate any local (guest-mode) deals
            const dbDeals = await getUserSavedDealIds(user.id);
            const localDeals = await loadLocalSavedDeals();
            const dealsToMigrate = localDeals.filter(id => !dbDeals.includes(id));

            if (dealsToMigrate.length === 0) {
                return dbDeals;
            }

            // `toggleUserSavedDeal` returns false on failure rather than
            // throwing, so `Promise.all` resolves even when every insert was
            // rejected. Clearing local storage unconditionally therefore
            // destroyed the only surviving copy of a guest's saved deals, and
            // the returned array claimed they were saved -- so the UI showed
            // them bookmarked for the rest of the session, and on next launch
            // they were gone from both the database and local storage. The
            // window is first-login-after-guest-use, which every tester passes
            // through exactly once.
            const outcomes = await Promise.all(
                dealsToMigrate.map(async (dealId) => ({
                    dealId,
                    migrated: await toggleUserSavedDeal(user.id, dealId, false),
                }))
            );
            const migrated = outcomes.filter(o => o.migrated).map(o => o.dealId);
            const failed = outcomes.filter(o => !o.migrated).map(o => o.dealId);

            if (failed.length === 0) {
                await AsyncStorage.removeItem('savedDeals');
            } else {
                // Keep exactly what did not make it, so the next launch retries
                // only those rather than re-attempting the whole list.
                Logger.warn(
                    `[DealsContext] ${failed.length} of ${dealsToMigrate.length} saved deals failed to migrate; keeping them locally to retry`
                );
                await AsyncStorage.setItem('savedDeals', JSON.stringify(failed));
            }

            // Only report what actually landed -- a deal shown as saved that
            // isn't in the database is the bug this replaces.
            return [...dbDeals, ...migrated];
        },
        enabled: !authLoading,
    });

    const savedDealIds = useMemo(() => savedDealIdsQuery.data ?? [], [savedDealIdsQuery.data]);
    const savedDealIdsRef = useRef<string[]>(savedDealIds);
    useEffect(() => {
        savedDealIdsRef.current = savedDealIds;
    }, [savedDealIds]);

    // Disabled queries (auth still loading) never leave `isPending`, but that
    // window is brief and covered by authLoading elsewhere; once enabled, this
    // tracks the real fetch/migration state.
    const isHydrated = !authLoading && !savedDealIdsQuery.isPending;

    // Persist to local storage ONLY while logged out (mirrors prior behavior —
    // logged-in state lives in the DB, not local storage).
    useEffect(() => {
        if (isHydrated && !user) {
            AsyncStorage.setItem('savedDeals', JSON.stringify(savedDealIds)).catch((error) => {
                Logger.error('Failed to save deals to local storage', error);
            });
        }
    }, [savedDealIds, isHydrated, user]);

    const toggleSave = useCallback(async (id: string, dealData?: { deal: string; time: string; name: string; daysActive?: number[] }) => {
        if (pendingTogglesRef.current.has(id)) {
            return;
        }

        pendingTogglesRef.current.add(id);
        const isCurrentlySaved = savedDealIdsRef.current.includes(id);
        const applyToggle = (old: string[] | undefined) =>
            dealsReducer(old ?? [], { type: 'TOGGLE', payload: id });

        // Optimistically update UI
        queryClient.setQueryData<string[]>(queryKey, applyToggle);

        // QOL-8: Track save/unsave events for alpha analytics
        Analytics.track(isCurrentlySaved ? 'deal_unsaved' : 'deal_saved', { dealId: id });

        try {
            // Schedule or cancel push notification reminder
            if (isCurrentlySaved) {
                await cancelDealReminder(id);
            } else if (dealData) {
                // Use the deal data passed from the calling component (no extra fetch)
                await scheduleSavedDealReminder(
                    id, dealData.deal, dealData.time, dealData.name, dealData.daysActive, user?.id
                );
            }

            if (user) {
                // Update database
                const success = await toggleUserSavedDeal(user.id, id, isCurrentlySaved);
                if (!success) {
                    // Revert on failure (TOGGLE is a flip, so applying it again undoes it)
                    queryClient.setQueryData<string[]>(queryKey, applyToggle);
                }
            }
        } catch (error) {
            Logger.error('Failed to toggle saved deal', error);
            queryClient.setQueryData<string[]>(queryKey, applyToggle);
        } finally {
            pendingTogglesRef.current.delete(id);
        }
    }, [user, queryClient, queryKey]);

    const savedDealsSet = useMemo(() => new Set(savedDealIds), [savedDealIds]);

    const isSaved = useCallback((id: string) => savedDealsSet.has(id), [savedDealsSet]);

    const value = useMemo(
        () => ({ savedDealIds, toggleSave, isSaved }),
        [savedDealIds, toggleSave, isSaved]
    );

    return (
        <DealsContext.Provider value={value}>
            {children}
        </DealsContext.Provider>
    );
};

export const useDeals = () => {
    const context = useContext(DealsContext);
    if (context === undefined) {
        throw new Error('useDeals must be used within a DealsProvider');
    }
    return context;
};
