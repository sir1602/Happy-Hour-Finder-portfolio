import PostHog from 'posthog-react-native';

export let posthog: PostHog | null = null;

export const Analytics = {
    init: async () => {
        const apiKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
        const host = process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://app.posthog.com';
        
        if (apiKey) {
            posthog = new PostHog(apiKey, {
                host: host,
                flushAt: 1,
                flushInterval: 10000,
            });
            console.log('[Analytics] PostHog initialized.');
        } else {
            console.warn('[Analytics] PostHog API Key not found. Analytics is disabled.');
        }
    },

    track: (event: string, properties?: Record<string, any>) => {
        if (posthog) {
            posthog.capture(event, properties);
        } else {
            console.log(`[Analytics - Dev] Tracked event: ${event}`, properties);
        }
    },

    identify: (distinctId: string, userProperties?: Record<string, any>) => {
        if (posthog) {
            posthog.identify(distinctId, userProperties);
        } else {
            console.log(`[Analytics - Dev] Identified user: ${distinctId}`, userProperties);
        }
    },

    reset: () => {
        if (posthog) {
            posthog.reset();
        }
    }
};
