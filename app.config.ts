import { ExpoConfig, ConfigContext } from 'expo/config';

/**
 * Google Maps key, resolved at config time and written into the native
 * manifests (AndroidManifest meta-data / Info.plist) during prebuild.
 *
 * This is checked rather than defaulted to "" because an empty key does not
 * fail the build — it produces an app that installs and launches fine, then
 * shows a blank grey map with no error anywhere in the UI. That costs a full
 * build, install, and manual test to discover. Failing here costs seconds.
 *
 * The variable must exist wherever the build runs. A local `.env` covers local
 * builds only: EAS Build never sees it, because `.env` is gitignored and so is
 * absent from the uploaded archive. For EAS, set it per environment:
 *
 *   eas env:create --environment preview \
 *     --name EXPO_PUBLIC_GOOGLE_MAPS_API_KEY --value "AIza..."
 *
 * Set ALLOW_MISSING_MAPS_KEY=1 to bypass this when building something that
 * genuinely does not need a working map.
 */
function resolveGoogleMapsApiKey(): string {
    const key = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
    if (key) return key;

    if (process.env.ALLOW_MISSING_MAPS_KEY === '1') {
        console.warn(
            '[app.config] EXPO_PUBLIC_GOOGLE_MAPS_API_KEY is not set and ' +
            'ALLOW_MISSING_MAPS_KEY=1. The map screen will render blank.'
        );
        return '';
    }

    throw new Error(
        'EXPO_PUBLIC_GOOGLE_MAPS_API_KEY is not set.\n\n' +
        'It is baked into the native manifest at build time, so a build without ' +
        'it produces an app whose map screen is permanently blank -- with no ' +
        'error shown in the app.\n\n' +
        '  Local builds:  add it to .env (see .env.example)\n' +
        '  EAS builds:    eas env:create --environment <env> \\\n' +
        '                   --name EXPO_PUBLIC_GOOGLE_MAPS_API_KEY --value "AIza..."\n\n' +
        'A local .env does NOT reach EAS Build -- it is gitignored, so it is not ' +
        'in the uploaded archive.\n\n' +
        'To build anyway without a working map, set ALLOW_MISSING_MAPS_KEY=1.'
    );
}

export default ({ config }: ConfigContext): ExpoConfig => {
    const googleMapsApiKey = resolveGoogleMapsApiKey();

    return {
        ...config,
        name: config.name || "Happy Hour Finder",
        slug: config.slug || "happy-hour-finder",
        ios: {
            ...config.ios,
            config: {
                ...config.ios?.config,
                googleMapsApiKey,
            },
        },
        android: {
            ...config.android,
            config: {
                ...config.android?.config,
                googleMaps: {
                    apiKey: googleMapsApiKey,
                },
            },
        },
    };
};
