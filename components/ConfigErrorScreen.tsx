import React from 'react';
import { View, Text, ScrollView } from 'react-native';

/**
 * Shown when the app was built without the environment variables it needs.
 *
 * This is not a user-recoverable state: `EXPO_PUBLIC_*` values are inlined into
 * the JS bundle at build time, so the binary itself is misconfigured and no
 * amount of signing in, reconnecting or reinstalling will change it. The screen
 * is therefore addressed to whoever produced the build, and its whole job is to
 * make the cause obvious in the one place a tester will actually look.
 *
 * It replaces a white screen. Previously `services/supabase.ts` threw during
 * module evaluation, which happens before React renders and before
 * `ErrorBoundary` mounts — the app died with no message in the UI, no log, and
 * (until services/instrument.ts) nothing in Sentry either.
 *
 * Styled with inline styles rather than NativeWind on purpose: this must render
 * even if something in the styling pipeline is part of what is broken.
 */
export function ConfigErrorScreen({ missing }: { missing: string }) {
    return (
        <View style={{ flex: 1, backgroundColor: '#212121' }}>
            <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 28 }}>
                <Text style={{ fontSize: 40, marginBottom: 16 }}>🍺</Text>
                <Text style={{ fontSize: 22, fontWeight: 'bold', color: '#FFC107', marginBottom: 12 }}>
                    This build is missing its configuration
                </Text>
                <Text style={{ fontSize: 15, color: '#F5F5F5', lineHeight: 22, marginBottom: 20 }}>
                    Happy Hour Finder cannot reach its backend, so there is nothing to show. This
                    is a problem with how the app was built, not with your device or your account —
                    reinstalling will not fix it.
                </Text>

                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#9E9E9E', letterSpacing: 1, marginBottom: 6 }}>
                    NOT SET AT BUILD TIME
                </Text>
                <View style={{ backgroundColor: '#171717', borderRadius: 6, padding: 14, marginBottom: 20 }}>
                    <Text style={{ fontFamily: 'monospace', fontSize: 13, color: '#FF8A80' }}>{missing}</Text>
                </View>

                <Text style={{ fontSize: 14, color: '#BDBDBD', lineHeight: 21 }}>
                    If you are testing this build, please send this screen to whoever sent you the
                    app — it tells them exactly what to fix.
                </Text>
                <Text style={{ fontSize: 13, color: '#757575', lineHeight: 20, marginTop: 14 }}>
                    Building it: set these per environment with{' '}
                    <Text style={{ fontFamily: 'monospace', color: '#9E9E9E' }}>eas env:create</Text>, then rebuild.
                    A local .env does not reach EAS Build.
                </Text>
            </ScrollView>
        </View>
    );
}
