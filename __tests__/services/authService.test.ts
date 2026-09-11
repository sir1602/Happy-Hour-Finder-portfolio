import { authService, extractTokensFromUrl } from '../../services/authService';
import { supabase } from '../../services/supabase';

jest.mock('../../services/supabase', () => ({
    supabase: {
        auth: {
            signUp: jest.fn(),
            signInWithPassword: jest.fn(),
            resetPasswordForEmail: jest.fn(),
            updateUser: jest.fn(),
            exchangeCodeForSession: jest.fn(),
            setSession: jest.fn(),
        },
    },
}));

jest.mock('expo-linking', () => ({
    createURL: (path: string) => `happyhourfinder://${path}`,
}));

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));

const auth = supabase.auth as unknown as Record<string, jest.Mock>;
const REDIRECT = 'happyhourfinder://auth/callback';

beforeEach(() => jest.clearAllMocks());

describe('extractTokensFromUrl', () => {
    it('reads PKCE code and type from the query string', () => {
        const out = extractTokensFromUrl(`${REDIRECT}?code=abc123&type=recovery`);

        expect(out.code).toBe('abc123');
        expect(out.type).toBe('recovery');
    });

    it('reads implicit-flow tokens and type from the fragment', () => {
        const out = extractTokensFromUrl(`${REDIRECT}#access_token=at&refresh_token=rt&type=magiclink`);

        expect(out.accessToken).toBe('at');
        expect(out.refreshToken).toBe('rt');
        expect(out.type).toBe('magiclink');
    });

    // Supabase reports a spent or expired link by adding an error, not by
    // omitting the tokens — so a callback that ignored this field showed a
    // spinner forever instead of saying the link was no good.
    it('surfaces an error carried on the link', () => {
        const out = extractTokensFromUrl(`${REDIRECT}#error=access_denied&error_description=Email+link+is+invalid+or+has+expired`);

        expect(out.error).toBe('Email link is invalid or has expired');
    });

    it('reports no error for a clean link', () => {
        expect(extractTokensFromUrl(`${REDIRECT}?code=abc123`).error).toBeNull();
    });
});

describe('redirects on emailed links', () => {
    // Without redirectTo the emailed link targets Supabase's default Site URL,
    // which is not this app — so even a tester who got the mail had nowhere to
    // land.
    it('sends the password reset link back into the app', async () => {
        auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });

        await authService.resetPasswordForEmail('tester@example.com');

        expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(
            'tester@example.com',
            expect.objectContaining({ redirectTo: REDIRECT }),
        );
    });

    it('sends the signup confirmation link back into the app', async () => {
        auth.signUp.mockResolvedValue({ data: {}, error: null });

        await authService.signUp('tester@example.com', 'hunter2hunter2');

        expect(auth.signUp).toHaveBeenCalledWith(
            expect.objectContaining({
                options: expect.objectContaining({ emailRedirectTo: REDIRECT }),
            }),
        );
    });
});

describe('updatePassword', () => {
    // There was no updateUser call anywhere in the codebase, so "Forgot
    // Password?" advertised a flow that could not complete.
    it('sets the new password', async () => {
        auth.updateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });

        await authService.updatePassword('a-new-password');

        expect(auth.updateUser).toHaveBeenCalledWith({ password: 'a-new-password' });
    });

    it('throws when Supabase rejects the new password', async () => {
        auth.updateUser.mockResolvedValue({ data: null, error: new Error('Password is too short') });

        await expect(authService.updatePassword('short')).rejects.toThrow('Password is too short');
    });
});

describe('handleAuthCallback', () => {
    it('exchanges a PKCE code for a session', async () => {
        auth.exchangeCodeForSession.mockResolvedValue({ data: { session: { user: { id: 'u1' } } }, error: null });

        const session = await authService.handleAuthCallback(`${REDIRECT}?code=abc123`);

        expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('abc123');
        expect(session).toEqual({ user: { id: 'u1' } });
    });

    it('establishes a session from implicit-flow tokens', async () => {
        auth.setSession.mockResolvedValue({ data: { session: { user: { id: 'u1' } } }, error: null });

        const session = await authService.handleAuthCallback(`${REDIRECT}#access_token=at&refresh_token=rt`);

        expect(auth.setSession).toHaveBeenCalledWith({ access_token: 'at', refresh_token: 'rt' });
        expect(session).toEqual({ user: { id: 'u1' } });
    });

    it('reports an expired link instead of silently doing nothing', async () => {
        await expect(
            authService.handleAuthCallback(`${REDIRECT}#error_description=Email+link+is+invalid+or+has+expired`)
        ).rejects.toThrow('Email link is invalid or has expired');

        expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
        expect(auth.setSession).not.toHaveBeenCalled();
    });

    it('returns null for a link carrying neither a code nor tokens', async () => {
        await expect(authService.handleAuthCallback(REDIRECT)).resolves.toBeNull();
    });
});
