import React, { useState } from 'react';
import { View, Text, Image, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Icon } from '../Icon';
import { Colors } from '../../constants/colors';

interface PhotoScanBlockProps {
    selectedImage: string | null;
    canScanPhoto: boolean;
    isScanning: boolean;
    scanNotice: string | null;
    onPickImage: () => void;
    onTakePhoto: () => void;
    onRemoveImage: () => void;
    onScanPhoto: () => void;
}

/**
 * The photo, and the offer to read the deal off it.
 *
 * Sits at the top of the form because it is the fastest route through it: a
 * scan fills the blank fields, and it only helps if it runs before anything is
 * typed. It stays collapsed to one line until asked for, though — a full-size
 * picker above the first field is an upsell in front of someone who just wants
 * to type.
 */
export const PhotoScanBlock = ({
    selectedImage, canScanPhoto, isScanning, scanNotice,
    onPickImage, onTakePhoto, onRemoveImage, onScanPhoto,
}: PhotoScanBlockProps) => {
    const [expanded, setExpanded] = useState(false);
    const isOpen = expanded || Boolean(selectedImage);

    if (!isOpen) {
        return (
            <TouchableOpacity
                onPress={() => setExpanded(true)}
                className="flex-row items-center gap-2 mb-4 px-3 py-3 rounded-xl border border-dashed border-primary/60 active:bg-primary/10"
                accessibilityRole="button"
                accessibilityLabel={canScanPhoto ? 'Add a photo of the menu and read the deal from it' : 'Add a photo of the menu'}
            >
                <Icon name={canScanPhoto ? 'auto-awesome' : 'photo-camera'} size={20} color={Colors.primary} />
                <Text className="flex-1 text-sm font-semibold text-slate-700 dark:text-slate-300">
                    {canScanPhoto ? "Have a photo of the menu? We'll fill this in" : 'Add a photo of the menu'}
                </Text>
                <Icon name="expand-more" size={20} color={Colors.iconMuted} />
            </TouchableOpacity>
        );
    }

    return (
        <View className="mb-4">
            <Text className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                {canScanPhoto
                    ? 'A shot of the happy hour menu or sign. It goes to the moderator with your submission, and can fill this form in for you.'
                    : 'A shot of the happy hour menu or sign. It goes to the moderator with your submission.'}
            </Text>

            {selectedImage ? (
                <>
                    <View className="relative w-full h-48 rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800">
                        <Image source={{ uri: selectedImage }} className="w-full h-full object-cover" accessibilityLabel="Selected venue photo" />
                        <TouchableOpacity
                            onPress={onRemoveImage}
                            className="absolute top-2 right-2 bg-red-500/80 p-2 rounded-full active:bg-red-600"
                            accessibilityRole="button"
                            accessibilityLabel="Remove photo"
                        >
                            <Icon name="close" size={20} color={Colors.white} />
                        </TouchableOpacity>
                    </View>

                    {canScanPhoto ? (
                        <TouchableOpacity
                            onPress={onScanPhoto}
                            disabled={isScanning}
                            className={`mt-3 flex-row items-center justify-center py-3 rounded-xl border ${
                                isScanning
                                    ? 'border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800'
                                    : 'border-primary bg-primary/10 active:bg-primary/20'
                            }`}
                            accessibilityRole="button"
                            accessibilityLabel="Read the deal from this photo"
                            accessibilityState={{ disabled: isScanning, busy: isScanning }}
                        >
                            {isScanning ? (
                                <ActivityIndicator size="small" color={Colors.iconMuted} />
                            ) : (
                                <Icon name="auto-awesome" size={20} color={Colors.primary} />
                            )}
                            <Text className="font-bold ml-2 text-slate-700 dark:text-slate-300">
                                {isScanning ? 'Reading the photo…' : 'Read the deal from this photo'}
                            </Text>
                        </TouchableOpacity>
                    ) : null}
                </>
            ) : (
                <View className="flex-row gap-3">
                    <TouchableOpacity
                        onPress={onPickImage}
                        className="flex-1 flex-row items-center justify-center py-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 active:bg-slate-50 dark:active:bg-slate-800"
                        accessibilityRole="button"
                        accessibilityLabel="Choose photo from gallery"
                    >
                        <Icon name="photo-library" size={20} color={Colors.primary} />
                        <Text className="text-slate-700 dark:text-slate-300 font-bold ml-2">Gallery</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={onTakePhoto}
                        className="flex-1 flex-row items-center justify-center py-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 active:bg-slate-50 dark:active:bg-slate-800"
                        accessibilityRole="button"
                        accessibilityLabel="Take photo with camera"
                    >
                        <Icon name="photo-camera" size={20} color={Colors.primary} />
                        <Text className="text-slate-700 dark:text-slate-300 font-bold ml-2">Camera</Text>
                    </TouchableOpacity>
                </View>
            )}

            {scanNotice ? (
                <Text className="text-xs text-slate-600 dark:text-slate-400 mt-2" accessibilityLiveRegion="polite">
                    {scanNotice}
                </Text>
            ) : null}
        </View>
    );
};
