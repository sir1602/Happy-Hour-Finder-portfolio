
/**
 * Utility to parse deal time strings and determine real-time status.
 * Deal times follow the format "X PM - Y PM" (12-hour format).
 */

export type DealStatus =
    | { status: 'active'; label: string }
    | { status: 'upcoming'; label: string }
    | { status: 'ended'; label: string };

const TIME_REGEX = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i;

/**
 * Parse a 12-hour time string like "4:30 PM" into 24-hour decimal hours (e.g., 16.5).
 */
function parseHour(timeStr: string): number {
    const parts = timeStr.trim().match(TIME_REGEX);
    if (!parts) return -1;

    let hour = parseInt(parts[1], 10);
    const minutes = parts[2] ? parseInt(parts[2], 10) : 0;
    const period = parts[3].toUpperCase();

    if (hour < 1 || hour > 12 || minutes < 0 || minutes > 59) return -1;

    if (period === 'AM' && hour === 12) hour = 0;
    else if (period === 'PM' && hour !== 12) hour += 12;

    return hour + minutes / 60;
}

/**
 * An end of "close" -- the venue's, not a clock time. Plenty of happy hours
 * genuinely advertise this way, so it is stored as written rather than being
 * guessed at; what it costs is the countdown, and only for those deals.
 */
const OPEN_ENDED = /^(close|closing|closes|late|until\s+close|til+\s+close)$/i;

export interface DealWindow {
    startHour: number;
    /** null when the deal runs until close, so there is no end to count down to. */
    endHour: number | null;
}

/**
 * Parse a deal time string into start/end hours, allowing an open end.
 *
 * Prefer this over parseDealTime() wherever knowing only the start is still
 * useful -- a "starts in 20m" label, or a reminder scheduled off the start.
 */
export function parseDealWindow(timeStr: string): DealWindow | null {
    if (!timeStr) return null;
    const parts = timeStr.split('-').map(s => s.trim());
    if (parts.length !== 2) return null;

    const startHour = parseHour(parts[0]);
    if (startHour === -1) return null;

    if (OPEN_ENDED.test(parts[1])) return { startHour, endHour: null };

    const endHour = parseHour(parts[1]);
    if (endHour === -1) return null;
    return { startHour, endHour };
}

/**
 * Parse a deal time string like "4 PM - 6 PM" into start/end hours.
 *
 * Null for an open-ended window, which is what callers that need a real end
 * -- anything computing time remaining -- should do with one.
 */
export function parseDealTime(timeStr: string): { startHour: number; endHour: number } | null {
    const window = parseDealWindow(timeStr);
    if (!window || window.endHour === null) return null;
    return { startHour: window.startHour, endHour: window.endHour };
}

/**
 * Get the current status of a deal based on its time string, active days, and the current time.
 * When activeDays is provided and today is not included, shows the next available day.
 * When activeDays is empty or includes today, evaluates the real-time status.
 */
export function getDealStatus(dealTime: string, activeDays: number[] = [], now: Date = new Date()): DealStatus {
    const window = parseDealWindow(dealTime);
    // Only a window with a real end can be counted down; an open-ended one
    // still knows when it starts.
    const parsed = window && window.endHour !== null
        ? { startHour: window.startHour, endHour: window.endHour }
        : null;

    // Determine the current "deal day" (accounting for overnight deals).
    let dealDay = now.getDay();
    let currentDecimal = 0;

    if (parsed) {
        const { startHour, endHour } = parsed;
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        currentDecimal = currentHour + currentMinute / 60;

        const isOvernight = endHour < startHour;
        if (isOvernight && currentDecimal < endHour) {
            // It's the morning after the deal started. The 'deal block' belongs to yesterday.
            dealDay = dealDay === 0 ? 6 : dealDay - 1;
        }
    }

    // Check if the current logical "deal day" is in the list of active days
    if (activeDays.length > 0 && !activeDays.includes(dealDay)) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const sortedDays = [...activeDays].sort();
        const daysLabel = sortedDays.map(d => dayNames[d]).join(', ');
        return { status: 'ended', label: `📅 ${daysLabel} · ${dealTime}` };
    }

    if (!parsed) {
        // A deal that runs until close: no countdown, but the start is known,
        // so it can still say whether it has begun.
        if (window) {
            const currentHour = now.getHours() + now.getMinutes() / 60;
            if (currentHour >= window.startHour) {
                return { status: 'active', label: '🟢 Active · until close' };
            }
            const timeUntil = window.startHour - currentHour;
            const hoursUntil = Math.floor(timeUntil);
            const minutesUntil = Math.round((timeUntil - hoursUntil) * 60);
            return hoursUntil === 0
                ? { status: 'upcoming', label: `⏳ Starts in ${minutesUntil}m` }
                : { status: 'upcoming', label: `⏳ Starts in ${hoursUntil}h ${minutesUntil}m` };
        }
        // Genuinely unparseable — show it as written rather than inventing one.
        return { status: 'active', label: dealTime };
    }

    const { startHour, endHour } = parsed;
    const isOvernight = endHour < startHour;


    let isActive = false;
    let remainingTime = 0; // in hours

    if (isOvernight) {
        // Active if >= start (before midnight) OR < end (after midnight)
        if (currentDecimal >= startHour) {
            isActive = true;
            remainingTime = (24 - currentDecimal) + endHour;
        } else if (currentDecimal < endHour) {
            isActive = true;
            remainingTime = endHour - currentDecimal;
        }
    } else {
        // Standard range
        if (currentDecimal >= startHour && currentDecimal < endHour) {
            isActive = true;
            remainingTime = endHour - currentDecimal;
        }
    }

    if (isActive) {
        let remainingHours = Math.floor(remainingTime);
        let remainingMinutes = Math.round((remainingTime - remainingHours) * 60);

        if (remainingMinutes === 60) {
            remainingHours += 1;
            remainingMinutes = 0;
        }

        if (remainingHours === 0) {
            return { status: 'active', label: `🟢 Active · Ends in ${remainingMinutes}m` };
        }
        return { status: 'active', label: `🟢 Active · ${remainingHours}h ${remainingMinutes}m left` };
    }

    // Not active logic
    let isUpcoming = false;
    let timeUntil = 0; // in hours

    if (isOvernight) {
        // The gap is [end, start).
        // Since we are not active, we must be in this gap.
        // currentDecimal >= endHour AND currentDecimal < startHour.
        // This is always "upcoming" for the next start time (later today).
        if (currentDecimal >= endHour && currentDecimal < startHour) {
            isUpcoming = true;
            timeUntil = startHour - currentDecimal;
        }
    } else {
        // Standard range [start, end).
        // If current < start, upcoming.
        if (currentDecimal < startHour) {
            isUpcoming = true;
            timeUntil = startHour - currentDecimal;
        }
        // Else (current >= end), ended.
    }

    if (isUpcoming) {
        let hoursUntil = Math.floor(timeUntil);
        let minutesUntil = Math.round((timeUntil - hoursUntil) * 60);

        if (minutesUntil === 60) {
            hoursUntil += 1;
            minutesUntil = 0;
        }

        if (hoursUntil === 0) {
            return { status: 'upcoming', label: `⏳ Starts in ${minutesUntil}m` };
        }
        return { status: 'upcoming', label: `⏳ Starts in ${hoursUntil}h ${minutesUntil}m` };
    }

    return { status: 'ended', label: '⏹ Ended for today' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing time windows
//
// Everything above reads a `time_window` that is already canonical. Everything
// below produces one. Two callers need this: the submit form's Start/End
// pickers (which compose a window from slots) and the photo scan (which hands
// us whatever string the model read off a menu board).
//
// The canonical form is "H:MM AM - H:MM PM". It has to satisfy two validators,
// not one: parseDealTime() above, and its Postgres twin
// public.hh_is_valid_time_window() in scripts/migration_n8n_content_pipeline.sql,
// which gates the n8n content pipeline and the data-quality report.
// ─────────────────────────────────────────────────────────────────────────────

/** Minutes past midnight for 12:00 AM through 11:59 PM. */
const MINUTES_PER_DAY = 24 * 60;

/** How an open end is written in a stored time_window. */
export const CLOSE_LABEL = 'Close';

/**
 * Phrases that describe no start time at all, which leaves nothing to store.
 *
 * "Until close" is not among them: the start is known, so the deal still says
 * when it begins and only forgoes the countdown. "All day" and "varies" give
 * us neither end, so they are still refused and the form explains why.
 */
const UNSUPPORTED_WINDOW = /\b(varies|all\s*day|allday)\b/i;

/** "3pm", "3 p.m.", "15:00", "3:30", "noon". Meridiem optional. */
const HALF_REGEX = /^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m?\.?)?$/i;

interface TimeHalf {
    /** 1-12 once resolved. */
    hour: number;
    minute: number;
    /** null when the input gave no meridiem and it still has to be inferred. */
    meridiem: 'AM' | 'PM' | null;
}

function parseHalf(raw: string): TimeHalf | null {
    const text = raw.trim().toLowerCase();
    if (!text) return null;
    if (text === 'noon') return { hour: 12, minute: 0, meridiem: 'PM' };
    if (text === 'midnight') return { hour: 12, minute: 0, meridiem: 'AM' };

    const parts = text.match(HALF_REGEX);
    if (!parts) return null;

    const hour = parseInt(parts[1], 10);
    const minute = parts[2] ? parseInt(parts[2], 10) : 0;
    if (minute > 59) return null;

    if (parts[3]) {
        // An explicit meridiem is only meaningful on a 12-hour clock.
        if (hour < 1 || hour > 12) return null;
        return { hour, minute, meridiem: parts[3].toLowerCase() === 'a' ? 'AM' : 'PM' };
    }

    // No meridiem. 0 and 13-23 have only one reading, so resolve them here and
    // leave 1-12 for inference against the other half.
    if (hour === 0) return { hour: 12, minute, meridiem: 'AM' };
    if (hour >= 13 && hour <= 23) return { hour: hour - 12, minute, meridiem: 'PM' };
    if (hour >= 1 && hour <= 12) return { hour, minute, meridiem: null };
    return null;
}

function toMinutes(hour: number, minute: number, meridiem: 'AM' | 'PM'): number {
    let h = hour % 12;
    if (meridiem === 'PM') h += 12;
    return h * 60 + minute;
}

/** How far forward from `start` to `end`, wrapping past midnight. */
function forwardSpan(start: number, end: number): number {
    return (end - start + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Pick the meridiem for `half` that lands closest after `anchor` — the reading
 * a person means by "11am-2" (2 PM, three hours later) rather than the one
 * fifteen hours away.
 */
function inferAfter(anchor: number, half: TimeHalf): 'AM' | 'PM' {
    const asAm = forwardSpan(anchor, toMinutes(half.hour, half.minute, 'AM'));
    const asPm = forwardSpan(anchor, toMinutes(half.hour, half.minute, 'PM'));
    // A span of 0 would mean start === end, which is not a window at all.
    if (asAm === 0) return 'PM';
    if (asPm === 0) return 'AM';
    return asAm < asPm ? 'AM' : 'PM';
}

/** Pick the meridiem for `half` that lands closest before `anchor`. */
function inferBefore(anchor: number, half: TimeHalf): 'AM' | 'PM' {
    const asAm = forwardSpan(toMinutes(half.hour, half.minute, 'AM'), anchor);
    const asPm = forwardSpan(toMinutes(half.hour, half.minute, 'PM'), anchor);
    if (asAm === 0) return 'PM';
    if (asPm === 0) return 'AM';
    return asAm < asPm ? 'AM' : 'PM';
}

/**
 * Render minutes-past-midnight as a canonical half. Values of 1440 and above
 * wrap, so an end picker can express "2 AM tomorrow" as 1560.
 */
export function formatTimeLabel(minutesPastMidnight: number): string {
    const wrapped = ((minutesPastMidnight % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const hour24 = Math.floor(wrapped / 60);
    const minute = wrapped % 60;
    const meridiem = hour24 < 12 ? 'AM' : 'PM';
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

/**
 * Compose a canonical window from two picker slots. `endMinutes` may exceed
 * 1440 to mean the following morning, which is how the End picker offers times
 * past midnight for late-night happy hours.
 */
export function buildTimeWindow(startMinutes: number, endMinutes: number | null): string {
    const end = endMinutes === null ? CLOSE_LABEL : formatTimeLabel(endMinutes);
    return `${formatTimeLabel(startMinutes)} - ${end}`;
}

/**
 * Split a canonical window back into picker slots, so a restored draft or a
 * scanned photo can seed the Start/End selectors.
 *
 * `endMinutes` is pushed past 1440 for an overnight window, matching what
 * buildTimeWindow() accepts, so the pair round-trips.
 */
export function timeWindowToMinutes(
    timeWindow: string,
): { startMinutes: number; endMinutes: number | null } | null {
    const parsed = parseDealWindow(timeWindow);
    if (!parsed) return null;

    const startMinutes = Math.round(parsed.startHour * 60);
    if (parsed.endHour === null) return { startMinutes, endMinutes: null };

    let endMinutes = Math.round(parsed.endHour * 60);
    if (endMinutes <= startMinutes) endMinutes += MINUTES_PER_DAY;
    return { startMinutes, endMinutes };
}

/**
 * Coerce a human- or model-written time window into the canonical form, or
 * return null when it cannot be read as two clock times.
 *
 * Accepts "3-6pm", "15:00-18:00", "4 to 7pm", "9pm-1am", "noon - 3", en and em
 * dashes, and any spacing or casing around them. When neither half carries a
 * meridiem the window is read as PM — the overwhelmingly common case for a
 * happy hour — except that a start later than the end flips the start to AM,
 * which is what makes "11-2" the lunch window a person means.
 *
 * Callers should show the result back to the user rather than saving it
 * silently: the PM assumption is a good guess, not a certainty.
 */
export function normalizeTimeWindow(input: string): string | null {
    if (!input) return null;
    if (UNSUPPORTED_WINDOW.test(input)) return null;

    const separated = input
        .replace(/[‒–—―]/g, '-')
        .replace(/\s+(?:to|until|till|thru|through)\s+/gi, '-');

    const halves = separated.split('-');
    if (halves.length !== 2) return null;

    const start = parseHalf(halves[0]);
    if (!start) return null;

    // "4pm-close": the start alone is enough to store, and with no end to
    // infer against, a bare hour reads as PM like any other happy hour.
    if (OPEN_ENDED.test(halves[1].trim())) {
        const meridiem = start.meridiem ?? 'PM';
        return buildTimeWindow(toMinutes(start.hour, start.minute, meridiem), null);
    }

    const end = parseHalf(halves[1]);
    if (!end) return null;

    if (start.meridiem && !end.meridiem) {
        end.meridiem = inferAfter(toMinutes(start.hour, start.minute, start.meridiem), end);
    } else if (!start.meridiem && end.meridiem) {
        start.meridiem = inferBefore(toMinutes(end.hour, end.minute, end.meridiem), start);
    } else if (!start.meridiem && !end.meridiem) {
        // Happy hours are an evening thing, so PM is the right default; a
        // start that would then sit after the end means the window actually
        // began in the morning ("11-2").
        start.meridiem = 'PM';
        end.meridiem = 'PM';
        if (toMinutes(start.hour, start.minute, 'PM') > toMinutes(end.hour, end.minute, 'PM')) {
            start.meridiem = 'AM';
        }
    }

    const startMinutes = toMinutes(start.hour, start.minute, start.meridiem as 'AM' | 'PM');
    const endMinutes = toMinutes(end.hour, end.minute, end.meridiem as 'AM' | 'PM');
    if (startMinutes === endMinutes) return null;

    return buildTimeWindow(startMinutes, endMinutes);
}
