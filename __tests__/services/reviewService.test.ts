import { reviewService } from '../../services/reviewService';
import { supabase } from '../../services/supabase';
import { Logger } from '../../services/logger';

// Mock Supabase
jest.mock('../../services/supabase', () => ({
  supabase: {
    from: jest.fn(),
    rpc: jest.fn()
  }
}));

describe('reviewService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getReviewsForVenue', () => {
    it('returns reviews with profiles successfully', async () => {
      const mockReviews = [
        { id: '1', venue_id: 'venue123', user_id: 'user1', rating: 5, comment: 'Great!', created_at: '2023-01-01' },
        { id: '2', venue_id: 'venue123', user_id: 'user2', rating: 4, comment: 'Good', created_at: '2023-01-02' }
      ];

      const mockProfiles = [
        { id: 'user1', display_name: 'Alice', avatar_url: 'alice.jpg' },
        { id: 'user2', display_name: 'Bob', avatar_url: 'bob.jpg' }
      ];

      // Mock for 'reviews' table
      const mockReviewsOrder = jest.fn().mockResolvedValue({ data: mockReviews, error: null });
      const mockReviewsEq = jest.fn().mockReturnValue({ order: mockReviewsOrder });
      const mockReviewsSelect = jest.fn().mockReturnValue({ eq: mockReviewsEq });

      (supabase.from as jest.Mock).mockImplementation((table) => {
        if (table === 'reviews') {
          return { select: mockReviewsSelect };
        }
        return {};
      });
      (supabase.rpc as jest.Mock).mockResolvedValue({ data: mockProfiles, error: null });

      const result = await reviewService.getReviewsForVenue('venue123');

      expect(supabase.from).toHaveBeenCalledWith('reviews');
      expect(mockReviewsEq).toHaveBeenCalledWith('venue_id', 'venue123');
      expect(supabase.rpc).toHaveBeenCalledWith('get_public_profiles', { p_user_ids: ['user1', 'user2'] });

      expect(result).toHaveLength(2);
      expect(result[0].profile).toEqual(mockProfiles[0]);
      expect(result[1].profile).toEqual(mockProfiles[1]);
    });

    it('returns empty array when venue has no reviews', async () => {
      const mockReviewsOrder = jest.fn().mockResolvedValue({ data: [], error: null });
      const mockReviewsEq = jest.fn().mockReturnValue({ order: mockReviewsOrder });
      const mockReviewsSelect = jest.fn().mockReturnValue({ eq: mockReviewsEq });

      (supabase.from as jest.Mock).mockReturnValue({ select: mockReviewsSelect });

      const result = await reviewService.getReviewsForVenue('venue123');

      expect(result).toEqual([]);
      expect(supabase.from).toHaveBeenCalledWith('reviews');
      // Should not call profiles table since reviews array is empty
      expect(supabase.from).toHaveBeenCalledTimes(1);
    });

    it('returns an empty array when there is an error fetching reviews', async () => {
      const mockOrder = jest.fn().mockResolvedValue({ data: null, error: new Error('Fetch error') });
      const mockEq = jest.fn().mockReturnValue({ order: mockOrder });
      const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });

      (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

      const loggerSpy = jest.spyOn(Logger, 'error').mockImplementation(() => {});

      const result = await reviewService.getReviewsForVenue('venue123');

      expect(result).toEqual([]);
      expect(loggerSpy).toHaveBeenCalledWith('Error fetching reviews', expect.any(Error));

      loggerSpy.mockRestore();
    });

    it('returns reviews without profiles if profile fetch fails', async () => {
      const mockReviews = [
        { id: '1', venue_id: 'venue123', user_id: 'user1', rating: 5, comment: 'Great!', created_at: '2023-01-01' }
      ];

      const mockReviewsOrder = jest.fn().mockResolvedValue({ data: mockReviews, error: null });
      const mockReviewsEq = jest.fn().mockReturnValue({ order: mockReviewsOrder });
      const mockReviewsSelect = jest.fn().mockReturnValue({ eq: mockReviewsEq });

      (supabase.from as jest.Mock).mockImplementation((table) => {
        if (table === 'reviews') return { select: mockReviewsSelect };
      });
      (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: new Error('Profile fetch error') });

      const result = await reviewService.getReviewsForVenue('venue123');

      expect(result).toHaveLength(1);
      expect(result[0].profile).toBeUndefined(); // profile is undefined because mapping returns what Map.get returns (undefined for absent key)
    });

    it('returns empty array when unexpected error occurs', async () => {
      const mockEq = jest.fn().mockImplementation(() => {
          throw new Error('Unexpected error');
      });
      const mockSelect = jest.fn().mockReturnValue({ eq: mockEq });
      (supabase.from as jest.Mock).mockReturnValue({ select: mockSelect });

      const loggerSpy = jest.spyOn(Logger, 'error').mockImplementation(() => {});

      const result = await reviewService.getReviewsForVenue('venue123');

      expect(result).toEqual([]);
      expect(loggerSpy).toHaveBeenCalledWith('Unexpected error fetching reviews', expect.any(Error));

      loggerSpy.mockRestore();
    });
  });

  describe('submitReview', () => {
    it('creates a new review if none exists', async () => {
      // Mock existing check (returns null)
      const mockMaybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
      const mockEqUserId = jest.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
      const mockEqVenueId = jest.fn().mockReturnValue({ eq: mockEqUserId });
      const mockSelect = jest.fn().mockReturnValue({ eq: mockEqVenueId });

      // Mock upsert (success)
      const mockUpsert = jest.fn().mockResolvedValue({ data: {}, error: null });

      (supabase.from as jest.Mock).mockImplementation((table) => {
        if (table === 'reviews') {
          return {
            select: mockSelect,
            upsert: mockUpsert
          };
        }
      });

      const result = await reviewService.submitReview('venue123', 'user123', 5, 'Great!');

      expect(result).toBe('created');
      expect(mockEqVenueId).toHaveBeenCalledWith('venue_id', 'venue123');
      expect(mockEqUserId).toHaveBeenCalledWith('user_id', 'user123');
      expect(mockUpsert).toHaveBeenCalledWith(
        { venue_id: 'venue123', user_id: 'user123', rating: 5, comment: 'Great!' },
        { onConflict: 'user_id,venue_id' }
      );
    });

    it('updates an existing review if one exists', async () => {
      // Mock existing check (returns an existing review)
      const mockMaybeSingle = jest.fn().mockResolvedValue({ data: { id: 'existing123' }, error: null });
      const mockEqUserId = jest.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
      const mockEqVenueId = jest.fn().mockReturnValue({ eq: mockEqUserId });
      const mockSelect = jest.fn().mockReturnValue({ eq: mockEqVenueId });

      // Mock upsert (success)
      const mockUpsert = jest.fn().mockResolvedValue({ data: {}, error: null });

      (supabase.from as jest.Mock).mockImplementation((table) => {
        if (table === 'reviews') {
          return {
            select: mockSelect,
            upsert: mockUpsert
          };
        }
      });

      const result = await reviewService.submitReview('venue123', 'user123', 4, 'Updated comment');

      expect(result).toBe('updated');
      expect(mockUpsert).toHaveBeenCalledWith(
        { id: 'existing123', venue_id: 'venue123', user_id: 'user123', rating: 4, comment: 'Updated comment' },
        { onConflict: 'user_id,venue_id' }
      );
    });

    it('returns false when upsert fails', async () => {
      const mockMaybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
      const mockEqUserId = jest.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
      const mockEqVenueId = jest.fn().mockReturnValue({ eq: mockEqUserId });
      const mockSelect = jest.fn().mockReturnValue({ eq: mockEqVenueId });

      const mockUpsert = jest.fn().mockResolvedValue({ data: null, error: new Error('Upsert failed') });

      (supabase.from as jest.Mock).mockImplementation((table) => {
        if (table === 'reviews') {
          return { select: mockSelect, upsert: mockUpsert };
        }
      });

      const loggerSpy = jest.spyOn(Logger, 'error').mockImplementation(() => {});

      const result = await reviewService.submitReview('venue123', 'user123', 5, 'Great!');

      expect(result).toBe(false);
      expect(loggerSpy).toHaveBeenCalledWith('Error submitting review', expect.any(Error));

      loggerSpy.mockRestore();
    });

    it('returns false when unexpected error occurs', async () => {
      const mockEqVenueId = jest.fn().mockImplementation(() => {
         throw new Error('Unexpected error');
      });
      const mockSelect = jest.fn().mockReturnValue({ eq: mockEqVenueId });

      (supabase.from as jest.Mock).mockImplementation((table) => {
        if (table === 'reviews') {
          return { select: mockSelect };
        }
      });

      const loggerSpy = jest.spyOn(Logger, 'error').mockImplementation(() => {});

      const result = await reviewService.submitReview('venue123', 'user123', 5, 'Great!');

      expect(result).toBe(false);
      expect(loggerSpy).toHaveBeenCalledWith('Unexpected error submitting review', expect.any(Error));

      loggerSpy.mockRestore();
    });
  });
});
