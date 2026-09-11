import { useEffect, useRef, useState, useCallback } from 'react';
import {
    readDealDraft,
    saveDealDraft,
    clearDealDraft,
    type DraftPayload,
} from '../services/dealDraftService';

export { DRAFT_KEY, clearDealDraft } from '../services/dealDraftService';
export type { DealDraft, DraftPayload } from '../services/dealDraftService';

/** Disk, not keystrokes — no need to write on every character. */
const WRITE_DEBOUNCE_MS = 800;

interface UseDealDraftOptions {
    /**
     * Overridable so tests can exercise the coalescing without spending the
     * real delay in wall-clock waiting, which makes the suite slow and its
     * timing sensitive to whatever else the runner is doing.
     */
    writeDelayMs?: number;
}

/**
 * Keeps a half-finished submission across a backgrounded app or an accidental
 * back-tap, so a long multi-schedule form is not lost to a stray gesture.
 */
export function useDealDraft({ writeDelayMs = WRITE_DEBOUNCE_MS }: UseDealDraftOptions = {}) {
    const [restored, setRestored] = useState<DraftPayload | null>(null);
    const [hasLoaded, setHasLoaded] = useState(false);
    // Suppress the save effect until the initial read has finished, otherwise
    // the empty first render overwrites the draft we are about to restore.
    const canSave = useRef(false);
    const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let cancelled = false;

        readDealDraft()
            .then((payload) => {
                if (cancelled || !payload) return;
                setRestored(payload);
            })
            .finally(() => {
                if (cancelled) return;
                setHasLoaded(true);
                canSave.current = true;
            });

        return () => { cancelled = true; };
    }, []);

    // A pending write must not outlive the screen, or it fires against an
    // unmounted component and, in tests, after teardown.
    useEffect(() => () => {
        if (writeTimer.current) clearTimeout(writeTimer.current);
    }, []);

    /** Debounced write. Safe to call on every change; it coalesces. */
    const save = useCallback((draft: DraftPayload) => {
        if (!canSave.current) return;
        if (writeTimer.current) clearTimeout(writeTimer.current);
        writeTimer.current = setTimeout(() => {
            void saveDealDraft(draft);
        }, writeDelayMs);
    }, [writeDelayMs]);

    const clear = useCallback(async () => {
        if (writeTimer.current) clearTimeout(writeTimer.current);
        setRestored(null);
        await clearDealDraft();
    }, []);

    /** Dismiss the restore banner without discarding what was restored. */
    const acknowledgeRestore = useCallback(() => setRestored(null), []);

    return { restored, hasLoaded, save, clear, acknowledgeRestore };
}
