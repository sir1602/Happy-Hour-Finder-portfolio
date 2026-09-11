import { renderHook, act, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import * as Network from 'expo-network';
import Constants from 'expo-constants';
import {
    useMapTiles,
    isUsableMapsKey,
    readConfiguredMapsKey,
    TILE_LOAD_TIMEOUT_MS,
} from '../../hooks/useMapTiles';

jest.mock('expo-network', () => ({
    getNetworkStateAsync: jest.fn(),
}));

// `Constants.expoConfig` is a non-configurable getter on the real module, so
// the manifest is swapped at the module boundary rather than on the object. The
// rest of the module is kept intact — jest-expo's own setup reads from it.
jest.mock('expo-constants', () => {
    const actual = jest.requireActual('expo-constants');
    return { ...actual, __esModule: true, default: { ...actual.default, expoConfig: null } };
});

const mockGetNetworkState = Network.getNetworkStateAsync as jest.Mock;
const mockConstants = Constants as { expoConfig: unknown };

const setPlatform = (os: 'android' | 'ios') => {
    Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
};

const setManifestKey = (key: string | undefined) => {
    mockConstants.expoConfig = { android: { config: { googleMaps: { apiKey: key } } } };
};

/** Runs out the tile timeout and lets the async network check settle. */
const advancePastTimeout = async () => {
    await act(async () => {
        jest.advanceTimersByTime(TILE_LOAD_TIMEOUT_MS);
    });
};

describe('isUsableMapsKey', () => {
    it('rejects an absent or empty key', () => {
        expect(isUsableMapsKey(undefined)).toBe(false);
        expect(isUsableMapsKey(null)).toBe(false);
        expect(isUsableMapsKey('   ')).toBe(false);
    });

    it('rejects the .env.example placeholder, which is what a copied env file leaves behind', () => {
        expect(isUsableMapsKey('your_google_maps_key')).toBe(false);
        expect(isUsableMapsKey('YOUR_GOOGLE_MAPS_KEY')).toBe(false);
        expect(isUsableMapsKey('AIza...')).toBe(false);
    });

    it('accepts a real-looking key', () => {
        expect(isUsableMapsKey('AIzaSyD-ExampleKeyValue_1234567890abcdef')).toBe(true);
    });
});

describe('readConfiguredMapsKey', () => {
    it('reads the key baked into the embedded manifest', () => {
        setPlatform('android');
        setManifestKey('AIzaFromManifest');
        expect(readConfiguredMapsKey()).toBe('AIzaFromManifest');
    });

    it('falls back to the inlined env var when the manifest carries no key', () => {
        setPlatform('android');
        setManifestKey(undefined);
        process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY = 'AIzaFromBundle';
        expect(readConfiguredMapsKey()).toBe('AIzaFromBundle');
        delete process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
    });
});

describe('useMapTiles', () => {
    beforeEach(() => {
        // `setImmediate` is left real: the testing library commits renders on it,
        // and faking it stops `renderHook` from ever producing a result.
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
        mockGetNetworkState.mockResolvedValue({ isConnected: true, isInternetReachable: true });
        setPlatform('android');
        setManifestKey('AIzaSyD-ExampleKeyValue_1234567890abcdef');
        delete process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('stays pending until the map reports either way', async () => {
        const { result } = await renderHook(() => useMapTiles({ enabled: true }));
        expect(result.current.status).toBe('pending');
        expect(result.current.failure).toBeNull();
    });

    it('reports loaded when onMapLoaded fires, and never times out afterwards', async () => {
        const { result } = await renderHook(() => useMapTiles({ enabled: true }));

        await act(async () => {
            result.current.handleMapLoaded();
        });
        expect(result.current.status).toBe('loaded');

        await advancePastTimeout();
        expect(result.current.status).toBe('loaded');
        expect(result.current.failure).toBeNull();
    });

    it('blames a rejected key when tiles never arrive but a real key shipped', async () => {
        const { result } = await renderHook(() => useMapTiles({ enabled: true }));

        await advancePastTimeout();

        await waitFor(() => expect(result.current.status).toBe('unavailable'));
        expect(result.current.failure).toBe('rejected-key');
    });

    it('blames the missing key when no key shipped in the build', async () => {
        setManifestKey(undefined);
        const { result } = await renderHook(() => useMapTiles({ enabled: true }));

        await advancePastTimeout();

        await waitFor(() => expect(result.current.failure).toBe('missing-key'));
    });

    it('blames the network when the device is offline, not the key', async () => {
        mockGetNetworkState.mockResolvedValue({ isConnected: false, isInternetReachable: false });
        const { result } = await renderHook(() => useMapTiles({ enabled: true }));

        await advancePastTimeout();

        await waitFor(() => expect(result.current.failure).toBe('offline'));
    });

    it('assumes online when the connectivity check itself fails, so a bad key is not hidden', async () => {
        mockGetNetworkState.mockRejectedValue(new Error('unavailable'));
        const { result } = await renderHook(() => useMapTiles({ enabled: true }));

        await advancePastTimeout();

        await waitFor(() => expect(result.current.failure).toBe('rejected-key'));
    });

    it('does not arm the timer while the map is not mounted', async () => {
        const { result } = await renderHook(() => useMapTiles({ enabled: false }));

        await advancePastTimeout();

        expect(result.current.status).toBe('pending');
    });

    it('never reports a failure on iOS, where onMapLoaded is not fired by Apple Maps', async () => {
        setPlatform('ios');
        const { result } = await renderHook(() => useMapTiles({ enabled: true }));

        await advancePastTimeout();

        expect(result.current.status).toBe('pending');
        expect(result.current.failure).toBeNull();
    });

    it('retry re-arms the check and remounts the map', async () => {
        const { result } = await renderHook(() => useMapTiles({ enabled: true }));
        await advancePastTimeout();
        await waitFor(() => expect(result.current.status).toBe('unavailable'));
        const keyBefore = result.current.mapKey;

        await act(async () => {
            result.current.retry();
        });
        expect(result.current.status).toBe('pending');
        expect(result.current.failure).toBeNull();
        expect(result.current.mapKey).toBe(keyBefore + 1);

        // A retry that succeeds clears the overlay for good.
        await act(async () => {
            result.current.handleMapLoaded();
        });
        await advancePastTimeout();
        expect(result.current.status).toBe('loaded');
    });
});
