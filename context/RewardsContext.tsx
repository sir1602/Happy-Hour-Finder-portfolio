import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    rewardsService,
    UserRewards,
    UserBadge,
    getLevelForPoints,
    getNextLevel,
    LevelDefinition,
    BadgeDefinition,
    BADGES,
} from '../services/rewardsService';
import { useAuth } from './AuthContext';

interface RewardsContextType {
    /** The user's current rewards summary */
    rewards: UserRewards | null;
    /** Badges the user has earned */
    earnedBadges: UserBadge[];
    /** Whether initial load is complete */
    isLoaded: boolean;
    /** The user's current level definition */
    currentLevel: LevelDefinition;
    /** The next level (or null if max) */
    nextLevel: LevelDefinition | null;
    /** Progress percentage toward next level (0–100) */
    levelProgress: number;
    /** Award points for a check-in (handles first-visit bonus) */
    awardCheckInPoints: (isFirstVisit: boolean) => Promise<string[]>;
    /** Award points for writing a review */
    awardReviewPoints: () => Promise<string[]>;
    /** Award points for submitting a deal */
    awardDealSubmittedPoints: () => Promise<string[]>;
    /** Force refresh rewards state */
    refreshRewards: () => Promise<void>;
    /** The active badge celebration to show in the modal */
    activeCelebration: BadgeDefinition | null;
    /** Dismiss the current celebration */
    dismissCelebration: () => void;
}

const defaultLevel = { level: 1, title: 'Newbie', pointsRequired: 0 };

const RewardsContext = createContext<RewardsContextType | undefined>(undefined);

export const RewardsProvider = ({ children }: { children: ReactNode }) => {
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const [pendingCelebrations, setPendingCelebrations] = useState<UserBadge[]>([]);

    // Both service methods already catch their own errors and return safe
    // defaults, so isError/error on these queries will effectively never fire.
    const {
        data: rewardsData,
        isPending: rewardsPending,
        refetch: refetchRewards,
    } = useQuery({
        queryKey: ['rewards', user?.id],
        queryFn: () => rewardsService.getRewards(user!.id),
        enabled: !!user,
    });

    const {
        data: badgesData,
        isPending: badgesPending,
        refetch: refetchBadges,
    } = useQuery({
        queryKey: ['badges', user?.id],
        queryFn: () => rewardsService.getUserBadges(user!.id),
        enabled: !!user,
    });

    const rewards = user ? rewardsData ?? null : null;
    const earnedBadges = useMemo(() => (user ? badgesData ?? [] : []), [user, badgesData]);
    // Disabled queries (logged out) never leave `isPending`, so isLoaded must
    // account for that case explicitly rather than relying on query state.
    const isLoaded = !user || (!rewardsPending && !badgesPending);

    const refreshRewards = useCallback(async () => {
        if (!user) {
            setPendingCelebrations([]);
            return;
        }
        await Promise.all([refetchRewards(), refetchBadges()]);
    }, [user, refetchRewards, refetchBadges]);

    // Compute derived level state
    const currentLevel = rewards ? getLevelForPoints(rewards.total_points) : defaultLevel;
    const nextLevel = getNextLevel(currentLevel);
    const levelProgress = nextLevel
        ? Math.min(
              100,
              ((rewards?.total_points ?? 0) - currentLevel.pointsRequired) /
                  (nextLevel.pointsRequired - currentLevel.pointsRequired) *
                  100
          )
        : 100;

    const queueNewBadges = useCallback(async (badgeIds: string[]) => {
        if (!user || badgeIds.length === 0) return;
        const { data: allBadges } = await refetchBadges();
        const newEarned = (allBadges ?? []).filter(b => badgeIds.includes(b.badge_id));
        setPendingCelebrations(prev => [...prev, ...newEarned]);
    }, [user, refetchBadges]);

    const awardCheckInPoints = useCallback(async (isFirstVisit: boolean): Promise<string[]> => {
        if (!user) return [];
        const updated = await rewardsService.awardAction(isFirstVisit ? 'check_in_first' : 'check_in');
        if (updated) {
            queryClient.setQueryData(['rewards', user.id], updated);
            const newBadges = await rewardsService.checkAndAwardBadges(user.id, updated);
            if (newBadges.length) {
                await queueNewBadges(newBadges);
            }
            return newBadges;
        }
        return [];
    }, [user, queryClient, queueNewBadges]);

    const awardReviewPoints = useCallback(async (): Promise<string[]> => {
        if (!user) return [];
        const updated = await rewardsService.awardAction('review');
        if (updated) {
            queryClient.setQueryData(['rewards', user.id], updated);
            const newBadges = await rewardsService.checkAndAwardBadges(user.id, updated);
            if (newBadges.length) {
                await queueNewBadges(newBadges);
            }
            return newBadges;
        }
        return [];
    }, [user, queryClient, queueNewBadges]);

    const awardDealSubmittedPoints = useCallback(async (): Promise<string[]> => {
        if (!user) return [];
        const updated = await rewardsService.awardAction('deal_submitted');
        if (updated) {
            queryClient.setQueryData(['rewards', user.id], updated);
            const newBadges = await rewardsService.checkAndAwardBadges(user.id, updated);
            if (newBadges.length) {
                await queueNewBadges(newBadges);
            }
            return newBadges;
        }
        return [];
    }, [user, queryClient, queueNewBadges]);

    const dismissCelebration = useCallback(() => {
        setPendingCelebrations(prev => prev.slice(1));
    }, []);

    const activeUserBadge = pendingCelebrations.length > 0 ? pendingCelebrations[0] : null;
    const activeCelebration = activeUserBadge
        ? BADGES.find(b => b.id === activeUserBadge.badge_id) || null
        : null;

    const value = useMemo(
        () => ({
            rewards,
            earnedBadges,
            isLoaded,
            currentLevel,
            nextLevel,
            levelProgress,
            awardCheckInPoints,
            awardReviewPoints,
            awardDealSubmittedPoints,
            refreshRewards,
            activeCelebration,
            dismissCelebration,
        }),
        [
            rewards, earnedBadges, isLoaded, currentLevel, nextLevel, levelProgress,
            awardCheckInPoints, awardReviewPoints, awardDealSubmittedPoints,
            refreshRewards, activeCelebration, dismissCelebration,
        ]
    );

    return (
        <RewardsContext.Provider value={value}>
            {children}
        </RewardsContext.Provider>
    );
};

export const useRewards = () => {
    const context = useContext(RewardsContext);
    if (!context) {
        throw new Error('useRewards must be used within a RewardsProvider');
    }
    return context;
};
