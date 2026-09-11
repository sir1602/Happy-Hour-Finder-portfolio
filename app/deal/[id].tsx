import React from 'react';
import { View, Text, ScrollView, ImageBackground, TouchableOpacity, ActivityIndicator, TextInput, KeyboardAvoidingView, Platform, Image, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Icon } from '../../components/Icon';
import { useDeals } from '../../context/DealsContext';
import { useAuth } from '../../context/AuthContext';
import { useDealDetail } from '../../hooks/useDealDetail';
import { getDealStatus } from '../../utils/dealTime';
import { openDirections } from '../../utils/navigation';
import { priceSymbols } from '../../utils/price';
import { isUnconfirmed, unconfirmedReason } from '../../utils/verification';
import { FeedbackModal } from '../../components/FeedbackModal';
import { VENUE_FALLBACK_IMAGE } from '../../constants/images';
import { Colors } from '../../constants/colors';

export default function DetailScreen() {
    const router = useRouter();
    const [reportOpen, setReportOpen] = React.useState(false);
    const { isSaved, toggleSave } = useDeals();
    const { user } = useAuth();
    const detail = useDealDetail();

    if (detail.loading) {
        return (
            <SafeAreaView className="flex-1 items-center justify-center bg-background-light dark:bg-background-dark">
                <ActivityIndicator size="large" color={Colors.primary} />
            </SafeAreaView>
        );
    }

    const { deal } = detail;

    if (!deal) {
        return (
            <SafeAreaView className="flex-1 items-center justify-center bg-background-light dark:bg-background-dark">
                <Text className="text-lg text-slate-800 dark:text-slate-200">Deal not found</Text>
                <TouchableOpacity
                    onPress={() => router.back()}
                    className="mt-4 p-3 bg-primary rounded-lg active:scale-95"
                    accessibilityRole="button"
                    accessibilityLabel="Go back"
                >
                    <Text className="font-bold text-background-dark">Go Back</Text>
                </TouchableOpacity>
            </SafeAreaView>
        );
    }

    const dealStatus = getDealStatus(deal.time, deal.daysActive);
    const statusColor = dealStatus.status === 'active' ? 'bg-green-600/90' : dealStatus.status === 'upcoming' ? 'bg-amber-500/90' : 'bg-slate-500/80';

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            className="flex-1 bg-background-light dark:bg-background-dark"
        >
            <ScrollView keyboardDismissMode="on-drag">
                 <ImageBackground
                    source={detail.imageSource || { uri: VENUE_FALLBACK_IMAGE }}
                    className="min-h-[320px] w-full justify-end"
                    accessibilityRole="image"
                    accessibilityLabel={`Photo of ${deal.name}`}
                    onError={() => detail.setImageError(VENUE_FALLBACK_IMAGE)}
                >
                    {/* B5 fix: gradient scrim overlay for readability */}
                    <View className="absolute inset-0 bg-black/30" />
                </ImageBackground>
                <View className="px-4 pb-4 pt-6 -mt-12 rounded-t-3xl bg-background-light dark:bg-background-dark shadow-sm">
                    <Text className="text-3xl font-bold leading-tight tracking-tight text-slate-900 dark:text-white">{deal.name}</Text>
                    <View className="flex-row items-center gap-4 pt-3">
                        <View className="flex-row items-center justify-center gap-2">
                            <Icon name="star" size={20} color={Colors.primary} />
                            <Text className="text-sm font-bold leading-normal text-slate-700 dark:text-slate-300">
                                {Number(deal.rating) > 0 ? Number(deal.rating).toFixed(1) : 'New'} ({deal.reviewCount} reviews)
                            </Text>
                        </View>
                        <View className={`rounded-full px-3 py-1 ${statusColor}`}>
                            <Text className="text-xs font-bold text-white">{dealStatus.label}</Text>
                        </View>
                    </View>
                    <View className="flex-row flex-wrap gap-2 pt-4">
                        <View className="flex h-8 shrink-0 items-center justify-center gap-x-2 rounded-full bg-primary/20 px-4"><Text className="text-sm font-medium leading-normal text-slate-800 dark:text-slate-200">{priceSymbols(deal.price)}</Text></View>
                        {deal.tags.map(tag => <View key={tag} className="flex h-8 shrink-0 items-center justify-center gap-x-2 rounded-full bg-primary/20 px-4"><Text className="text-sm font-medium leading-normal text-slate-800 dark:text-slate-200">{tag}</Text></View>)}
                    </View>

                    {/* An explicit caveat where there is room to explain it.
                        The card badge only has space for one word; standing
                        outside a bar, the useful information is *why* and what
                        to do about it. */}
                    {isUnconfirmed(deal) && (
                        <View
                            className="mt-5 flex-row gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3"
                            accessibilityRole="alert"
                        >
                            <Icon name="error-outline" size={20} color={Colors.primary} />
                            <View className="flex-1">
                                <Text className="font-bold text-amber-700 dark:text-amber-300">Unconfirmed</Text>
                                <Text className="mt-0.5 text-sm leading-5 text-slate-700 dark:text-slate-300">
                                    {unconfirmedReason(deal)} Worth a quick call before you go — and please tell us if it&apos;s wrong.
                                </Text>
                            </View>
                        </View>
                    )}

                    {/* Check-in Section */}
                    <View className="mt-5 pt-4 border-t border-slate-200/50 dark:border-slate-700/50">
                        {detail.visitCount > 0 && !detail.checkedInToday && (
                            <Text className="text-xs text-slate-500 dark:text-slate-400 mb-2 text-center">
                                You've visited here {detail.visitCount} time{detail.visitCount === 1 ? '' : 's'}
                            </Text>
                        )}
                        {detail.checkedInToday ? (
                            <View className="flex-row items-center justify-center gap-2 py-3 px-4 rounded-xl bg-green-600/20 border border-green-600/30">
                                <Icon name="check-circle" size={20} color={Colors.success} />
                                <Text className="text-green-700 dark:text-green-400 font-bold text-base">Checked In Today!</Text>
                                <Text className="text-xs text-green-600 dark:text-green-500">{detail.visitCount > 1 ? `(${detail.visitCount} total visits)` : ''}</Text>
                            </View>
                        ) : (
                            <TouchableOpacity
                                onPress={detail.handleCheckIn}
                                disabled={detail.isCheckingIn}
                                className="flex-row items-center justify-center gap-2 py-3 px-4 rounded-xl bg-primary/10 border border-primary/30 active:scale-95"
                                accessibilityRole="button"
                                accessibilityLabel="Check in here"
                                accessibilityState={{ disabled: detail.isCheckingIn }}
                            >
                                {detail.isCheckingIn ? (
                                    <ActivityIndicator size="small" color={Colors.primary} />
                                ) : (
                                    <Icon name="place" size={20} color={Colors.primary} />
                                )}
                                <Text className="text-primary font-bold text-base">Check In Here</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
                <View className="mx-4 my-4 rounded-xl border border-slate-200/50 bg-white p-4 shadow-sm dark:border-slate-700/50 dark:bg-slate-800/20">
                    <View className="flex-row items-center gap-3 border-b border-slate-200 pb-3 dark:border-slate-700">
                        <Icon name="local-bar" size={24} color={Colors.primary} />
                        <Text className="text-lg font-bold text-slate-900 dark:text-white">{deal.deal}</Text>
                    </View>
                    <View className="mt-4 rounded-lg border border-primary/20 bg-primary/10 p-3 dark:border-primary/30 dark:bg-primary/20">
                        <View className="flex-row items-center gap-3">
                            <Icon name="schedule" size={20} color={Colors.primary} />
                            <Text className="font-semibold text-slate-800 dark:text-slate-100">{deal.time}</Text>
                        </View>
                    </View>
                </View>

                {/* Only shown when the venue actually has a description.
                    The fallback here used to splice the tag list into prose --
                    "Located in River North (Chicago), Mercadito offers a great
                    atmosphere for Patio / Beer Garden, Speakeasy, Upscale/Fancy,
                    Cocktail-Forward, Late Night, Large Groups, Weekend HH." --
                    which is ungrammatical, restates the chips rendered directly
                    above it, and reads as generated filler. 122 of 355 active
                    deals have no description, so a third of detail screens
                    opened on it. Saying nothing is the honest presentation of
                    nothing, the same call constants/images makes for artwork. */}
                {deal.description?.trim() ? (
                    <View className="px-4 py-2">
                        <Text className="text-lg font-bold mb-2 text-slate-900 dark:text-white">About</Text>
                        <Text className="text-base text-slate-700 dark:text-slate-300">
                            {deal.description}
                        </Text>
                    </View>
                ) : null}

                <View className="px-4 py-4">
                    <Text className="text-lg font-bold mb-2 text-slate-900 dark:text-white">Location</Text>
                    <View className="flex-row items-center gap-2 mb-1">
                        <Icon name="location-on" size={20} color={Colors.textMuted} />
                        <Text className="text-base text-slate-700 dark:text-slate-300">{deal.address}</Text>
                    </View>
                    {deal.phone ? (
                        <TouchableOpacity
                            onPress={() => { Linking.openURL(`tel:${deal.phone}`).catch(() => {}); }}
                            className="flex-row items-center gap-2 mb-4"
                            accessibilityRole="link"
                            accessibilityLabel={`Call ${deal.name}`}
                        >
                            <Icon name="phone" size={20} color={Colors.textMuted} />
                            <Text className="text-base text-blue-600 dark:text-blue-400 underline">{deal.phone}</Text>
                        </TouchableOpacity>
                    ) : null}
                    {deal.website?.trim() ? (
                        <View className="flex-row items-center gap-2 mb-4">
                            <Icon name="language" size={20} color={Colors.textMuted} />
                            <TouchableOpacity
                                onPress={() => { Linking.openURL(deal.website.startsWith('http') ? deal.website : `https://${deal.website}`).catch(() => {}); }}
                                className="flex-1"
                                accessibilityRole="link"
                                accessibilityLabel={`Visit ${deal.name} website`}
                            >
                                <Text className="text-base text-blue-600 dark:text-blue-400 underline" numberOfLines={1} ellipsizeMode="tail">
                                    {deal.website.replace(/^https?:\/\//, '')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    ) : null}

                    <View className="flex-row gap-3">
                        <TouchableOpacity
                            onPress={() => {
                                router.push({
                                    pathname: '/(tabs)/map',
                                    params: {
                                        focusDealId: deal.id,
                                        lat: String(deal.latitude),
                                        lng: String(deal.longitude),
                                        // Fresh per tap — see MapButton in DealCard.
                                        ts: String(Date.now()),
                                    },
                                });
                            }}
                            className="flex-1 flex-row items-center justify-center gap-2 py-2.5 rounded-lg bg-primary/20 active:scale-95"
                            accessibilityRole="button"
                            accessibilityLabel="View on map"
                        >
                            <Icon name="map" size={18} color={Colors.mapAccent} />
                            <Text className="text-amber-700 dark:text-amber-500 font-bold text-sm">View on Map</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            onPress={() => openDirections(deal.name, deal.address, deal.neighborhood, deal.latitude, deal.longitude)}
                            className="flex-1 flex-row items-center justify-center gap-2 py-2.5 rounded-lg bg-slate-200 dark:bg-slate-700 active:scale-95"
                            accessibilityRole="button"
                            accessibilityLabel="Get directions"
                        >
                            <Icon name="directions" size={18} color={Colors.directionsAccent} />
                            <Text className="text-blue-700 dark:text-blue-400 font-bold text-sm">Directions</Text>
                        </TouchableOpacity>
                    </View>
                </View>


                    {/* All Venue Deals */}
                    {detail.venueDeals.length > 0 && (
                        <View className="mb-8 mt-6">
                            <Text className="text-xl font-bold text-slate-800 dark:text-slate-200 mb-4 px-2">All Deals at {deal.name}</Text>
                            <View className="bg-slate-50 dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700">
                                {detail.venueDeals.map((vDeal, index) => {
                                    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                                    const daysText = vDeal.daysActive && vDeal.daysActive.length > 0
                                        ? [...vDeal.daysActive].sort().map(d => dayNames[d]).join(', ')
                                        : 'Daily';

                                    return (
                                        <View key={vDeal.id} className={`py-3 ${index < detail.venueDeals.length - 1 ? 'border-b border-slate-200 dark:border-slate-700' : ''}`}>
                                            <View className="flex-row justify-between items-start mb-1">
                                                <Text className="text-base font-bold text-slate-800 dark:text-slate-200 flex-1 mr-2">{vDeal.deal}</Text>
                                                <View className="bg-sky-100 dark:bg-sky-900/40 px-2 py-1 rounded">
                                                    <Text className="text-sky-800 dark:text-sky-300 text-xs font-bold">{vDeal.time}</Text>
                                                </View>
                                            </View>
                                            <Text className="text-slate-500 dark:text-slate-400 text-sm">{daysText}</Text>
                                        </View>
                                    );
                                })}
                            </View>
                        </View>
                    )}

                    {/* Reviews Section */}

                <View className="px-4 py-6 border-t border-slate-200 dark:border-slate-700 mb-20">
                    <View className="flex-row justify-between items-center mb-4">
                        <Text className="text-xl font-bold text-slate-900 dark:text-white">Reviews</Text>
                        {!detail.showReviewForm && (
                            <TouchableOpacity
                                onPress={() => user ? detail.setShowReviewForm(true) : router.push('/login')}
                                className="bg-primary/20 px-4 py-2 rounded-full"
                                accessibilityRole="button"
                                accessibilityLabel="Write a review"
                            >
                                <Text className="font-bold text-primary dark:text-amber-400">Write a Review</Text>
                            </TouchableOpacity>
                        )}
                    </View>

                    {detail.showReviewForm && (
                        <View className="mb-6 bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
                            <Text className="font-bold text-slate-700 dark:text-slate-300 mb-2">Rating</Text>
                            <View className="flex-row gap-2 mb-4">
                                {[1, 2, 3, 4, 5].map((star) => (
                                    <TouchableOpacity
                                        key={star}
                                        onPress={() => detail.setNewRating(star)}
                                        accessibilityRole="radio"
                                        accessibilityLabel={`${star} star${star === 1 ? '' : 's'}`}
                                        accessibilityState={{ selected: star <= detail.newRating }}
                                    >
                                        <Icon
                                            name={star <= detail.newRating ? "star" : "star-border"}
                                            size={32}
                                            color={star <= detail.newRating ? Colors.primary : Colors.borderMuted}
                                        />
                                    </TouchableOpacity>
                                ))}
                            </View>

                            <Text className="font-bold text-slate-700 dark:text-slate-300 mb-2">Comment (Optional)</Text>
                            <TextInput
                                className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg p-3 text-slate-900 dark:text-white min-h-[80px]"
                                placeholder="Share your experience (optional)..."
                                placeholderTextColor={Colors.iconMuted}
                                maxLength={500}
                                multiline
                                textAlignVertical="top"
                                value={detail.newComment}
                                onChangeText={detail.setNewComment}
                            />

                            <View className="flex-row justify-end gap-3 mt-4">
                                <TouchableOpacity
                                    onPress={() => detail.setShowReviewForm(false)}
                                    className="px-4 py-2"
                                    accessibilityRole="button"
                                    accessibilityLabel="Cancel review"
                                >
                                    <Text className="font-semibold text-slate-500 dark:text-slate-400">Cancel</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={detail.handleSubmitReview}
                                    disabled={detail.isSubmittingReview}
                                    className={`px-6 py-2 rounded-lg ${detail.isSubmittingReview ? 'bg-slate-400' : 'bg-primary'}`}
                                    accessibilityRole="button"
                                    accessibilityLabel="Submit review"
                                    accessibilityState={{ disabled: detail.isSubmittingReview, busy: detail.isSubmittingReview }}
                                >
                                    {detail.isSubmittingReview ? (
                                        <ActivityIndicator size="small" color={Colors.white} />
                                    ) : (
                                        <Text className="font-bold text-background-dark">Submit</Text>
                                    )}
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}

                    {detail.loadingReviews ? (
                        <ActivityIndicator size="small" color={Colors.primary} className="mt-4" />
                    ) : detail.reviews.length > 0 ? (
                        <View className="gap-4">
                            {detail.reviews.map((review) => (
                                <View key={review.id} className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-100 dark:border-slate-700 shadow-sm">
                                    <View className="flex-row justify-between items-start mb-2">
                                        <View className="flex-row items-center gap-3">
                                            <View className="h-10 w-10 items-center justify-center rounded-full bg-primary/20 dark:bg-primary/30 overflow-hidden">
                                                {/* B7 fix: if avatar_url is a real URL (from OAuth providers), render
                                                    it as an Image. Otherwise render the emoji/initials as text. */}
                                                {review.profile?.avatar_url?.startsWith('http') ? (
                                                    <Image
                                                        source={{ uri: review.profile.avatar_url }}
                                                        className="h-10 w-10 rounded-full"
                                                        accessibilityLabel={`${review.profile.display_name ?? 'User'} avatar`}
                                                    />
                                                ) : (
                                                    <Text className="text-lg font-bold text-slate-800 dark:text-amber-400">
                                                        {review.profile?.avatar_url ||
                                                            (review.profile?.display_name
                                                                ? review.profile.display_name.charAt(0).toUpperCase()
                                                                : '👤')}
                                                    </Text>
                                                )}
                                            </View>
                                            <View>
                                                <Text className="font-bold text-slate-900 dark:text-white">
                                                    {review.profile?.display_name || 'Anonymous User'}
                                                </Text>
                                                <Text className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                                    {new Date(review.created_at).toLocaleDateString()}
                                                </Text>
                                            </View>
                                        </View>
                                        <View className="flex-row">
                                            {[...Array(5)].map((_, i) => (
                                                <Icon key={i} name={i < review.rating ? "star" : "star-border"} size={16} color={Colors.primary} />
                                            ))}
                                        </View>
                                    </View>
                                    {review.comment && (
                                        <Text className="text-slate-700 dark:text-slate-300 mt-2 leading-relaxed pl-13">
                                            {review.comment}
                                        </Text>
                                    )}
                                </View>
                            ))}
                        </View>
                    ) : (
                        <View className="items-center justify-center py-8">
                            <Icon name="comment" size={48} color={Colors.reviewIcon} />
                            <Text className="text-slate-500 dark:text-slate-400 mt-4 text-center">No reviews yet. Be the first to review this venue!</Text>
                        </View>
                    )}
                </View>

                <View className="px-4 pb-10 -mt-14">
                    <TouchableOpacity
                        onPress={() => setReportOpen(true)}
                        className="flex-row items-center justify-center gap-2 py-3"
                        accessibilityRole="button"
                        accessibilityLabel={`Report a problem with ${deal.name}`}
                    >
                        <Icon name="flag" size={16} color={Colors.textMuted} />
                        <Text className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                            Something wrong with this deal?
                        </Text>
                    </TouchableOpacity>
                </View>

            </ScrollView>

            <FeedbackModal
                visible={reportOpen}
                onClose={() => setReportOpen(false)}
                kind="deal_report"
                deal={deal}
            />

            <SafeAreaView pointerEvents="box-none" className="absolute top-0 left-0 right-0 flex-row justify-between items-center p-4" edges={['top']}>
                <TouchableOpacity
                    onPress={() => router.back()}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/40 active:scale-95"
                    accessibilityRole="button"
                    accessibilityLabel="Go back"
                >
                    <Icon name="arrow-back" size={24} color="white" />
                </TouchableOpacity>
                <View pointerEvents="box-none" className="flex-row gap-2">
                    <TouchableOpacity
                        onPress={() => {
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                            toggleSave(deal.id, { deal: deal.deal, time: deal.time, name: deal.name, daysActive: deal.daysActive });
                        }}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/40 active:scale-95"
                        accessibilityRole="button"
                        accessibilityLabel={isSaved(deal.id) ? 'Remove from saved' : 'Save deal'}
                    >
                        <Icon name={isSaved(deal.id) ? 'bookmark' : 'bookmark-border'} size={24} color={isSaved(deal.id) ? Colors.primary : Colors.white} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={detail.handleShare}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/40 active:scale-95"
                        accessibilityRole="button"
                        accessibilityLabel="Share this deal"
                    >
                        <Icon name="share" size={24} color="white" />
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        </KeyboardAvoidingView>
    );
}
