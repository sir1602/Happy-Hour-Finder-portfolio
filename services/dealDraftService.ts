import AsyncStorage from '@react-native-async-storage/async-storage';
import { Schedule } from '../types';
import { Logger } from './logger';

/**
 * Where a half-finished deal submission is kept between visits to the form.
 *
 * Deliberately a plain AsyncStorage key rather than cacheService: that cache
 * evicts its least-recently-used entries past a ceiling, and getDeals() writes
 * one per debounced search keystroke, so a draft parked there could be thrown
 * away while the user was still typing it.
 */
export const DRAFT_KEY = 'submit_deal_draft_v1';

/** Older than this and the draft is more likely noise than work in progress. */
export const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A guard against a pathological form growing the stored blob without limit. */
export const MAX_DRAFT_SCHEDULES = 10;

export interface DealDraft {
    venueName: string;
    venueId?: string;
    address: string;
    neighborhood: string;
    schedules: Schedule[];
    priceLevel: number;
    tagsInput: string;
    /**
     * The *uploaded* photo only. A local file:// URI from the image picker
     * points into the app's cache directory, which both platforms purge freely,
     * so restoring one would render a broken image and then fail on upload.
     */
    uploadedImageUrl?: string;
    /**
     * The uploaded photo of the venue itself, kept for the same reason and
     * under the same rule as uploadedImageUrl: only ever the https:// URL.
     * Losing it on restore would not merely blank the field — the object is
     * already in the bucket, and nothing else knows to go and delete it.
     */
    uploadedVenuePhotoUrl?: string;
    savedAt: number;
}

export type DraftPayload = Omit<DealDraft, 'savedAt'>;

export const isEmptyDraft = (draft: DraftPayload): boolean =>
    !draft.venueName.trim() &&
    !draft.address.trim() &&
    !draft.neighborhood.trim() &&
    !draft.tagsInput.trim() &&
    !draft.uploadedImageUrl &&
    !draft.uploadedVenuePhotoUrl &&
    draft.schedules.every(s => s.days.length === 0 && !s.timeWindow.trim() && !s.dealTitle.trim());

/** Strip anything we refuse to persist, and cap the size. */
export const serializeDraft = (draft: DraftPayload): DealDraft => ({
    venueName: draft.venueName,
    venueId: draft.venueId,
    address: draft.address,
    neighborhood: draft.neighborhood,
    schedules: draft.schedules.slice(0, MAX_DRAFT_SCHEDULES),
    priceLevel: draft.priceLevel,
    tagsInput: draft.tagsInput,
    ...(draft.uploadedImageUrl ? { uploadedImageUrl: draft.uploadedImageUrl } : {}),
    ...(draft.uploadedVenuePhotoUrl ? { uploadedVenuePhotoUrl: draft.uploadedVenuePhotoUrl } : {}),
    savedAt: Date.now(),
});

/** Writes the draft, unless there is nothing in it worth restoring. */
export const saveDealDraft = async (draft: DraftPayload): Promise<void> => {
    if (isEmptyDraft(draft)) return;
    try {
        await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(serializeDraft(draft)));
    } catch (e) {
        Logger.warn('[dealDraft] Could not save the draft', e);
    }
};

/**
 * The stored draft, or null when there isn't a usable one. A corrupt, stale or
 * wrong-shaped value is cleared and reported as absent — it is indistinguishable
 * from no draft from the form's point of view.
 */
export const readDealDraft = async (): Promise<DraftPayload | null> => {
    try {
        const raw = await AsyncStorage.getItem(DRAFT_KEY);
        if (!raw) return null;

        let parsed: DealDraft;
        try {
            parsed = JSON.parse(raw);
        } catch {
            await clearDealDraft();
            return null;
        }

        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.schedules)) {
            await clearDealDraft();
            return null;
        }
        if (!parsed.savedAt || Date.now() - parsed.savedAt > MAX_DRAFT_AGE_MS) {
            await clearDealDraft();
            return null;
        }

        const { savedAt: _savedAt, ...payload } = parsed;
        return payload;
    } catch (e) {
        Logger.warn('[dealDraft] Could not read the saved draft', e);
        return null;
    }
};

export const clearDealDraft = async (): Promise<void> => {
    try {
        await AsyncStorage.removeItem(DRAFT_KEY);
    } catch (e) {
        Logger.warn('[dealDraft] Could not clear the saved draft', e);
    }
};
