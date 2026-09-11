import AsyncStorage from '@react-native-async-storage/async-storage';
import { Logger } from './logger';

const CACHE_PREFIX = 'cache_';

/**
 * Maximum number of cached entries retained.
 *
 * Nothing used to evict, and `getDeals` keys on
 * `deals_${JSON.stringify(filters)}` — where filters include the search query,
 * tags, neighborhoods, day, and offset. Because the Explore search box debounces
 * at 300ms, typing "margarita" leaves an entry behind for roughly every pause,
 * each holding a full page of deals with joined venue rows. Filter and day
 * combinations multiply it further.
 *
 * Android's AsyncStorage is SQLite-backed with a 6MB default ceiling. Once hit,
 * writes fail silently (they're caught and logged) and the stale-while-revalidate
 * path quietly degrades to always-network.
 */
const MAX_ENTRIES = 60;

interface CacheEnvelope<T> {
    value: T;
    expiry: number | null;
    /** Last access time, used for LRU eviction. */
    touched?: number;
}

export const cacheService = {
    /**
     * Get a value from the cache. Returns null if not found or expired (unless ignoreExpiry is true).
     */
    async get<T>(key: string, ignoreExpiry = false): Promise<T | null> {
        try {
            const cached = await AsyncStorage.getItem(`${CACHE_PREFIX}${key}`);
            if (!cached) return null;

            const { value, expiry } = JSON.parse(cached) as CacheEnvelope<T>;
            if (!ignoreExpiry && expiry && expiry < Date.now()) {
                // Return null if expired (but don't delete yet so we can fall back if network fails)
                return null;
            }

            // Refresh the LRU timestamp. Awaited rather than fire-and-forget so
            // a read that races an eviction can't lose to it — an unwritten touch
            // would make a hot entry look cold and get it dropped.
            await AsyncStorage.setItem(
                `${CACHE_PREFIX}${key}`,
                JSON.stringify({ value, expiry, touched: Date.now() })
            ).catch(() => {});

            return value as T;
        } catch (e) {
            Logger.error(`Cache read failed for key ${key}`, e);
            return null;
        }
    },

    /**
     * Set a value in the cache with an optional Time-To-Live (TTL) in milliseconds.
     */
    async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
        try {
            const expiry = ttlMs ? Date.now() + ttlMs : null;
            const data = JSON.stringify({ value, expiry, touched: Date.now() });
            await AsyncStorage.setItem(`${CACHE_PREFIX}${key}`, data);
            await this.evictIfNeeded();
        } catch (e) {
            Logger.error(`Cache write failed for key ${key}`, e);
        }
    },

    /**
     * Drop expired entries, then the least-recently-used ones, until the cache is
     * back under MAX_ENTRIES. Called after each write.
     */
    async evictIfNeeded(): Promise<void> {
        try {
            const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(CACHE_PREFIX));
            if (keys.length <= MAX_ENTRIES) return;

            const entries = await AsyncStorage.multiGet(keys);
            const now = Date.now();
            const expired: string[] = [];
            const live: { key: string; touched: number }[] = [];

            for (const [key, raw] of entries) {
                if (!raw) {
                    expired.push(key);
                    continue;
                }
                try {
                    const { expiry, touched } = JSON.parse(raw) as CacheEnvelope<unknown>;
                    if (expiry && expiry < now) {
                        expired.push(key);
                    } else {
                        live.push({ key, touched: touched ?? 0 });
                    }
                } catch {
                    // Unparseable entry — not usable, so treat it as evictable.
                    expired.push(key);
                }
            }

            const toRemove = [...expired];
            const overBy = live.length - MAX_ENTRIES;
            if (overBy > 0) {
                live.sort((a, b) => a.touched - b.touched); // oldest first
                toRemove.push(...live.slice(0, overBy).map(e => e.key));
            }

            if (toRemove.length > 0) {
                await AsyncStorage.multiRemove(toRemove);
            }
        } catch (e) {
            Logger.warn('Cache eviction failed', e);
        }
    },

    /**
     * Remove a specific key from the cache.
     */
    async remove(key: string): Promise<void> {
        try {
            await AsyncStorage.removeItem(`${CACHE_PREFIX}${key}`);
        } catch (e) {
            Logger.error(`Cache remove failed for key ${key}`, e);
        }
    },

    /**
     * Clear all cached items starting with the prefix `cache_`.
     */
    async clear(): Promise<void> {
        try {
            const keys = await AsyncStorage.getAllKeys();
            const cacheKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
            if (cacheKeys.length > 0) {
                await AsyncStorage.multiRemove(cacheKeys);
            }
        } catch (e) {
            Logger.error('Cache clear failed', e);
        }
    }
};
