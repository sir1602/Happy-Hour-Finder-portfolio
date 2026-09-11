
import React from 'react';
import { View } from 'react-native';
import { Icon } from './Icon';
import { getStarConfig } from '../utils/starRating';

export const StarRating = ({ rating, className = '' }: { rating: number; className?: string }) => {
    const { fullStars, halfStar, emptyStars } = getStarConfig(rating);

    return (
        <View className={`flex-row items-center gap-1 ${className}`}>
            {[...Array(fullStars)].map((_, i) => <Icon key={`full-${i}`} name="star" size={16} color="#FFC107" />)}
            {halfStar && <Icon name="star-half" size={16} color="#FFC107" />}
            {[...Array(emptyStars)].map((_, i) => <Icon key={`empty-${i}`} name="star-border" size={16} color="#BDBDBD" />)}
        </View>
    );
};
