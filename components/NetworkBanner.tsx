/**
 * NetworkBanner
 * Displays a persistent warning banner when the device is offline.
 * Uses expo-network which ships with Expo and requires no additional install.
 */
import React, { useState, useEffect } from 'react';
import { Text, Animated } from 'react-native';
import * as Network from 'expo-network';
import { Icon } from './Icon';

export const NetworkBanner = () => {
    const [isOffline, setIsOffline] = useState(false);
    const slideAnim = React.useRef(new Animated.Value(-56)).current;

    useEffect(() => {
        let isMounted = true;

        const apply = (state: { isConnected?: boolean | null; isInternetReachable?: boolean | null }) => {
            if (!isMounted) return;
            setIsOffline(!state.isConnected || !state.isInternetReachable);
        };

        // One check on mount for the initial state...
        Network.getNetworkStateAsync()
            .then(apply)
            .catch(() => {
                // If we can't check, assume online rather than showing a false alarm.
                if (isMounted) setIsOffline(false);
            });

        // ...then subscribe. This used to poll every 5 seconds for the entire
        // lifetime of the app — waking the JS thread 720 times an hour to observe
        // a value that changes maybe twice a day.
        const subscription = Network.addNetworkStateListener(apply);

        return () => {
            isMounted = false;
            subscription.remove();
        };
    }, []);

    useEffect(() => {
        Animated.timing(slideAnim, {
            toValue: isOffline ? 0 : -56,
            duration: 300,
            useNativeDriver: true,
        }).start();
    }, [isOffline, slideAnim]);

    if (!isOffline) return null;

    return (
        <Animated.View
            style={{ transform: [{ translateY: slideAnim }] }}
            className="absolute top-0 left-0 right-0 z-50 flex-row items-center justify-center gap-2 bg-red-600 px-4 py-3"
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
        >
            <Icon name="wifi-off" size={16} color="white" />
            <Text className="text-white text-sm font-semibold">
                No internet connection — showing cached data
            </Text>
        </Animated.View>
    );
};
