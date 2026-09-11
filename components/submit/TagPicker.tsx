import React from 'react';
import { View, Text, TextInput } from 'react-native';
import { Chip } from '../ui/Chip';
import { Colors } from '../../constants/colors';
import { INPUT_CLASSNAME } from './FormField';

interface TagPickerProps {
    suggestions: string[];
    selected: string[];
    onToggle: (tag: string) => void;
    value: string;
    onChangeText: (text: string) => void;
    inputRef?: React.RefObject<TextInput | null>;
}

/**
 * Tappable tags over the comma-separated field they edit.
 *
 * The chips and the text input are the same value: the chips write into the
 * string, so there is one source of truth for what gets submitted and anything
 * not on the list can still be typed.
 */
export const TagPicker = ({ suggestions, selected, onToggle, value, onChangeText, inputRef }: TagPickerProps) => {
    const isSelected = (tag: string) => selected.some(t => t.toLowerCase() === tag.toLowerCase());

    return (
        <View className="mb-4">
            <Text className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Tags</Text>

            <View className="flex-row flex-wrap gap-2 mb-3">
                {suggestions.map(tag => (
                    <Chip key={tag} label={tag} isSelected={isSelected(tag)} onPress={() => onToggle(tag)} />
                ))}
            </View>

            <TextInput
                ref={inputRef}
                className={`${INPUT_CLASSNAME} border-slate-300 dark:border-slate-700`}
                placeholder="Anything else? Separate with commas"
                placeholderTextColor={Colors.iconMuted}
                value={value}
                onChangeText={onChangeText}
                returnKeyType="done"
                maxLength={200}
                accessibilityLabel="Tags, comma separated"
            />
        </View>
    );
};
