import { buildTimeWindow, formatTimeLabel, CLOSE_LABEL } from '../utils/dealTime';

/**
 * The one-tap shortcuts on the submit-a-deal form.
 *
 * These live outside the screen because both the form hook (which applies them
 * and is unit-tested) and the components (which render them) need the same
 * lists, and because they are the knobs worth tuning as we learn what people
 * actually submit.
 */

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export interface DayPreset {
    label: string;
    days: number[];
}

/** Covers the overwhelming majority of schedules in one tap instead of up to seven. */
export const DAY_PRESETS: DayPreset[] = [
    { label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
    { label: 'Weekdays', days: [1, 2, 3, 4, 5] },
    { label: 'Weekends', days: [0, 6] },
    { label: 'Thu–Sat', days: [4, 5, 6] },
];

/**
 * Whether `days` is exactly this preset, so the chip can render as selected.
 * Order-insensitive, because the day pills append in tap order.
 */
export const daysMatchPreset = (days: number[], preset: DayPreset): boolean =>
    days.length === preset.days.length && preset.days.every(d => days.includes(d));

// ── Time ────────────────────────────────────────────────────────────────────

const MINUTES_PER_DAY = 24 * 60;
const SLOT_MINUTES = 30;

/** Earliest a happy hour plausibly starts. */
export const FIRST_START_MINUTES = 11 * 60;
/** Latest a happy hour plausibly starts. */
export const LAST_START_MINUTES = 23 * 60 + 30;
/**
 * Latest it can end — 2 AM the following day, expressed as minutes past the
 * *start* day's midnight. Capping at midnight instead would make late-night
 * happy hours unenterable, and getDealStatus already handles a window whose
 * end falls before its start.
 */
export const LAST_END_MINUTES = MINUTES_PER_DAY + 2 * 60;

export interface TimeSlot {
    /** null is the open end — "until close". */
    minutes: number | null;
    label: string;
}

const buildSlots = (from: number, to: number): TimeSlot[] => {
    const slots: TimeSlot[] = [];
    for (let m = from; m <= to; m += SLOT_MINUTES) {
        slots.push({ minutes: m, label: formatTimeLabel(m) });
    }
    return slots;
};

/**
 * The open end. Offered last so it reads as the fallback it is: picking it
 * costs the deal its countdown, and only that deal's.
 */
export const CLOSE_SLOT: TimeSlot = { minutes: null, label: CLOSE_LABEL };

export const START_SLOTS: TimeSlot[] = buildSlots(FIRST_START_MINUTES, LAST_START_MINUTES);

/** End options are whatever comes after the chosen start, wrapping past midnight. */
export const endSlotsFor = (startMinutes: number): TimeSlot[] => [
    ...buildSlots(startMinutes + SLOT_MINUTES, LAST_END_MINUTES),
    CLOSE_SLOT,
];

/** Snap a parsed time onto the nearest slot, for seeding from a scan or a draft. */
export const snapToSlot = (minutes: number): number =>
    Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES;

export interface TimePreset {
    label: string;
    startMinutes: number;
    endMinutes: number;
}

const timePreset = (label: string, startMinutes: number, endMinutes: number): TimePreset => ({
    label, startMinutes, endMinutes,
});

/** The windows most happy hours actually run, so the common case is one tap. */
export const TIME_PRESETS: TimePreset[] = [
    timePreset('3–6 PM', 15 * 60, 18 * 60),
    timePreset('4–6 PM', 16 * 60, 18 * 60),
    timePreset('4–7 PM', 16 * 60, 19 * 60),
    timePreset('5–7 PM', 17 * 60, 19 * 60),
    timePreset('11 AM–2 PM', 11 * 60, 14 * 60),
];

export const timeWindowForPreset = (preset: TimePreset): string =>
    buildTimeWindow(preset.startMinutes, preset.endMinutes);

// ── Deal text and tags ──────────────────────────────────────────────────────

/**
 * Tap-to-insert starters for the deal description — the slowest field on the
 * form, and the only one no other shortcut touches. The "$X" is deliberate:
 * the user replaces it with the real price, which is faster than typing the
 * whole phrase.
 */
export const DEAL_SNIPPETS = [
    '$X Drafts',
    '$X Cocktails',
    '$X Wine',
    '$X Well Drinks',
    'Half-Price Apps',
    'BOGO',
    '$X Tacos',
] as const;

/**
 * Tags offered before (and alongside) whatever the live data suggests.
 *
 * A curated base means the chips are useful on first paint, without waiting on
 * getFilterOptions() and without the list being empty in a metro that has few
 * deals yet.
 */
export const BASE_TAGS = [
    'cocktails', 'beer', 'wine', 'food', 'patio',
    'rooftop', 'late-night', 'dog-friendly', 'games', 'trivia',
] as const;

/** How many tag chips to render before falling back to the free-text field. */
export const MAX_TAG_SUGGESTIONS = 12;

/**
 * The curated list first, then whatever else is actually in use nearby, deduped
 * case-insensitively and capped. getFilterOptions() can return well over a
 * hundred tags in a busy metro, which is a scroll, not a shortcut.
 */
export const mergeTagSuggestions = (liveTags: string[]): string[] => {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const tag of [...BASE_TAGS, ...liveTags]) {
        const key = tag.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(tag.trim());
        if (merged.length >= MAX_TAG_SUGGESTIONS) break;
    }
    return merged;
};
