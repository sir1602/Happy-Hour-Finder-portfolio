import React from 'react';
import { View, Text, TextInput, TextInputProps, LayoutChangeEvent } from 'react-native';
import { Colors } from '../../constants/colors';

export const INPUT_CLASSNAME =
    'bg-white dark:bg-slate-900 border rounded-xl p-4 text-slate-900 dark:text-white';

interface FormFieldProps extends TextInputProps {
    label: string;
    /** Marks the label and is what the screen reader announces as required. */
    required?: boolean;
    error?: string;
    hint?: string;
    /** Reports this field's y offset so the form can scroll to it on a failed submit. */
    onRegisterOffset?: (y: number) => void;
    inputRef?: React.RefObject<TextInput | null>;
}

/**
 * A labelled text input with its inline error underneath.
 *
 * Exists so the error convention lives in one place rather than being repeated
 * per field, and so every field can report where it sits without each caller
 * wiring up its own onLayout.
 */
export const FormField = ({
    label, required, error, hint, onRegisterOffset, inputRef, ...inputProps
}: FormFieldProps) => {
    const handleLayout = (e: LayoutChangeEvent) => onRegisterOffset?.(e.nativeEvent.layout.y);

    return (
        <View onLayout={onRegisterOffset ? handleLayout : undefined} className="mb-4">
            <Text className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">
                {label}{required ? ' *' : ''}
            </Text>
            {hint ? (
                <Text className="text-xs text-slate-500 dark:text-slate-400 mb-2">{hint}</Text>
            ) : null}
            <TextInput
                ref={inputRef}
                placeholderTextColor={Colors.iconMuted}
                accessibilityLabel={label}
                className={`${INPUT_CLASSNAME} ${
                    error ? 'border-red-500' : 'border-slate-300 dark:border-slate-700'
                }`}
                {...inputProps}
            />
            {error ? (
                <Text className="text-red-500 text-xs mt-1 px-1" accessibilityLiveRegion="polite">
                    {error}
                </Text>
            ) : null}
        </View>
    );
};
