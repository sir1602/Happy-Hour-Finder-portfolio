import { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Redirect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Root entry point. Checks onboarding completion directly here to avoid
 * the visible double-redirect flash that occurred when index → onboarding → tabs.
 */
export default function Index() {
    const [target, setTarget] = useState<'/(tabs)' | '/onboarding' | null>(null);

    useEffect(() => {
        AsyncStorage.getItem('onboardingComplete')
            .then(value => setTarget(value === 'true' ? '/(tabs)' : '/onboarding'))
            .catch(() => setTarget('/onboarding'));
    }, []);

    if (!target) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#212121' }}>
                <ActivityIndicator size="large" color="#FFC107" />
            </View>
        );
    }

    return <Redirect href={target} />;
}
