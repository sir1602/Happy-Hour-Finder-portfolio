import React from 'react';
import {
    View, Text, TextInput, TouchableOpacity, ActivityIndicator,
    KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Icon } from '../../components/Icon';
import { authService } from '../../services/authService';
import { useAuth } from '../../context/AuthContext';
import { Logger } from '../../services/logger';
import { Colors } from '../../constants/colors';

const MIN_PASSWORD_LENGTH = 8;

/**
 * Set a new password, reached from a recovery link via `app/auth/callback.tsx`.
 *
 * The reset flow previously stopped at the email: `resetPasswordForEmail` was
 * called with no `redirectTo`, there was no callback route, and no
 * `supabase.auth.updateUser` call existed anywhere in the codebase. The UI
 * advertised "Forgot Password?" and showed a success alert for something that
 * could never complete, so every locked-out tester became a support ticket.
 *
 * Requires the session the recovery link establishes. If there isn't one — link
 * expired, or the screen opened directly — say so rather than showing a form
 * whose submit is guaranteed to fail.
 */
export default function ResetPasswordScreen() {
    const router = useRouter();
    const { user, isLoading: authLoading } = useAuth();

    const [password, setPassword] = React.useState('');
    const [confirm, setConfirm] = React.useState('');
    const [showPassword, setShowPassword] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [isSaving, setIsSaving] = React.useState(false);

    const validate = (): string | null => {
        if (!password) return 'Enter a new password';
        if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
        if (password !== confirm) return 'Those passwords do not match';
        return null;
    };

    const handleSubmit = async () => {
        const problem = validate();
        if (problem) {
            setError(problem);
            return;
        }
        setError(null);
        setIsSaving(true);
        try {
            await authService.updatePassword(password);
            Alert.alert(
                'Password updated',
                'You are signed in with your new password.',
                [{ text: 'OK', onPress: () => router.replace('/(tabs)') }],
            );
        } catch (e: unknown) {
            Logger.error('[ResetPassword] Could not update password', e);
            setError(e instanceof Error ? e.message : 'Could not update your password. Please try again.');
        } finally {
            setIsSaving(false);
        }
    };

    if (authLoading) {
        return (
            <SafeAreaView className="flex-1 items-center justify-center bg-background-light dark:bg-background-dark">
                <ActivityIndicator size="large" color={Colors.primary} />
            </SafeAreaView>
        );
    }

    if (!user) {
        return (
            <SafeAreaView className="flex-1 items-center justify-center bg-background-light dark:bg-background-dark p-6">
                <Icon name="link-off" size={56} color={Colors.borderMuted} />
                <Text className="text-xl font-bold text-slate-800 dark:text-slate-200 mt-4 text-center">
                    This reset link has expired
                </Text>
                <Text className="text-slate-600 dark:text-slate-400 mt-2 text-center mb-6">
                    Password reset links can only be used once, and they stop working after a while.
                    Request a fresh one and try again.
                </Text>
                <TouchableOpacity
                    onPress={() => router.replace('/login')}
                    className="bg-primary px-8 py-3 rounded-xl w-full"
                    accessibilityRole="button"
                    accessibilityLabel="Back to sign in"
                >
                    <Text className="font-bold text-center text-background-dark text-lg">Back to sign in</Text>
                </TouchableOpacity>
            </SafeAreaView>
        );
    }

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            className="flex-1 bg-background-light dark:bg-background-dark"
        >
            <SafeAreaView className="flex-1" edges={['top']}>
                <ScrollView contentContainerStyle={{ padding: 24, flexGrow: 1, justifyContent: 'center' }} keyboardDismissMode="on-drag">
                    <Text className="text-3xl font-bold text-slate-900 dark:text-white mb-2">Choose a new password</Text>
                    <Text className="text-base text-slate-600 dark:text-slate-400 mb-8">
                        For {user.email}. Use at least {MIN_PASSWORD_LENGTH} characters.
                    </Text>

                    <Text className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">New password</Text>
                    <View className="flex-row items-center bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg mb-4">
                        <TextInput
                            className="flex-1 p-3 text-slate-900 dark:text-white"
                            placeholder="New password"
                            placeholderTextColor={Colors.iconMuted}
                            value={password}
                            onChangeText={(v) => { setPassword(v); setError(null); }}
                            secureTextEntry={!showPassword}
                            autoCapitalize="none"
                            autoComplete="new-password"
                            textContentType="newPassword"
                            returnKeyType="next"
                        />
                        <TouchableOpacity
                            onPress={() => setShowPassword((prev) => !prev)}
                            className="px-3 py-3"
                            accessibilityRole="button"
                            accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                        >
                            <Icon name={showPassword ? 'visibility-off' : 'visibility'} size={22} color={Colors.iconMuted} />
                        </TouchableOpacity>
                    </View>

                    <Text className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Confirm new password</Text>
                    <TextInput
                        className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg p-3 text-slate-900 dark:text-white"
                        placeholder="Confirm new password"
                        placeholderTextColor={Colors.iconMuted}
                        value={confirm}
                        onChangeText={(v) => { setConfirm(v); setError(null); }}
                        secureTextEntry={!showPassword}
                        autoCapitalize="none"
                        autoComplete="new-password"
                        textContentType="newPassword"
                        returnKeyType="done"
                        onSubmitEditing={handleSubmit}
                    />

                    {error ? (
                        <Text className="text-red-500 text-sm mt-3" accessibilityLiveRegion="polite">{error}</Text>
                    ) : null}

                    <TouchableOpacity
                        onPress={handleSubmit}
                        disabled={isSaving}
                        className={`mt-8 py-4 rounded-xl ${isSaving ? 'bg-slate-400' : 'bg-primary active:scale-95'}`}
                        accessibilityRole="button"
                        accessibilityLabel="Save new password"
                        accessibilityState={{ disabled: isSaving, busy: isSaving }}
                    >
                        {isSaving ? (
                            <ActivityIndicator size="small" color={Colors.white} />
                        ) : (
                            <Text className="font-bold text-center text-background-dark text-lg">Save new password</Text>
                        )}
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
        </KeyboardAvoidingView>
    );
}
