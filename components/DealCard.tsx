
import React, { memo, useState, useEffect } from 'react';
import { View, Text, Image, TouchableOpacity, ImageBackground } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Deal } from '../types';
import { Icon } from './Icon';
import { getDealStatus } from '../utils/dealTime';
import { priceSymbols, priceSymbolsRemainder } from '../utils/price';
import { isUnconfirmed } from '../utils/verification';
import { Button } from './ui/Button';
import { VENUE_FALLBACK_IMAGE } from '../constants/images';

/**
 * Re-exported so the existing importers (and their tests) keep working. The
 * value itself now lives in constants/images, shared with the read path in
 * dealService so a missing image and a broken one look the same.
 */
export const FALLBACK_IMAGE = VENUE_FALLBACK_IMAGE;

// Q4: memoized — avoids re-renders from unrelated parent list updates.
const DealStatusBadge = memo(({ deal }: { deal: Deal }) => {
    // The label is a live countdown ("Ends in 5m", "Starts in 1h 20m") computed
    // from the current time, but it was only ever evaluated at render — so a card
    // sitting on screen kept showing whatever it said when it mounted. Ticking
    // once a minute is enough resolution for a label whose finest unit is minutes.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(id);
    }, []);

    const { status, label } = getDealStatus(deal.time, deal.daysActive, new Date(now));
    const bgColor = status === 'active' ? 'bg-green-600/90' : status === 'upcoming' ? 'bg-amber-500/90' : 'bg-slate-500/80';
    return (
        <View className={`absolute right-4 top-4 rounded-full px-3 py-1.5 ${bgColor}`}>
            <Text className="text-xs font-bold text-white">{label}</Text>
        </View>
    );
});
DealStatusBadge.displayName = 'DealStatusBadge';

/**
 * Marks a deal the re-validation pipeline has positively flagged as not
 * matching its source.
 *
 * Sits directly under DealStatusBadge rather than beside it: the status badge
 * is a live countdown whose width changes as it ticks ("Ends in 5m" ->
 * "Active · 2h 10m left"), so anything sharing that row would be pushed around
 * or overlapped.
 *
 * Renders nothing for a deal that is verified or simply never checked — see
 * utils/verification for why "never checked" deliberately gets no badge.
 */
const UnconfirmedBadge = memo(({ deal, compact = false }: { deal: Deal; compact?: boolean }) => {
    if (!isUnconfirmed(deal)) return null;

    return (
        <View
            className={`absolute right-4 flex-row items-center gap-1 rounded-full bg-slate-900/80 border border-amber-400/60 ${compact ? 'top-12 px-2 py-1' : 'top-14 px-2.5 py-1'}`}
            accessibilityRole="text"
            accessibilityLabel="Unconfirmed deal. We could not confirm these details recently."
        >
            <Icon name="error-outline" size={compact ? 11 : 13} color="#FBBF24" />
            <Text className={`font-bold text-amber-300 ${compact ? 'text-[10px]' : 'text-xs'}`}>Unconfirmed</Text>
        </View>
    );
});
UnconfirmedBadge.displayName = 'UnconfirmedBadge';

// Q4: memoized — deal reference is stable between renders when parent uses useCallback
const MapButton = memo(({ deal, compact = false }: { deal: Deal; compact?: boolean }) => {
    const router = useRouter();

    const handlePress = () => {
        router.push({
            pathname: '/(tabs)/map',
            params: {
                focusDealId: deal.id,
                lat: String(deal.latitude),
                lng: String(deal.longitude),
                // Fresh per tap: the map tab stays mounted, so without a changing
                // param, re-focusing the same deal is a silent no-op.
                ts: String(Date.now()),
            },
        });
    };

    return (
        <TouchableOpacity
            onPress={(e) => { e.stopPropagation(); handlePress(); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={`Show ${deal.name} on map`}
            className={`flex-row items-center gap-1 rounded-full active:scale-95 ${
                compact
                    ? 'bg-white/20 px-2 py-1'
                    : 'bg-primary/10 border border-primary/25 px-2.5 py-1.5'
            }`}
        >
            <Icon name="map" size={compact ? 12 : 14} color={compact ? '#fff' : '#FFC107'} />
            {!compact && <Text className="text-xs font-bold text-primary">Map</Text>}
        </TouchableOpacity>
    );
});
MapButton.displayName = 'MapButton';

export const HighlightCard = memo(({ deal, onSelectDeal, onToggleSave, isSaved, isVisited }: { deal: Deal; onSelectDeal: (id: string) => void; onToggleSave: (id: string, dealData?: { deal: string; time: string; name: string; daysActive?: number[] }) => void; isSaved: boolean; isVisited?: boolean; }) => {
    const [imageSource, setImageSource] = useState({ uri: deal.image });

    useEffect(() => {
        setImageSource({ uri: deal.image });
    }, [deal.image]);

    const getTag = () => {
        switch (deal.type) {
            case 'trending': return { icon: 'local-fire-department', text: 'Trending Now' } as const;
            case 'ends-soon': return { icon: 'hourglass-top', text: `Ends in ${deal.endsIn}` } as const;
            case 'new': return { icon: 'new-releases', text: 'New Highlight' } as const;
            default: return null;
        }
    };
    const tag = getTag();

    return (
        <View className="flex-col overflow-hidden rounded-xl bg-background-light shadow-sm dark:bg-[#2a2a2a]">
            <View className="relative">
                <Image
                    className="h-56 w-full"
                    source={imageSource}
                    onError={() => setImageSource({ uri: FALLBACK_IMAGE })}
                    accessible={false}
                />
                <View className="absolute inset-x-0 bottom-0 h-2/3">
                    <LinearGradient
                        colors={['transparent', 'rgba(0,0,0,0.75)']}
                        style={{ flex: 1 }}
                    />
                </View>
                {tag && (
                    <View className="absolute left-4 top-4 inline-flex flex-row items-center gap-1.5 rounded-full bg-primary/20 px-3 py-1.5">
                        <Icon name={tag.icon} size={16} color="#FFC107" />
                        <Text className="text-xs font-bold text-primary">{tag.text}</Text>
                    </View>
                )}
                <DealStatusBadge deal={deal} />
                <UnconfirmedBadge deal={deal} />
                {isVisited && (
                    <View className="absolute bottom-3 left-4 flex-row items-center gap-1 bg-green-600/90 rounded-full px-2 py-1">
                        <Icon name="check-circle" size={12} color="white" />
                        <Text className="text-xs font-bold text-white">Visited</Text>
                    </View>
                )}
            </View>
            <View className="flex-col p-4">
                <View className="flex-row items-start justify-between">
                    <View>
                        <Text className="text-2xl font-bold tracking-tight text-text-light dark:text-text-dark">{deal.name}</Text>
                        <Text className="mt-1 text-base font-medium text-text-secondary-light dark:text-text-secondary-dark">{deal.deal}</Text>
                    </View>
                    <TouchableOpacity
                        onPress={() => {
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                            onToggleSave(deal.id, { deal: deal.deal, time: deal.time, name: deal.name, daysActive: deal.daysActive });
                        }}
                        className={`mt-1 flex h-11 w-11 items-center justify-center rounded-full active:scale-95`}
                        accessibilityRole="button"
                        accessibilityLabel={isSaved ? "Remove from saved" : "Save deal"}
                        accessibilityHint={`Double tap to ${isSaved ? "remove" : "save"} ${deal.name}`}
                    >
                        <Icon name={isSaved ? 'bookmark' : 'bookmark-border'} size={28} color={isSaved ? '#FFC107' : '#757575'} />
                    </TouchableOpacity>
                </View>
                {/* Location row with inline Map button */}
                <View className="mt-4 flex-row items-center gap-3 flex-wrap">
                    {deal.distance ? (
                        <View className="flex-row items-center gap-1.5">
                            <Icon name="near-me" size={18} color="#757575" />
                            <Text className="text-sm text-text-secondary-light dark:text-text-secondary-dark">{deal.distance}</Text>
                        </View>
                    ) : null}
                    <View className="flex-row items-center gap-1.5">
                        <Icon name="pin-drop" size={18} color="#757575" />
                        <Text className="text-sm text-text-secondary-light dark:text-text-secondary-dark">{deal.neighborhood}</Text>
                    </View>
                    <Text className="text-primary">{priceSymbols(deal.price)}<Text className="text-text-secondary-light/50 dark:text-text-secondary-dark/50">{priceSymbolsRemainder(deal.price)}</Text></Text>
                </View>
                <Button
                    label="View Deal"
                    onPress={() => onSelectDeal(deal.id)}
                    variant="primary"
                    size="md"
                    className="mt-6"
                />
            </View>
        </View>
    );
});
HighlightCard.displayName = 'HighlightCard';

export const SavedCard = memo(({ deal, onSelectDeal, onToggleSave, isVisited }: { deal: Deal, onSelectDeal: (id: string) => void, onToggleSave: (id: string) => void, isVisited?: boolean }) => {
    const [imageSource, setImageSource] = useState({ uri: deal.image });

    useEffect(() => {
        setImageSource({ uri: deal.image });
    }, [deal.image]);

    return (
        <TouchableOpacity
            onPress={() => onSelectDeal(deal.id)}
            className="flex-col items-stretch justify-start rounded-xl bg-slate-100 dark:bg-black/20"
            accessibilityRole="button"
            accessibilityLabel={`${deal.name}, ${deal.deal}, ${deal.neighborhood}`}
            accessibilityHint="Double tap to view deal details"
        >
            <View className="relative">
                <Image
                    source={imageSource}
                    className="w-full aspect-video rounded-t-xl"
                    onError={() => setImageSource({ uri: FALLBACK_IMAGE })}
                    accessible={false}
                />
                <DealStatusBadge deal={deal} />
                <UnconfirmedBadge deal={deal} />
                {isVisited && (
                    <View className="absolute bottom-3 left-3 flex-row items-center gap-1 bg-green-600/90 rounded-full px-2 py-1">
                        <Icon name="check-circle" size={12} color="white" />
                        <Text className="text-xs font-bold text-white">Visited</Text>
                    </View>
                )}
            </View>
        <View className="grow flex-col gap-2 p-4">
            <View className="flex-row items-start justify-between gap-3">
                <Text className="text-slate-900 dark:text-white text-lg font-bold leading-tight tracking-[-0.015em] flex-1">{deal.name}</Text>
                <TouchableOpacity
                    onPress={(e) => { e.stopPropagation(); onToggleSave(deal.id); }}
                    className="h-11 w-11 items-center justify-center active:scale-95"
                    accessibilityRole="button"
                    accessibilityLabel="Remove from saved"
                    accessibilityHint={`Double tap to remove ${deal.name} from saved deals`}
                >
                    <Icon name="bookmark" size={28} color="#FFC107" />
                </TouchableOpacity>
            </View>
            <View className="flex-col gap-1.5">
                <View className="flex-row items-center gap-2">
                    <Icon name="local-bar" size={16} color="#94a3b8" />
                    <Text className="text-sm font-normal leading-normal text-slate-600 dark:text-white/70 flex-1">{deal.deal}</Text>
                </View>
                {/* Location row with Map button */}
                <View className="flex-row items-center gap-2">
                    <Icon name="location-on" size={16} color="#94a3b8" />
                    <Text className="text-sm font-normal leading-normal text-slate-600 dark:text-white/70 flex-1">{deal.neighborhood}</Text>
                    <MapButton deal={deal} />
                </View>
                <View className="flex-row items-center gap-2">
                    <Icon name="schedule" size={16} color="#94a3b8" />
                    <Text className="text-sm font-normal leading-normal text-slate-600 dark:text-white/70">{deal.time}</Text>
                </View>
            </View>
        </View>
    </TouchableOpacity>
    );
});
SavedCard.displayName = 'SavedCard';

export const ExploreCard = memo(({ deal, onSelectDeal, onToggleSave, isSaved, isVisited }: { deal: Deal, onSelectDeal: (id: string) => void, onToggleSave: (id: string, dealData?: { deal: string; time: string; name: string; daysActive?: number[] }) => void, isSaved: boolean, isVisited?: boolean }) => {
    const [imageSource, setImageSource] = useState({ uri: deal.image });

    useEffect(() => {
        setImageSource({ uri: deal.image });
    }, [deal.image]);

    return (
        <TouchableOpacity
            onPress={() => onSelectDeal(deal.id)}
            className="relative h-64 justify-end overflow-hidden rounded-xl"
            accessibilityRole="button"
            accessibilityLabel={`${deal.name}, ${deal.deal}, ${deal.neighborhood}`}
            accessibilityHint="Double tap to view deal details"
        >
            <ImageBackground
                source={imageSource}
                className="absolute inset-0"
                onError={() => setImageSource({ uri: FALLBACK_IMAGE })}
                accessible={false}
            >
                <View className="flex-1 justify-end p-4 bg-black/40">
                    {isVisited && (
                        <View className="absolute top-3 left-3 flex-row items-center gap-1 bg-green-600/90 rounded-full px-2 py-1">
                            <Icon name="check-circle" size={12} color="white" />
                            <Text className="text-xs font-bold text-white">Visited</Text>
                        </View>
                    )}
                    {/* Save control — Explore is the primary browsing surface, so it
                        needs parity with HighlightCard/SavedCard/the detail screen.
                        Sits below the status badge (top-4) to avoid overlapping it. */}
                    <TouchableOpacity
                        onPress={(e) => {
                            e.stopPropagation();
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                            onToggleSave(deal.id, { deal: deal.deal, time: deal.time, name: deal.name, daysActive: deal.daysActive });
                        }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        className="absolute right-3 top-16 h-11 w-11 items-center justify-center rounded-full bg-black/40 active:scale-95"
                        accessibilityRole="button"
                        accessibilityLabel={isSaved ? 'Remove from saved' : 'Save deal'}
                        accessibilityHint={`Double tap to ${isSaved ? 'remove' : 'save'} ${deal.name}`}
                    >
                        <Icon name={isSaved ? 'bookmark' : 'bookmark-border'} size={24} color={isSaved ? '#FFC107' : '#fff'} />
                    </TouchableOpacity>
                    <View className="flex-1 mb-1">
                        <Text className="text-xl font-bold text-white" numberOfLines={1}>{deal.name}</Text>
                        <Text className="text-sm font-normal text-white/90" numberOfLines={1}>{deal.neighborhood}</Text>
                    </View>
                    {/* Bottom bar: deal info + map button */}
                    <View className="flex-row items-center justify-between mt-2">
                        <Text className="text-lg font-bold text-primary flex-1 mr-2" numberOfLines={1}>{deal.deal}</Text>
                        <View className="flex-row items-center gap-2">
                            <Text className="text-sm font-medium text-white">{deal.distance ? `${deal.distance} • ` : ''}{priceSymbols(deal.price)}</Text>
                            <MapButton deal={deal} compact />
                        </View>
                    </View>
                </View>
            </ImageBackground>
        {/* B6: badge lives outside the gradient overlay, directly in the relative container */}
        <DealStatusBadge deal={deal} />
        <UnconfirmedBadge deal={deal} compact />
    </TouchableOpacity>
    );
});
ExploreCard.displayName = 'ExploreCard';
