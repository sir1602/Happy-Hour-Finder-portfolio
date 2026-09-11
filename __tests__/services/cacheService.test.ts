import AsyncStorage from '@react-native-async-storage/async-storage';
import { cacheService } from '../../services/cacheService';

describe('cacheService', () => {
    beforeEach(async () => {
        await AsyncStorage.clear();
        jest.restoreAllMocks();
    });

    it('round-trips a value', async () => {
        await cacheService.set('k', { a: 1 });
        expect(await cacheService.get('k')).toEqual({ a: 1 });
    });

    it('returns null for an expired entry', async () => {
        await cacheService.set('k', 'v', -1);
        expect(await cacheService.get('k')).toBeNull();
    });

    it('returns an expired entry when ignoreExpiry is set', async () => {
        await cacheService.set('k', 'v', -1);
        expect(await cacheService.get('k', true)).toBe('v');
    });

    it('only touches keys under its own prefix', async () => {
        await AsyncStorage.setItem('savedDeals', '["a"]');
        await cacheService.set('k', 'v');
        await cacheService.clear();
        expect(await AsyncStorage.getItem('savedDeals')).toBe('["a"]');
    });

    describe('eviction', () => {
        /**
         * The regression this guards: nothing evicted, and getDeals keys on the
         * full filter object including the debounced search query and offset, so
         * the cache_ namespace grew without bound until AsyncStorage's ~6MB
         * Android ceiling silently started failing writes.
         */
        it('keeps the cache bounded across many distinct keys', async () => {
            for (let i = 0; i < 90; i++) {
                await cacheService.set(`deals_${i}`, { rows: [i] }, 60_000);
            }
            const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith('cache_'));
            expect(keys.length).toBeLessThanOrEqual(60);
        });

        it('drops expired entries before live ones', async () => {
            await cacheService.set('stale', 'old', -1);
            for (let i = 0; i < 70; i++) {
                await cacheService.set(`fresh_${i}`, i, 60_000);
            }
            expect(await AsyncStorage.getItem('cache_stale')).toBeNull();
        });

        it('evicts least-recently-used entries first', async () => {
            // Drive the clock explicitly. Real `Date.now()` has millisecond
            // resolution, so dozens of writes in a tight loop share a timestamp
            // and the LRU ordering among those ties is arbitrary — which made
            // this assertion flaky roughly one run in six.
            let clock = 1_700_000_000_000;
            jest.spyOn(Date, 'now').mockImplementation(() => (clock += 1));

            await cacheService.set('oldest', 'v', 600_000);
            for (let i = 0; i < 59; i++) {
                await cacheService.set(`filler_${i}`, i, 600_000);
            }

            // Re-reading refreshes the LRU timestamp, so this should now survive.
            await cacheService.get('oldest');

            for (let i = 0; i < 20; i++) {
                await cacheService.set(`later_${i}`, i, 600_000);
            }

            expect(await cacheService.get('oldest')).toBe('v');
            // ...while the entries never re-read since being written are gone.
            expect(await cacheService.get('filler_0')).toBeNull();
        });

        it('does not evict while under the cap', async () => {
            for (let i = 0; i < 10; i++) {
                await cacheService.set(`k_${i}`, i, 60_000);
            }
            const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith('cache_'));
            expect(keys.length).toBe(10);
        });

        it('discards unparseable entries', async () => {
            await AsyncStorage.setItem('cache_corrupt', 'not json');
            for (let i = 0; i < 70; i++) {
                await cacheService.set(`k_${i}`, i, 60_000);
            }
            expect(await AsyncStorage.getItem('cache_corrupt')).toBeNull();
        });
    });
});
