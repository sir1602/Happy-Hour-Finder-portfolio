import React, { memo } from 'react';
import { TouchableOpacity, Text, ActivityIndicator, ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Colors } from '../../constants/colors';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  isDisabled?: boolean;
  icon?: React.ReactNode;
  fullWidth?: boolean;
  className?: string;
  style?: ViewStyle;
}

export const Button = memo(({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  isLoading = false,
  isDisabled = false,
  icon,
  fullWidth = true,
  className = '',
}: ButtonProps) => {

  const handlePress = () => {
    if (isLoading || isDisabled) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      // Ignore if haptics unavailable
    }
    onPress();
  };

  const variantStyles = {
    primary: 'bg-amber-400 active:bg-amber-500 text-slate-950',
    secondary: 'bg-slate-100 dark:bg-slate-800 active:bg-slate-200 dark:active:bg-slate-700 text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-700',
    outline: 'bg-transparent border border-amber-400/60 active:bg-amber-400/10 text-amber-400',
    ghost: 'bg-transparent active:bg-slate-200/60 dark:active:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    danger: 'bg-red-600 active:bg-red-700 text-white',
  };

  const textVariantStyles = {
    primary: 'text-slate-950 font-bold',
    secondary: 'text-slate-900 dark:text-slate-100 font-semibold',
    outline: 'text-amber-400 font-bold',
    ghost: 'text-slate-600 dark:text-slate-300 font-medium',
    danger: 'text-white font-bold',
  };

  const sizeStyles = {
    sm: 'h-9 px-3 text-xs gap-1.5 rounded-lg',
    md: 'h-12 px-5 text-sm gap-2 rounded-xl',
    lg: 'h-14 px-6 text-base gap-2.5 rounded-xl',
  };

  const textSizeStyles = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={isDisabled || isLoading}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: isLoading }}
      className={`flex-row items-center justify-center ${fullWidth ? 'w-full' : ''} ${sizeStyles[size]} ${variantStyles[variant]} ${isDisabled ? 'opacity-50' : ''} ${className}`}
    >
      {isLoading ? (
        <ActivityIndicator
          size={size === 'sm' ? 'small' : 'small'}
          color={variant === 'primary' ? Colors.onPrimaryAlt : Colors.primary}
        />
      ) : (
        <>
          {icon}
          <Text className={`${textVariantStyles[variant]} ${textSizeStyles[size]}`}>
            {label}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
});

Button.displayName = 'Button';
