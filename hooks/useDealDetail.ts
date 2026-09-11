import { useState, useEffect, useCallback, useRef } from 'react';
import { Share, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useVisits } from '../context/VisitsContext';
import { useAuth } from '../context/AuthContext';
import { useRewards } from '../context/RewardsContext';
import { getDealById, getDealsByVenueId } from '../services/dealService';
import { reviewService, Review } from '../services/reviewService';
import { Deal } from '../types';
import { Analytics } from '../services/analytics';
import { Logger } from '../services/logger';
import { getDealShareUrl } from '../constants/links';

/**
 * All state and business logic for the deal detail screen: deal + related
 * venue-deals fetching, review fetching/submission, check-in, and sharing.
 * Kept separate from the screen's JSX so the data/interaction logic is
 * testable independent of layout.
 */
export function useDealDetail() {
    const { id } = useLocalSearchParams();
    const router = useRouter();
    const { user } = useAuth();
    const { checkIn, getVenueVisitStats } = useVisits();
    const { awardCheckInPoints, awardReviewPoints } = useRewards();

    const [deal, setDeal] = useState<Deal | null>(null);
    const [venueDeals, setVenueDeals] = useState<Deal[]>([]);
    const [loading, setLoading] = useState(true);
    const [imageSource, setImageSource] = useState<{ uri: string } | null>(null);

    useEffect(() => {
        if (deal?.image) {
            setImageSource({ uri: deal.image });
        }
    }, [deal?.image]);

    const setImageError = useCallback((uri: string) => {
        setImageSource({ uri });
    }, []);

    // Check-in state
    const [visitCount, setVisitCount] = useState(0);
    const [checkedInToday, setCheckedInToday] = useState(false);
    const [isCheckingIn, setIsCheckingIn] = useState(false);

    // Reviews state
    const [reviews, setReviews] = useState<Review[]>([]);
    const [loadingReviews, setLoadingReviews] = useState(false);
    const [newRating, setNewRating] = useState(5);
    const [newComment, setNewComment] = useState('');
    const [isSubmittingReview, setIsSubmittingReview] = useState(false);
    const [showReviewForm, setShowReviewForm] = useState(false);
    const isMountedRef = useRef(true);

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const fetchReviews = useCallback(async (venueId: string) => {
        if (isMountedRef.current) {
            setLoadingReviews(true);
        }

        try {
            const fetchedReviews = await reviewService.getReviewsForVenue(venueId);
            if (isMountedRef.current) {
                setReviews(fetchedReviews);
            }
        } catch (error) {
            Logger.error('Failed to fetch reviews', error);
            if (isMountedRef.current) {
                setReviews([]);
            }
        } finally {
            if (isMountedRef.current) {
                setLoadingReviews(false);
            }
        }
    }, []);

    const fetchDeal = useCallback(async () => {
        const dealId = Array.isArray(id) ? id[0] : id;

        try {
            if (!dealId) {
                if (isMountedRef.current) {
                    setDeal(null);
                }
                return;
            }

            const data = await getDealById(dealId);
            if (isMountedRef.current) {
                setDeal(data || null);
                if (data) {
                    Analytics.track('deal_viewed', { dealId: data.id, dealName: data.name, venueId: data.venueId });
                }
            }

            if (data?.venueId) {
                await fetchReviews(data.venueId);
                const vDeals = await getDealsByVenueId(data.venueId);
                if (isMountedRef.current) {
                    setVenueDeals(vDeals);
                }
                // Load visit stats for this venue+deal
                const stats = await getVenueVisitStats(data.venueId, data.id);
                if (isMountedRef.current) {
                    setVisitCount(stats.visitCount);
                    setCheckedInToday(stats.checkedInToday);
                }
            }
        } catch (error) {
            Logger.error('Failed to fetch deal details', error);
            if (isMountedRef.current) {
                setDeal(null);
            }
        } finally {
            if (isMountedRef.current) {
                setLoading(false);
            }
        }
    }, [id, fetchReviews, getVenueVisitStats]);

    useEffect(() => {
        fetchDeal();
    }, [fetchDeal]);

    const handleShare = useCallback(async () => {
        if (!deal) return;
        try {
            // Only attach a URL when a public web origin is configured. The old
            // behavior shared `happyhourfinder://deal/<id>`, which is unopenable
            // for anyone without the app already installed.
            const url = getDealShareUrl(deal.id);
            const body = `Check out ${deal.name} in ${deal.neighborhood}! ${deal.deal} (${deal.time}). Found on Happy Hour Chicago 🍺`;

            await Share.share({
                title: `${deal.name} – Happy Hour Deal`,
                message: url ? `${body}\n\n${url}` : body,
                ...(url ? { url } : {}), // iOS specific
            });
            Analytics.track('deal_shared', { dealId: deal.id, dealName: deal.name });
        } catch (e) {
            Logger.error('Share failed', e);
        }
    }, [deal]);

    const handleCheckIn = useCallback(async () => {
        if (!user) {
            Alert.alert(
                'Log In Required',
                'You need to be logged in to check in at a venue.',
                [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Log In', onPress: () => router.push('/login') },
                ]
            );
            return;
        }
        if (!deal?.venueId) return;
        if (checkedInToday) return;

        setIsCheckingIn(true);
        try {
            const result = await checkIn(deal.venueId, deal.id);
            if (result.success) {
                setCheckedInToday(true);
                setVisitCount(prev => result.alreadyCheckedIn ? prev : prev + 1);
                if (!result.alreadyCheckedIn) {
                    // Award rewards points for this check-in.
                    // B5: isFirstVisit intentionally uses the PRE-check-in visitCount
                    // (still 0 before setVisitCount takes effect). This is the correct
                    // value to determine whether this is the user's very first visit.
                    const isFirstVisit = visitCount === 0;
                    awardCheckInPoints(isFirstVisit).catch(e =>
                        Logger.error('Failed to award check-in points', e)
                    );
                    // Track analytics event
                    Analytics.track('check_in_completed', { dealId: deal.id, venueId: deal.venueId, isFirstVisit });
                    // Haptic feedback on successful new check-in
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
                    Alert.alert('Checked In! 🍺', `You've checked in at ${deal.name}. Enjoy your happy hour!`);
                }
            } else {
                Alert.alert('Error', 'Failed to record your check-in. Please try again.');
            }
        } catch (e) {
            Logger.error('Check-in failed', e);
        } finally {
            if (isMountedRef.current) setIsCheckingIn(false);
        }
    }, [user, deal, checkedInToday, checkIn, visitCount, awardCheckInPoints, router]);

    const handleSubmitReview = useCallback(async () => {
        if (!user) {
            Alert.alert("Authentication Required", "You must be logged in to leave a review.");
            router.push('/login');
            return;
        }

        if (!deal?.venueId) return;

        setIsSubmittingReview(true);
        let result: 'created' | 'updated' | false = false;

        try {
            result = await reviewService.submitReview(deal.venueId, user.id, newRating, newComment.trim() || null);
        } catch (error) {
            Logger.error('Failed to submit review', error);
        } finally {
            if (isMountedRef.current) {
                setIsSubmittingReview(false);
            }
        }

        if (result) {
            const msg = result === 'updated' ? 'Your review has been updated!' : 'Your review has been submitted!';
            Alert.alert("Success", msg);
            setNewComment('');
            setNewRating(5);
            setShowReviewForm(false);
            // Award rewards points only for new reviews, not updates
            if (result === 'created') {
                awardReviewPoints().catch(e =>
                    Logger.error('Failed to award review points', e)
                );
            }
            // Refresh to get the new review and updated average rating
            fetchDeal();
        } else {
            Alert.alert("Error", "Failed to submit review. Please try again.");
        }
    }, [user, deal, newRating, newComment, awardReviewPoints, fetchDeal, router]);

    return {
        deal, venueDeals, loading,
        imageSource, setImageError,
        visitCount, checkedInToday, isCheckingIn, handleCheckIn,
        reviews, loadingReviews,
        newRating, setNewRating,
        newComment, setNewComment,
        isSubmittingReview, showReviewForm, setShowReviewForm,
        handleSubmitReview,
        handleShare,
    };
}
