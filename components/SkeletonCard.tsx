/**
 * SkeletonCard
 * A shimmer placeholder that matches ExploreCard dimensions.
 * Used during initial load to provide a polished loading experience.
 * Composed from the shared `ui/Skeleton` primitive so the shimmer animation
 * itself isn't duplicated here.
 */
import React from 'react';
import { View } from 'react-native';
import { Skeleton } from './ui/Skeleton';

export const SkeletonCard = () => (
    <View className="h-64 rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800">
        {/* Image area — fills the entire card; content below is overlaid on top via absolute positioning */}
        <Skeleton width="100%" height="100%" borderRadius={0} className="absolute inset-0" />
        {/* Content area at bottom */}
        <View className="absolute bottom-0 left-0 right-0 p-4 gap-2">
            <Skeleton width="60%" height={20} />
            <Skeleton width="40%" height={16} />
            <View className="flex-row items-center justify-between mt-1">
                <Skeleton width="33%" height={20} />
                <Skeleton width={64} height={24} borderRadius={9999} />
            </View>
        </View>
    </View>
);

/** List of skeleton cards for initial load */
export const SkeletonList = ({ count = 4 }: { count?: number }) => (
    <>
        {Array.from({ length: count }).map((_, i) => (
            <SkeletonCard key={i} />
        ))}
    </>
);
