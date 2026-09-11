import React from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authService, extractTokensFromUrl } from '../../services/authService';
import { Logger } from '../../services/logger';
import { Colors } from '../../constants/colors';

/**
 * Landing route for every emailed auth link: magic link, email confirmation,
 * and password recovery.
 *
 * `authService` builds its redirect as `Linking.createURL('auth/callback')`,
 * but this file did not exist — so expo-router resolved the incoming URL to
 * nothing and rendered its built-in "This screen does not exist" page. The only
 * handler was a `Linking` listener inside `useLoginForm`, which exists solely
 * while `/login` is mounted; a link opened from the mail app on a cold start
 * therefore dead-ended.
 *
 * OAuth is unaffected either way — `openAuthSessionAsync` returns the URL
 * directly to the caller's promise and never routes through here.
 */
export default function AuthCallbackScreen() {
    const router = useRouter();
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        // Supabase rejects a code that has already been exchanged, so the same
        // URL must never be processed twice — which is easy to do here, since
        // a cold start can surface it through getInitialURL AND the listener.
        const handled = new Set<string>();

        const complete = async (url: string | null) => {
            if (!url || cancelled) return;
            if (!url.includes('auth/callback')) return;
            if (handled.has(url)) return;
            handled.add(url);

            try {
                const { type } = extractTokensFromUrl(url);
                const session = await authService.handleAuthCallback(url);
                if (cancelled) return;

                if (!session) {
                    setError('That link did not contain a valid sign-in. It may have expired.');
                    return;
                }

                await AsyncStorage.setItem('onboardingComplete', 'true').catch(() => {});

                // A recovery link establishes a session purely so the user can
                // set a new password; dropping them on the tabs would leave the
                // reset half-finished and the old password still in force.
                router.replace(type === 'recovery' ? '/auth/reset-password' : '/(tabs)');
            } catch (e: unknown) {
                Logger.error('[AuthCallback] Could not complete sign-in from link', e);
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : 'Could not complete sign-in from that link.');
                }
            }
        };

        // Cold start: the link that launched the app.
        Linking.getInitialURL().then((url) => {
            if (url) return complete(url);
            // Reached without a link at all — most likely opened directly.
            if (!cancelled) router.replace('/(tabs)');
        });

        // Already running: getInitialURL still returns the original launch URL,
        // so a link opened into a warm app only arrives through this event.
        const subscription = Linking.addEventListener('url', ({ url }) => { void complete(url); });

        return () => {
            cancelled = true;
            subscription.remove();
        };
    }, [router]);

    if (error) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#212121' }}>
                <Text style={{ fontSize: 20, fontWeight: 'bold', color: Colors.primary, marginBottom: 10, textAlign: 'center' }}>
                    That link didn&apos;t work
                </Text>
                <Text style={{ fontSize: 15, color: '#F5F5F5', textAlign: 'center', lineHeight: 22, marginBottom: 24 }}>
                    {error}
                </Text>
                <TouchableOpacity
                    onPress={() => router.replace('/login')}
                    style={{ backgroundColor: Colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel="Back to sign in"
                >
                    <Text style={{ fontWeight: 'bold', color: '#212121', fontSize: 16 }}>Back to sign in</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#212121' }}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={{ marginTop: 16, color: '#BDBDBD', fontSize: 15 }}>Signing you in…</Text>
        </View>
    );
}
