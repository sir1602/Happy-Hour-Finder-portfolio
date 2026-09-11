import React, { memo } from 'react';
import { View, Text } from 'react-native';
import { Icon } from '../Icon';
import { Button } from './Button';
import { Colors } from '../../constants/colors';

export interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export const ErrorState = memo(({
  title = 'Something went wrong',
  message = 'Failed to load content. Please check your connection and try again.',
  onRetry,
  className = '',
}: ErrorStateProps) => {
  return (
    <View className={`flex-1 items-center justify-center p-8 text-center ${className}`}>
      <View className="size-16 rounded-full bg-red-100 dark:bg-red-950/40 items-center justify-center mb-4 border border-red-300 dark:border-red-800/40">
        <Icon name="error-outline" size={32} color={Colors.danger} />
      </View>
      <Text className="text-xl font-bold text-slate-900 dark:text-slate-100 text-center mb-2">{title}</Text>
      <Text className="text-sm text-slate-500 dark:text-slate-400 text-center mb-6 leading-relaxed max-w-xs">{message}</Text>
      {onRetry && (
        <Button
          label="Try Again"
          onPress={onRetry}
          variant="primary"
          fullWidth={false}
          size="md"
          icon={<Icon name="refresh" size={18} color={Colors.onPrimaryAlt} />}
        />
      )}
    </View>
  );
});

ErrorState.displayName = 'ErrorState';
