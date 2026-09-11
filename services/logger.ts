import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

let isInitialized = false;

export const Logger = {
    /**
     * Initialize crash reporting.
     *
     * Called at module scope from `app/_layout.tsx`, NOT from a `useEffect`.
     * Init used to run inside the root layout's effect, i.e. after the first
     * render — so anything thrown during module evaluation or initial render
     * was never reported. That includes the hard `throw` in `services/supabase.ts`
     * when the Supabase env vars are missing, which is exactly the kind of
     * startup crash an alpha is meant to surface.
     */
    init: () => {
        if (isInitialized) return;
        isInitialized = true;

        const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
        if (!dsn) {
            console.warn('[Logger] Sentry DSN not found. Crash reporting is disabled.');
            return;
        }

        Sentry.init({
            dsn,
            debug: process.env.NODE_ENV === 'development',
            // Distinguishes alpha crashes from everything else.
            environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
            release: Constants.expoConfig?.version,
            // Performance tracing is off by default: it is the bulk of event
            // volume and nothing here is being profiled yet.
            tracesSampleRate: Number(process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0),
        });
        console.log('[Logger] Sentry initialized.');
    },

    error: (message: string, error?: unknown, context?: Record<string, any>) => {
        console.error(`[ERROR] ${message}`, error);

        if (context) {
            Sentry.setContext('additional_info', context);
        }

        if (error instanceof Error) {
            Sentry.captureException(error);
        } else if (error) {
            Sentry.captureMessage(`${message}: ${JSON.stringify(error)}`, 'error');
        } else {
            Sentry.captureMessage(message, 'error');
        }
    },

    /**
     * Recoverable problems. Recorded as a breadcrumb, not an event.
     *
     * These used to call `captureMessage`, which made every warning its own
     * Sentry event. Routine paths warn — `getDeals` background-refresh failures,
     * `getFilterOptions` cache fallbacks — so ordinary offline use generated a
     * steady stream of events that burns the quota and buries real crashes.
     * As breadcrumbs they still show up, attached to whatever error follows.
     */
    warn: (message: string, errorOrContext?: unknown, context?: Record<string, any>) => {
        console.warn(`[WARN] ${message}`, errorOrContext instanceof Error ? errorOrContext : '');
        const ctx = context ?? (errorOrContext && !(errorOrContext instanceof Error) ? errorOrContext as Record<string, any> : undefined);

        Sentry.addBreadcrumb({
            level: 'warning',
            message,
            data: {
                ...(ctx ?? {}),
                ...(errorOrContext instanceof Error ? { error: errorOrContext.message } : {}),
            },
        });
    },

    /** Informational. Breadcrumb only — see the note on `warn`. */
    info: (message: string, context?: Record<string, any>) => {
        console.log(`[INFO] ${message}`);
        Sentry.addBreadcrumb({
            level: 'info',
            message,
            data: context,
        });
    },

    setUser: (id: string, email?: string) => {
        Sentry.setUser({ id, email });
    },

    clearUser: () => {
        Sentry.setUser(null);
    }
};
