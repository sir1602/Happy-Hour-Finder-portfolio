import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Icon } from '../../components/Icon';
import { useDeals } from '../../context/DealsContext';
import { useVisits } from '../../context/VisitsContext';
import { SavedCard } from '../../components/DealCard';
import { ErrorState } from '../../components/ui/ErrorState';
import { getDealsByIds } from '../../services/dealService';
import { SkeletonList } from '../../components/SkeletonCard';
import { Deal } from '../../types';
import { Logger } from '../../services/logger';

export default function SavedScreen() {
    const router = useRouter();
    const { savedDealIds, toggleSave } = useDeals();
    const { visitedVenueIds } = useVisits();
    const [refreshing, setRefreshing] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [hasError, setHasError] = useState(false);
    const [savedDeals, setSavedDeals] = useState<Deal[]>([]);
    const isMountedRef = useRef(true);

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const fetchDeals = useCallback(async () => {
        try {
            const data = await getDealsByIds(savedDealIds);
            if (isMountedRef.current) {
                setSavedDeals(data);
                setHasError(false);
            }
        } catch (error) {
            Logger.error('Failed to fetch saved deals', error);
            if (isMountedRef.current) {
                setSavedDeals([]);
                setHasError(true);
            }
        } finally {
            if (isMountedRef.current) {
                setIsLoading(false);
            }
        }
    }, [savedDealIds]);

    useEffect(() => {
        fetchDeals();
    }, [fetchDeals]);


    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await fetchDeals();
        } finally {
            if (isMountedRef.current) {
                setRefreshing(false);
            }
        }
    }, [fetchDeals]);

    const handleSelectDeal = useCallback((id: string) => {
        router.push(`/deal/${id}`);
    }, [router]);

    const renderItem = useCallback(({ item }: { item: Deal }) => (
        <SavedCard
            deal={item}
            onSelectDeal={handleSelectDeal}
            onToggleSave={toggleSave}
            isVisited={visitedVenueIds.has(item.venueId)}
        />
    ), [toggleSave, handleSelectDeal, visitedVenueIds]);

    return (
        <SafeAreaView className="flex-1 bg-background-light dark:bg-background-dark" edges={['top']}>
            <FlatList
                data={savedDeals}
                keyExtractor={(item) => item.id.toString()}
                contentContainerStyle={{ padding: 16, gap: 16 }}
                initialNumToRender={8}
                maxToRenderPerBatch={6}
                windowSize={5}
                refreshControl={
                    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FFC107" colors={['#FFC107']} />
                }
                ListHeaderComponent={
                    <View className="flex-row items-center gap-3 pb-2">
                        <Icon name="bookmark" size={28} color="#FFC107" />
                        <Text className="text-2xl font-bold tracking-tight text-text-light dark:text-text-dark">Saved Deals</Text>
                    </View>
                }
                renderItem={renderItem}
                ListEmptyComponent={
                    isLoading ? (
                        <View className="gap-4">
                            <SkeletonList count={3} />
                        </View>
                    ) : hasError ? (
                        <ErrorState
                            title="Couldn't load saved deals"
                            message="Something went wrong fetching your saved deals. Check your connection and try again."
                            onRetry={fetchDeals}
                        />
                    ) : (
                    <View className="items-center justify-center py-20">
                        <Icon name="bookmark-border" size={64} color="#D1D5DB" />
                        <Text className="mt-4 text-lg font-semibold text-slate-500 dark:text-slate-400">No saved deals yet</Text>
                        <Text className="mt-2 text-sm text-slate-400 dark:text-slate-500 text-center px-8">
                            Tap the bookmark icon on any deal to save it here for quick access.
                        </Text>
                        <TouchableOpacity
                            onPress={() => router.push('/(tabs)/explore')}
                            className="mt-6 h-12 px-6 items-center justify-center rounded-lg bg-primary active:scale-95"
                            accessibilityRole="button"
                            accessibilityLabel="Explore deals"
                        >
                            <Text className="text-background-dark text-base font-bold">Explore Deals</Text>
                        </TouchableOpacity>
                    </View>
                    )
                }
            />
        </SafeAreaView>
    );
}
