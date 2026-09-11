
import React, { memo, useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Image, ActivityIndicator } from 'react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { Icon } from './Icon';
import { openDirections } from '../utils/navigation';
import { Deal } from '../types';
import { useMapScreen } from '../hooks/useMapScreen';
import { useMapTiles } from '../hooks/useMapTiles';
import { ClusterMarker } from './map/ClusterMarker';
import { MapTilesUnavailable } from './map/MapTilesUnavailable';
import { Colors } from '../constants/colors';
import { Logger } from '../services/logger';
import { VENUE_FALLBACK_IMAGE } from '../constants/images';

let MapView: any = null;
let Marker: any = null;
let Callout: any = null;

try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const maps = require('react-native-maps');
    MapView = maps.default;
    Marker = maps.Marker;
    Callout = maps.Callout;
} catch (e) {
    Logger.warn('[MapScreen] react-native-maps failed to load', e);
}

// Optimization: Extract Marker to memoized component to prevent re-rendering all markers when one is selected
const DealMarker = memo(({ deal, isActive, onPress, onCalloutPress }: { deal: Deal, isActive: boolean, onPress: (deal: Deal) => void, onCalloutPress: (id: string) => void }) => {
    if (!Marker || !Callout) return null;
    return (
        <Marker
            coordinate={{ latitude: deal.latitude, longitude: deal.longitude }}
            onPress={() => onPress(deal)}
            // Always a colour, never `undefined`. Selecting a different deal
            // used to *remove* this prop from the previously-selected marker,
            // and a removed prop is not the same update as a changed one for a
            // native view behind the new architecture's interop layer. Passing
            // Google's own default red keeps the pin looking identical while
            // making every selection change a plain value swap.
            pinColor={isActive ? Colors.primary : Colors.mapMarkerDefault}
            tracksViewChanges={false}
        >
            <Callout onPress={() => onCalloutPress(deal.id)} tooltip={false}>
                <View className="w-48 p-1">
                    <Text className="font-bold text-base">{deal.name}</Text>
                    <Text className="text-sm">{deal.deal}</Text>
                    <Text className="mt-1 text-sm text-primary font-bold">View Details</Text>
                </View>
            </Callout>
        </Marker>
    );
});
DealMarker.displayName = 'DealMarker';

interface MapImplProps {
    focusDealId?: string;
    focusLat?: number;
    focusLng?: number;
    focusNonce?: string;
}

/**
 * The bottom-sheet thumbnail.
 *
 * This was the one place in the app rendering a venue image with no `onError`
 * at all, so a dead URL — a venue whose site has since moved the picture, say —
 * left a blank box here while every card elsewhere fell back. Same pattern as
 * DealCard's three variants: swap the source once, and reset when the deal
 * behind the sheet changes.
 */
const VenueThumb = memo(({ uri }: { uri: string }) => {
    const [imageSource, setImageSource] = useState({ uri });

    useEffect(() => {
        setImageSource({ uri });
    }, [uri]);

    return (
        <Image
            source={imageSource}
            className="w-28 h-full"
            onError={() => setImageSource({ uri: VENUE_FALLBACK_IMAGE })}
            accessible={false}
        />
    );
});
VenueThumb.displayName = 'VenueThumb';

export default function MapImpl({ focusDealId, focusLat, focusLng, focusNonce }: MapImplProps) {
    const map = useMapScreen({ focusDealId, focusLat, focusLng, focusNonce });
    // Armed only once the MapView below is actually mounted, i.e. not while
    // the deals spinner is up.
    const tiles = useMapTiles({ enabled: !map.isLoadingDeals && !!MapView });

    if (map.isLoadingDeals) {
        return (
            <View className="flex-1 items-center justify-center bg-background-light dark:bg-background-dark">
                <ActivityIndicator size="large" color={Colors.primary} />
            </View>
        );
    }

    // Fallback if react-native-maps failed to load
    if (!MapView) {
        return (
            <View className="flex-1 items-center justify-center bg-background-light dark:bg-background-dark">
                <Icon name="map" size={64} color={Colors.iconMuted} />
                <Text className="mt-4 text-lg font-semibold text-slate-500 dark:text-slate-400">Map not available</Text>
                <Text className="mt-2 text-sm text-slate-400 dark:text-slate-500 text-center px-8">
                    The map component could not be loaded on this device.
                </Text>
            </View>
        );
    }

    return (
        <View className="flex-1">
            <MapView
                // Remounts the native view when the user retries after a tile
                // failure; otherwise constant across the screen's lifetime.
                key={tiles.mapKey}
                ref={map.mapRef}
                style={{ flex: 1, width: '100%', height: '100%' }}
                initialRegion={map.initialMapRegion}
                showsUserLocation
                onRegionChangeComplete={map.handleRegionChangeComplete}
                onMapLoaded={tiles.handleMapLoaded}
            >
                {map.clusters.map(item => {
                    if (item.type === 'cluster') {
                        return (
                            <ClusterMarker
                                key={item.id}
                                latitude={item.latitude}
                                longitude={item.longitude}
                                pointCount={item.pointCount}
                                onPress={() => map.handleClusterPress(item)}
                            />
                        );
                    }
                    return (
                        <DealMarker
                            key={item.id}
                            deal={item.deal}
                            isActive={map.activeDeal?.id === item.deal.id}
                            onPress={map.handleMarkerPress}
                            onCalloutPress={map.handleSelectDeal}
                        />
                    );
                })}
            </MapView>
            {tiles.status === 'unavailable' && tiles.failure && (
                <MapTilesUnavailable failure={tiles.failure} onRetry={tiles.retry} />
            )}
            {map.locationMessage && (
                <View className={`absolute top-20 left-4 right-4 z-30 p-3 rounded-lg shadow-lg ${map.toastColors[map.locationStatus]}`}>
                    <Text className="text-sm font-semibold text-white text-center">{map.locationMessage}</Text>
                </View>
            )}
            {/* Deal count pill */}
            {map.deals.length > 0 && (
                <View className="absolute top-14 left-0 right-0 items-center z-20 pointer-events-none">
                    <View className="bg-slate-900/85 border border-amber-400/30 rounded-full px-4 py-1.5 flex-row items-center gap-1.5 shadow-lg">
                        <Icon name="local-offer" size={14} color={Colors.primary} />
                        <Text className="text-xs font-bold text-amber-400">
                            {map.deals.length} {map.deals.length === 1 ? 'deal' : 'deals'} nearby
                        </Text>
                    </View>
                </View>
            )}
            {/* Fetching states */}
            {map.isFetchingRegion && (
                <View className="absolute top-24 left-0 right-0 items-center z-20 pointer-events-none">
                    <View className="bg-slate-900/85 border border-amber-400/30 rounded-full px-4 py-1.5 flex-row items-center gap-1.5 shadow-lg">
                        <ActivityIndicator size="small" color={Colors.primary} />
                        <Text className="text-xs font-bold text-amber-400">Loading area...</Text>
                    </View>
                </View>
            )}
            {map.fetchError && !map.isFetchingRegion && (
                <View className="absolute top-24 left-0 right-0 items-center z-20 pointer-events-none">
                    <View className="bg-red-900/85 border border-red-500/50 rounded-full px-4 py-1.5 flex-row items-center gap-1.5 shadow-lg">
                        <Icon name="error" size={14} color={Colors.danger} />
                        <Text className="text-xs font-bold text-red-400">{map.fetchError}</Text>
                    </View>
                </View>
            )}
            <View className="absolute bottom-32 right-4 items-end gap-3 pointer-events-none">
                {/* Deals are re-queried when the camera moves far enough and
                    when a stale map regains focus. Neither covers the case a
                    tester actually hits: sitting on this screen while the
                    ingestion pipeline adds a venue down the road. */}
                <TouchableOpacity
                    onPress={map.refresh}
                    className="flex size-12 items-center justify-center rounded-lg bg-white shadow-lg pointer-events-auto"
                    disabled={map.isFetchingRegion}
                    accessibilityRole="button"
                    accessibilityLabel="Reload deals in this area"
                >
                    {map.isFetchingRegion ?
                        <ActivityIndicator size="small" color={Colors.black} />
                        : <Icon name="refresh" size={24} color={Colors.mapLocationIcon} />}
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={map.handleFindMyLocation}
                    className="flex size-12 items-center justify-center rounded-lg bg-white shadow-lg pointer-events-auto"
                    disabled={map.locationStatus === 'loading'}
                    accessibilityRole="button"
                    accessibilityLabel="Center the map on my location"
                >
                    {map.locationStatus === 'loading' ?
                        <ActivityIndicator size="small" color={Colors.black} />
                        : <Icon name="my-location" size={24} color={Colors.mapLocationIcon} />}
                </TouchableOpacity>
            </View>

            <BottomSheet
                ref={map.bottomSheetRef}
                index={map.activeDeal ? 0 : -1}
                snapPoints={map.snapPoints}
                enablePanDownToClose={true}
                onClose={() => map.setActiveDeal(null)}
                backgroundStyle={{ backgroundColor: Colors.mapSheetBackground }}
                handleIndicatorStyle={{ backgroundColor: Colors.mapSheetHandle }}
            >
                <BottomSheetView className="p-4">
                    {map.activeDeal && (
                        <View>
                            {/* Deal info card */}
                            <TouchableOpacity onPress={() => map.handleSelectDeal(map.activeDeal!.id)} className="flex-row items-stretch justify-start rounded-lg bg-slate-900 border border-slate-700 shadow-md overflow-hidden h-28">
                                <VenueThumb uri={map.activeDeal.image} />
                                <View className="flex-1 p-3">
                                    <Text className="text-xs font-medium text-slate-400 uppercase tracking-wider">{map.activeDeal.neighborhood}</Text>
                                    <Text className="text-lg font-bold leading-tight text-white mt-1" numberOfLines={1}>{map.activeDeal.name}</Text>
                                    <Text className="text-base font-semibold text-primary mt-1" numberOfLines={1}>{map.activeDeal.deal}</Text>
                                </View>
                            </TouchableOpacity>

                            {/* Action buttons */}
                            <View className="flex-row gap-3 mt-3">
                                <TouchableOpacity
                                    onPress={() => map.handleSelectDeal(map.activeDeal!.id)}
                                    className="flex-1 flex-row items-center justify-center gap-2 h-11 rounded-lg bg-primary active:scale-95"
                                >
                                    <Icon name="info" size={18} color={Colors.onPrimary} />
                                    <Text className="text-background-dark font-bold text-sm">View Details</Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    onPress={() => openDirections(map.activeDeal!.name, map.activeDeal!.address, map.activeDeal!.neighborhood, map.activeDeal!.latitude, map.activeDeal!.longitude)}
                                    className="flex-1 flex-row items-center justify-center gap-2 h-11 rounded-lg bg-slate-700 border border-slate-600 active:scale-95"
                                >
                                    <Icon name="directions" size={18} color={Colors.mapDirectionsIcon} />
                                    <Text className="text-blue-400 font-bold text-sm">Directions</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}
                </BottomSheetView>
            </BottomSheet>
        </View>
    );
}
