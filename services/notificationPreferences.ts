import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import type { Json } from '../types/database.types';
import { Logger } from './logger';

export interface NotificationPreferences {
    dealReminders: boolean;
    newDealsNearby: boolean;
    weeklyDigest: boolean;
}

const STORAGE_KEY = 'notification_preferences';

const defaultPreferences: NotificationPreferences = {
    dealReminders: true,
    newDealsNearby: true,
    weeklyDigest: false,
};

export const notificationPreferencesService = {
    /**
     * Get notification preferences from local cache (and optionally sync to Supabase)
     */
    async getPreferences(userId?: string): Promise<NotificationPreferences> {
        try {
            const cached = await AsyncStorage.getItem(STORAGE_KEY);
            let preferences = defaultPreferences;
            
            if (cached) {
                preferences = { ...defaultPreferences, ...JSON.parse(cached) };
            }

            // If user is logged in, try to fetch from Supabase to sync
            if (userId) {
                const { data, error } = await supabase
                    .from('profiles')
                    .select('notification_preferences')
                    .eq('id', userId)
                    .maybeSingle();

                if (!error && data?.notification_preferences) {
                    const dbPrefs = data.notification_preferences as Partial<NotificationPreferences>;
                    preferences = { ...preferences, ...dbPrefs };
                    // Keep cache in sync
                    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
                }
            }
            
            return preferences;
        } catch (e) {
            Logger.error('Error fetching notification preferences', e);
            return defaultPreferences;
        }
    },

    /**
     * Save notification preferences to local cache and Supabase
     */
    async savePreferences(userId: string | undefined, preferences: NotificationPreferences): Promise<boolean> {
        try {
            await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));

            if (userId) {
                const { error } = await supabase
                    .from('profiles')
                    .update({ notification_preferences: preferences as unknown as Json })
                    .eq('id', userId);

                if (error) {
                    Logger.error('Error updating notification preferences in Supabase', error);
                    // Still return true because it was saved locally
                    return true;
                }
            }
            return true;
        } catch (e) {
            Logger.error('Error saving notification preferences', e);
            return false;
        }
    }
};
