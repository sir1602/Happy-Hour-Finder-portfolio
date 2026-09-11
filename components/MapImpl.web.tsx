import React from 'react';
import { View, Text } from 'react-native';
import { Icon } from './Icon';

export default function MapImpl(_props: { focusDealId?: string; focusLat?: number; focusLng?: number; focusNonce?: string }) {
    return (
        <View className="flex-1 items-center justify-center bg-background-light dark:bg-background-dark">
            <Icon name="map" size={64} color="#9CA3AF" />
            <Text className="mt-4 text-lg font-semibold text-slate-500 dark:text-slate-400">Map View</Text>
            <Text className="mt-2 text-sm text-slate-400 dark:text-slate-500 text-center px-8">
                The interactive map is currently optimized for mobile devices.
                Please use the Explore tab to find deals.
            </Text>
        </View>
    );
}
