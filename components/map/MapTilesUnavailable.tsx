import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Icon } from '../Icon';
import { Colors } from '../../constants/colors';
import type { MapTileFailure } from '../../hooks/useMapTiles';

/**
 * Shown over the map when tiles never rendered (see `useMapTiles`). The map
 * stays mounted underneath — this is a card, not a replacement screen — so a
 * retry that succeeds simply reveals the working map behind it.
 *
 * The remedy lines are deliberately specific rather than a generic "something
 * went wrong". Every cause here is a build or account misconfiguration that
 * only the developer can fix, and an alpha tester who can quote the exact line
 * turns a blank screenshot into a one-step fix.
 */

const COPY: Record<MapTileFailure, { title: string; body: string; remedy: string }> = {
    'missing-key': {
        title: 'Map tiles unavailable',
        body: 'This build was compiled without a Google Maps API key, so the map cannot draw anything.',
        remedy: 'Set EXPO_PUBLIC_GOOGLE_MAPS_API_KEY and rebuild the app.',
    },
    offline: {
        title: 'Map tiles need a connection',
        body: 'Map tiles are downloaded as you pan, so they cannot load while offline. Deals you have already seen are still cached.',
        remedy: 'Reconnect, then tap Retry.',
    },
    'rejected-key': {
        title: 'Map tiles were rejected',
        body: 'Google refused this build’s Maps API key, so no tiles were drawn.',
        remedy: 'Check that the Maps SDK is enabled, billing is on, and the key allows this app’s package name and signing certificate.',
    },
};

interface MapTilesUnavailableProps {
    failure: MapTileFailure;
    onRetry: () => void;
}

export const MapTilesUnavailable = ({ failure, onRetry }: MapTilesUnavailableProps) => {
    const router = useRouter();
    const copy = COPY[failure];

    return (
        <View
            className="absolute top-0 bottom-0 left-0 right-0 z-10 items-center justify-center px-6 bg-background-dark/80"
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
        >
            <View className="w-full max-w-sm items-center rounded-2xl bg-slate-900 border border-slate-700 p-6 shadow-lg">
                <Icon
                    name={failure === 'offline' ? 'wifi-off' : 'layers-clear'}
                    size={44}
                    color={Colors.iconMuted}
                />
                <Text className="mt-4 text-lg font-bold text-white text-center">{copy.title}</Text>
                <Text className="mt-2 text-sm text-slate-400 text-center">{copy.body}</Text>
                <Text className="mt-3 text-xs text-slate-500 text-center">{copy.remedy}</Text>

                <View className="flex-row gap-3 mt-5 w-full">
                    <TouchableOpacity
                        onPress={onRetry}
                        accessibilityRole="button"
                        className="flex-1 flex-row items-center justify-center gap-2 h-11 rounded-lg bg-primary active:scale-95"
                    >
                        <Icon name="refresh" size={18} color={Colors.onPrimary} />
                        <Text className="text-background-dark font-bold text-sm">Retry</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        onPress={() => router.push('/(tabs)/explore')}
                        accessibilityRole="button"
                        className="flex-1 flex-row items-center justify-center gap-2 h-11 rounded-lg bg-slate-700 border border-slate-600 active:scale-95"
                    >
                        <Icon name="search" size={18} color={Colors.mapDirectionsIcon} />
                        <Text className="text-blue-400 font-bold text-sm">Browse deals</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </View>
    );
};
