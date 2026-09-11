import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import BottomSheet, { BottomSheetView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withSpring, 
  withSequence,
  withRepeat,
  withTiming
} from 'react-native-reanimated';
import { TouchableOpacity } from 'react-native-gesture-handler';
import { BadgeDefinition } from '../services/rewardsService';

interface BadgeCelebrationModalProps {
    badge: BadgeDefinition | null;
    onDismiss: () => void;
}

export const BadgeCelebrationModal = ({ badge, onDismiss }: BadgeCelebrationModalProps) => {
    const bottomSheetRef = useRef<BottomSheet>(null);
    const scale = useSharedValue(0.5);
    const rotation = useSharedValue(-10);
    const glowOpacity = useSharedValue(0.5);

    useEffect(() => {
        if (badge) {
            bottomSheetRef.current?.expand();
            
            // Pop-in animation
            scale.value = withSequence(
                withSpring(1.2, { damping: 10, stiffness: 100 }),
                withSpring(1, { damping: 12, stiffness: 100 })
            );
            
            // Wiggle animation
            rotation.value = withSequence(
                withTiming(10, { duration: 150 }),
                withTiming(-10, { duration: 150 }),
                withTiming(5, { duration: 100 }),
                withTiming(0, { duration: 100 })
            );

            // Continuous pulse glow
            glowOpacity.value = withRepeat(
                withSequence(
                    withTiming(1, { duration: 800 }),
                    withTiming(0.4, { duration: 800 })
                ),
                -1,
                true
            );
        }
    }, [badge, scale, rotation, glowOpacity]);

    const animatedBadgeStyle = useAnimatedStyle(() => {
        return {
            transform: [
                { scale: scale.value },
                { rotate: `${rotation.value}deg` }
            ] as any,
        };
    });

    const animatedGlowStyle = useAnimatedStyle(() => {
        return {
            opacity: glowOpacity.value,
            transform: [{ scale: scale.value * 1.5 }]
        };
    });

    const handleClose = () => {
        bottomSheetRef.current?.close();
    };

    // Don't render the BottomSheet at all when there's no badge.
    // BottomSheet at index={-1} still renders an invisible gesture surface
    // that intercepts ALL touch events on the screen, blocking interaction.
    if (!badge) return null;

    return (
        <BottomSheet
            ref={bottomSheetRef}
            index={0}
            snapPoints={['50%']}
            enablePanDownToClose
            onClose={onDismiss}
            backdropComponent={(props) => (
                <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.7} />
            )}
            backgroundStyle={{ backgroundColor: '#1E293B' }}
            handleIndicatorStyle={{ backgroundColor: '#475569' }}
        >
            <BottomSheetView style={styles.contentContainer}>
                <View className="items-center justify-center flex-1 w-full px-6 py-4">
                    <View className="mb-2 bg-amber-500/20 px-4 py-1 rounded-full">
                        <Text className="text-amber-400 font-bold tracking-widest text-xs uppercase">New Badge Earned!</Text>
                    </View>
                    
                    <View className="relative items-center justify-center h-48 w-48 mb-4">
                        {/* Animated Glow */}
                        <Animated.View 
                            style={[styles.glow, animatedGlowStyle]} 
                            className="absolute bg-amber-400/40 rounded-full h-32 w-32 blur-2xl flex items-center justify-center"
                        />
                        
                        {/* Animated Badge */}
                        <Animated.View style={animatedBadgeStyle} className="items-center justify-center mt-6">
                            <Text style={{ fontSize: 80 }}>{badge.icon}</Text>
                        </Animated.View>
                    </View>

                    <Text className="text-2xl font-bold text-white mb-2 text-center">
                        {badge.name}
                    </Text>
                    
                    <Text className="text-slate-300 text-base text-center mb-8 px-4">
                        {badge.description}
                    </Text>

                    <TouchableOpacity
                        className="bg-amber-500 py-3.5 px-8 rounded-xl w-full items-center shadow-sm active:scale-95 transition-transform"
                        onPress={handleClose}
                    >
                        <Text className="text-slate-900 font-bold text-lg">Awesome!</Text>
                    </TouchableOpacity>
                </View>
            </BottomSheetView>
        </BottomSheet>
    );
};

const styles = StyleSheet.create({
    contentContainer: {
        flex: 1,
        alignItems: 'center',
    },
    glow: {
        shadowColor: '#F59E0B',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.8,
        shadowRadius: 40,
        elevation: 10,
    }
});
