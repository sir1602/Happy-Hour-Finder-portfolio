import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { Colors } from '../constants/colors';

/**
 * Catch-all for any route that does not resolve.
 *
 * Without this file expo-router falls back to its own development-flavoured
 * "This screen does not exist" page — which is what every malformed or stale
 * deep link produced, with no way back into the app.
 */
export default function NotFoundScreen() {
    const router = useRouter();
    const pathname = usePathname();

    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#212121' }}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>🍸</Text>
            <Text style={{ fontSize: 20, fontWeight: 'bold', color: Colors.primary, marginBottom: 10, textAlign: 'center' }}>
                We couldn&apos;t find that page
            </Text>
            <Text style={{ fontSize: 15, color: '#F5F5F5', textAlign: 'center', lineHeight: 22, marginBottom: 8 }}>
                The link you followed doesn&apos;t point anywhere in the app. It may be out of date.
            </Text>
            {pathname ? (
                <Text style={{ fontFamily: 'monospace', fontSize: 12, color: '#757575', marginBottom: 24 }}>{pathname}</Text>
            ) : null}
            <TouchableOpacity
                onPress={() => router.replace('/(tabs)')}
                style={{ backgroundColor: Colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Go to the home screen"
            >
                <Text style={{ fontWeight: 'bold', color: '#212121', fontSize: 16 }}>Take me home</Text>
            </TouchableOpacity>
        </View>
    );
}
