import React, { useCallback } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, ScrollView, RefreshControl, ActivityIndicator, Modal, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '../../components/Icon';
import { ExploreCard } from '../../components/DealCard';
import { Chip } from '../../components/ui/Chip';
import { SkeletonList } from '../../components/SkeletonCard';
import { Deal } from '../../types';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { useVisits } from '../../context/VisitsContext';
import { useDeals } from '../../context/DealsContext';
import { useExploreScreen } from '../../hooks/useExploreScreen';
import { Colors } from '../../constants/colors';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Container component so a save toggle re-renders only the affected row rather
// than every card in the list (mirrors HighlightCardContainer on Home).
const ExploreCardContainer = React.memo(({ deal, onSelectDeal, isVisited }: { deal: Deal; onSelectDeal: (id: string) => void; isVisited?: boolean }) => {
    const { isSaved, toggleSave } = useDeals();

    return (
        <ExploreCard
            deal={deal}
            onSelectDeal={onSelectDeal}
            onToggleSave={toggleSave}
            isSaved={isSaved(deal.id)}
            isVisited={isVisited}
        />
    );
});
ExploreCardContainer.displayName = 'ExploreCardContainer';

export default function ExploreScreen() {
    const { hasVisited } = useVisits();
    const explore = useExploreScreen();

    const renderItem = useCallback(({ item }: { item: Deal }) => (
        <ExploreCardContainer deal={item} onSelectDeal={explore.handleSelectDeal} isVisited={hasVisited(item.venueId)} />
    ), [explore.handleSelectDeal, hasVisited]);

    return (
        <SafeAreaView className="flex-1 bg-background-light dark:bg-background-dark" edges={['top']}>
            <View className="px-4 pt-4 pb-2">
                <Text className="text-2xl font-bold text-text-light dark:text-text-dark">Explore</Text>
            </View>

            {/* Search Bar */}
            <View className="px-4 pb-2">
                <View className="flex-row items-center h-12 rounded-xl bg-slate-100 dark:bg-slate-800 px-4">
                    <Icon name="search" size={20} color={Colors.iconMuted} />
                    <TextInput
                        className="flex-1 ml-3 text-base text-slate-900 dark:text-white"
                        placeholder="Search deals, restaurants, neighborhoods..."
                        placeholderTextColor={Colors.iconMuted}
                        value={explore.query}
                        onChangeText={explore.setQuery}
                        returnKeyType="search"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    {explore.query.length > 0 && (
                        <TouchableOpacity
                            onPress={() => explore.setQuery('')}
                            className="p-2 -mr-2"
                            accessibilityRole="button"
                            accessibilityLabel="Clear search query"
                        >
                            <Icon name="close" size={20} color={Colors.iconMuted} />
                        </TouchableOpacity>
                    )}
                </View>
            </View>

            {/* Day-of-Week Filter */}
            <View className="h-12">
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ paddingHorizontal: 16, gap: 8, alignItems: 'center' }}
                >
                    {DAY_LABELS.map((label, index) => {
                        const isSelected = explore.selectedDay === index;
                        const isToday = index === explore.TODAY;
                        return (
                            <TouchableOpacity
                                key={label}
                                onPress={() => explore.handleToggleDay(index)}
                                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                                className={`h-8 min-w-[44px] items-center justify-center rounded-full px-3 ${
                                    isSelected
                                        ? 'bg-amber-400'
                                        : 'bg-slate-100 dark:bg-slate-800'
                                }`}
                                accessibilityRole="button"
                                accessibilityLabel={`Filter by ${label}${isToday ? ' (today)' : ''}`}
                                accessibilityState={{ selected: isSelected }}
                            >
                                <Text className={`text-xs font-bold ${
                                    isSelected
                                        ? 'text-slate-900'
                                        : isToday
                                            ? 'text-amber-500 dark:text-amber-400'
                                            : 'text-slate-600 dark:text-slate-300'
                                }`}>
                                    {label}
                                    {isToday ? ' •' : ''}
                                </Text>
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>
            </View>

            {/* Tag Filter Chips + Location Dropdown Button */}
            <View className="min-h-[48px]">
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ paddingHorizontal: 16, gap: 8, alignItems: 'center', paddingVertical: 6 }}
                >
                    {/* Location Dropdown Button */}
                    <TouchableOpacity
                        onPress={() => explore.setLocationDropdownOpen(true)}
                        hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                        className={`h-8 flex-row items-center rounded-full px-3 gap-1.5 ${
                            explore.selectedNeighborhoods.size > 0
                                ? 'bg-primary'
                                : 'bg-slate-100 dark:bg-slate-800'
                        }`}
                        accessibilityRole="button"
                        accessibilityLabel="Open location filter"
                    >
                        <Icon
                            name="location-on"
                            size={14}
                            color={explore.selectedNeighborhoods.size > 0 ? Colors.onPrimary : Colors.iconMuted}
                        />
                        <Text className={`text-xs font-medium ${
                            explore.selectedNeighborhoods.size > 0
                                ? 'text-charcoal font-bold'
                                : 'text-slate-600 dark:text-slate-300'
                        }`}>
                            {explore.locationButtonLabel}
                        </Text>
                        <Icon
                            name="expand-more"
                            size={14}
                            color={explore.selectedNeighborhoods.size > 0 ? Colors.onPrimary : Colors.iconMuted}
                        />
                    </TouchableOpacity>

                    {/* Clear all chips button (when any tag is selected) */}
                    {explore.selectedTags.size > 0 && (
                        <TouchableOpacity
                            onPress={explore.handleClearTags}
                            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                            className="h-8 flex-row items-center rounded-full bg-red-100 dark:bg-red-900/30 px-3 gap-1"
                            accessibilityRole="button"
                            accessibilityLabel="Clear tag filters"
                        >
                            <Icon name="close" size={14} color={Colors.danger} />
                            <Text className="text-xs font-medium text-red-600 dark:text-red-400">Clear</Text>
                        </TouchableOpacity>
                    )}

                    {/* Tag Filter Chips (multi-select) */}
                    {explore.allTags.map(tag => (
                        <Chip
                            key={tag}
                            label={tag}
                            isSelected={explore.selectedTags.has(tag)}
                            onPress={() => explore.handleToggleTag(tag)}
                        />
                    ))}
                </ScrollView>
            </View>

            {/* Location Dropdown Modal */}
            <Modal
                visible={explore.locationDropdownOpen}
                transparent
                animationType="fade"
                onRequestClose={() => explore.setLocationDropdownOpen(false)}
            >
                <Pressable
                    className="flex-1 bg-black/40"
                    onPress={() => explore.setLocationDropdownOpen(false)}
                >
                    <View className="flex-1 justify-end">
                        <Pressable onPress={() => { /* prevent dismiss */ }}>
                            <View className="bg-white dark:bg-slate-900 rounded-t-3xl px-5 pt-5 pb-8 max-h-[60%]">
                                {/* Header */}
                                <View className="flex-row items-center justify-between mb-4">
                                    <Text className="text-lg font-bold text-slate-900 dark:text-white">
                                        Filter by Location
                                    </Text>
                                    <View className="flex-row items-center gap-3">
                                        {explore.selectedNeighborhoods.size > 0 && (
                                            <TouchableOpacity
                                                onPress={explore.handleClearNeighborhoods}
                                                accessibilityRole="button"
                                                accessibilityLabel="Clear location filters"
                                            >
                                                <Text className="text-sm font-medium text-red-500">Clear All</Text>
                                            </TouchableOpacity>
                                        )}
                                        <TouchableOpacity
                                            onPress={() => explore.setLocationDropdownOpen(false)}
                                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                            className="w-8 h-8 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800"
                                            accessibilityRole="button"
                                            accessibilityLabel="Close location filter"
                                        >
                                            <Icon name="close" size={18} color={Colors.iconMuted} />
                                        </TouchableOpacity>
                                    </View>
                                </View>

                                {/* Neighborhood List */}
                                <ScrollView showsVerticalScrollIndicator={false}>
                                    {explore.allNeighborhoods.map(neighborhood => {
                                        const isChecked = explore.selectedNeighborhoods.has(neighborhood);
                                        return (
                                            <TouchableOpacity
                                                key={neighborhood}
                                                onPress={() => explore.handleToggleNeighborhood(neighborhood)}
                                                className="flex-row items-center py-3 px-1"
                                                accessibilityRole="checkbox"
                                                accessibilityState={{ checked: isChecked }}
                                                accessibilityLabel={neighborhood}
                                            >
                                                {/* Checkbox */}
                                                <View className={`w-5 h-5 rounded mr-3 items-center justify-center border ${
                                                    isChecked
                                                        ? 'bg-amber-400 border-amber-400'
                                                        : 'border-slate-300 dark:border-slate-600'
                                                }`}>
                                                    {isChecked && (
                                                        <Icon name="check" size={14} color={Colors.onPrimary} />
                                                    )}
                                                </View>
                                                <Text className={`text-base ${
                                                    isChecked
                                                        ? 'text-slate-900 dark:text-white font-semibold'
                                                        : 'text-slate-700 dark:text-slate-300'
                                                }`}>
                                                    {neighborhood}
                                                </Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                    {explore.allNeighborhoods.length === 0 && (
                                        <Text className="text-sm text-slate-400 text-center py-8">
                                            No locations available
                                        </Text>
                                    )}
                                </ScrollView>

                                {/* Done Button */}
                                <TouchableOpacity
                                    onPress={() => explore.setLocationDropdownOpen(false)}
                                    className="mt-4 h-12 items-center justify-center rounded-xl bg-amber-400 active:bg-amber-500"
                                    accessibilityRole="button"
                                    accessibilityLabel="Apply location filters"
                                >
                                    <Text className="text-base font-bold text-slate-900">
                                        {explore.selectedNeighborhoods.size > 0
                                            ? `Show Results (${explore.selectedNeighborhoods.size} selected)`
                                            : 'Done'}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </Pressable>
                    </View>
                </Pressable>
            </Modal>

            {/* Results */}
            <FlatList
                data={explore.deals}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ padding: 16, gap: 16 }}
                initialNumToRender={8}
                maxToRenderPerBatch={6}
                windowSize={5}
                refreshControl={
                    <RefreshControl refreshing={explore.refreshing} onRefresh={explore.onRefresh} tintColor={Colors.primary} colors={[Colors.primary]} />
                }
                renderItem={renderItem}
                onEndReached={explore.onEndReached}
                onEndReachedThreshold={0.3}
                ListFooterComponent={
                    explore.isLoadingMore ? (
                        <View className="items-center py-4">
                            <ActivityIndicator size="small" color={Colors.primary} />
                        </View>
                    ) : null
                }
                ListEmptyComponent={
                    explore.isLoading ? (
                        <View className="pt-4 gap-4">
                            <SkeletonList count={4} />
                        </View>
                    ) : explore.fetchError ? (
                        <ErrorState
                            title="Failed to load happy hour deals"
                            message={explore.fetchError}
                            onRetry={() => explore.fetchDeals()}
                            className="py-16"
                        />
                    ) : (
                        <EmptyState
                            title="No deals found"
                            message="Try adjusting your search query, neighborhood, or day filters."
                            iconName="search-off"
                            actionLabel={explore.hasActiveFilters ? "Clear All Filters" : undefined}
                            onAction={explore.hasActiveFilters ? explore.handleClearAllFilters : undefined}
                            className="py-16"
                        />
                    )
                }
            />
        </SafeAreaView>
    );
}
