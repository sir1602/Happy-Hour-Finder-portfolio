import React, { memo } from 'react';
import { TouchableOpacity, Text } from 'react-native';
import * as Haptics from 'expo-haptics';

export interface ChipProps {
  label: string;
  isSelected: boolean;
  onPress: () => void;
  icon?: React.ReactNode;
  className?: string;
}

export const Chip = memo(({ label, isSelected, onPress, icon, className = '' }: ChipProps) => {
  const handlePress = () => {
    try {
      Haptics.selectionAsync();
    } catch {
      // Ignore
    }
    onPress();
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      className={`flex-row items-center gap-1.5 h-9 px-3.5 rounded-full border active:scale-95 ${
        isSelected
          ? 'bg-amber-400 border-amber-400'
          : 'bg-slate-100 dark:bg-slate-800/80 border-slate-300 dark:border-slate-700/80'
      } ${className}`}
    >
      {icon}
      <Text className={`text-xs font-semibold ${isSelected ? 'text-slate-950 font-bold' : 'text-slate-600 dark:text-slate-300'}`}>
        {label}
      </Text>
    </TouchableOpacity>
  );
});

Chip.displayName = 'Chip';
