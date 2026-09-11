import React, { memo } from 'react';
import { View, Text } from 'react-native';

export interface BadgeProps {
  label: string;
  variant?: 'active' | 'upcoming' | 'expired' | 'trending' | 'new' | 'neutral';
  icon?: React.ReactNode;
  className?: string;
}

export const Badge = memo(({ label, variant = 'neutral', icon, className = '' }: BadgeProps) => {
  const variantStyles = {
    active: 'bg-green-600/90 text-white',
    upcoming: 'bg-amber-500/90 text-slate-950',
    expired: 'bg-slate-400/80 dark:bg-slate-500/80 text-slate-900 dark:text-slate-100',
    trending: 'bg-amber-400/20 border border-amber-400/40 text-amber-400',
    new: 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-400',
    neutral: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-700',
  };

  const textStyles = {
    active: 'text-white font-bold',
    upcoming: 'text-slate-950 font-bold',
    expired: 'text-slate-900 dark:text-slate-100 font-medium',
    trending: 'text-amber-400 font-bold',
    new: 'text-emerald-400 font-bold',
    neutral: 'text-slate-600 dark:text-slate-300 font-medium',
  };

  return (
    <View className={`flex-row items-center gap-1 rounded-full px-2.5 py-1 ${variantStyles[variant]} ${className}`}>
      {icon}
      <Text className={`text-xs ${textStyles[variant]}`}>{label}</Text>
    </View>
  );
});

Badge.displayName = 'Badge';
