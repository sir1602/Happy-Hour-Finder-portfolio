import React, { memo } from 'react';
import { View, Text } from 'react-native';
import { Icon } from '../Icon';
import { Button } from './Button';
import { Colors } from '../../constants/colors';

export interface EmptyStateProps {
  title: string;
  message: string;
  iconName?: React.ComponentProps<typeof Icon>['name'];
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export const EmptyState = memo(({
  title,
  message,
  iconName = 'search-off',
  actionLabel,
  onAction,
  className = '',
}: EmptyStateProps) => {
  return (
    <View className={`flex-1 items-center justify-center p-8 text-center ${className}`}>
      <View className="size-16 rounded-full bg-slate-200 dark:bg-slate-800/80 items-center justify-center mb-4 border border-slate-300 dark:border-slate-700">
        <Icon name={iconName} size={32} color={Colors.iconMutedAlt} />
      </View>
      <Text className="text-xl font-bold text-slate-900 dark:text-slate-100 text-center mb-2">{title}</Text>
      <Text className="text-sm text-slate-500 dark:text-slate-400 text-center mb-6 leading-relaxed max-w-xs">{message}</Text>
      {actionLabel && onAction && (
        <Button label={actionLabel} onPress={onAction} variant="outline" fullWidth={false} size="md" />
      )}
    </View>
  );
});

EmptyState.displayName = 'EmptyState';
