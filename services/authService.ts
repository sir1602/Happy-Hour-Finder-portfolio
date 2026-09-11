import { supabase } from './supabase';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Logger } from './logger';
import { clearDealDraft } from './dealDraftService';

// Use expo-linking for redirect URI (expo-auth-session pulls in expo-crypto
// native modules which are not available in Expo Go)
const redirectUri = Linking.createURL('auth/callback');

// Every Supabase auth call follows the same "log and rethrow" shape; callers
// (AuthContext, login.tsx) already handle thrown errors, so this only adds
// Sentry visibility without changing control flow.
const throwIfError = (context: string, error: unknown): void => {
  if (error) {
    Logger.error(context, error);
    throw error;
  }
};


export const extractTokensFromUrl = (rawUrl: string) => {
  const url = new URL(rawUrl);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
  const queryParams = new URLSearchParams(url.search.replace(/^\?/, ''));

  const accessToken = hashParams.get('access_token') ?? queryParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token') ?? queryParams.get('refresh_token');
  const code = queryParams.get('code');
  // Supabase marks a password-reset link with type=recovery. It arrives in the
  // fragment on the implicit flow and the query string on PKCE, so read both.
  const type = hashParams.get('type') ?? queryParams.get('type');
  // Supabase reports a rejected link (expired, already used) here rather than
  // by omitting the tokens, so a callback that carries one must say so instead
  // of silently doing nothing.
  const errorDescription =
    hashParams.get('error_description') ?? queryParams.get('error_description');
  const error = hashParams.get('error') ?? queryParams.get('error');

  return {
    accessToken,
    refreshToken,
    code,
    type,
    error: errorDescription ?? error,
  };
};

export const authService = {
  /**
   * Get the current user session
   */
  async getSession() {
    const { data, error } = await supabase.auth.getSession();
    throwIfError('Error fetching session', error);
    return data.session;
  },

  /**
   * Sign up a new user with email and password
   */
  async signUp(email: string, password: string) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Without this the confirmation link targets Supabase's Site URL, which
        // is not this app. `app/auth/callback.tsx` handles the redirect.
        emailRedirectTo: redirectUri,
      },
    });
    throwIfError('Error signing up', error);
    return data;
  },

  /**
   * Sign in an existing user with email and password
   */
  async signIn(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    throwIfError('Error signing in', error);
    return data;
  },

  /**
   * Sign out the current user
   */
  async signOut() {
    // Drop any half-written deal submission first. The submit screen is
    // auth-gated, so a draft left behind would be restored for whoever signs
    // in next -- their address and notes, on someone else's account.
    await clearDealDraft();
    const { error } = await supabase.auth.signOut();
    throwIfError('Error signing out', error);
  },

  /**
   * Send a password reset email to the user
   */
  async resetPasswordForEmail(email: string) {
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      // No redirectTo meant the emailed link went to Supabase's default Site
      // URL, so even a tester who received the mail had nowhere to land. It now
      // deep-links back into the app, where `app/auth/callback.tsx` establishes
      // the recovery session and forwards to the new-password screen.
      redirectTo: redirectUri,
    });
    throwIfError('Error sending password reset email', error);
    return data;
  },

  /**
   * Set a new password for the signed-in user.
   *
   * Only reachable with a live session, which for the reset flow is the
   * short-lived one established from the recovery link. There was previously no
   * `updateUser` call anywhere in the codebase, so "Forgot Password?" advertised
   * a flow that could not complete at all.
   */
  async updatePassword(newPassword: string) {
    const { data, error } = await supabase.auth.updateUser({ password: newPassword });
    throwIfError('Error updating password', error);
    return data;
  },

  /**
   * Send a magic link to the user's email for passwordless login
   */
  async signInWithMagicLink(email: string) {
    const { data, error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectUri,
      },
    });
    throwIfError('Error sending magic link', error);
    return data;
  },

  /**
   * Sign in with Google OAuth
   */
  async signInWithGoogle() {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUri,
        skipBrowserRedirect: true,
      },
    });
    throwIfError('Error starting Google OAuth', error);

    if (data?.url) {
      const result = await WebBrowser.openAuthSessionAsync(
        data.url,
        redirectUri,
        { showInRecents: true }
      );

      if (result.type === 'success' && result.url) {
        // Extract the tokens from the URL fragment
        const url = new URL(result.url);
        // Supabase returns tokens in the hash fragment
        const hashParams = new URLSearchParams(url.hash.substring(1));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');

        if (accessToken && refreshToken) {
          const { data: sessionData, error: sessionError } =
            await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
          throwIfError('Error establishing session after Google OAuth', sessionError);
          return sessionData;
        }
      }
    }
    return null;
  },

  /**
   * Sign in with Apple OAuth
   */
  async signInWithApple() {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: {
        redirectTo: redirectUri,
        skipBrowserRedirect: true,
      },
    });
    throwIfError('Error starting Apple OAuth', error);

    if (data?.url) {
      const result = await WebBrowser.openAuthSessionAsync(
        data.url,
        redirectUri,
        { showInRecents: true }
      );

      if (result.type === 'success' && result.url) {
        const url = new URL(result.url);
        const hashParams = new URLSearchParams(url.hash.substring(1));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');

        if (accessToken && refreshToken) {
          const { data: sessionData, error: sessionError } =
            await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
          throwIfError('Error establishing session after Apple OAuth', sessionError);
          return sessionData;
        }
      }
    }
    return null;
  },


  /**
   * Process an auth callback URL and establish a user session.
   */
  async handleAuthCallback(url: string) {
    const { accessToken, refreshToken, code, error: linkError } = extractTokensFromUrl(url);

    if (linkError) {
      throw new Error(linkError);
    }

    if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      throwIfError('Error exchanging auth code for session', error);
      return data.session;
    }

    if (accessToken && refreshToken) {
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      throwIfError('Error establishing session from auth callback', error);
      return data.session;
    }

    return null;
  },

  /**
   * Listen for authentication state changes and return a subscription string
   */
  onAuthStateChange(callback: (event: string, session: any) => void) {
    const { data } = supabase.auth.onAuthStateChange(callback);
    return data.subscription;
  },

  /**
   * Delete the current user's account by calling the delete_user_account RPC
   */
  async deleteAccount() {
    const { error } = await supabase.rpc('delete_user_account');
    throwIfError('Error deleting account', error);
    await this.signOut();
  },
};
