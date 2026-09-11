import React, { useEffect, useCallback } from 'react';
import { View, Text, FlatList, Image, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Icon } from '../../components/Icon';
import { useAuth } from '../../context/AuthContext';
import { useVisits } from '../../context/VisitsContext';
import { Visit } from '../../services/visitService';

function formatRelativeDate(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: diffDays > 365 ? 'numeric' : undefined });
}

// ⚡ Bolt: Memoized VisitRow to prevent unnecessary re-renders of the entire list.
// Expected Impact: O(1) rendering time per item update instead of O(N).
const VisitRow = React.memo(({ item, onPress }: { item: Visit; onPress: (visit: Visit) => void }) => (
    <TouchableOpacity
        onPress={() => onPress(item)}
        className="flex-row items-center gap-3 bg-white dark:bg-slate-800 rounded-xl p-3 mb-3 shadow-sm active:scale-95"
    >
        {item.venues?.image_url ? (
            <Image
                source={{ uri: item.venues.image_url }}
                className="w-16 h-16 rounded-lg"
            />
        ) : (
            <View className="w-16 h-16 rounded-lg bg-slate-200 dark:bg-slate-700 items-center justify-center">
                <Icon name="restaurant" size={28} color="#9CA3AF" />
            </View>
        )}
        <View className="flex-1">
            <Text className="text-base font-bold text-slate-900 dark:text-white" numberOfLines={1}>
                {item.venues?.name ?? 'Unknown Venue'}
            </Text>
            {item.venues?.neighborhood && (
                <Text className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {item.venues.neighborhood}
                </Text>
            )}
            {item.deals?.title && (
                <Text className="text-sm text-primary font-medium mt-1" numberOfLines={1}>
                    {item.deals.title}
                </Text>
            )}
        </View>
        <View className="items-end">
            <Text className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                {formatRelativeDate(item.visited_at)}
            </Text>
            <View className="mt-1 flex-row items-center gap-1 bg-green-600/15 rounded-full px-2 py-0.5">
                <Icon name="check-circle" size={10} color="#16A34A" />
                <Text className="text-xs text-green-700 dark:text-green-400 font-medium">Visited</Text>
            </View>
        </View>
    </TouchableOpacity>
));
VisitRow.displayName = 'VisitRow';

export default function VisitsScreen() {
    const router = useRouter();
    const { user } = useAuth();
    const { visits, refreshVisits } = useVisits();
    const [refreshing, setRefreshing] = React.useState(false);
    const [initialLoading, setInitialLoading] = React.useState(true);

    const loadVisits = useCallback(async () => {
        try {
            await refreshVisits();
        } finally {
            setInitialLoading(false);
        }
    }, [refreshVisits]);

    useEffect(() => {
        loadVisits();
    }, [loadVisits]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await refreshVisits();
        } finally {
            setRefreshing(false);
        }
    }, [refreshVisits]);

    // ⚡ Bolt: Memoized handler and renderItem to maintain stable references,
    // avoiding re-renders of all VisitRow components when VisitsScreen state changes.
    const handleVisitPress = useCallback((visit: Visit) => {
        if (visit.deal_id) {
            router.push(`/deal/${visit.deal_id}`);
        }
    }, [router]);

    const renderItem = useCallback(({ item }: { item: Visit }) => (
        <VisitRow item={item} onPress={handleVisitPress} />
    ), [handleVisitPress]);

    if (initialLoading) {
        return (
            <SafeAreaView className="flex-1 items-center justify-center bg-background-light dark:bg-background-dark" edges={['top']}>
                <ActivityIndicator size="large" color="#FFC107" />
            </SafeAreaView>
        );
    }

    const GuestEmptyState = () => (
        <View className="items-center justify-center py-20 px-8">
            <Icon name="login" size={64} color="#D1D5DB" />
            <Text className="mt-4 text-lg font-semibold text-slate-500 dark:text-slate-400">Log in to track visits</Text>
            <Text className="mt-2 text-sm text-slate-400 dark:text-slate-500 text-center">
                Create an account to keep a history of all the happy hours you've explored.
            </Text>
            <TouchableOpacity
                onPress={() => router.push('/login')}
                className="mt-6 h-12 px-6 items-center justify-center rounded-lg bg-primary active:scale-95"
            >
                <Text className="text-background-dark text-base font-bold">Log In / Sign Up</Text>
            </TouchableOpacity>
        </View>
    );

    const EmptyState = () => (
        <View className="items-center justify-center py-20 px-8">
            <Icon name="place" size={64} color="#D1D5DB" />
            <Text className="mt-4 text-lg font-semibold text-slate-500 dark:text-slate-400">No visits yet</Text>
            <Text className="mt-2 text-sm text-slate-400 dark:text-slate-500 text-center">
                Check in at a happy hour to start tracking your adventures!
            </Text>
            <TouchableOpacity
                onPress={() => router.push('/(tabs)')}
                className="mt-6 h-12 px-6 items-center justify-center rounded-lg bg-primary active:scale-95"
            >
                <Text className="text-background-dark text-base font-bold">Find Happy Hours</Text>
            </TouchableOpacity>
        </View>
    );

    return (
        <SafeAreaView className="flex-1 bg-background-light dark:bg-background-dark" edges={['top']}>
            <FlatList
                data={visits}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
                refreshControl={
                    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FFC107" colors={['#FFC107']} />
                }
                ListHeaderComponent={
                    <View className="flex-row items-center gap-3 pb-4">
                        <Icon name="place" size={28} color="#FFC107" />
                        <View>
                            <Text className="text-2xl font-bold tracking-tight text-text-light dark:text-text-dark">
                                My Visits
                            </Text>
                            {visits.length > 0 && (
                                <Text className="text-xs text-slate-500 dark:text-slate-400">
                                    {visits.length} check-in{visits.length === 1 ? '' : 's'} total
                                </Text>
                            )}
                        </View>
                    </View>
                }
                renderItem={renderItem}
                ListEmptyComponent={!user ? <GuestEmptyState /> : <EmptyState />}
            />
        </SafeAreaView>
    );
}
