import { submitFeedback, MAX_FEEDBACK_LENGTH } from '../../services/feedbackService';
import { supabase } from '../../services/supabase';

jest.mock('../../services/supabase', () => ({
    supabase: { from: jest.fn(), auth: { getUser: jest.fn() } },
}));

jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.0-alpha.1' } }));

const DEAL = {
    id: 'deal-1',
    name: 'The Draft House',
    deal: '$5 Craft Beers',
    time: '4 PM - 6 PM',
    verificationStatus: 'conflict' as const,
};

const mockInsert = (error: unknown = null) => {
    const insert = jest.fn().mockResolvedValue({ error });
    (supabase.from as jest.Mock).mockReturnValue({ insert });
    return insert;
};

const signedIn = () =>
    (supabase.auth.getUser as jest.Mock).mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
const guest = () =>
    (supabase.auth.getUser as jest.Mock).mockResolvedValue({ data: { user: null }, error: null });

beforeEach(() => {
    jest.clearAllMocks();
    signedIn();
});

describe('submitFeedback', () => {
    it('files a deal report against the deal and the user', async () => {
        const insert = mockInsert();

        await expect(submitFeedback({ kind: 'deal_report', message: 'Times are wrong', deal: DEAL })).resolves.toBe(true);

        expect(supabase.from).toHaveBeenCalledWith('feedback');
        expect(insert).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'deal_report',
            deal_id: 'deal-1',
            user_id: 'user-1',
            message: 'Times are wrong',
        }));
    });

    // A report saying only "this is wrong" costs a round trip to act on.
    it('attaches enough context to act on the report without a follow-up', async () => {
        const insert = mockInsert();

        await submitFeedback({ kind: 'deal_report', message: 'Wrong', deal: DEAL });

        expect(insert.mock.calls[0][0].context).toEqual(expect.objectContaining({
            appVersion: '1.0.0-alpha.1',
            dealName: 'The Draft House',
            dealTime: '4 PM - 6 PM',
            // Tells us whether the pipeline had already flagged this one.
            verificationStatus: 'conflict',
        }));
    });

    // Someone browsing without an account who spots a wrong deal is exactly as
    // useful as a signed-in one; the table's anon policy allows a null user_id.
    it('accepts feedback from a guest', async () => {
        guest();
        const insert = mockInsert();

        await expect(submitFeedback({ kind: 'general', message: 'The map is slow' })).resolves.toBe(true);

        expect(insert.mock.calls[0][0].user_id).toBeNull();
        expect(insert.mock.calls[0][0].deal_id).toBeNull();
    });

    it('trims and refuses an empty message without hitting the network', async () => {
        const insert = mockInsert();

        await expect(submitFeedback({ kind: 'general', message: '   ' })).resolves.toBe(false);

        expect(insert).not.toHaveBeenCalled();
    });

    it('truncates to the length the database will accept', async () => {
        const insert = mockInsert();

        await submitFeedback({ kind: 'general', message: 'x'.repeat(MAX_FEEDBACK_LENGTH + 500) });

        expect(insert.mock.calls[0][0].message).toHaveLength(MAX_FEEDBACK_LENGTH);
    });

    // Returns false rather than throwing: the modal keeps the user's typed text
    // and offers a retry, instead of losing it to an exception.
    it('reports failure without throwing when the insert is rejected', async () => {
        mockInsert(new Error('permission denied'));

        await expect(submitFeedback({ kind: 'general', message: 'hello' })).resolves.toBe(false);
    });

    it('reports failure without throwing when the client blows up', async () => {
        (supabase.from as jest.Mock).mockImplementation(() => { throw new Error('offline'); });

        await expect(submitFeedback({ kind: 'general', message: 'hello' })).resolves.toBe(false);
    });
});
