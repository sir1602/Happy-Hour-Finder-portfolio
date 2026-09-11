import { supabase } from './supabase';
import { Logger } from './logger';

export interface Review {
    id: string;
    venue_id: string;
    user_id: string;
    rating: number;
    comment: string | null;
    created_at: string;
    profile?: {
        display_name: string | null;
        avatar_url: string | null;
    };
}

export const reviewService = {
  /**
   * Get all reviews for a specific venue
   */
  async getReviewsForVenue(venueId: string): Promise<Review[]> {
    try {
      const { data, error } = await supabase
        .from('reviews')
        .select('*')
        .eq('venue_id', venueId)
        .order('created_at', { ascending: false });

      if (error) {
        Logger.error('Error fetching reviews', error);
        return [];
      }

      const reviews = (data ?? []) as Review[];
      if (reviews.length === 0) return [];

      const userIds = [...new Set(reviews.map((r) => r.user_id))];
      const { data: profilesData } = await supabase
        .rpc('get_public_profiles', { p_user_ids: userIds });

      const profilesMap = new Map();
      if (profilesData) {
        for (const p of profilesData) {
          profilesMap.set(p.id, p);
        }
      }

      return reviews.map((r) => ({
        ...r,
        profile: profilesMap.get(r.user_id),
      }));
    } catch (error) {
      Logger.error('Unexpected error fetching reviews', error);
      return [];
    }
  },

  /**
   * Submit a new review for a venue, or update an existing one.
   * The DB has a unique constraint on (user_id, venue_id), so we upsert.
   * Returns 'created' if a new review was inserted, 'updated' if an
   * existing review was replaced, or false on failure.
   */
  async submitReview(
    venueId: string,
    userId: string,
    rating: number,
    comment: string | null = null
  ): Promise<'created' | 'updated' | false> {
    try {
      // Check if the user already has a review for this venue
      const { data: existing } = await supabase
        .from('reviews')
        .select('id')
        .eq('venue_id', venueId)
        .eq('user_id', userId)
        .maybeSingle();

      const isUpdate = !!existing;

      const { error } = await supabase
        .from('reviews')
        .upsert(
          {
            ...(existing ? { id: existing.id } : {}),
            venue_id: venueId,
            user_id: userId,
            rating,
            comment,
          },
          { onConflict: 'user_id,venue_id' }
        );

      if (error) {
        Logger.error('Error submitting review', error);
        return false;
      }
      return isUpdate ? 'updated' : 'created';
    } catch (error) {
      Logger.error('Unexpected error submitting review', error);
      return false;
    }
  }
};
