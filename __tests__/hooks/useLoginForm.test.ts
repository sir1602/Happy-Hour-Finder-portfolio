import { renderHook, act, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { useLoginForm } from '../../hooks/useLoginForm';
import { authService } from '../../services/authService';

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockSearchParams: Record<string, string> = {};

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, replace: mockReplace }),
    useLocalSearchParams: () => mockSearchParams,
}));

jest.mock('expo-linking', () => ({
    getInitialURL: jest.fn().mockResolvedValue(null),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('../../services/authService', () => ({
    authService: {
        signUp: jest.fn(),
        signIn: jest.fn(),
        resetPasswordForEmail: jest.fn(),
        signInWithMagicLink: jest.fn(),
        signInWithGoogle: jest.fn(),
        signInWithApple: jest.fn(),
        handleAuthCallback: jest.fn(),
    },
}));

const mockedAuthService = authService as jest.Mocked<typeof authService>;

describe('useLoginForm', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSearchParams = {};
        jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    });

    it('starts in login mode with empty fields and no errors', async () => {
        const { result } = await renderHook(() => useLoginForm());
        expect(result.current.mode).toBe('login');
        expect(result.current.email).toBe('');
        expect(result.current.password).toBe('');
        expect(result.current.errors).toEqual({});
        expect(result.current.isLoading).toBe(false);
    });

    describe('initial mode from route params', () => {
        // Onboarding's "Sign Up" button used to push /login with no mode, so it
        // landed the user on the "Log In" form.
        it('starts in signup mode when ?mode=signup', async () => {
            mockSearchParams = { mode: 'signup' };
            const { result } = await renderHook(() => useLoginForm());
            expect(result.current.mode).toBe('signup');
        });

        it('starts in login mode when ?mode=login', async () => {
            mockSearchParams = { mode: 'login' };
            const { result } = await renderHook(() => useLoginForm());
            expect(result.current.mode).toBe('login');
        });

        it('falls back to login mode for an unrecognized value', async () => {
            mockSearchParams = { mode: 'nonsense' };
            const { result } = await renderHook(() => useLoginForm());
            expect(result.current.mode).toBe('login');
        });
    });

    it('switchMode changes mode and clears errors', async () => {
        const { result } = await renderHook(() => useLoginForm());
        await act(() => result.current.onEmailChange('not-an-email'));
        await act(() => result.current.onEmailBlur());
        expect(result.current.errors.email).toBeTruthy();

        await act(() => result.current.switchMode('signup'));
        expect(result.current.mode).toBe('signup');
        expect(result.current.errors).toEqual({});
    });

    it('togglePasswordVisibility flips showPassword', async () => {
        const { result } = await renderHook(() => useLoginForm());
        expect(result.current.showPassword).toBe(false);
        await act(() => result.current.togglePasswordVisibility());
        expect(result.current.showPassword).toBe(true);
    });

    it('onEmailBlur sets an error for an invalid, non-empty email', async () => {
        const { result } = await renderHook(() => useLoginForm());
        await act(() => result.current.onEmailChange('not-an-email'));
        await act(() => result.current.onEmailBlur());
        expect(result.current.errors.email).toBe('Please enter a valid email address');
    });

    it('onEmailChange clears a previously-set email error', async () => {
        const { result } = await renderHook(() => useLoginForm());
        await act(() => result.current.onEmailChange('not-an-email'));
        await act(() => result.current.onEmailBlur());
        expect(result.current.errors.email).toBeTruthy();

        await act(() => result.current.onEmailChange('valid@example.com'));
        expect(result.current.errors.email).toBeUndefined();
    });

    it('onSubmit does not call authService when the form is invalid', async () => {
        const { result } = await renderHook(() => useLoginForm());
        await act(async () => {
            await result.current.onSubmit();
        });
        expect(result.current.errors.email).toBe('Email is required');
        expect(result.current.errors.password).toBe('Password is required');
        expect(mockedAuthService.signIn).not.toHaveBeenCalled();
    });

    it('onSubmit in signup mode rejects a password under 8 characters', async () => {
        const { result } = await renderHook(() => useLoginForm());
        await act(() => result.current.switchMode('signup'));
        await act(() => result.current.onEmailChange('valid@example.com'));
        await act(() => result.current.onPasswordChange('short'));
        await act(async () => {
            await result.current.onSubmit();
        });
        expect(result.current.errors.password).toBe('Password must be at least 8 characters');
        expect(mockedAuthService.signUp).not.toHaveBeenCalled();
    });

    it('onSubmit in login mode calls signIn and navigates on success', async () => {
        mockedAuthService.signIn.mockResolvedValue({ session: {} } as any);
        const { result } = await renderHook(() => useLoginForm());
        await act(() => result.current.onEmailChange('valid@example.com'));
        await act(() => result.current.onPasswordChange('password123'));
        await act(async () => {
            await result.current.onSubmit();
        });
        expect(mockedAuthService.signIn).toHaveBeenCalledWith('valid@example.com', 'password123');
        await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)'));
    });

    it('onSubmit in signup mode calls signUp, shows a confirmation alert, and switches back to login mode', async () => {
        mockedAuthService.signUp.mockResolvedValue({} as any);
        const { result } = await renderHook(() => useLoginForm());
        await act(() => result.current.switchMode('signup'));
        await act(() => result.current.onEmailChange('new@example.com'));
        await act(() => result.current.onPasswordChange('password123'));
        await act(async () => {
            await result.current.onSubmit();
        });
        expect(mockedAuthService.signUp).toHaveBeenCalledWith('new@example.com', 'password123');
        expect(Alert.alert).toHaveBeenCalledWith('Check Your Email', expect.any(String));
        expect(result.current.mode).toBe('login');
    });

    it('maps a raw Supabase auth error to a friendly message on failure', async () => {
        mockedAuthService.signIn.mockRejectedValue(new Error('Invalid login credentials'));
        const { result } = await renderHook(() => useLoginForm());
        await act(() => result.current.onEmailChange('valid@example.com'));
        await act(() => result.current.onPasswordChange('password123'));
        await act(async () => {
            await result.current.onSubmit();
        });
        expect(result.current.errors.email).toBe('Incorrect email or password. Please try again.');
        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('maps a rate-limit error to a friendly message', async () => {
        mockedAuthService.signIn.mockRejectedValue(new Error('Email rate limit exceeded'));
        const { result } = await renderHook(() => useLoginForm());
        await act(() => result.current.onEmailChange('valid@example.com'));
        await act(() => result.current.onPasswordChange('password123'));
        await act(async () => {
            await result.current.onSubmit();
        });
        expect(result.current.errors.email).toBe('Too many attempts. Please wait a few minutes and try again.');
    });

    it('handleForgotPassword requires a valid email before sending', async () => {
        const { result } = await renderHook(() => useLoginForm());
        await act(async () => {
            await result.current.handleForgotPassword();
        });
        expect(result.current.errors.email).toBe('Enter your email above to receive a reset link');
        expect(mockedAuthService.resetPasswordForEmail).not.toHaveBeenCalled();
    });

    it('handleForgotPassword sends a reset email for a valid address', async () => {
        mockedAuthService.resetPasswordForEmail.mockResolvedValue(undefined as any);
        const { result } = await renderHook(() => useLoginForm());
        await act(() => result.current.onEmailChange('valid@example.com'));
        await act(async () => {
            await result.current.handleForgotPassword();
        });
        expect(mockedAuthService.resetPasswordForEmail).toHaveBeenCalledWith('valid@example.com');
        expect(Alert.alert).toHaveBeenCalledWith('Reset Link Sent', expect.any(String));
    });

    it('handleMagicLink sets magicLinkSent on success', async () => {
        mockedAuthService.signInWithMagicLink.mockResolvedValue(undefined as any);
        const { result } = await renderHook(() => useLoginForm());
        await act(() => result.current.onEmailChange('valid@example.com'));
        await act(async () => {
            await result.current.handleMagicLink();
        });
        expect(mockedAuthService.signInWithMagicLink).toHaveBeenCalledWith('valid@example.com');
        expect(result.current.magicLinkSent).toBe(true);
    });

    it('handleSocialLogin navigates on a successful session', async () => {
        mockedAuthService.signInWithGoogle.mockResolvedValue({ session: {} } as any);
        const { result } = await renderHook(() => useLoginForm());
        await act(async () => {
            await result.current.handleSocialLogin('google');
        });
        expect(mockedAuthService.signInWithGoogle).toHaveBeenCalled();
        await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)'));
    });

    it('handleSocialLogin shows an alert and does not navigate on failure', async () => {
        mockedAuthService.signInWithApple.mockRejectedValue(new Error('User cancelled'));
        const { result } = await renderHook(() => useLoginForm());
        await act(async () => {
            await result.current.handleSocialLogin('apple');
        });
        expect(Alert.alert).toHaveBeenCalledWith('Login Failed', 'User cancelled');
        expect(mockReplace).not.toHaveBeenCalled();
    });
});
