import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';
import { Logger } from './logger';
import { parseDealWindow } from '../utils/dealTime';
import { notificationPreferencesService } from './notificationPreferences';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function registerForPushNotificationsAsync(userId: string) {
  let token;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FFC107',
    });
  }

  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      Logger.warn('Notification permission denied. Skipping push token registration.');
      return;
    }
    
    try {
        const projectId =
            Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
            
        if (!projectId) {
            Logger.warn('No Expo project ID found. Skipping push token registration. Please configure EAS (`eas init`) to test push notifications.');
            return;
        } else {
            token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
        }
    } catch (e) {
        Logger.error('Error getting push token', e);
    }
    
  } else {
    Logger.warn('Push notifications require a physical device. Skipping registration.');
  }

  if (token && userId) {
      // Save token to Supabase profiles table
      const { error } = await supabase
        .from('profiles')
        .update({ expo_push_token: token })
        .eq('id', userId);
        
      if (error) {
          Logger.error('Error saving push token to profile', error);
      }
  }

  return token;
}

/**
 * Schedule a local notification to remind the user about a saved deal.
 * Fires 30 minutes before the deal's start time on the *next* active day.
 * If the deal runs today and the reminder time is still in the future,
 * it schedules for today; otherwise it advances to the next eligible day.
 */
export async function scheduleSavedDealReminder(
    dealId: string,
    dealName: string,
    dealTime: string,
    venueName: string,
    daysActive?: number[],  // 0=Sun…6=Sat
    userId?: string
): Promise<string | null> {
    try {
        // Respect the user's "Deal Reminders" setting. Previously this was
        // scheduled unconditionally, so turning the switch off in Settings had
        // no effect at all.
        const prefs = await notificationPreferencesService.getPreferences(userId);
        if (!prefs.dealReminders) return null;

        // Parse the start time from the deal time string (e.g., "4 PM - 6 PM"),
        // reusing the same validated parser getDealStatus() uses elsewhere.
        // parseDealWindow, not parseDealTime: the reminder fires at the start,
        // so a deal running until close can still have one.
        const parsed = parseDealWindow(dealTime);
        if (!parsed) return null;

        const hour = Math.floor(parsed.startHour);
        const minutes = Math.round((parsed.startHour - hour) * 60);

        const now = new Date();

        // Find the next valid trigger date (today or a future active day)
        // Try up to 8 days out to cover the full week + buffer
        for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
            const candidate = new Date(now);
            candidate.setDate(candidate.getDate() + dayOffset);

            // Check if this day is in the deal's active days
            if (daysActive && daysActive.length > 0) {
                if (!daysActive.includes(candidate.getDay())) continue;
            }

            // Set to deal start time exactly
            candidate.setHours(hour, minutes, 0, 0);
            
            // Check if exact start time is in the future
            if (candidate <= now) continue;

            const reminderTime = new Date(candidate);
            reminderTime.setMinutes(reminderTime.getMinutes() - 30);

            // Only schedule the 30-min reminder if the reminder time itself is in the future
            if (reminderTime > now) {
                await Notifications.scheduleNotificationAsync({
                    content: {
                        title: '🍺 Happy Hour Alert!',
                        body: `${dealName} at ${venueName} starts in 30 minutes!`,
                        data: { dealId, type: 'reminder' },
                        sound: true,
                    },
                    trigger: {
                        type: Notifications.SchedulableTriggerInputTypes.DATE,
                        date: reminderTime,
                    },
                });
            }

            const startingNowId = await Notifications.scheduleNotificationAsync({
                content: {
                    title: '🍻 Happy Hour Starting Now!',
                    body: `${dealName} at ${venueName} is active right now!`,
                    data: { dealId, type: 'start' },
                    sound: true,
                },
                trigger: {
                    type: Notifications.SchedulableTriggerInputTypes.DATE,
                    date: candidate,
                },
            });

            return startingNowId; // Just return one ID for simplicity, cancel uses the payload anyway
        }

        // No valid trigger found within the next week
        return null;
    } catch (e) {
        Logger.error('Error scheduling deal reminder', e);
        return null;
    }
}

/**
 * Cancel a previously scheduled deal reminder.
 */
export async function cancelDealReminder(dealId: string): Promise<void> {
    try {
        const scheduled = await Notifications.getAllScheduledNotificationsAsync();
        for (const notif of scheduled) {
            // Depending on the platform and expo version, the data might be in different places.
            // Usually it's in notif.content.data
            const triggerAny = notif.trigger as any;
            const data = notif.content?.data || triggerAny?.payload || {};
            if (data?.dealId === dealId) {
                await Notifications.cancelScheduledNotificationAsync(notif.identifier);
            }
        }
    } catch (e) {
        Logger.error('Error cancelling deal reminder', e);
    }
}
