import React from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, LayoutChangeEvent } from 'react-native';
import { Icon } from '../Icon';
import { Chip } from '../ui/Chip';
import { Colors } from '../../constants/colors';
import { INPUT_CLASSNAME } from './FormField';
import { TimeRangePicker } from './TimeRangePicker';
import { DAY_LABELS, DAY_PRESETS, DEAL_SNIPPETS, daysMatchPreset, type DayPreset, type TimePreset } from '../../constants/submitPresets';
import type { DealSchedule, ScheduleErrors } from '../../hooks/useSubmitDealForm';

interface ScheduleCardProps {
    index: number;
    schedule: DealSchedule;
    total: number;
    errors?: ScheduleErrors;
    range: { startMinutes: number; endMinutes: number | null } | null;
    onRemove: () => void;
    onToggleDay: (dayIdx: number) => void;
    onApplyDayPreset: (preset: DayPreset) => void;
    onApplyTimePreset: (preset: TimePreset) => void;
    onSelectRange: (startMinutes: number, endMinutes: number | null) => void;
    onChangeTimeText: (text: string) => void;
    onBlurTimeText: () => void;
    onChangeDealTitle: (text: string) => void;
    onAppendSnippet: (snippet: string) => void;
    onRegisterOffset?: (y: number) => void;
}

/** One "on these days, at these times, this deal" block. */
export const ScheduleCard = ({
    index, schedule, total, errors, range, onRemove, onToggleDay, onApplyDayPreset,
    onApplyTimePreset, onSelectRange, onChangeTimeText, onBlurTimeText,
    onChangeDealTitle, onAppendSnippet, onRegisterOffset,
}: ScheduleCardProps) => {
    const handleLayout = (e: LayoutChangeEvent) => onRegisterOffset?.(e.nativeEvent.layout.y);

    return (
        <View
            onLayout={onRegisterOffset ? handleLayout : undefined}
            className="bg-slate-50 dark:bg-slate-800 p-4 rounded-xl mb-4 border border-slate-200 dark:border-slate-700"
        >
            {total > 1 ? (
                <View className="flex-row justify-between items-center mb-2">
                    <Text className="text-slate-700 dark:text-slate-300 font-semibold">Schedule {index + 1}</Text>
                    <TouchableOpacity
                        onPress={onRemove}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove schedule ${index + 1}`}
                    >
                        <Icon name="close" size={20} color={Colors.danger} />
                    </TouchableOpacity>
                </View>
            ) : null}

            <Text className="text-slate-600 dark:text-slate-400 text-sm mb-2">Days</Text>

            {/* One tap for the four combinations that cover most happy hours,
                instead of up to seven on the pills below. */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2">
                <View className="flex-row gap-2 pr-2">
                    {DAY_PRESETS.map(preset => (
                        <Chip
                            key={preset.label}
                            label={preset.label}
                            isSelected={daysMatchPreset(schedule.days, preset)}
                            onPress={() => onApplyDayPreset(preset)}
                        />
                    ))}
                </View>
            </ScrollView>

            <View className="flex-row flex-wrap mb-1 gap-2">
                {DAY_LABELS.map((day, dIdx) => {
                    const isSelected = schedule.days.includes(dIdx);
                    return (
                        <TouchableOpacity
                            key={dIdx}
                            onPress={() => onToggleDay(dIdx)}
                            className={`px-3 py-1 rounded-full border ${
                                isSelected
                                    ? 'bg-primary border-primary'
                                    : 'bg-white dark:bg-slate-700 border-slate-300 dark:border-slate-600'
                            }`}
                            accessibilityRole="checkbox"
                            accessibilityLabel={day}
                            accessibilityState={{ checked: isSelected }}
                        >
                            <Text className={`text-sm font-semibold ${isSelected ? 'text-slate-900' : 'text-slate-600 dark:text-slate-400'}`}>
                                {day}
                            </Text>
                        </TouchableOpacity>
                    );
                })}
            </View>
            {errors?.days ? (
                <Text className="text-red-500 text-xs mt-1 px-1" accessibilityLiveRegion="polite">{errors.days}</Text>
            ) : null}

            <View className="mt-3">
                <TimeRangePicker
                    timeWindow={schedule.timeWindow}
                    range={range}
                    onSelectRange={onSelectRange}
                    onSelectPreset={onApplyTimePreset}
                    onChangeText={onChangeTimeText}
                    onBlurText={onBlurTimeText}
                    error={errors?.timeWindow}
                />
            </View>

            <Text className="text-slate-600 dark:text-slate-400 text-sm mb-2 mt-4">The deal</Text>

            {/* The longest thing to type on the form, so it gets starters. */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2">
                <View className="flex-row gap-2 pr-2">
                    {DEAL_SNIPPETS.map(snippet => (
                        <Chip
                            key={snippet}
                            label={snippet}
                            isSelected={false}
                            onPress={() => onAppendSnippet(snippet)}
                        />
                    ))}
                </View>
            </ScrollView>

            <TextInput
                className={`${INPUT_CLASSNAME} min-h-[80px] ${
                    errors?.dealTitle ? 'border-red-500' : 'border-slate-300 dark:border-slate-700'
                }`}
                placeholder="e.g. $4 Drafts, $5 Margaritas, Half-Price Apps"
                placeholderTextColor={Colors.iconMuted}
                multiline
                textAlignVertical="top"
                value={schedule.dealTitle}
                maxLength={200}
                onChangeText={onChangeDealTitle}
                accessibilityLabel="The deal for this time"
            />
            {errors?.dealTitle ? (
                <Text className="text-red-500 text-xs mt-1 px-1" accessibilityLiveRegion="polite">{errors.dealTitle}</Text>
            ) : null}
        </View>
    );
};
