import React from 'react';
import { View, Text, TouchableOpacity, Alert, ScrollView, TextInput, Switch, ActivityIndicator, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { MaterialIcons } from '@expo/vector-icons';
import { Icon } from '../../components/Icon';
import { authService } from '../../services/authService';
import { useAuth } from '../../context/AuthContext';
import { useRewards } from '../../context/RewardsContext';
import { BADGES } from '../../services/rewardsService';
import { profileService, UserProfile } from '../../services/profileService';
import { notificationPreferencesService, NotificationPreferences } from '../../services/notificationPreferences';
import { cacheService } from '../../services/cacheService';
import { PRIVACY_POLICY_URL, TERMS_URL } from '../../constants/legal';
import { Logger } from '../../services/logger';
import { FeedbackModal } from '../../components/FeedbackModal';

const SettingsToggleRow = ({
    icon,
    label,
    sublabel,
    value,
    onValueChange,
}: {
    icon: keyof typeof MaterialIcons.glyphMap;
    label: string;
    sublabel?: string;
    value: boolean;
    onValueChange: (val: boolean) => void;
}) => (
    <View className="flex-row items-center justify-between p-4 border-b border-slate-100 dark:border-slate-700">
        <View className="flex-row items-center gap-3 flex-1">
            <Icon name={icon as keyof typeof MaterialIcons.glyphMap} size={24} color="#FFC107" />
            <View className="flex-1 mr-2">
                <Text className="text-base font-medium text-slate-800 dark:text-white">
                    {label}
                </Text>
                {sublabel && (
                    <Text className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{sublabel}</Text>
                )}
            </View>
        </View>
        <Switch
            value={value}
            onValueChange={onValueChange}
            trackColor={{ false: '#767577', true: '#FFC107' }}
            thumbColor={value ? '#ffffff' : '#f4f3f4'}
            accessibilityLabel={label}
            accessibilityHint={sublabel}
        />
    </View>
);

const SettingsRow = ({
    icon,
    label,
    sublabel,
    onPress,
    destructive = false,
    rightAction,
}: {
    icon: keyof typeof MaterialIcons.glyphMap;
    label: string;
    sublabel?: string;
    onPress?: () => void;
    destructive?: boolean;
    rightAction?: React.ReactNode;
}) => (
    <TouchableOpacity
        onPress={onPress}
        disabled={!onPress}
        className="flex-row items-center justify-between p-4 active:bg-slate-50 dark:active:bg-slate-700"
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={sublabel ? `${label}, ${sublabel}` : label}
    >
        <View className="flex-row items-center gap-3 flex-1">
            <Icon name={icon as keyof typeof MaterialIcons.glyphMap} size={24} color={destructive ? '#EF4444' : '#FFC107'} />
            <View>
                <Text className={`text-base font-medium ${destructive ? 'text-red-500' : 'text-slate-800 dark:text-white'}`}>
                    {label}
                </Text>
                {sublabel && (
                    <Text className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{sublabel}</Text>
                )}
            </View>
        </View>
        {rightAction ?? <Icon name="chevron-right" size={24} color="#9CA3AF" />}
    </TouchableOpacity>
);

const openLegalUrl = async (url: string, label: string) => {
    try {
        await Linking.openURL(url);
    } catch (e) {
        Logger.error(`[Settings] Failed to open ${label}`, e);
        Alert.alert('Could not open link', `Please visit ${url}`);
    }
};

export default function SettingsScreen() {
    const router = useRouter();
    const { user } = useAuth();
    const { rewards, earnedBadges, currentLevel, nextLevel, levelProgress, isLoaded: rewardsLoaded } = useRewards();

    const [profile, setProfile] = React.useState<UserProfile | null>(null);
    const [isEditingProfile, setIsEditingProfile] = React.useState(false);
    const [editName, setEditName] = React.useState('');
    const [editAvatar, setEditAvatar] = React.useState('');
    const [savingProfile, setSavingProfile] = React.useState(false);
    const [feedbackOpen, setFeedbackOpen] = React.useState(false);

    // F6: State for notification preferences
    const [prefs, setPrefs] = React.useState<NotificationPreferences>({
        dealReminders: true,
        newDealsNearby: true,
        weeklyDigest: false,
    });

    React.useEffect(() => {
        if (user) {
            profileService.getProfile(user.id)
                .then(p => {
                    if (p) {
                        setProfile(p);
                        setEditName(p.display_name || '');
                        setEditAvatar(p.avatar_url || '');
                    }
                })
                // Q2 fix: surface fetch failures so they're visible in dev logs
                // instead of silently swallowing errors that would break profile editing.
                .catch(e => Logger.error('[Settings] Failed to load profile', e));

            // F6: Load notification preferences
            notificationPreferencesService.getPreferences(user.id)
                .then(setPrefs)
                .catch(e => Logger.error('[Settings] Failed to load preferences', e));
        } else {
            // Load defaults for guest
            notificationPreferencesService.getPreferences()
                .then(setPrefs)
                .catch(e => Logger.error('[Settings] Failed to load guest preferences', e));
        }
    }, [user]);

    const handleSaveProfile = async () => {
        if (!user) return;
        setSavingProfile(true);
        try {
            const success = await profileService.updateProfile(user.id, {
                display_name: editName.trim() || null,
                avatar_url: editAvatar.trim() || null,
            });
            if (success) {
                setProfile(prev => prev ? { ...prev, display_name: editName.trim() || null, avatar_url: editAvatar.trim() || null } : null);
                setIsEditingProfile(false);
                Alert.alert("Success", "Profile updated!");
            } else {
                Alert.alert("Error", "Failed to update profile.");
            }
        } catch (e) {
            Logger.error('[Settings] Error saving profile', e);
            Alert.alert("Error", "An unexpected error occurred saving your profile.");
        } finally {
            setSavingProfile(false);
        }
    };

    // F6: Toggle preference handler
    // The Switch's onValueChange is a sync handler, so this was previously an
    // unawaited async call with no catch: a failed save became an unhandled
    // rejection and the switch stayed visually on, silently disagreeing with
    // what was actually stored. Roll the optimistic flip back instead, so the
    // control always reflects what persisted.
    const handleTogglePref = (key: keyof NotificationPreferences, value: boolean) => {
        const previous = prefs;
        const newPrefs = { ...prefs, [key]: value };
        setPrefs(newPrefs);

        notificationPreferencesService
            .savePreferences(user?.id, newPrefs)
            .catch((e) => {
                Logger.error('[Settings] Failed to save notification preferences', e);
                setPrefs(previous);
                Alert.alert('Could not save', 'Your notification preference did not save. Please try again.');
            });
    };

    // F3: Delete account handler
    const handleDeleteAccount = () => {
        Alert.alert(
            "Delete Account",
            "Are you sure you want to permanently delete your account? This action cannot be undone.",
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Delete Permanently",
                    style: "destructive",
                    onPress: async () => {
                        try {
                            await authService.deleteAccount();
                            // Account deletion is a full reset, so onboarding
                            // does replay here — unlike plain logout.
                            await AsyncStorage.multiRemove(['onboardingComplete', 'savedDeals']);
                            await cacheService.clear();
                            router.replace('/onboarding');
                        } catch (e) {
                            Logger.error('[Settings] Account deletion failed', e);
                            Alert.alert("Error", "Failed to delete account. Please try again later.");
                        }
                    }
                }
            ]
        );
    };

    const earnedBadgeIds = new Set(earnedBadges.map(b => b.badge_id));

    const handleLogout = () => {
        Alert.alert(
            "Log Out",
            "You'll go back to browsing as a guest. Your saved deals stay on your account.",
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Log Out",
                    style: "destructive",
                    onPress: async () => {
                        try {
                            await authService.signOut();
                            // Clear the guest-mode saved-deals cache so the next
                            // signed-out session doesn't inherit this account's
                            // bookmarks, and drop cached API responses that were
                            // fetched under this identity.
                            await AsyncStorage.removeItem('savedDeals');
                            await cacheService.clear();
                            // `onboardingComplete` intentionally survives logout:
                            // clearing it replayed the whole intro carousel every
                            // single time anyone signed out.
                            router.replace('/(tabs)');
                        } catch (e) {
                            Logger.error('[Settings] Logout failed', e);
                            Alert.alert("Error", "Failed to log out. Please try again.");
                        }
                    }
                }
            ]
        );
    };

    return (
        <SafeAreaView className="flex-1 bg-background-light dark:bg-background-dark" edges={['top']}>
            <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
                <Text className="text-2xl font-bold text-slate-900 dark:text-white mb-2 pt-4 px-4">Settings</Text>

                {/* ── Rewards Summary ─────────────────────────── */}
                {user && rewardsLoaded && rewards && (
                    <View className="mx-4 mb-4">
                        <View className="bg-white dark:bg-slate-800 rounded-xl overflow-hidden shadow-sm p-4">
                            {/* Level & Points header */}
                            <View className="flex-row items-center justify-between mb-3">
                                <View>
                                    <Text className="text-lg font-bold text-slate-900 dark:text-white">
                                        Level {currentLevel.level} — {currentLevel.title}
                                    </Text>
                                    <Text className="text-sm text-slate-500 dark:text-slate-400">
                                        {rewards.total_points} points
                                    </Text>
                                </View>
                                <View className="bg-amber-100 dark:bg-amber-900/40 rounded-full px-3 py-1">
                                    <Text className="text-amber-700 dark:text-amber-300 text-sm font-bold">⭐ Lv.{currentLevel.level}</Text>
                                </View>
                            </View>

                            {/* Progress bar */}
                            {nextLevel && (
                                <View className="mb-3">
                                    <View className="h-2.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                                        <View
                                            className="h-full bg-amber-500 rounded-full"
                                            style={{ width: `${Math.max(2, levelProgress)}%` }}
                                        />
                                    </View>
                                    <Text className="text-xs text-slate-500 dark:text-slate-400 mt-1 text-right">
                                        {nextLevel.pointsRequired - rewards.total_points} pts to {nextLevel.title}
                                    </Text>
                                </View>
                            )}

                            {/* Quick Stats row */}
                            <View className="flex-row justify-around border-t border-slate-100 dark:border-slate-700 pt-3">
                                <View className="items-center">
                                    <Text className="text-lg font-bold text-slate-900 dark:text-white">{rewards.total_visits}</Text>
                                    <Text className="text-xs text-slate-500 dark:text-slate-400">Visits</Text>
                                </View>
                                <View className="items-center">
                                    <Text className="text-lg font-bold text-slate-900 dark:text-white">{rewards.total_reviews}</Text>
                                    <Text className="text-xs text-slate-500 dark:text-slate-400">Reviews</Text>
                                </View>
                                <View className="items-center">
                                    <Text className="text-lg font-bold text-slate-900 dark:text-white">{rewards.deals_submitted}</Text>
                                    <Text className="text-xs text-slate-500 dark:text-slate-400">Deals</Text>
                                </View>
                                <View className="items-center">
                                    <Text className="text-lg font-bold text-slate-900 dark:text-white">{earnedBadges.length}</Text>
                                    <Text className="text-xs text-slate-500 dark:text-slate-400">Badges</Text>
                                </View>
                            </View>
                        </View>
                    </View>
                )}

                {/* ── Badges ─────────────────────────────────── */}
                {user && rewardsLoaded && (
                    <View className="mx-4 mb-4">
                        <Text className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Badges</Text>
                        <View className="bg-white dark:bg-slate-800 rounded-xl overflow-hidden shadow-sm p-4">
                            <View className="flex-row flex-wrap gap-3">
                                {/* Show every earnable badge, plus any the user has
                                    somehow already been granted from the not-yet-
                                    earnable set — so an existing award never
                                    silently disappears from their profile. */}
                                {BADGES.filter(b => b.earnable || earnedBadgeIds.has(b.id)).map(badge => {
                                    const earned = earnedBadgeIds.has(badge.id);
                                    return (
                                        <View
                                            key={badge.id}
                                            className={`items-center w-16 ${earned ? '' : 'opacity-30'}`}
                                        >
                                            <Text className="text-2xl mb-1">{badge.icon}</Text>
                                            <Text className="text-xs text-center text-slate-700 dark:text-slate-300" numberOfLines={2}>{badge.name}</Text>
                                        </View>
                                    );
                                })}
                            </View>
                        </View>
                    </View>
                )}

                {/* ── Account Section ──────────────────────── */}
                <View className="mx-4 mb-4">
                    <Text className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Account</Text>
                    <View className="bg-white dark:bg-slate-800 rounded-xl overflow-hidden shadow-sm">
                        {user ? (
                            <>
                                {isEditingProfile ? (
                                    <View className="p-4 border-b border-slate-100 dark:border-slate-700">
                                        <Text className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Display Name</Text>
                                        <TextInput
                                            className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3 mb-4 text-slate-900 dark:text-white"
                                            placeholder="Anonymous"
                                            value={editName}
                                            onChangeText={setEditName}
                                            returnKeyType="done"
                                        />
                                        <Text className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Avatar (Emoji or Initials)</Text>
                                        <TextInput
                                            className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3 mb-4 text-slate-900 dark:text-white"
                                            placeholder="👤"
                                            value={editAvatar}
                                            onChangeText={setEditAvatar}
                                            maxLength={4}
                                            returnKeyType="done"
                                        />
                                        <View className="flex-row justify-end gap-3">
                                            <TouchableOpacity onPress={() => setIsEditingProfile(false)} className="px-4 py-2">
                                                <Text className="text-slate-500 font-bold">Cancel</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity 
                                                onPress={handleSaveProfile} 
                                                disabled={savingProfile}
                                                className={`px-4 py-2 rounded-lg ${savingProfile ? 'bg-slate-400' : 'bg-primary'}`}
                                            >
                                                {savingProfile ? (
                                                    <ActivityIndicator size="small" color="#fff" />
                                                ) : (
                                                    <Text className="text-slate-900 font-bold">Save</Text>
                                                )}
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                ) : (
                                    <SettingsRow
                                        icon="person"
                                        label={profile?.display_name || "Anonymous User"}
                                        sublabel={`${profile?.avatar_url || '👤'} • ${user.email}`}
                                        onPress={() => setIsEditingProfile(true)}
                                    />
                                )}
                                <View className="h-px bg-slate-100 dark:bg-slate-700 mx-4" />
                                <SettingsRow
                                    icon="logout"
                                    label="Log Out"
                                    onPress={handleLogout}
                                    destructive
                                />
                                <View className="h-px bg-slate-100 dark:bg-slate-700 mx-4" />
                                <SettingsRow
                                    icon="delete-forever"
                                    label="Delete Account"
                                    onPress={handleDeleteAccount}
                                    destructive
                                />
                            </>
                        ) : (
                            <SettingsRow
                                icon="login"
                                label="Log In / Sign Up"
                                sublabel="Save deals across devices"
                                onPress={() => router.push('/login')}
                            />
                        )}
                    </View>
                </View>

                {/* ── Notification Preferences Section ────────────────── */}
                {/*
                  Only "Deal Reminders" is shown: it maps to a real local
                  notification that DealsContext schedules on save, and it is now
                  actually enforced there. "New Deals Nearby" and "Weekly Digest"
                  had no delivery mechanism behind them at all — no server, no
                  scheduled job, nothing reading profiles.expo_push_token — so
                  they're withheld until that exists rather than shipping
                  switches that silently do nothing.
                */}
                <View className="mx-4 mb-4">
                    <Text className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Notification Preferences</Text>
                    <View className="bg-white dark:bg-slate-800 rounded-xl overflow-hidden shadow-sm">
                        <SettingsToggleRow
                            icon="notifications"
                            label="Deal Reminders"
                            sublabel="Get notified 30 minutes before your saved deals start"
                            value={prefs.dealReminders}
                            onValueChange={(val) => handleTogglePref('dealReminders', val)}
                        />
                    </View>
                </View>

                {/* ── Feedback ─────────────────────────────── */}
                {/*
                  The alpha exists to produce signal, and until this row there
                  was no way for a tester to send any: no report action, no
                  contact address, nothing. Placed above About so it is visible
                  without scrolling to the bottom of the screen.
                */}
                <View className="mx-4 mb-4">
                    <Text className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Help us improve</Text>
                    <View className="bg-white dark:bg-slate-800 rounded-xl overflow-hidden shadow-sm">
                        <SettingsRow
                            icon="feedback"
                            label="Send feedback"
                            sublabel="Tell us what's broken, missing, or wrong"
                            onPress={() => setFeedbackOpen(true)}
                        />
                    </View>
                </View>

                {/* ── About Section ────────────────────────── */}
                <View className="mx-4 mb-4">
                    <Text className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">About</Text>
                    <View className="bg-white dark:bg-slate-800 rounded-xl overflow-hidden shadow-sm">
                        <SettingsRow
                            icon="info"
                            label="Happy Hour Chicago"
                            sublabel="Finding the best deals since 2025"
                            rightAction={<View />}
                        />
                        <View className="h-px bg-slate-100 dark:bg-slate-700 mx-4" />
                        <SettingsRow
                            icon="privacy-tip"
                            label="Privacy Policy"
                            onPress={() => openLegalUrl(PRIVACY_POLICY_URL, 'privacy policy')}
                        />
                        {TERMS_URL ? (
                            <>
                                <View className="h-px bg-slate-100 dark:bg-slate-700 mx-4" />
                                <SettingsRow
                                    icon="gavel"
                                    label="Terms of Service"
                                    onPress={() => openLegalUrl(TERMS_URL, 'terms of service')}
                                />
                            </>
                        ) : null}
                    </View>
                </View>

                <View className="items-center mt-2 mb-6">
                    {/* Q6: read version from expo-constants so it always reflects package.json */}
                    <Text className="text-sm text-slate-400">Version {Constants.expoConfig?.version ?? '1.0.0-alpha.1'}</Text>
                </View>
            </ScrollView>

            <FeedbackModal
                visible={feedbackOpen}
                onClose={() => setFeedbackOpen(false)}
                kind="general"
            />
        </SafeAreaView>
    );
}
