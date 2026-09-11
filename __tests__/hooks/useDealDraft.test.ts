import { renderHook, act, waitFor, cleanup } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDealDraft, DRAFT_KEY, type DraftPayload } from '../../hooks/useDealDraft';

jest.mock('@react-native-async-storage/async-storage', () => ({
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
}));

const mockedStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const payload = (over: Partial<DraftPayload> = {}): DraftPayload => ({
    venueName: 'The Tap Room',
    address: '745 N Birch Ave',
    neighborhood: 'River North',
    schedules: [{ days: [1, 2], timeWindow: '4:00 PM - 6:00 PM', dealTitle: '$5 drafts' }],
    priceLevel: 2,
    tagsInput: 'beer, patio',
    ...over,
});

const stored = () => JSON.parse((mockedStorage.setItem as jest.Mock).mock.calls[0][1]);

beforeEach(() => {
    jest.clearAllMocks();
    mockedStorage.getItem.mockResolvedValue(null);
});

// Explicit: the mount-time read resolves after the test body returns, so a
// root left standing keeps settling into the next test's render.
afterEach(cleanup);

/**
 * Real timers, but a short debounce.
 *
 * Faking timers here means a pending debounce left by one test orphans React's
 * captured scheduler for the next; spending the real 800ms instead makes the
 * suite slow and its timing sensitive to whatever else the runner is doing.
 * Shortening the delay keeps the coalescing behaviour under test either way.
 */
const WRITE_DELAY_MS = 10;
const DEBOUNCE_WAIT = { timeout: 1000 };

/** Comfortably past the debounce, for asserting that nothing was written. */
const settle = () => new Promise(r => setTimeout(r, WRITE_DELAY_MS * 10));

/** Render and let the mount-time read settle. */
const mountDraft = async () => {
    const rendered = await renderHook(() => useDealDraft({ writeDelayMs: WRITE_DELAY_MS }));
    await waitFor(() => expect(rendered.result.current.hasLoaded).toBe(true));
    return rendered;
};

const expectWrite = () =>
    waitFor(() => expect(mockedStorage.setItem).toHaveBeenCalled(), DEBOUNCE_WAIT);

describe('useDealDraft', () => {
    describe('saving', () => {
        it('debounces the write rather than hitting disk on every keystroke', async () => {
            const { result } = await mountDraft();

            result.current.save(payload({ venueName: 'T' }));
            result.current.save(payload({ venueName: 'Ta' }));
            result.current.save(payload({ venueName: 'Tap' }));
            // Three edits in a row, one write, carrying the latest value.
            expect(mockedStorage.setItem).not.toHaveBeenCalled();
            await expectWrite();
            expect(mockedStorage.setItem).toHaveBeenCalledTimes(1);
            expect(stored().venueName).toBe('Tap');
        });

        it('does not save an untouched form', async () => {
            const { result } = await mountDraft();

            result.current.save(payload({
                venueName: '', address: '', neighborhood: '', tagsInput: '',
                schedules: [{ days: [], timeWindow: '', dealTitle: '' }],
            }));

            await settle();
            expect(mockedStorage.setItem).not.toHaveBeenCalled();
        });

        it('never persists a local file:// URI', async () => {
            // ImagePicker writes into the app cache, which both platforms purge.
            // A restored dead URI renders broken and then fails on upload.
            const { result } = await mountDraft();

            result.current.save(payload({ uploadedImageUrl: undefined }));
            await expectWrite();

            expect(JSON.stringify(stored())).not.toContain('file://');
            expect(stored().uploadedImageUrl).toBeUndefined();
        });

        it('persists an uploaded photo URL, which survives a restart', async () => {
            const { result } = await mountDraft();

            result.current.save(payload({ uploadedImageUrl: 'https://cdn.example/menu.jpg' }));
            await expectWrite();

            expect(stored().uploadedImageUrl).toBe('https://cdn.example/menu.jpg');
        });

        it('persists the venue photo alongside the menu photo', async () => {
            // Both are already in the bucket by the time they reach a draft.
            // Dropping one on restore does not merely blank a field: nothing
            // else knows the object is there to be deleted.
            const { result } = await mountDraft();

            result.current.save(payload({
                uploadedImageUrl: 'https://cdn.example/menu.jpg',
                uploadedVenuePhotoUrl: 'https://cdn.example/place.jpg',
            }));
            await expectWrite();

            expect(stored().uploadedImageUrl).toBe('https://cdn.example/menu.jpg');
            expect(stored().uploadedVenuePhotoUrl).toBe('https://cdn.example/place.jpg');
        });

        it('counts a lone venue photo as worth saving', async () => {
            const { result } = await mountDraft();

            result.current.save(payload({
                venueName: '', address: '', neighborhood: '', tagsInput: '',
                schedules: [{ days: [], timeWindow: '', dealTitle: '' }],
                uploadedVenuePhotoUrl: 'https://cdn.example/place.jpg',
            }));
            await expectWrite();

            expect(stored().uploadedVenuePhotoUrl).toBe('https://cdn.example/place.jpg');
        });

        it('caps how many schedules a single draft can grow to', async () => {
            const { result } = await mountDraft();

            const many = Array.from({ length: 25 }, () => ({ days: [1], timeWindow: '4:00 PM - 6:00 PM', dealTitle: 'x' }));
            result.current.save(payload({ schedules: many }));
            await expectWrite();

            expect(stored().schedules).toHaveLength(10);
        });
    });

    describe('restoring', () => {
        it('hands back a recent draft', async () => {
            mockedStorage.getItem.mockResolvedValue(
                JSON.stringify({ ...payload(), savedAt: Date.now() }),
            );
            const { result } = await mountDraft();
            expect(result.current.restored?.venueName).toBe('The Tap Room');
        });

        it('restores a draft written before the venue photo existed', async () => {
            // The stored key is unversioned on purpose: an added optional field
            // has to read back as absent rather than as a broken draft.
            mockedStorage.getItem.mockResolvedValue(
                JSON.stringify({ ...payload({ uploadedImageUrl: 'https://cdn.example/menu.jpg' }), savedAt: Date.now() }),
            );
            const { result } = await mountDraft();

            expect(result.current.restored?.uploadedImageUrl).toBe('https://cdn.example/menu.jpg');
            expect(result.current.restored?.uploadedVenuePhotoUrl).toBeUndefined();
        });

        it('discards a draft older than a week', async () => {
            const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
            mockedStorage.getItem.mockResolvedValue(
                JSON.stringify({ ...payload(), savedAt: eightDaysAgo }),
            );
            const { result } = await mountDraft();

            expect(result.current.restored).toBeNull();
            expect(mockedStorage.removeItem).toHaveBeenCalledWith(DRAFT_KEY);
        });

        it('treats a corrupt value as no draft at all', async () => {
            mockedStorage.getItem.mockResolvedValue('{not json');
            const { result } = await mountDraft();

            expect(result.current.restored).toBeNull();
            expect(mockedStorage.removeItem).toHaveBeenCalledWith(DRAFT_KEY);
        });

        it('ignores a payload that is the right JSON but the wrong shape', async () => {
            mockedStorage.getItem.mockResolvedValue(JSON.stringify({ venueName: 'x', savedAt: Date.now() }));
            const { result } = await mountDraft();
            expect(result.current.restored).toBeNull();
        });
    });

    it('clears the stored draft on demand', async () => {
        const { result } = await mountDraft();

        await act(async () => { await result.current.clear(); });
        expect(mockedStorage.removeItem).toHaveBeenCalledWith(DRAFT_KEY);
    });

    it('does not write after unmount', async () => {
        // A pending timer firing against a gone screen warns in tests and
        // wastes a disk write in production.
        const { result, unmount } = await mountDraft();

        result.current.save(payload());
        unmount();

        await settle();
        expect(mockedStorage.setItem).not.toHaveBeenCalled();
    });
});
