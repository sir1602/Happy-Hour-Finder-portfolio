import React from 'react';
import { View, Text } from 'react-native';

/**
 * One titled section of the submit form.
 *
 * The form was a single flat column of ten-odd fields; grouping it into
 * Venue / When / What gives the eye somewhere to land and makes the length
 * feel like three short steps rather than one long one.
 */
export const SubmitCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <View className="mb-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/40 p-4">
        <Text className="text-base font-bold text-slate-900 dark:text-white mb-3">{title}</Text>
        {children}
    </View>
);
