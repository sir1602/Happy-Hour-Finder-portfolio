import { useState, useCallback, useRef } from 'react';
import { Alert, Animated } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authService } from '../services/authService';
import { Logger } from '../services/logger';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LoginMode = 'login' | 'signup';
export type LoadingAction = 'submit' | 'forgot' | 'magic' | 'google' | 'apple' | null;

export type FormErrors = {
  email?: string;
  password?: string;
};

// Q5: Map raw Supabase auth errors to user-friendly messages
const friendlyAuthError = (message: string): string => {
  const map: Record<string, string> = {
    'Invalid login credentials': 'Incorrect email or password. Please try again.',
    'User already registered': 'An account with this email already exists. Try logging in instead.',
    'Email rate limit exceeded': 'Too many attempts. Please wait a few minutes and try again.',
    'Signup requires a valid password': 'Please enter a valid password.',
    'Email not confirmed': 'Please check your inbox and confirm your email address first.',
    'Password should be at least 6 characters': 'Password must be at least 8 characters long.',
  };
  // Check for partial matches in case Supabase changes casing
  for (const [key, friendly] of Object.entries(map)) {
    if (message.toLowerCase().includes(key.toLowerCase())) return friendly;
  }
  return message;
};

/**
 * All state and business logic for the login/signup screen: form fields,
 * validation, the shake-on-error animation, deep-link auth-callback
 * handling, and every auth action (password, magic link, forgot password,
 * Google/Apple OAuth). Kept separate from the screen's JSX so the auth flow
 * is testable independent of layout.
 */
export function useLoginForm() {
  const router = useRouter();
  // Onboarding passes ?mode=signup so its "Sign Up" button opens the signup
  // form rather than dropping the user on "Log In".
  const { mode: modeParam } = useLocalSearchParams<{ mode?: string }>();

  const [mode, setMode] = useState<LoginMode>(modeParam === 'signup' ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});

  // Loading state – track which action is in-flight
  const [loadingAction, setLoadingAction] = useState<LoadingAction>(null);

  // Magic link state
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  // Shake animation for error feedback
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const triggerShake = useCallback(() => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  // ── Inline validation ───────────────────────────────────────────────
  const validateEmail = useCallback((value: string): string | undefined => {
    if (!value.trim()) return 'Email is required';
    if (!EMAIL_REGEX.test(value.trim())) return 'Please enter a valid email address';
    return undefined;
  }, []);

  const validatePassword = useCallback(
    (value: string): string | undefined => {
      if (!value) return 'Password is required';
      if (mode === 'signup' && value.length < 8)
        return 'Password must be at least 8 characters';
      return undefined;
    },
    [mode]
  );

  const validateForm = useCallback((): boolean => {
    const emailErr = validateEmail(email);
    const passwordErr = validatePassword(password);
    const newErrors: FormErrors = {};
    if (emailErr) newErrors.email = emailErr;
    if (passwordErr) newErrors.password = passwordErr;
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) {
      triggerShake();
      return false;
    }
    return true;
  }, [email, password, validateEmail, validatePassword, triggerShake]);

  const markOnboardingComplete = useCallback(async () => {
    try {
      await AsyncStorage.setItem('onboardingComplete', 'true');
    } catch (e) {
      Logger.error('Failed to set onboarding complete', e);
    }
  }, []);

  // Deep-linked auth callbacks (magic link, email confirmation, password
  // recovery) are handled by `app/auth/callback.tsx`, which is the route
  // Supabase actually redirects to. A duplicate `Linking` listener used to live
  // here; now that the route exists it would race it — exchanging the same
  // one-time code twice (the second attempt fails) and pushing the tabs on top
  // of the callback screen. OAuth is unaffected: `openAuthSessionAsync` returns
  // its URL directly to `handleSocialLogin` and never deep-links.

  // ── Handlers ────────────────────────────────────────────────────────
  const onSubmit = useCallback(async () => {
    if (!validateForm()) return;
    if (loadingAction) return;
    setLoadingAction('submit');

    try {
      if (mode === 'signup') {
        await authService.signUp(email.trim(), password);
        Alert.alert(
          'Check Your Email',
          'We sent you a confirmation email. Please verify your address, then log in.',
        );
        setMode('login');
      } else {
        await authService.signIn(email.trim(), password);
        await markOnboardingComplete();
        router.replace('/(tabs)');
      }
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : 'An unexpected error occurred.';
      setErrors((prev) => ({ ...prev, email: friendlyAuthError(raw) }));
      triggerShake();
    } finally {
      setLoadingAction(null);
    }
  }, [validateForm, loadingAction, mode, email, password, markOnboardingComplete, router, triggerShake]);

  const handleForgotPassword = useCallback(async () => {
    const emailErr = validateEmail(email);
    if (emailErr) {
      setErrors((prev) => ({ ...prev, email: 'Enter your email above to receive a reset link' }));
      triggerShake();
      return;
    }
    if (loadingAction) return;
    setLoadingAction('forgot');
    try {
      await authService.resetPasswordForEmail(email.trim());
      Alert.alert('Reset Link Sent', 'Check your inbox for a password reset link.');
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to send reset email';
      Alert.alert('Error', errorMessage);
    } finally {
      setLoadingAction(null);
    }
  }, [validateEmail, email, loadingAction, triggerShake]);

  const handleMagicLink = useCallback(async () => {
    const emailErr = validateEmail(email);
    if (emailErr) {
      setErrors((prev) => ({ ...prev, email: emailErr }));
      triggerShake();
      return;
    }
    if (loadingAction) return;
    setLoadingAction('magic');
    try {
      await authService.signInWithMagicLink(email.trim());
      setMagicLinkSent(true);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to send magic link';
      Alert.alert('Error', errorMessage);
    } finally {
      setLoadingAction(null);
    }
  }, [validateEmail, email, loadingAction, triggerShake]);

  const handleSocialLogin = useCallback(async (provider: 'google' | 'apple') => {
    if (loadingAction) return;
    setLoadingAction(provider);
    try {
      let result;
      if (provider === 'google') {
        result = await authService.signInWithGoogle();
      } else {
        result = await authService.signInWithApple();
      }
      if (result?.session) {
        await markOnboardingComplete();
        router.replace('/(tabs)');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : `Failed to sign in with ${provider}`;
      Alert.alert('Login Failed', errorMessage);
    } finally {
      setLoadingAction(null);
    }
  }, [loadingAction, markOnboardingComplete, router]);

  // ── Clear field-level errors on edit ────────────────────────────────
  const onEmailChange = useCallback((value: string) => {
    setEmail(value);
    setErrors((prev) => (prev.email ? { ...prev, email: undefined } : prev));
    setMagicLinkSent((prev) => (prev ? false : prev));
  }, []);

  const onPasswordChange = useCallback((value: string) => {
    setPassword(value);
    setErrors((prev) => (prev.password ? { ...prev, password: undefined } : prev));
  }, []);

  const onEmailBlur = useCallback(() => {
    if (email.trim()) {
      const err = validateEmail(email);
      if (err) setErrors((prev) => ({ ...prev, email: err }));
    }
  }, [email, validateEmail]);

  const switchMode = useCallback((next: LoginMode) => {
    setMode(next);
    setErrors({});
  }, []);

  const togglePasswordVisibility = useCallback(() => {
    setShowPassword((prev) => !prev);
  }, []);

  return {
    mode, switchMode,
    email, onEmailChange, onEmailBlur,
    password, onPasswordChange,
    showPassword, togglePasswordVisibility,
    errors,
    loadingAction,
    isLoading: loadingAction !== null,
    magicLinkSent,
    shakeAnim,
    onSubmit,
    handleForgotPassword,
    handleMagicLink,
    handleSocialLogin,
  };
}
