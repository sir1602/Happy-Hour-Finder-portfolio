import { supabase } from './supabase';
import { Logger } from './logger';

export interface UserProfile {
    id: string; // references auth.users
    display_name: string | null;
    avatar_url: string | null; // e.g. initials or an emoji string for now
}

export const profileService = {
    /**
     * Get the current user's profile
     */
    async getProfile(userId: string): Promise<UserProfile | null> {
        try {
            const { data, error } = await supabase
                .from('profiles')
                .select('id, display_name, avatar_url')
                .eq('id', userId)
                .maybeSingle();

            if (error) {
                Logger.error('Error fetching profile', error);
                return null;
            }
            return data as UserProfile | null;
        } catch (e) {
            Logger.error('Unexpected error fetching profile', e);
            return null;
        }
    },

    /**
     * Update the current user's profile
     */
    async updateProfile(userId: string, updates: Partial<UserProfile>): Promise<boolean> {
        try {
            const { error } = await supabase
                .from('profiles')
                .update(updates)
                .eq('id', userId);

            if (error) {
                Logger.error('Error updating profile', error);
                return false;
            }
            return true;
        } catch (e) {
            Logger.error('Unexpected error updating profile', e);
            return false;
        }
    }
};
