import { Linking, Platform } from 'react-native';
import { openDirections } from '../../utils/navigation';

// Override only `Linking` and `Platform`, leaving the rest of react-native
// intact. This used to replace the whole module with a two-key object, which
// broke under Expo SDK 56: `globalThis.fetch` is now a lazy getter for
// expo/fetch, and resolving it pulls in expo-modules-core ->
// react-native-css-interop, which reads `Appearance.getColorScheme()`. With
// react-native stubbed out wholesale, `Appearance` was undefined and the whole
// suite failed to load.
//
// A Proxy rather than a spread: react-native's exports are lazy getters, and
// spreading would eagerly evaluate every one of them.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const linking = { openURL: jest.fn() };
    const platform = { select: jest.fn() };

    return new Proxy(actual, {
        get: (target, prop) => {
            if (prop === 'Linking') return linking;
            if (prop === 'Platform') return platform;
            return Reflect.get(target, prop);
        },
    });
});

describe('openDirections', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('falls back to text search when coordinates are 0,0 (with address)', () => {
        (Linking.openURL as jest.Mock).mockResolvedValue(true);
        openDirections('My Place', '123 Main St', 'Downtown', 0, 0);
        expect(Linking.openURL).toHaveBeenCalledWith('https://maps.google.com/?q=My%20Place%20123%20Main%20St');
    });

    it('falls back to text search when coordinates are 0,0 (without address)', () => {
        (Linking.openURL as jest.Mock).mockResolvedValue(true);
        openDirections('My Place', undefined, 'Downtown', 0, 0);
        expect(Linking.openURL).toHaveBeenCalledWith('https://maps.google.com/?q=My%20Place%20Downtown');
    });

    it('opens iOS native maps when Platform.select returns ios string', () => {
        (Platform.select as jest.Mock).mockReturnValue('maps://0,0?daddr=40,-73&q=My%20Place');
        (Linking.openURL as jest.Mock).mockResolvedValue(true);

        openDirections('My Place', '123 Main St', 'Downtown', 40, -73);

        expect(Platform.select).toHaveBeenCalledWith(expect.objectContaining({
            ios: 'maps://0,0?daddr=40,-73&q=My%20Place',
            android: 'google.navigation:q=40,-73&label=My%20Place',
            default: 'https://maps.google.com/maps?daddr=40,-73',
        }));
        expect(Linking.openURL).toHaveBeenCalledWith('maps://0,0?daddr=40,-73&q=My%20Place');
    });

    it('opens Android native maps when Platform.select returns android string', () => {
        (Platform.select as jest.Mock).mockReturnValue('google.navigation:q=40,-73&label=My%20Place');
        (Linking.openURL as jest.Mock).mockResolvedValue(true);

        openDirections('My Place', '123 Main St', 'Downtown', 40, -73);

        expect(Linking.openURL).toHaveBeenCalledWith('google.navigation:q=40,-73&label=My%20Place');
    });

    it('opens web fallback when Platform.select returns default string', () => {
        (Platform.select as jest.Mock).mockReturnValue('https://maps.google.com/maps?daddr=40,-73');
        (Linking.openURL as jest.Mock).mockResolvedValue(true);

        openDirections('My Place', '123 Main St', 'Downtown', 40, -73);

        expect(Linking.openURL).toHaveBeenCalledWith('https://maps.google.com/maps?daddr=40,-73');
    });

    it('opens fallback Google Maps URL if native app opening fails', async () => {
        (Platform.select as jest.Mock).mockReturnValue('maps://0,0?daddr=40,-73&q=My%20Place');
        (Linking.openURL as jest.Mock)
            .mockRejectedValueOnce(new Error('Failed to open'))
            .mockResolvedValueOnce(true);

        openDirections('My Place', '123 Main St', 'Downtown', 40, -73);

        // Wait for next tick for the catch block to execute
        await new Promise(process.nextTick);

        expect(Linking.openURL).toHaveBeenCalledTimes(2);
        expect(Linking.openURL).toHaveBeenNthCalledWith(1, 'maps://0,0?daddr=40,-73&q=My%20Place');
        expect(Linking.openURL).toHaveBeenNthCalledWith(2, 'https://maps.google.com/maps?daddr=40,-73');
    });
});
