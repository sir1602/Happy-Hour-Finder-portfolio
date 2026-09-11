import React, { useState } from 'react';
import { View, Text, Image, TouchableOpacity } from 'react-native';
import { Icon } from '../Icon';
import { Colors } from '../../constants/colors';

interface VenuePhotoBlockProps {
    selectedVenuePhoto: string | null;
    onPickVenuePhoto: () => void;
    onTakeVenuePhoto: () => void;
    onRemoveVenuePhoto: () => void;
}

/**
 * A picture of the place, used as the venue's artwork on cards.
 *
 * The sibling of PhotoScanBlock, and deliberately not merged with it. That one
 * takes a photo of the *menu* — evidence a moderator checks the submission
 * against, which is why it is stored on the deal rows. This one is what the
 * venue looks like. Making one photo do both jobs is what used to put a
 * photograph of a chalkboard on the feed as though it were the bar.
 *
 * Collapsed until asked for, like PhotoScanBlock: most submitters are here to
 * report a happy hour, not to do photography, and a venue with no artwork now
 * gets some from its own website overnight anyway.
 */
export const VenuePhotoBlock = ({
    selectedVenuePhoto, onPickVenuePhoto, onTakeVenuePhoto, onRemoveVenuePhoto,
}: VenuePhotoBlockProps) => {
    const [expanded, setExpanded] = useState(false);
    const isOpen = expanded || Boolean(selectedVenuePhoto);

    if (!isOpen) {
        return (
            <TouchableOpacity
                onPress={() => setExpanded(true)}
                className="flex-row items-center gap-2 mb-4 px-3 py-3 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 active:bg-slate-100 dark:active:bg-slate-800"
                accessibilityRole="button"
                accessibilityLabel="Add a photo of the venue itself"
            >
                <Icon name="storefront" size={20} color={Colors.iconMuted} />
                <Text className="flex-1 text-sm font-semibold text-slate-700 dark:text-slate-300">
                    Add a photo of the place
                </Text>
                <Icon name="expand-more" size={20} color={Colors.iconMuted} />
            </TouchableOpacity>
        );
    }

    return (
        <View className="mb-4">
            <Text className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                What the venue looks like — the front, the bar, the room. This is
                the picture shown on the deal card. Optional: without one we use
                the venue&apos;s own website.
            </Text>

            {selectedVenuePhoto ? (
                <View className="relative w-full h-48 rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800">
                    <Image
                        source={{ uri: selectedVenuePhoto }}
                        className="w-full h-full object-cover"
                        accessibilityLabel="Selected photo of the venue"
                    />
                    <TouchableOpacity
                        onPress={onRemoveVenuePhoto}
                        className="absolute top-2 right-2 bg-red-500/80 p-2 rounded-full active:bg-red-600"
                        accessibilityRole="button"
                        accessibilityLabel="Remove the photo of the venue"
                    >
                        <Icon name="close" size={20} color={Colors.white} />
                    </TouchableOpacity>
                </View>
            ) : (
                <View className="flex-row gap-3">
                    <TouchableOpacity
                        onPress={onPickVenuePhoto}
                        className="flex-1 flex-row items-center justify-center py-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 active:bg-slate-50 dark:active:bg-slate-800"
                        accessibilityRole="button"
                        accessibilityLabel="Choose a photo of the venue from gallery"
                    >
                        <Icon name="photo-library" size={20} color={Colors.primary} />
                        <Text className="text-slate-700 dark:text-slate-300 font-bold ml-2">Gallery</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={onTakeVenuePhoto}
                        className="flex-1 flex-row items-center justify-center py-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 active:bg-slate-50 dark:active:bg-slate-800"
                        accessibilityRole="button"
                        accessibilityLabel="Take a photo of the venue with the camera"
                    >
                        <Icon name="photo-camera" size={20} color={Colors.primary} />
                        <Text className="text-slate-700 dark:text-slate-300 font-bold ml-2">Camera</Text>
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
};
