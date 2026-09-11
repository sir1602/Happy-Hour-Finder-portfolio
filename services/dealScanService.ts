import { supabase } from './supabase';
import { Logger } from './logger';

/**
 * Reads a happy hour off a photo by way of the n8n intake API.
 *
 * The flow is deliberately read-only: the app uploads the photo, asks
 * `POST /hh-deal-scan` what it says, and shows the answer in the normal submit
 * form for the user to correct. Nothing is written until they press Submit, so
 * a misreading is something a person sees and fixes rather than something that
 * lands in the database.
 *
 * There is no shared secret here on purpose. Every `EXPO_PUBLIC_*` value is
 * inlined into the app binary and can be read straight out of it, so the
 * endpoint authenticates the *user* instead: their Supabase access token is
 * forwarded, and the workflow spends it on `hh_claim_photo_scan`, which is
 * granted to `authenticated` only and meters the shared Gemini quota per user.
 */

const SCAN_URL = process.env.EXPO_PUBLIC_HH_SCAN_URL?.trim() || '';

/** Gemini plus an image fetch; slow, but not minutes-slow. */
const SCAN_TIMEOUT_MS = 45_000;

export interface ScannedDeal {
    title: string | null;
    description: string | null;
    timeWindow: string | null;
    daysActive: number[];
    tags: string[];
    priceLevel: number;
    venueName: string | null;
    confidence: number;
}

export interface DealScanResult {
    /** The photo was read AND named a deal with a usable time window. */
    usable: boolean;
    /** Why not, in words fit to show the user. Null when `usable`. */
    reason: string | null;
    /**
     * Every distinct set of hours on the board, in the order the model read
     * them. A menu that says "Mon-Thu 4-6, Fri 12-3" is two entries, and the
     * form seeds one schedule row from each -- which is how the app has always
     * stored a happy hour whose hours change with the day.
     */
    deals: ScannedDeal[];
    /**
     * The first of `deals`, kept because it is what the shipped binaries read.
     * Prefer `deals`.
     */
    deal: ScannedDeal | null;
}

export class DealScanUnavailableError extends Error {
    constructor() {
        super('Photo scanning is not configured');
        this.name = 'DealScanUnavailableError';
    }
}

export class DealScanRateLimitError extends Error {
    readonly retryAfterSeconds: number;

    constructor(message: string, retryAfterSeconds: number) {
        super(message);
        this.name = 'DealScanRateLimitError';
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

/** The endpoint is optional: without it the screen hides the scan button. */
export const isDealScanConfigured = (): boolean => SCAN_URL.length > 0;

const asNumberArray = (value: unknown): number[] =>
    Array.isArray(value)
        ? value
            .map((day) => Number(day))
            .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        : [];

const asStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((tag) => String(tag).trim()).filter(Boolean) : [];

const asTrimmedString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

export const scanDealPhoto = async (params: {
    imageUrl: string;
    venueName?: string;
    neighborhood?: string;
    address?: string;
}): Promise<DealScanResult> => {
    if (!SCAN_URL) throw new DealScanUnavailableError();

    const { data, error } = await supabase.auth.getSession();
    const accessToken = data?.session?.access_token;
    if (error || !accessToken) {
        throw new Error('Cannot scan a photo without a signed-in user');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(SCAN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
                image_url: params.imageUrl,
                venue_name: params.venueName ?? '',
                neighborhood: params.neighborhood ?? '',
                address: params.address ?? '',
            }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    // A non-JSON body means something in front of the workflow answered (a
    // proxy, a 502 page). Treat it as a failed scan rather than letting a JSON
    // parse error surface as the reason.
    let body: Record<string, unknown> = {};
    try {
        body = (await response.json()) as Record<string, unknown>;
    } catch {
        Logger.warn(`[dealScanService] Scan endpoint returned a non-JSON body (${response.status})`);
    }

    if (response.status === 429) {
        const retryAfter = Number(body.retry_after_seconds);
        throw new DealScanRateLimitError(
            asTrimmedString(body.message) ?? 'You have scanned a lot of photos recently.',
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 3600,
        );
    }

    if (!response.ok) {
        throw new Error(asTrimmedString(body.message) ?? `Scan failed (${response.status})`);
    }

    // The endpoint answers with `deals` now and `deal` as well, so that an
    // install running an older binary keeps working. Read both, in that order,
    // rather than depending on which side was deployed first.
    const rawDeals = (Array.isArray(body.deals) ? body.deals : [body.deal])
        .filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object');

    const deals = rawDeals.map(
        (rawDeal): ScannedDeal => ({
            title: asTrimmedString(rawDeal.title),
            description: asTrimmedString(rawDeal.description),
            timeWindow: asTrimmedString(rawDeal.time_window),
            daysActive: asNumberArray(rawDeal.days_active),
            tags: asStringArray(rawDeal.tags),
            priceLevel: Number.isInteger(Number(rawDeal.price_level))
                ? Number(rawDeal.price_level)
                : 2,
            venueName: asTrimmedString(rawDeal.venue_name),
            confidence: Number.isFinite(Number(rawDeal.confidence))
                ? Number(rawDeal.confidence)
                : 0,
        }),
    );

    const usable = body.usable === true && deals.length > 0;

    return {
        usable,
        reason: usable ? null : asTrimmedString(body.reason) ?? 'The photo could not be read.',
        deals,
        deal: deals[0] ?? null,
    };
};
