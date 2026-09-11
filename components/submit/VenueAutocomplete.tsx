import React from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Icon } from '../Icon';
import { Colors } from '../../constants/colors';
import { VenueSearchResult } from '../../services/dealService';
import { INPUT_CLASSNAME } from './FormField';

interface VenueAutocompleteProps {
    value: string;
    onChangeText: (text: string) => void;
    results: VenueSearchResult[];
    isSearching: boolean;
    /** Set once a suggestion has been taken, which collapses the address fields. */
    resolvedVenueId?: string;
    onSelect: (venue: VenueSearchResult) => void;
    onUseTypedName: () => void;
    onClearVenue: () => void;
    error?: string;
    onRegisterOffset?: (y: number) => void;
    onSubmitEditing?: () => void;
}

const formatDistance = (km: number | null): string | null => {
    if (km === null) return null;
    const miles = km * 0.621371;
    return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
};

/**
 * Venue name entry that offers venues we already have.
 *
 * Picking one fills the address and neighborhood too, which is the difference
 * between three typed fields and a single tap. The list is a plain mapped View
 * rather than a FlatList on purpose: a VirtualizedList nested in the form's
 * ScrollView warns and breaks scrolling, and there are never more than eight
 * rows to draw.
 */
export const VenueAutocomplete = ({
    value, onChangeText, results, isSearching, resolvedVenueId,
    onSelect, onUseTypedName, onClearVenue, error, onRegisterOffset, onSubmitEditing,
}: VenueAutocompleteProps) => {
    const showList = !resolvedVenueId && (results.length > 0 || (value.trim().length >= 2 && !isSearching));

    return (
        <View
            onLayout={onRegisterOffset ? (e) => onRegisterOffset(e.nativeEvent.layout.y) : undefined}
            className="mb-4"
        >
            <Text className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Venue Name *</Text>

            <View className="relative">
                <TextInput
                    className={`${INPUT_CLASSNAME} ${
                        error ? 'border-red-500' : 'border-slate-300 dark:border-slate-700'
                    } ${resolvedVenueId ? 'pr-12' : ''}`}
                    placeholder="Start typing — we'll find it"
                    placeholderTextColor={Colors.iconMuted}
                    value={value}
                    onChangeText={onChangeText}
                    returnKeyType="next"
                    onSubmitEditing={onSubmitEditing}
                    maxLength={100}
                    autoCorrect={false}
                    accessibilityLabel="Venue name"
                />
                {resolvedVenueId ? (
                    <View className="absolute right-3 top-0 bottom-0 justify-center">
                        <Icon name="check-circle" size={22} color={Colors.success} />
                    </View>
                ) : null}
                {isSearching ? (
                    <View className="absolute right-3 top-0 bottom-0 justify-center">
                        <ActivityIndicator size="small" color={Colors.iconMuted} />
                    </View>
                ) : null}
            </View>

            {error ? (
                <Text className="text-red-500 text-xs mt-1 px-1" accessibilityLiveRegion="polite">{error}</Text>
            ) : null}

            {showList ? (
                <View className="mt-2 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                    {results.map((venue, index) => {
                        const distance = formatDistance(venue.distanceKm);
                        return (
                            <TouchableOpacity
                                key={venue.id}
                                onPress={() => onSelect(venue)}
                                className={`p-3 bg-white dark:bg-slate-900 active:bg-slate-100 dark:active:bg-slate-800 ${
                                    index > 0 ? 'border-t border-slate-200 dark:border-slate-700' : ''
                                }`}
                                accessibilityRole="button"
                                accessibilityLabel={`${venue.name}, ${venue.address}${distance ? `, ${distance} away` : ''}`}
                            >
                                <Text className="font-bold text-slate-900 dark:text-white" numberOfLines={1}>
                                    {venue.name}
                                </Text>
                                <Text className="text-xs text-slate-500 dark:text-slate-400 mt-0.5" numberOfLines={1}>
                                    {[venue.address, venue.neighborhood, distance].filter(Boolean).join(' · ')}
                                </Text>
                            </TouchableOpacity>
                        );
                    })}

                    {/* Creating a new venue should be a deliberate tap, not the
                        thing that happens when you ignore the list. */}
                    <TouchableOpacity
                        onPress={onUseTypedName}
                        className={`p-3 bg-slate-50 dark:bg-slate-800/60 active:bg-slate-100 dark:active:bg-slate-800 ${
                            results.length > 0 ? 'border-t border-slate-200 dark:border-slate-700' : ''
                        }`}
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${value.trim()} as a new venue`}
                    >
                        <View className="flex-row items-center gap-2">
                            <Icon name="add-location-alt" size={18} color={Colors.primary} />
                            <Text className="text-sm font-semibold text-slate-700 dark:text-slate-300" numberOfLines={1}>
                                Use &ldquo;{value.trim()}&rdquo; — it&apos;s new
                            </Text>
                        </View>
                    </TouchableOpacity>
                </View>
            ) : null}

            {resolvedVenueId ? (
                <TouchableOpacity
                    onPress={onClearVenue}
                    className="mt-2 self-start"
                    accessibilityRole="button"
                    accessibilityLabel="Choose a different venue"
                >
                    <Text className="text-xs font-semibold text-primary underline">Not this one?</Text>
                </TouchableOpacity>
            ) : null}
        </View>
    );
};
