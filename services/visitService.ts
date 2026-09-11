import dayjs from 'dayjs';
import { supabase } from './supabase';
import { Logger } from './logger';

/**
 * The current calendar day in the *device's local* timezone, expressed as a
 * half-open UTC instant range `[start, end)`.
 *
 * This must not be derived from `new Date().toISOString()`. That yields the UTC
 * date, which for Chicago (UTC−5/−6) rolls over at 6–7 PM local — the middle of
 * happy hour. A user checking in at 5 PM and again at 8 PM the same evening
 * would land on two different "days", defeating the duplicate-check-in guard
 * and double-awarding points.
 */
export function localDayBounds(now: Date = new Date()): {
    start: string;
    end: string;
    startMs: number;
    endMs: number;
} {
    const startOfDay = dayjs(now).startOf('day');
    const endOfDay = startOfDay.add(1, 'day');
    return {
        start: startOfDay.toISOString(),
        end: endOfDay.toISOString(),
        startMs: startOfDay.valueOf(),
        endMs: endOfDay.valueOf(),
    };
}

export interface Visit {
    id: string;
    user_id: string;
    venue_id: string;
    deal_id: string | null;
    visited_at: string;
    notes: string | null;
    venues?: {
        name: string;
        neighborhood: string;
        image_url: string | null;
    };
    deals?: {
        title: string;
    } | null;
}

export interface VenueVisitStats {
    visitCount: number;
    lastVisitedAt: string | null;
    checkedInToday: boolean;
}

export const visitService = {
    /**
     * Record a check-in at a venue for the current deal.
     * Returns { success, alreadyCheckedIn }.
     */
    async checkIn(
        userId: string,
        venueId: string,
        dealId: string | null,
        notes?: string
    ): Promise<{ success: boolean; alreadyCheckedIn: boolean }> {
        try {
            // Prevent duplicate check-ins for the same deal on the same *local* day
            const { start, end } = localDayBounds();
            let existingQuery = supabase
                .from('user_visits')
                .select('id')
                .eq('user_id', userId)
                .eq('venue_id', venueId)
                .gte('visited_at', start)
                .lt('visited_at', end)
                .limit(1);

            if (dealId) {
                existingQuery = existingQuery.eq('deal_id', dealId);
            }

            const { data: existing } = await existingQuery.maybeSingle();

            if (existing) {
                return { success: true, alreadyCheckedIn: true };
            }

            const { error } = await supabase.from('user_visits').insert({
                user_id: userId,
                venue_id: venueId,
                deal_id: dealId ?? null,
                notes: notes ?? null,
            });

            if (error) {
                Logger.error('Error recording check-in', error);
                return { success: false, alreadyCheckedIn: false };
            }

            return { success: true, alreadyCheckedIn: false };
        } catch (e) {
            Logger.error('Unexpected error during check-in', e);
            return { success: false, alreadyCheckedIn: false };
        }
    },

    /**
     * Fetch all visits for a user, ordered newest first.
     */
    async getUserVisits(userId: string): Promise<Visit[]> {
        try {
            const { data, error } = await supabase
                .from('user_visits')
                .select(`
                    *,
                    venues (name, neighborhood, image_url),
                    deals (title)
                `)
                .eq('user_id', userId)
                .order('visited_at', { ascending: false });

            if (error) {
                Logger.error('Error fetching user visits', error);
                return [];
            }

            return (data ?? []) as Visit[];
        } catch (e) {
            Logger.error('Unexpected error fetching visits', e);
            return [];
        }
    },

    /**
     * Fetch the distinct set of venue_ids the user has ever visited.
     * Used to power the "visited" badge on cards.
     */
    async getVisitedVenueIds(userId: string): Promise<string[]> {
        try {
            // Query only the venue_id column. Ideally we'd use DISTINCT but
            // Supabase JS doesn't expose it. We compensate by selecting the
            // minimal column set and ordering so the DB can use an index,
            // then dedup client-side with a Set.  We also add a page limit
            // so the query doesn't balloon as visit count grows – the Set
            // naturally deduplicates across pages.
            const { data, error } = await supabase
                .from('user_visits')
                .select('venue_id')
                .eq('user_id', userId)
                .order('venue_id')
                .limit(5000);  // Safety cap — revisit if users exceed this

            if (error) {
                Logger.error('Error fetching visited venue IDs', error);
                return [];
            }

            const ids = new Set((data ?? []).map((row: { venue_id: string }) => row.venue_id));
            return Array.from(ids);
        } catch (e) {
            Logger.error('Unexpected error fetching venue IDs', e);
            return [];
        }
    },

    /**
     * Get visit stats for a specific user + venue combination.
     * When dealId is supplied, stats are scoped to that specific deal.
     * When omitted, all visits to the venue are counted (venue-level stats).
     */
    async getVenueVisitStats(userId: string, venueId: string, dealId?: string | null): Promise<VenueVisitStats> {
        try {
            let query = supabase
                .from('user_visits')
                .select('visited_at')
                .eq('user_id', userId)
                .eq('venue_id', venueId)
                .order('visited_at', { ascending: false });

            // B4 fix: apply deal-level filter when a dealId is provided
            if (dealId) {
                query = query.eq('deal_id', dealId);
            }

            const { data, error } = await query;

            if (error || !data) {
                return { visitCount: 0, lastVisitedAt: null, checkedInToday: false };
            }

            // Compare as instants, not as strings: PostgREST serializes timestamptz
            // with a `+00:00` offset and microsecond precision, so lexicographic
            // comparison against a `Z`-suffixed toISOString() value is unreliable.
            const { startMs, endMs } = localDayBounds();
            const checkedInToday = data.some((row: { visited_at: string }) => {
                const visitedMs = Date.parse(row.visited_at);
                return visitedMs >= startMs && visitedMs < endMs;
            });

            return {
                visitCount: data.length,
                lastVisitedAt: data.length > 0 ? data[0].visited_at : null,
                checkedInToday,
            };
        } catch (e) {
            Logger.error('Unexpected error fetching venue visit stats', e);
            return { visitCount: 0, lastVisitedAt: null, checkedInToday: false };
        }
    },
};
