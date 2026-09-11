import React from 'react';
import { useRewards } from '../context/RewardsContext';
import { BadgeCelebrationModal } from './BadgeCelebrationModal';

export const GlobalBadgeCelebration = () => {
    const { activeCelebration, dismissCelebration } = useRewards();

    return (
        <BadgeCelebrationModal 
            badge={activeCelebration} 
            onDismiss={dismissCelebration} 
        />
    );
};
