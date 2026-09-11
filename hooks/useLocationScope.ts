import { useEffect, useState } from 'react';
import { useLocation } from '../context/LocationContext';
import { resolveLocationScope, type LocationScope } from '../services/metroService';
import { Logger } from '../services/logger';

/**
 * The geographic scope the current screen should show deals for.
 *
 * `scope` is null only while it is being resolved; once resolved it is always
 * a usable value, because resolveLocationScope() falls back through the stored
 * metro to a seeded default rather than ever giving up. Screens should wait for
 * a non-null scope before fetching, otherwise the first render issues an
 * unscoped query that briefly shows another city's deals.
 */
export const useLocationScope = (): { scope: LocationScope | null; isResolving: boolean } => {
    const { userLocation } = useLocation();
    const [scope, setScope] = useState<LocationScope | null>(null);
    const [isResolving, setIsResolving] = useState(true);

    const lat = userLocation?.latitude;
    const lng = userLocation?.longitude;

    useEffect(() => {
        let cancelled = false;
        setIsResolving(true);

        resolveLocationScope(lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : null)
            .then((resolved) => {
                if (!cancelled) setScope(resolved);
            })
            .catch((e) => {
                Logger.warn('[useLocationScope] Could not resolve a scope', e);
            })
            .finally(() => {
                if (!cancelled) setIsResolving(false);
            });

        return () => {
            cancelled = true;
        };
    }, [lat, lng]);

    return { scope, isResolving };
};
