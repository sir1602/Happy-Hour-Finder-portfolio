import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Modal } from 'react-native';
import { Chip } from '../ui/Chip';
import { Icon } from '../Icon';
import { Colors } from '../../constants/colors';
import { INPUT_CLASSNAME } from './FormField';
import { formatTimeLabel, normalizeTimeWindow } from '../../utils/dealTime';
import { START_SLOTS, endSlotsFor, TIME_PRESETS, type TimePreset, timeWindowForPreset } from '../../constants/submitPresets';

interface TimeRangePickerProps {
    timeWindow: string;
    /** Where the pickers currently sit, derived from `timeWindow`. */
    range: { startMinutes: number; endMinutes: number | null } | null;
    /** A null end means the deal runs until close, so it gets no countdown. */
    onSelectRange: (startMinutes: number, endMinutes: number | null) => void;
    onSelectPreset: (preset: TimePreset) => void;
    onChangeText: (text: string) => void;
    onBlurText: () => void;
    error?: string;
}

const DEFAULT_START = 16 * 60; // 4 PM

/**
 * Start and End selectors, with the common windows as one-tap chips and free
 * text kept as a fallback.
 *
 * The pickers exist because the field they replace was the form's biggest
 * source of rejected submissions: it took free text and matched it against a
 * strict "4 PM - 6 PM" regex, so "15:00-18:00" and "3-6pm" both failed. A slot
 * cannot be typed wrong. The End list runs past midnight so a late-night happy
 * hour is still expressible.
 */
export const TimeRangePicker = ({
    timeWindow, range, onSelectRange, onSelectPreset, onChangeText, onBlurText, error,
}: TimeRangePickerProps) => {
    const [editing, setEditing] = useState<'start' | 'end' | null>(null);
    const [showFreeText, setShowFreeText] = useState(false);

    const startMinutes = range?.startMinutes ?? null;
    const endMinutes = range?.endMinutes ?? null;
    // A range that parsed but has no end is "until close" -- distinct from
    // nothing having been picked yet.
    const isOpenEnded = range !== null && range.endMinutes === null;
    const preview = normalizeTimeWindow(timeWindow);

    const pick = (minutes: number | null) => {
        if (editing === 'start') {
            if (minutes === null) return;
            // An open end stays open when the start moves. Otherwise keep the
            // window as long as it was: the end list is relative to the start,
            // so a later start can invalidate the old end.
            if (isOpenEnded) {
                onSelectRange(minutes, null);
            } else {
                const currentLength =
                    startMinutes !== null && endMinutes !== null ? endMinutes - startMinutes : 120;
                onSelectRange(minutes, minutes + currentLength);
            }
        } else if (editing === 'end') {
            onSelectRange(startMinutes ?? DEFAULT_START, minutes);
        }
        setEditing(null);
    };

    const slots = editing === 'start' ? START_SLOTS : endSlotsFor(startMinutes ?? DEFAULT_START);

    return (
        <View>
            <Text className="text-slate-600 dark:text-slate-400 text-sm mb-2">Time</Text>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-3">
                <View className="flex-row gap-2 pr-2">
                    {TIME_PRESETS.map(preset => (
                        <Chip
                            key={preset.label}
                            label={preset.label}
                            isSelected={timeWindow === timeWindowForPreset(preset)}
                            onPress={() => onSelectPreset(preset)}
                        />
                    ))}
                </View>
            </ScrollView>

            <View className="flex-row items-center gap-2">
                {(['start', 'end'] as const).map(which => {
                    const minutes = which === 'start' ? startMinutes : endMinutes;
                    const isSet = minutes !== null || (which === 'end' && isOpenEnded);
                    const label = minutes !== null
                        ? formatTimeLabel(minutes)
                        : which === 'end' && isOpenEnded
                            ? 'Close'
                            : which === 'start' ? 'Start' : 'End';
                    return (
                        <React.Fragment key={which}>
                            {which === 'end' ? (
                                <Text className="text-slate-400 dark:text-slate-500">to</Text>
                            ) : null}
                            <TouchableOpacity
                                onPress={() => setEditing(which)}
                                className={`flex-1 flex-row items-center justify-between rounded-xl border px-3 py-3 bg-white dark:bg-slate-900 ${
                                    error ? 'border-red-500' : 'border-slate-300 dark:border-slate-700'
                                }`}
                                accessibilityRole="button"
                                accessibilityLabel={`${which === 'start' ? 'Start' : 'End'} time${
                                    isSet ? `, ${label}` : ', not set'
                                }`}
                            >
                                <Text className={isSet ? 'text-slate-900 dark:text-white font-semibold' : 'text-slate-400'}>
                                    {label}
                                </Text>
                                <Icon name="expand-more" size={18} color={Colors.iconMuted} />
                            </TouchableOpacity>
                        </React.Fragment>
                    );
                })}
            </View>

            {error ? (
                <Text className="text-red-500 text-xs mt-1 px-1" accessibilityLiveRegion="polite">{error}</Text>
            ) : null}

            {showFreeText ? (
                <View className="mt-3">
                    <TextInput
                        className={`${INPUT_CLASSNAME} border-slate-300 dark:border-slate-700`}
                        placeholder='e.g. 3-6pm, 15:00-18:00'
                        placeholderTextColor={Colors.iconMuted}
                        value={timeWindow}
                        onChangeText={onChangeText}
                        onBlur={onBlurText}
                        maxLength={100}
                        accessibilityLabel="Type a time window"
                    />
                    {/* Show what will actually be saved: the reading of a bare
                        "3-6" as PM is a good guess, not a certainty. */}
                    {preview && preview !== timeWindow ? (
                        <Text className="text-xs text-slate-500 dark:text-slate-400 mt-1 px-1">
                            ✓ Saves as {preview}
                        </Text>
                    ) : null}
                </View>
            ) : (
                <TouchableOpacity
                    onPress={() => setShowFreeText(true)}
                    className="mt-2 self-start"
                    accessibilityRole="button"
                    accessibilityLabel="Type a time instead"
                >
                    <Text className="text-xs font-semibold text-primary underline">Type it instead</Text>
                </TouchableOpacity>
            )}

            <Modal visible={editing !== null} transparent animationType="slide" onRequestClose={() => setEditing(null)}>
                <TouchableOpacity
                    className="flex-1 bg-black/40 justify-end"
                    activeOpacity={1}
                    onPress={() => setEditing(null)}
                    accessibilityRole="button"
                    accessibilityLabel="Close time picker"
                >
                    <View className="bg-white dark:bg-slate-900 rounded-t-3xl max-h-96 p-4">
                        <Text className="text-base font-bold text-slate-900 dark:text-white mb-3">
                            {editing === 'start' ? 'Starts at' : 'Ends at'}
                        </Text>
                        <ScrollView>
                            {slots.map(slot => {
                                const isSelected = slot.minutes === null
                                    ? editing === 'end' && isOpenEnded
                                    : (editing === 'start' ? startMinutes : endMinutes) === slot.minutes;
                                return (
                                    <TouchableOpacity
                                        key={slot.label}
                                        onPress={() => pick(slot.minutes)}
                                        className={`py-3 px-3 rounded-xl ${isSelected ? 'bg-primary/20' : 'active:bg-slate-100 dark:active:bg-slate-800'}`}
                                        accessibilityRole="radio"
                                        accessibilityState={{ selected: isSelected }}
                                        accessibilityLabel={slot.label}
                                    >
                                        <Text className={`text-base ${isSelected ? 'font-bold text-primary' : 'text-slate-700 dark:text-slate-300'}`}>
                                            {slot.label}
                                            {slot.minutes !== null && slot.minutes >= 24 * 60 ? '  (next day)' : ''}
                                        </Text>
                                        {slot.minutes === null ? (
                                            <Text className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                                No countdown on the deal card
                                            </Text>
                                        ) : null}
                                    </TouchableOpacity>
                                );
                            })}
                        </ScrollView>
                    </View>
                </TouchableOpacity>
            </Modal>
        </View>
    );
};
