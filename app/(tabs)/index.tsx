import React, { useState, useCallback, memo, useEffect, useRef } from 'react';
import { View, Text, FlatList, RefreshControl, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Icon } from '../../components/Icon';
import { HighlightCard } from '../../components/DealCard';
import { ErrorState } from '../../components/ui/ErrorState';
import { useDeals } from '../../context/DealsContext';
import { getHighlightDeals } from '../../services/dealService';
import { Deal } from '../../types';
import { useVisits } from '../../context/VisitsContext';
import { useLocation } from '../../context/LocationContext';
import { useLocationScope } from '../../hooks/useLocationScope';
import { Logger } from '../../services/logger';

// Container component to isolate context updates to individual list items
const HighlightCardContainer = memo(({ deal, onSelectDeal }: { deal: Deal, onSelectDeal: (id: string) => void }) => {
    const { isSaved, toggleSave } = useDeals();
    const { hasVisited } = useVisits();
    const isDealSaved = isSaved(deal.id);

    return (
        <HighlightCard
            deal={deal}
            onSelectDeal={onSelectDeal}
            onToggleSave={toggleSave}
            isSaved={isDealSaved}
            isVisited={hasVisited(deal.venueId)}
        />
    );
});
HighlightCardContainer.displayName = 'HighlightCardContainer';

export default function HomeScreen() {
    const router = useRouter();
    const { sortByDistance } = useLocation();
    const { scope } = useLocationScope();
    const [refreshing, setRefreshing] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [hasError, setHasError] = useState(false);
    const [highlights, setHighlights] = useState<Deal[]>([]);
    const isMountedRef = useRef(true);

    const fetchHighlights = useCallback(async () => {
        // Wait for the scope: fetching before it resolves would briefly show
        // highlights from whichever cities happen to have data.
        if (!scope) return;

        setIsLoading(true);
        try {
            const data = await getHighlightDeals(scope);
            if (isMountedRef.current) {
                setHighlights(sortByDistance(data));
                setHasError(false);
            }
        } catch (error) {
            Logger.error('Failed to fetch highlight deals', error);
            if (isMountedRef.current) {
                setHighlights([]);
                setHasError(true);
            }
        } finally {
            if (isMountedRef.current) {
                setIsLoading(false);
            }
        }
    }, [sortByDistance, scope]);

    useEffect(() => {
        fetchHighlights();
    }, [fetchHighlights]);

    useEffect(() => () => {
        isMountedRef.current = false;
    }, []);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await fetchHighlights();
        } finally {
            if (isMountedRef.current) {
                setRefreshing(false);
            }
        }
    }, [fetchHighlights]);

    const handleSelectDeal = useCallback((id: string) => {
        router.push(`/deal/${id}`);
    }, [router]);

    const renderItem = useCallback(({ item }: { item: Deal }) => (
        <HighlightCardContainer
            deal={item}
            onSelectDeal={handleSelectDeal}
        />
    ), [handleSelectDeal]);

    return (
        <SafeAreaView className="flex-1 bg-background-light dark:bg-background-dark" edges={['top']}>
            <FlatList
                data={highlights}
                keyExtractor={(item) => item.id.toString()}
                contentContainerStyle={{ padding: 16, gap: 16 }}
                refreshControl={
                    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FFC107" colors={['#FFC107']} />
                }
                ListHeaderComponent={
                    <View className="flex-row items-center gap-3 pb-2">
                        <Icon name="local-fire-department" size={28} color="#FFC107" />
                        <Text className="text-2xl font-bold tracking-tight text-text-light dark:text-text-dark">Daily Highlights</Text>
                    </View>
                }
                renderItem={renderItem}
                ListEmptyComponent={
                    isLoading ? (
                        <View className="flex-1 items-center justify-center py-20">
                            <ActivityIndicator size="large" color="#FFC107" />
                            <Text className="mt-4 text-sm text-slate-400">Loading highlights…</Text>
                        </View>
                    ) : hasError ? (
                        <ErrorState
                            title="Couldn't load highlights"
                            message="Something went wrong fetching today's deals. Check your connection and try again."
                            onRetry={fetchHighlights}
                        />
                    ) : (
                        <View className="flex-1 items-center justify-center py-20">
                            <Text className="text-base text-slate-500">No highlights today</Text>
                        </View>
                    )
                }
            />
            {/* Submit Deal FAB */}
            <TouchableOpacity 
                onPress={() => router.push('/submit-deal')}
                className="absolute bottom-6 right-6 h-14 w-14 rounded-full bg-primary items-center justify-center shadow-lg active:scale-95 z-50 elevation-5"
                accessibilityLabel="Submit a new deal"
                accessibilityRole="button"
            >
                <Icon name="add" size={32} color="#1E293B" />
            </TouchableOpacity>
        </SafeAreaView>
    );
}
