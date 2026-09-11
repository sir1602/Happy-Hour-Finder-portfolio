import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

/**
 * Which required variables are missing, or null when the client is properly
 * configured.
 *
 * This module used to `throw` here. Because it is reached through the import
 * graph of `app/_layout.tsx` (via DealsProvider -> dealService), that throw
 * happened during module evaluation: before React rendered, before
 * `ErrorBoundary` existed to catch it, and — until `services/instrument.ts` —
 * before Sentry was initialized. The result was a white screen with no error
 * anywhere: in the app, in the logs, or in Sentry.
 *
 * `EXPO_PUBLIC_*` values are inlined at BUILD time, so this is not something a
 * user can fix by signing in or reconnecting. It means the binary itself was
 * built without configuration, and the only useful thing the app can do is say
 * so plainly. `app/_layout.tsx` renders `ConfigErrorScreen` when this is set.
 */
export const supabaseConfigError: string | null = (() => {
    const missing: string[] = [];
    if (!supabaseUrl) missing.push('EXPO_PUBLIC_SUPABASE_URL');
    if (!supabaseAnonKey) missing.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
    return missing.length > 0 ? missing.join(', ') : null;
})();

/**
 * A stand-in client used only when configuration is missing.
 *
 * Every call rejects with the same diagnosable error rather than throwing at
 * import time. Nothing should reach it — `_layout.tsx` short-circuits to the
 * configuration screen — but a stray call during startup must not crash the
 * process before that screen can render.
 */
const unconfiguredClient = (): unknown => {
    const message = `Supabase is not configured. Missing: ${supabaseConfigError}`;
    const noop = () => undefined;

    // A thenable proxy, so the whole PostgREST builder shape keeps working:
    // every property access and every call returns the proxy again, and only
    // *awaiting* it rejects.
    //
    // Neither simpler option works. Throwing synchronously could unwind a
    // non-async caller and kill the process before the configuration screen
    // paints. Returning a rejected promise from the call trap ends the chain --
    // `.from('deals')` would resolve to a promise that `.select()` cannot be
    // read from, and the orphaned rejection becomes an unhandled one.
    const handler: ProxyHandler<typeof noop> = {
        get: (_target, prop) => {
            if (prop === 'then') {
                return (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error(message));
            }
            return new Proxy(noop, handler);
        },
        apply: () => new Proxy(noop, handler),
    };

    return new Proxy(noop, handler);
};

export const supabase = supabaseConfigError
    ? (unconfiguredClient() as ReturnType<typeof createClient<Database>>)
    : createClient<Database>(supabaseUrl, supabaseAnonKey, {
        auth: {
            storage: AsyncStorage,
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false,
        },
    });
