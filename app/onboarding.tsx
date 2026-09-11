
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ImageBackground, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Icon } from '../components/Icon';
import { Logger } from '../services/logger';

export default function OnboardingScreen() {
    const router = useRouter();
    const [loadingAction, setLoadingAction] = useState<string | null>(null);
    const isMounted = useRef(true);
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        return () => {
            isMounted.current = false;
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, []);

    const completeOnboarding = async (action: string) => {
        if (loadingAction) return;
        setLoadingAction(action);

        // Artificial delay for better feedback
        await new Promise(resolve => {
            timeoutRef.current = setTimeout(resolve, 500);
        });

        if (!isMounted.current) return;

        if (action === 'guest') {
            try {
                await AsyncStorage.setItem('onboardingComplete', 'true');
            } catch (e) {
                Logger.error('[Onboarding] Failed to set onboarding complete', e);
            }
            router.replace('/(tabs)');
        } else {
            // For login/signup, we do NOT mark onboarding as complete yet.
            // The user must successfully log in first.
            // Pass the intended mode: without it both buttons landed on the
            // login form, so "Sign Up" showed "Log In".
            router.push({ pathname: '/login', params: { mode: action } });
            // Reset loading state after navigation since we push to stack
            if (isMounted.current) {
                setLoadingAction(null);
            }
        }
    };

    return (
        <ImageBackground source={require('../assets/images/onboarding_hero.jpg')} resizeMode="cover" className="flex-1">
            <View className="flex-1 justify-between p-6 bg-charcoal/70">
                <SafeAreaView>
                    <View className="items-center justify-start pt-16">
                        <View className="flex-row items-center gap-2">
                            <Icon name="sports-bar" size={36} color="#FFC107" />
                            <Text className="text-3xl font-extrabold tracking-tight text-white">Happy Hour Chicago</Text>
                        </View>
                    </View>
                </SafeAreaView>
                <View className="flex-grow items-center justify-center">
                    <Text className="tracking-light text-3xl font-bold leading-tight text-center max-w-sm text-white">Your Guide to the Best Deals in the Windy City</Text>
                </View>
                <View className="pb-8">
                    <View className="w-full max-w-[480px] self-center flex-col items-stretch gap-3">
                        <TouchableOpacity
                            onPress={() => completeOnboarding('signup')}
                            className="h-12 px-5 items-center justify-center rounded-lg bg-primary"
                            disabled={loadingAction !== null}
                            accessibilityRole="button"
                            accessibilityLabel="Sign up for an account"
                            accessibilityState={{ disabled: loadingAction !== null }}
                        >
                            {loadingAction === 'signup' ? (
                                <ActivityIndicator color="#36454F" />
                            ) : (
                                <Text className="text-charcoal text-base font-bold">Sign Up</Text>
                            )}
                        </TouchableOpacity>

                        <TouchableOpacity
                            onPress={() => completeOnboarding('login')}
                            className="h-12 px-5 items-center justify-center rounded-lg border-2 border-white"
                            disabled={loadingAction !== null}
                            accessibilityRole="button"
                            accessibilityLabel="Log in to existing account"
                            accessibilityState={{ disabled: loadingAction !== null }}
                        >
                            {loadingAction === 'login' ? (
                                <ActivityIndicator color="#FFFFFF" />
                            ) : (
                                <Text className="text-white text-base font-bold">Log In</Text>
                            )}
                        </TouchableOpacity>

                        <TouchableOpacity
                            onPress={() => completeOnboarding('guest')}
                            className="h-12 px-5 items-center justify-center rounded-lg"
                            disabled={loadingAction !== null}
                            accessibilityRole="button"
                            accessibilityLabel="Continue as guest without account"
                            accessibilityState={{ disabled: loadingAction !== null }}
                        >
                            {loadingAction === 'guest' ? (
                                <ActivityIndicator color="#FFFFFF" />
                            ) : (
                                <Text className="text-white text-base font-bold underline">Continue as Guest</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </ImageBackground>
    );
}
