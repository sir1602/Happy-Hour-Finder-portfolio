import { supabase } from './supabase';
import { Logger } from './logger';

// ── Badge Definitions ──────────────────────────────────────────────
export interface BadgeDefinition {
    id: string;
    name: string;
    description: string;
    icon: string;
    /**
     * False when nothing in the app can currently award this badge, because it
     * depends on data we don't track yet. Such badges are excluded from the UI
     * rather than rendered permanently greyed out with no way to explain why.
     */
    earnable: boolean;
}

export const BADGES: BadgeDefinition[] = [
    { id: 'first_sip',     name: 'First Sip',     description: 'Check in for the first time',       icon: '🍻', earnable: true },
    { id: 'regular',       name: 'Regular',        description: 'Visit the same venue 5 times',      icon: '🔥', earnable: true },
    { id: 'critic',        name: 'Critic',         description: 'Write 10 reviews',                  icon: '⭐', earnable: true },
    { id: 'deal_hunter',   name: 'Deal Hunter',    description: 'Submit 20 deals',                   icon: '🏅', earnable: true },
    { id: 'hh_royalty',    name: 'HH Royalty',     description: 'Reach 1,000 points',                icon: '👑', earnable: true },

    // Not yet awardable — see checkAndAwardBadges. Kept here (rather than
    // deleted) so already-granted rows still resolve to a name and icon, and so
    // the intended design is visible when the underlying data lands.
    //
    // `explorer` and `streak_master` were marked earnable but never could be:
    // their criteria read `unique_venues_visited` and `longest_streak`, and no
    // client path writes either column. `RewardsContext` only ever calls
    // `addPoints` with `total_visits`, `total_reviews`, or `deals_submitted`,
    // so both counters sit at 0 forever and the badges rendered permanently
    // locked with no way to explain why. `explorer`'s description also
    // described a rule ("neighborhoods") the check does not implement; it now
    // matches the criterion it is actually gated on.
    { id: 'explorer',      name: 'Explorer',       description: 'Visit 5 different venues',          icon: '🗺️', earnable: false },
    { id: 'streak_master', name: 'Streak Master',  description: '4-week check-in streak',            icon: '🎯', earnable: false },
    { id: 'storyteller',   name: 'Storyteller',    description: 'Add photos to 5 check-ins',         icon: '📸', earnable: false },
    { id: 'night_owl',     name: 'Night Owl',      description: 'Check in after 9 PM, 5 times',      icon: '🌙', earnable: false },
    { id: 'trailblazer',   name: 'Trailblazer',    description: 'First person to check in at a new venue', icon: '🆕', earnable: false },
];

/** Badges the app can actually award today — what the badge grid should show. */
export const EARNABLE_BADGES: BadgeDefinition[] = BADGES.filter(b => b.earnable);

// ── Levels ─────────────────────────────────────────────────────────
export interface LevelDefinition {
    level: number;
    title: string;
    pointsRequired: number;
}

export const LEVELS: LevelDefinition[] = [
    { level: 1, title: 'Newbie',            pointsRequired: 0 },
    { level: 2, title: 'Regular',           pointsRequired: 100 },
    { level: 3, title: 'Explorer',          pointsRequired: 300 },
    { level: 4, title: 'Connoisseur',       pointsRequired: 600 },
    { level: 5, title: 'Happy Hour Hero',   pointsRequired: 1000 },
    { level: 6, title: 'Legend',            pointsRequired: 2000 },
];

// ── Points Table ───────────────────────────────────────────────────
/**
 * Actions the rewards RPC understands. These are the contract with
 * `increment_rewards(p_action text)`; the point value for each one lives in
 * the function, not here.
 */
export type RewardsAction = 'check_in' | 'check_in_first' | 'review' | 'deal_submitted';

/**
 * Presentational only. The server awards points from its own copy of this
 * table (see the `increment_rewards` migration); these values exist so the UI
 * can say "+15" without a round trip. They must stay in step with the RPC.
 */
export const POINTS = {
    CHECK_IN:        10,
    FIRST_VISIT:     25, // bonus for new venue
    REVIEW:          15,
    DEAL_SUBMITTED:  50,
    WEEKLY_STREAK:   30, // 3 unique venues in a week
    SHARE_DEAL:       5,
} as const;

// ── Types ──────────────────────────────────────────────────────────
export interface UserRewards {
    user_id: string;
    total_points: number;
    level: number;
    current_streak: number;
    longest_streak: number;
    unique_venues_visited: number;
    total_visits: number;
    total_reviews: number;
    deals_submitted: number;
}

export interface UserBadge {
    badge_id: string;
    earned_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────
export function getLevelForPoints(points: number): LevelDefinition {
    for (let i = LEVELS.length - 1; i >= 0; i--) {
        if (points >= LEVELS[i].pointsRequired) return LEVELS[i];
    }
    return LEVELS[0];
}

export function getNextLevel(current: LevelDefinition): LevelDefinition | null {
    const idx = LEVELS.findIndex(l => l.level === current.level);
    return idx < LEVELS.length - 1 ? LEVELS[idx + 1] : null;
}

function defaultRewards(userId: string): UserRewards {
    return {
        user_id: userId,
        total_points: 0,
        level: 1,
        current_streak: 0,
        longest_streak: 0,
        unique_venues_visited: 0,
        total_visits: 0,
        total_reviews: 0,
        deals_submitted: 0,
    };
}

// ── Service ────────────────────────────────────────────────────────
export const rewardsService = {
    /**
     * Fetch (or initialise) the rewards row for a user.
     */
    async getRewards(userId: string): Promise<UserRewards> {
        try {
            const { data, error } = await supabase
                .from('user_rewards')
                .select('*')
                .eq('user_id', userId)
                .maybeSingle();

            if (error) {
                Logger.error('Error fetching rewards', error);
                return defaultRewards(userId);
            }

            if (!data) {
                // First time — insert defaults
                const defaults = defaultRewards(userId);
                const { error: insertError } = await supabase.from('user_rewards').insert(defaults);
                if (insertError) {
                    Logger.error('Error initializing rewards row', insertError);
                }
                return defaults;
            }

            return data as UserRewards;
        } catch (e) {
            Logger.error('Unexpected error fetching rewards', e);
            return defaultRewards(userId);
        }
    },

    /**
     * Award points for a named action, atomically, via a Supabase RPC.
     *
     * The caller names what happened; the server decides what it is worth. The
     * previous signature took a client-supplied point total and added it
     * directly, so any authenticated user could ask for a million. The RPC also
     * creates the rewards row if it is missing, so there is no read-then-write
     * round trip to lose a race on.
     */
    async awardAction(action: RewardsAction): Promise<UserRewards | null> {
        try {
            const { data, error } = await supabase.rpc('increment_rewards', {
                p_action: action,
            });

            if (error) {
                Logger.error('Error updating rewards via RPC', error);
                return null;
            }

            return data as UserRewards;
        } catch (e) {
            Logger.error('Unexpected error updating rewards', e);
            return null;
        }
    },

    /**
     * Fetch all badges the user has earned.
     */
    async getUserBadges(userId: string): Promise<UserBadge[]> {
        try {
            const { data, error } = await supabase
                .from('user_badges')
                .select('badge_id, earned_at')
                .eq('user_id', userId)
                .order('earned_at', { ascending: false });

            if (error) {
                Logger.error('Error fetching badges', error);
                return [];
            }

            return (data ?? []) as UserBadge[];
        } catch (e) {
            Logger.error('Unexpected error fetching badges', e);
            return [];
        }
    },

    /**
     * Award a badge if not already earned. Returns true when newly awarded.
     *
     * Goes through the `award_badge` RPC rather than inserting into
     * `user_badges` directly. The table's INSERT policy previously allowed any
     * row where `auth.uid() = user_id` with no validation of `badge_id`, so a
     * client could self-award arbitrary (including unearnable) badges. The RPC
     * authenticates the caller and rejects unknown badge IDs; the direct-insert
     * policy has been dropped.
     *
     * `userId` is no longer sent — the RPC derives it from `auth.uid()` so the
     * caller cannot award badges to anyone but themselves. It is retained in the
     * signature for call-site symmetry with the other methods here.
     */
    async awardBadge(_userId: string, badgeId: string): Promise<boolean> {
        try {
            const { data, error } = await supabase.rpc('award_badge', {
                p_badge_id: badgeId,
            });

            if (error) {
                Logger.error('Error awarding badge', error);
                return false;
            }
            // false = already earned (ON CONFLICT DO NOTHING suppressed the insert)
            return data === true;
        } catch (e) {
            Logger.error('Unexpected error awarding badge', e);
            return false;
        }
    },

    /**
     * Award multiple badges. Returns the IDs of the ones newly awarded.
     *
     * Issued one RPC per badge. The previous bulk-insert path is gone along with
     * the direct-insert policy; badge awards happen at most a few at a time
     * (only after a check-in, review, or submission), so the extra round trips
     * are not worth batching into another RPC.
     */
    async awardBadges(userId: string, badgeIds: string[]): Promise<string[]> {
        if (badgeIds.length === 0) return [];

        try {
            const results = await Promise.all(
                badgeIds.map(async (id) => ((await this.awardBadge(userId, id)) ? id : null))
            );
            return results.filter((id): id is string => id !== null);
        } catch (e) {
            Logger.error('Unexpected error in bulk badge award', e);
            return [];
        }
    },

    /**
     * Run lightweight badge checks client-side. Called after each check-in,
     * review, or deal submission. Returns newly awarded badge IDs.
     */
    async checkAndAwardBadges(userId: string, rewards: UserRewards): Promise<string[]> {
        const badgesToAward: string[] = [];
        const earned = await this.getUserBadges(userId);
        const earnedIds = new Set(earned.map(b => b.badge_id));

        const tryAward = (id: string, condition: boolean) => {
            if (condition && !earnedIds.has(id)) {
                badgesToAward.push(id);
            }
        };

        // ── Badges that can be checked from UserRewards stats ──
        tryAward('first_sip',     rewards.total_visits >= 1);
        tryAward('critic',        rewards.total_reviews >= 10);
        tryAward('hh_royalty',     rewards.total_points >= 1000);
        // Both counters below are never incremented by any client path, so
        // these two can only fire once something writes them. They are marked
        // `earnable: false` in BADGES so the grid does not advertise them in
        // the meantime; the checks stay so they start working the moment the
        // stats do.
        tryAward('explorer',       rewards.unique_venues_visited >= 5);
        tryAward('deal_hunter',    rewards.deals_submitted >= 20);
        tryAward('streak_master',  rewards.longest_streak >= 4);

        // regular: Visit the same venue 5 times
        // We check this by querying if any venue has 5+ visits
        if (!earnedIds.has('regular')) {
            try {
                const { data } = await supabase
                    .from('user_visits')
                    .select('venue_id')
                    .eq('user_id', userId)
                    .limit(5000); // Safety cap, matches visitService.getVisitedVenueIds
                if (data) {
                    const counts = new Map<string, number>();
                    for (const row of data) {
                        counts.set(row.venue_id, (counts.get(row.venue_id) || 0) + 1);
                    }
                    const hasRegular = Array.from(counts.values()).some(c => c >= 5);
                    if (hasRegular) {
                        badgesToAward.push('regular');
                    }
                }
            } catch (e) {
                Logger.error('Error checking regular badge', e);
            }
        }

        // ── Badges that need future data/features ──
        // storyteller:  requires photo uploads on check-ins (not yet tracked)
        // night_owl:    requires check-in timestamp analysis (9 PM+, 5 times)
        // trailblazer:  requires first-ever-checkin detection at a new venue

        if (badgesToAward.length > 0) {
            return await this.awardBadges(userId, badgesToAward);
        }

        return [];
    },
};
