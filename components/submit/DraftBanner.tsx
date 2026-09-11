import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Icon } from '../Icon';
import { Colors } from '../../constants/colors';

/**
 * Says that a half-finished submission was brought back.
 *
 * A restore that happens silently is indistinguishable from the app having
 * kept fields it should have cleared, so it gets a banner and a way out.
 */
export const DraftBanner = ({ onDiscard, onDismiss }: { onDiscard: () => void; onDismiss: () => void }) => (
    <View
        className="flex-row items-center gap-2 mb-4 px-3 py-2 rounded-xl bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-800"
        accessibilityLiveRegion="polite"
    >
        <Icon name="history" size={18} color={Colors.primary} />
        <Text className="flex-1 text-xs text-amber-900 dark:text-amber-200">
            We brought back the deal you started.
        </Text>
        <TouchableOpacity onPress={onDiscard} accessibilityRole="button" accessibilityLabel="Discard the restored draft">
            <Text className="text-xs font-bold text-amber-900 dark:text-amber-200 underline">Discard</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss">
            <Icon name="close" size={16} color={Colors.closeIconMuted} />
        </TouchableOpacity>
    </View>
);
