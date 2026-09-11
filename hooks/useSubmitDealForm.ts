import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { TextInput, ScrollView, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useRewards } from '../context/RewardsContext';
import {
    submitUserDeal,
    SubmitDealData,
    DealSubmissionRateLimitError,
    VenueSearchResult,
    getFilterOptions,
} from '../services/dealService';
import { storageService, ImageTooLargeError, ImageDimensions } from '../services/storageService';
import {
    scanDealPhoto,
    isDealScanConfigured,
    DealScanRateLimitError,
    DealScanUnavailableError,
} from '../services/dealScanService';
import { Schedule } from '../types';
import { normalizeTimeWindow, timeWindowToMinutes, buildTimeWindow } from '../utils/dealTime';
import {
    DAY_PRESETS,
    TIME_PRESETS,
    type DayPreset,
    type TimePreset,
    timeWindowForPreset,
    snapToSlot,
    mergeTagSuggestions,
} from '../constants/submitPresets';
import { useVenueSearch } from './useVenueSearch';
import { useDealDraft } from './useDealDraft';
import { useLocationScope } from './useLocationScope';
import { Analytics } from '../services/analytics';
import { Logger } from '../services/logger';

// The schedule shape lives in types.ts as `Schedule`. This alias is kept
// because the form and its tests have always referred to it by this name.
export type DealSchedule = Schedule;

export type ScheduleErrors = { days?: string; timeWindow?: string; dealTitle?: string };

export interface SubmitFormErrors {
    venueName?: string;
    address?: string;
    neighborhood?: string;
    schedules?: Record<number, ScheduleErrors>;
}

const EMPTY_SCHEDULE: DealSchedule = { days: [], timeWindow: '', dealTitle: '' };

/** Deal descriptions are capped in the database and by the input itself. */
const DEAL_TITLE_MAX = 200;

const RATE_LIMIT_KEY = 'last_deal_submission_time';
const RATE_LIMIT_SECONDS = 60;

/**
 * All state and business logic for the submit-a-deal form: field state,
 * per-schedule editing, image picker handlers, photo scanning, client-side
 * validation, rate limiting, image upload, and submission. Kept separate from
 * the screen's JSX so the form logic is testable/reusable independent of layout.
 */
export function useSubmitDealForm() {
    const router = useRouter();
    const { awardDealSubmittedPoints } = useRewards();

    const [venueName, setVenueName] = useState('');
    const [address, setAddress] = useState('');
    const [neighborhood, setNeighborhood] = useState('');
    const [schedules, setSchedules] = useState<DealSchedule[]>([{ ...EMPTY_SCHEDULE }]);
    // $$ rather than $: most happy hours are not in the cheapest bucket, so the
    // old default was the wrong guess more often than it was the right one.
    const [priceLevel, setPriceLevel] = useState<number>(2);
    const [tagsInput, setTagsInput] = useState('');

    // The venue picked out of autocomplete, if any. Submitting with this set
    // lets the server skip both the name-match lookup and the geocode.
    const [resolvedVenueId, setResolvedVenueId] = useState<string | undefined>(undefined);

    // Nothing is marked invalid until the user has actually tried to submit;
    // after that, errors follow the fields, so one clears the moment it is
    // fixed rather than lingering until the next submit press.
    const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

    const [tagSuggestions, setTagSuggestions] = useState<string[]>(() => mergeTagSuggestions([]));
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Bumped on each successful submission so the "Your submissions" list refetches.
    const [submissionCount, setSubmissionCount] = useState(0);
    // F5: state for photo upload
    const [selectedImage, setSelectedImage] = useState<string | null>(null);
    // Public URL of `selectedImage` once uploaded. Set by whichever comes first,
    // scanning or submitting, so a photo is never uploaded twice.
    const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>(null);
    // The picker knows the photo's dimensions; the uploader needs them to decide
    // whether resizing would shrink the file or enlarge it.
    const [selectedImageSize, setSelectedImageSize] = useState<ImageDimensions | undefined>(undefined);
    // The other photo: the venue itself, used as its artwork. Deliberately a
    // separate picker from the menu shot above rather than one photo doing both
    // jobs — a picture of a menu board is evidence for a reviewer, and putting
    // it on a card as though it were the place was the bug this pair replaces.
    const [selectedVenuePhoto, setSelectedVenuePhoto] = useState<string | null>(null);
    const [uploadedVenuePhotoUrl, setUploadedVenuePhotoUrl] = useState<string | null>(null);
    const [venuePhotoSize, setVenuePhotoSize] = useState<ImageDimensions | undefined>(undefined);
    const [isScanning, setIsScanning] = useState(false);
    // What the last scan did, shown under the photo. The user must be able to
    // tell a filled-in-from-photo field from one they typed, because the model
    // misreads and they are the one who can catch it.
    const [scanNotice, setScanNotice] = useState<string | null>(null);

    // Refs for input focus navigation (Q10)
    const addressInputRef = useRef<TextInput>(null);
    const neighborhoodInputRef = useRef<TextInput>(null);
    const tagsInputRef = useRef<TextInput>(null);

    // ── Venue ───────────────────────────────────────────────────────────────

    const venueSearch = useVenueSearch(venueName, !resolvedVenueId);
    const { scope } = useLocationScope();

    /**
     * Any hand-edit of the venue's identifying fields invalidates the picked
     * venue.
     *
     * `venues` has no UPDATE policy, so a submission carrying a venueId ignores
     * the address and neighborhood entirely. Holding the id after the user
     * corrected an address would silently throw that correction away; dropping
     * it costs one lookup query and keeps the edit.
     */
    const clearResolvedVenue = useCallback(() => setResolvedVenueId(undefined), []);

    const handleVenueNameChange = useCallback((text: string) => {
        setVenueName(text);
        clearResolvedVenue();
    }, [clearResolvedVenue]);

    const handleAddressChange = useCallback((text: string) => {
        setAddress(text);
        clearResolvedVenue();
    }, [clearResolvedVenue]);

    const handleNeighborhoodChange = useCallback((text: string) => {
        setNeighborhood(text);
        clearResolvedVenue();
    }, [clearResolvedVenue]);

    /** One tap fills the three fields the user would otherwise type out. */
    const selectVenue = useCallback((venue: VenueSearchResult) => {
        setVenueName(venue.name);
        setAddress(venue.address);
        setNeighborhood(venue.neighborhood);
        setResolvedVenueId(venue.id);
        venueSearch.clearResults();
    }, [venueSearch]);

    /** Keep the typed name and create a new venue from it. */
    const useTypedVenueName = useCallback(() => {
        setResolvedVenueId(undefined);
        venueSearch.clearResults();
    }, [venueSearch]);

    // ── Schedule shortcuts ──────────────────────────────────────────────────

    const applyDayPreset = useCallback((index: number, preset: DayPreset) => {
        setSchedules(prev => prev.map((s, i) => (i === index ? { ...s, days: [...preset.days] } : s)));
    }, []);

    const applyTimePreset = useCallback((index: number, preset: TimePreset) => {
        setSchedules(prev => prev.map((s, i) =>
            i === index ? { ...s, timeWindow: timeWindowForPreset(preset) } : s));
    }, []);

    /** Compose the window from the Start/End pickers, which cannot produce an invalid one. */
    const setScheduleTimeRange = useCallback((index: number, startMinutes: number, endMinutes: number | null) => {
        setSchedules(prev => prev.map((s, i) =>
            i === index ? { ...s, timeWindow: buildTimeWindow(startMinutes, endMinutes) } : s));
    }, []);

    /**
     * Where the pickers should sit for a schedule, so a restored draft, a
     * scanned photo or a typed window all seed them the same way.
     */
    const scheduleTimeRange = useCallback((timeWindow: string) => {
        const parsed = timeWindowToMinutes(timeWindow);
        if (!parsed) return null;
        return {
            startMinutes: snapToSlot(parsed.startMinutes),
            endMinutes: parsed.endMinutes === null ? null : snapToSlot(parsed.endMinutes),
        };
    }, []);

    /** Coerce whatever was typed into the canonical form, on blur. */
    const normalizeScheduleTime = useCallback((index: number) => {
        setSchedules(prev => prev.map((s, i) => {
            if (i !== index) return s;
            const normalized = normalizeTimeWindow(s.timeWindow);
            return normalized ? { ...s, timeWindow: normalized } : s;
        }));
    }, []);

    const appendDealSnippet = useCallback((index: number, snippet: string) => {
        setSchedules(prev => prev.map((s, i) => {
            if (i !== index) return s;
            const existing = s.dealTitle.trim();
            const combined = existing ? `${existing}, ${snippet}` : snippet;
            // The column and the input both cap at 200; dropping the addition
            // is better than silently truncating what the user already wrote.
            if (combined.length > DEAL_TITLE_MAX) return s;
            return { ...s, dealTitle: combined };
        }));
    }, []);

    // ── Tags ────────────────────────────────────────────────────────────────

    const selectedTags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);

    /**
     * Chips edit the same comma-separated string the free-text field owns, so
     * there is exactly one source of truth for what gets submitted.
     */
    const toggleTag = useCallback((tag: string) => {
        setTagsInput(prev => {
            const current = prev.split(',').map(t => t.trim()).filter(Boolean);
            const match = current.find(t => t.toLowerCase() === tag.toLowerCase());
            const next = match ? current.filter(t => t !== match) : [...current, tag];
            return next.join(', ');
        });
    }, []);

    // ── Draft ───────────────────────────────────────────────────────────────

    const draft = useDealDraft();
    const [draftRestored, setDraftRestored] = useState(false);

    // Apply a restored draft exactly once, then let the banner explain itself.
    useEffect(() => {
        if (!draft.restored) return;
        const d = draft.restored;
        setVenueName(d.venueName);
        setAddress(d.address);
        setNeighborhood(d.neighborhood);
        setResolvedVenueId(d.venueId);
        setSchedules(d.schedules.length > 0 ? d.schedules : [{ ...EMPTY_SCHEDULE }]);
        setPriceLevel(d.priceLevel);
        setTagsInput(d.tagsInput);
        if (d.uploadedImageUrl) {
            // The stored value is the uploaded https:// URL, which renders in
            // <Image> directly and lets ensureUploaded() short-circuit, so a
            // restored photo is never uploaded a second time.
            setSelectedImage(d.uploadedImageUrl);
            setUploadedImageUrl(d.uploadedImageUrl);
        }
        if (d.uploadedVenuePhotoUrl) {
            setSelectedVenuePhoto(d.uploadedVenuePhotoUrl);
            setUploadedVenuePhotoUrl(d.uploadedVenuePhotoUrl);
        }
        setDraftRestored(true);
        draft.acknowledgeRestore();
    }, [draft]);

    const { save: saveDraft, clear: clearDraft, hasLoaded: draftLoaded } = draft;

    useEffect(() => {
        if (!draftLoaded) return;
        saveDraft({
            venueName, venueId: resolvedVenueId, address, neighborhood,
            schedules, priceLevel, tagsInput,
            uploadedImageUrl: uploadedImageUrl ?? undefined,
            uploadedVenuePhotoUrl: uploadedVenuePhotoUrl ?? undefined,
        });
    }, [
        draftLoaded, saveDraft, venueName, resolvedVenueId, address, neighborhood,
        schedules, priceLevel, tagsInput, uploadedImageUrl, uploadedVenuePhotoUrl,
    ]);

    const discardDraft = useCallback(async () => {
        await clearDraft();
        setVenueName('');
        setAddress('');
        setNeighborhood('');
        setResolvedVenueId(undefined);
        setSchedules([{ ...EMPTY_SCHEDULE }]);
        setPriceLevel(2);
        setTagsInput('');
        setSelectedImage(null);
        setUploadedImageUrl(null);
        setSelectedVenuePhoto(null);
        setUploadedVenuePhotoUrl(null);
        setHasAttemptedSubmit(false);
        setDraftRestored(false);
    }, [clearDraft]);

    // ── Tag suggestions ─────────────────────────────────────────────────────

    useEffect(() => {
        let cancelled = false;
        getFilterOptions(scope)
            .then(({ tags }) => {
                if (!cancelled) setTagSuggestions(mergeTagSuggestions(tags));
            })
            .catch(() => {
                // The curated base list is already in state, so a failed fetch
                // costs nothing visible.
            });
        return () => { cancelled = true; };
    }, [scope]);

    const updateSchedule = useCallback((index: number, updates: Partial<DealSchedule>) => {
        setSchedules(prev => prev.map((s, i) => (i === index ? { ...s, ...updates } : s)));
    }, []);

    const toggleScheduleDay = useCallback((index: number, dayIdx: number) => {
        setSchedules(prev => prev.map((s, i) => {
            if (i !== index) return s;
            const days = s.days.includes(dayIdx)
                ? s.days.filter(d => d !== dayIdx)
                : [...s.days, dayIdx];
            return { ...s, days };
        }));
    }, []);

    const addSchedule = useCallback(() => {
        setSchedules(prev => [...prev, { ...EMPTY_SCHEDULE }]);
    }, []);

    const removeSchedule = useCallback((index: number) => {
        setSchedules(prev => prev.filter((_, i) => i !== index));
    }, []);

    // Picking a different photo invalidates whatever the last one was read as.
    const acceptPickedImage = useCallback((asset: { uri: string; width?: number; height?: number }) => {
        setSelectedImage(asset.uri);
        setSelectedImageSize(
            asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined,
        );
        setUploadedImageUrl(null);
        setScanNotice(null);
    }, []);

    // F5: Camera and gallery picker handlers
    const handlePickImage = useCallback(async () => {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert("Permission Required", "We need permission to access your gallery to upload photos.");
            return;
        }

        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [4, 3],
            quality: 0.8,
        });

        if (!result.canceled && result.assets && result.assets.length > 0) {
            acceptPickedImage(result.assets[0]);
        }
    }, [acceptPickedImage]);

    const handleTakePhoto = useCallback(async () => {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert("Permission Required", "We need permission to access your camera to take photos.");
            return;
        }

        const result = await ImagePicker.launchCameraAsync({
            allowsEditing: true,
            aspect: [4, 3],
            quality: 0.8,
        });

        if (!result.canceled && result.assets && result.assets.length > 0) {
            acceptPickedImage(result.assets[0]);
        }
    }, [acceptPickedImage]);

    const handleRemoveImage = useCallback(() => {
        // A scanned photo is already in the bucket, so removing it here has to
        // take it back out — otherwise every abandoned scan leaves an orphan
        // nobody can delete. Best-effort: the user's intent is served either way.
        if (uploadedImageUrl) {
            storageService.deleteVenueImage(uploadedImageUrl).catch(() => {});
        }
        setSelectedImage(null);
        setSelectedImageSize(undefined);
        setUploadedImageUrl(null);
        setScanNotice(null);
    }, [uploadedImageUrl]);

    /**
     * Upload the picked photo if it is not already up, returning its public URL.
     * Both scanning and submitting need it, and neither should upload twice.
     */
    const ensureUploaded = useCallback(async (): Promise<string | null> => {
        if (!selectedImage) return null;
        if (uploadedImageUrl) return uploadedImageUrl;

        const url = await storageService.uploadLocalImage(selectedImage, selectedImageSize);
        setUploadedImageUrl(url);
        return url;
    }, [selectedImage, selectedImageSize, uploadedImageUrl]);

    // ── The venue's own photo ───────────────────────────────────────────────
    // Same three handlers as the menu photo, against their own state. They are
    // not shared: the two photos are picked, removed and uploaded independently,
    // and only this one is ever scanned.

    const acceptPickedVenuePhoto = useCallback((asset: { uri: string; width?: number; height?: number }) => {
        setSelectedVenuePhoto(asset.uri);
        setVenuePhotoSize(
            asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined,
        );
        setUploadedVenuePhotoUrl(null);
    }, []);

    const handlePickVenuePhoto = useCallback(async () => {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert("Permission Required", "We need permission to access your gallery to upload photos.");
            return;
        }

        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [4, 3],
            quality: 0.8,
        });

        if (!result.canceled && result.assets && result.assets.length > 0) {
            acceptPickedVenuePhoto(result.assets[0]);
        }
    }, [acceptPickedVenuePhoto]);

    const handleTakeVenuePhoto = useCallback(async () => {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert("Permission Required", "We need permission to access your camera to take photos.");
            return;
        }

        const result = await ImagePicker.launchCameraAsync({
            allowsEditing: true,
            aspect: [4, 3],
            quality: 0.8,
        });

        if (!result.canceled && result.assets && result.assets.length > 0) {
            acceptPickedVenuePhoto(result.assets[0]);
        }
    }, [acceptPickedVenuePhoto]);

    const handleRemoveVenuePhoto = useCallback(() => {
        // Already in the bucket if a draft restored it or a submission failed
        // after uploading, so removing it here has to take it back out too.
        if (uploadedVenuePhotoUrl) {
            storageService.deleteVenueImage(uploadedVenuePhotoUrl).catch(() => {});
        }
        setSelectedVenuePhoto(null);
        setVenuePhotoSize(undefined);
        setUploadedVenuePhotoUrl(null);
    }, [uploadedVenuePhotoUrl]);

    /** The venue photo's equivalent of ensureUploaded(). Only submit needs it. */
    const ensureVenuePhotoUploaded = useCallback(async (): Promise<string | null> => {
        if (!selectedVenuePhoto) return null;
        if (uploadedVenuePhotoUrl) return uploadedVenuePhotoUrl;

        const url = await storageService.uploadLocalImage(selectedVenuePhoto, venuePhotoSize);
        setUploadedVenuePhotoUrl(url);
        return url;
    }, [selectedVenuePhoto, venuePhotoSize, uploadedVenuePhotoUrl]);

    /**
     * Read the deal off the photo and fill in what the form is still missing.
     *
     * Deliberately fills blanks only. Anything already typed is the user's, and
     * the scan is a suggestion — the whole point of returning the result to the
     * form instead of submitting it is that a person confirms it first.
     */
    const handleScanPhoto = useCallback(async () => {
        if (!selectedImage || isScanning) return;

        setIsScanning(true);
        setScanNotice(null);

        try {
            const imageUrl = await ensureUploaded();
            if (!imageUrl) return;

            const result = await scanDealPhoto({
                imageUrl,
                venueName: venueName.trim(),
                neighborhood: neighborhood.trim(),
                address: address.trim(),
            });

            Analytics.track('deal_photo_scanned', { usable: result.usable });

            if (!result.usable || result.deals.length === 0) {
                setScanNotice(
                    `Couldn't read a deal from that photo — ${result.reason ?? 'it was not legible'}. Fill the form in by hand, or try a clearer photo.`,
                );
                return;
            }

            const scannedDeals = result.deals;
            const first = scannedDeals[0];

            // Venue, price and tags belong to the submission, not to any one
            // window, so they come off the first entry.
            if (!venueName.trim() && first.venueName) setVenueName(first.venueName);
            if (first.priceLevel) setPriceLevel(first.priceLevel);
            if (!tagsInput.trim() && first.tags.length > 0) setTagsInput(first.tags.join(', '));

            // A board reading "Mon-Thu 4-6, Fri 12-3" is two schedules, and the
            // form has always been able to hold several -- it was the scan that
            // could only fill one. Anything the user has already typed wins, so
            // a scan run halfway through filling the form never overwrites it.
            setSchedules(prev => {
                const rows = Math.max(prev.length, scannedDeals.length);
                return Array.from({ length: rows }, (_, index) => {
                    const schedule = prev[index] ?? { ...EMPTY_SCHEDULE };
                    const scanned = scannedDeals[index];
                    if (!scanned) return schedule;

                    // The model writes whatever was on the menu board --
                    // "3-6pm", "15:00-18:00" -- which the old code stored
                    // verbatim and the validator then rejected. Normalizing
                    // here is what lets a scan seed the time pickers at all.
                    const scannedWindow = scanned.timeWindow
                        ? normalizeTimeWindow(scanned.timeWindow) ?? scanned.timeWindow
                        : '';
                    return {
                        days: schedule.days.length > 0 ? schedule.days : scanned.daysActive,
                        timeWindow: schedule.timeWindow.trim() || scannedWindow,
                        dealTitle: schedule.dealTitle.trim() || scanned.title || '',
                    };
                });
            });

            setScanNotice(
                scannedDeals.length > 1
                    ? `Filled in ${scannedDeals.length} sets of hours from your photo. Check every field before submitting — it still goes to a moderator.`
                    : 'Filled in from your photo. Check every field before submitting — it still goes to a moderator.',
            );
        } catch (e) {
            if (e instanceof DealScanRateLimitError) {
                setScanNotice(e.message);
            } else if (e instanceof DealScanUnavailableError) {
                setScanNotice('Photo scanning is not available right now. Fill the form in by hand.');
            } else if (e instanceof ImageTooLargeError) {
                setScanNotice('That photo is over 5MB. Try taking it again, or pick a smaller one.');
            } else {
                Logger.error('Failed to scan deal photo', e);
                setScanNotice("Couldn't read that photo just now. Fill the form in by hand, or try again.");
            }
        } finally {
            setIsScanning(false);
        }
    }, [selectedImage, isScanning, ensureUploaded, venueName, neighborhood, address, tagsInput]);

    /**
     * Errors for the whole form, keyed by field.
     *
     * Pure so it can be reused for on-blur checks without touching state, and
     * so the shape is what the tests assert on. It reports every problem at
     * once rather than the old behaviour of alerting about the first one it
     * found and making the user resubmit to discover the next.
     */
    const collectErrors = useCallback((): SubmitFormErrors => {
        const next: SubmitFormErrors = {};

        if (!venueName.trim()) next.venueName = 'Add the venue name.';
        if (!address.trim()) next.address = 'Add the street address.';
        if (!neighborhood.trim()) next.neighborhood = 'Add the neighborhood.';

        const scheduleErrors: Record<number, ScheduleErrors> = {};
        schedules.forEach((schedule, index) => {
            const problems: ScheduleErrors = {};

            if (schedule.days.length === 0) {
                problems.days = 'Pick at least one day.';
            }

            const trimmedWindow = schedule.timeWindow.trim();
            if (!trimmedWindow) {
                problems.timeWindow = 'Add a start and end time.';
            } else if (!normalizeTimeWindow(trimmedWindow)) {
                // "All day" and "varies" give us no start either, so there is
                // nothing to store; say so rather than calling them invalid.
                problems.timeWindow = /all\s*day|varies/i.test(trimmedWindow)
                    ? 'Give a start time — "all day" can\'t be shown on the deal card.'
                    : 'Use a time like "4 PM - 6 PM", or "4 PM - close".';
            }

            if (!schedule.dealTitle.trim()) {
                problems.dealTitle = 'Say what the deal is.';
            }

            if (Object.keys(problems).length > 0) scheduleErrors[index] = problems;
        });

        if (Object.keys(scheduleErrors).length > 0) next.schedules = scheduleErrors;
        return next;
    }, [venueName, address, neighborhood, schedules]);

    const hasErrors = (found: SubmitFormErrors): boolean =>
        Boolean(found.venueName || found.address || found.neighborhood || found.schedules);

    const errors = useMemo(
        () => (hasAttemptedSubmit ? collectErrors() : {}),
        [hasAttemptedSubmit, collectErrors],
    );

    const validateForm = useCallback(() => {
        setHasAttemptedSubmit(true);
        return !hasErrors(collectErrors());
    }, [collectErrors]);

    // ── Scrolling to the first thing that is wrong ──────────────────────────

    const scrollRef = useRef<ScrollView>(null);
    const fieldOffsets = useRef<Record<string, number>>({});

    /** Fields report their y offset as they lay out; see FormField. */
    const registerFieldOffset = useCallback((key: string, y: number) => {
        fieldOffsets.current[key] = y;
    }, []);

    const scrollToFirstError = useCallback((found: SubmitFormErrors) => {
        const keys: string[] = [];
        if (found.venueName) keys.push('venueName');
        if (found.address) keys.push('address');
        if (found.neighborhood) keys.push('neighborhood');
        // Schedule sub-fields scroll to their card: a card offset is stable,
        // whereas measuring a nested input means a measureLayout chain.
        Object.keys(found.schedules ?? {}).forEach(i => keys.push(`schedule-${i}`));

        const offsets = keys
            .map(k => fieldOffsets.current[k])
            .filter((y): y is number => typeof y === 'number');
        if (offsets.length === 0) return;

        scrollRef.current?.scrollTo({ y: Math.max(0, Math.min(...offsets) - 24), animated: true });
    }, []);

    const handleSubmit = useCallback(async () => {
        const found = collectErrors();
        setHasAttemptedSubmit(true);
        if (hasErrors(found)) {
            scrollToFirstError(found);
            return;
        }

        setIsSubmitting(true);

        // Local 60-second cooldown. This is a UX guard against double-taps and
        // impatient resubmits, NOT a security control — it lives in AsyncStorage,
        // so wiping app data clears it and it does not exist at all for anyone
        // posting straight to the REST API. The real limit is enforced by the
        // `enforce_deal_submission_rate_limit` trigger in Postgres; failures from
        // that surface through the submit error path below.
        try {
            const lastSubmitTimeStr = await AsyncStorage.getItem(RATE_LIMIT_KEY);
            if (lastSubmitTimeStr) {
                const lastSubmitTime = parseInt(lastSubmitTimeStr, 10);
                const diffSeconds = Math.floor((Date.now() - lastSubmitTime) / 1000);
                if (diffSeconds < RATE_LIMIT_SECONDS) {
                    const remaining = RATE_LIMIT_SECONDS - diffSeconds;
                    Alert.alert(
                        "Please Wait",
                        `You are submitting deals too quickly. Please wait ${remaining} seconds before submitting another deal.`
                    );
                    setIsSubmitting(false);
                    return;
                }
            }
        } catch (e) {
            Logger.error('Failed to check rate limiting', e);
        }

        let uploadedUrl: string | undefined = undefined;
        if (selectedImage) {
            try {
                uploadedUrl = (await ensureUploaded()) ?? undefined;
            } catch (uploadError) {
                Logger.error('Failed to upload image', uploadError);
                Alert.alert(
                    "Upload Failed",
                    uploadError instanceof ImageTooLargeError
                        ? "That photo is over 5MB. Please pick a smaller one, or submit without a photo."
                        : "Could not upload the selected image. Please try again or submit without an image."
                );
                setIsSubmitting(false);
                return;
            }
        }

        let uploadedVenueUrl: string | undefined = undefined;
        if (selectedVenuePhoto) {
            try {
                uploadedVenueUrl = (await ensureVenuePhotoUploaded()) ?? undefined;
            } catch (uploadError) {
                Logger.error('Failed to upload venue photo', uploadError);
                Alert.alert(
                    "Upload Failed",
                    uploadError instanceof ImageTooLargeError
                        ? "That photo of the venue is over 5MB. Please pick a smaller one, or remove it and submit."
                        : "Could not upload the photo of the venue. Please try again, or remove it and submit."
                );
                setIsSubmitting(false);
                return;
            }
        }

        const tags = tagsInput.split(',').map(t => t.trim()).filter(t => t.length > 0);

        const data: SubmitDealData = {
            venueName: venueName.trim(),
            venueId: resolvedVenueId,
            address: address.trim(),
            neighborhood: neighborhood.trim(),
            priceLevel,
            // Not a submitter's call. 'trending', 'new' and 'ends-soon' are
            // editorial states the app derives; offering them here only let a
            // submitter label their own deal as trending.
            type: 'regular',
            tags,
            // Store the canonical form whatever route it came in by -- picker,
            // preset, free text or photo scan.
            schedules: schedules.map(schedule => ({
                ...schedule,
                timeWindow: normalizeTimeWindow(schedule.timeWindow) ?? schedule.timeWindow.trim(),
            })),
            imageUrl: uploadedUrl,
            venuePhotoUrl: uploadedVenueUrl,
        };

        try {
            const success = await submitUserDeal(data);

            if (success) {
                // S3: Save submission timestamp on success
                await AsyncStorage.setItem(RATE_LIMIT_KEY, Date.now().toString()).catch(() => {});
                setSubmissionCount(prev => prev + 1);
                // The work is filed; keeping the draft would restore it over
                // the next submission.
                await clearDraft();

                // Award rewards points for deal submission
                awardDealSubmittedPoints().catch(e =>
                    Logger.error('Failed to award deal submission points', e)
                );

                // Track analytics event
                Analytics.track('deal_submitted', { venueName: data.venueName, neighborhood: data.neighborhood });

                Alert.alert(
                    "Deal Submitted",
                    "Thanks for sharing! Your deal has been submitted and is pending approval by our moderators.",
                    [{ text: "OK", onPress: () => router.back() }]
                );
            } else {
                Alert.alert("Submission Failed", "There was an error submitting your deal. Please try again.");
            }
        } catch (e) {
            if (e instanceof DealSubmissionRateLimitError) {
                Alert.alert(
                    "Too Many Submissions",
                    "You've submitted a lot of deals recently. Please try again later — this helps us keep the listings trustworthy."
                );
            } else {
                Logger.error('Unexpected error submitting deal', e);
                Alert.alert("Submission Failed", "There was an error submitting your deal. Please try again.");
            }
        } finally {
            // Q3 fix: always re-enable the button, even if submitUserDeal throws
            setIsSubmitting(false);
        }
    }, [collectErrors, scrollToFirstError, selectedImage, ensureUploaded, selectedVenuePhoto, ensureVenuePhotoUploaded, tagsInput, venueName, address, neighborhood, priceLevel, resolvedVenueId, schedules, awardDealSubmittedPoints, router, clearDraft]);

    return {
        venueName, setVenueName: handleVenueNameChange,
        address, setAddress: handleAddressChange,
        neighborhood, setNeighborhood: handleNeighborhoodChange,
        schedules, updateSchedule, toggleScheduleDay, addSchedule, removeSchedule,
        priceLevel, setPriceLevel,
        tagsInput, setTagsInput,
        isSubmitting,
        submissionCount,
        selectedImage,
        isScanning,
        scanNotice,
        canScanPhoto: isDealScanConfigured(),
        addressInputRef, neighborhoodInputRef, tagsInputRef,
        handlePickImage, handleTakePhoto, handleRemoveImage, handleScanPhoto,
        selectedVenuePhoto,
        handlePickVenuePhoto, handleTakeVenuePhoto, handleRemoveVenuePhoto,
        handleSubmit,

        // Venue autocomplete
        venueResults: venueSearch.results,
        isSearchingVenues: venueSearch.isSearching,
        resolvedVenueId,
        selectVenue,
        useTypedVenueName,
        clearResolvedVenue,

        // Schedule shortcuts
        dayPresets: DAY_PRESETS,
        timePresets: TIME_PRESETS,
        applyDayPreset,
        applyTimePreset,
        setScheduleTimeRange,
        scheduleTimeRange,
        normalizeScheduleTime,
        appendDealSnippet,

        // Tags
        selectedTags,
        tagSuggestions,
        toggleTag,

        // Validation
        errors,
        hasAttemptedSubmit,
        validateForm,
        scrollRef,
        registerFieldOffset,

        // Draft
        draftRestored,
        discardDraft,
        dismissDraftBanner: () => setDraftRestored(false),
    };
}
