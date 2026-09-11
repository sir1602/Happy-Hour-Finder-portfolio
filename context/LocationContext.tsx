import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode, useCallback } from 'react';
import * as Location from 'expo-location';
import { calculateDistance } from '../utils/location';
import { Deal } from '../types';
import { Logger } from '../services/logger';

interface UserLocation {
    latitude: number;
    longitude: number;
}

interface LocationContextType {
    userLocation: UserLocation | null;
    isLoading: boolean;
    errorMsg: string | null;
    permissionGranted: boolean;
    /**
     * Prompt for foreground location permission and fetch a fresh position.
     * Resolves to the coordinates on success, or null if denied/unavailable.
     *
     * Returns the coords rather than a boolean because callers act on them
     * immediately (e.g. animating the map) and can't read the freshly-set
     * `userLocation` state from the same closure.
     */
    requestLocationPermission: () => Promise<UserLocation | null>;
    getDistanceTo: (lat: number, lng: number) => string | null;
    sortByDistance: (deals: Deal[]) => Deal[];
}

const LocationContext = createContext<LocationContextType | undefined>(undefined);

export const useLocation = () => {
    const context = useContext(LocationContext);
    if (!context) {
        throw new Error('useLocation must be used within a LocationProvider');
    }
    return context;
};

export const LocationProvider = ({ children }: { children: ReactNode }) => {
    const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [permissionGranted, setPermissionGranted] = useState(false);

    const initLocation = useCallback(async () => {
        setIsLoading(true);
        try {
            const { status } = await Location.getForegroundPermissionsAsync();
            if (status === 'granted') {
                setPermissionGranted(true);
                const location = await Location.getCurrentPositionAsync({});
                setUserLocation({
                    latitude: location.coords.latitude,
                    longitude: location.coords.longitude,
                });
            } else {
                setPermissionGranted(false);
            }
        } catch (e) {
            Logger.error('[LocationContext] Error getting initial location', e);
            setErrorMsg('Failed to get location');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        initLocation();
    }, [initLocation]);

    const requestLocationPermission = useCallback(async (): Promise<UserLocation | null> => {
        setIsLoading(true);
        try {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status !== 'granted') {
                setErrorMsg('Permission to access location was denied');
                setPermissionGranted(false);
                return null;
            }

            setPermissionGranted(true);
            const location = await Location.getCurrentPositionAsync({});
            const coords = {
                latitude: location.coords.latitude,
                longitude: location.coords.longitude,
            };
            setUserLocation(coords);
            setErrorMsg(null);
            return coords;
        } catch (e) {
            Logger.error('[LocationContext] Error requesting location permission', e);
            setErrorMsg('Failed to request location permission');
            return null;
        } finally {
            setIsLoading(false);
        }
    }, []);

    /**
     * Get distance as formatted string (e.g., "0.8 mi")
     */
    const getDistanceTo = useCallback((lat: number, lng: number): string | null => {
        if (!userLocation) return null;
        if (lat === 0 && lng === 0) return null; // Invalid/missing coords
        
        const dist = calculateDistance(
            userLocation.latitude,
            userLocation.longitude,
            lat,
            lng
        );
        return `${dist} mi`;
    }, [userLocation]);

    /**
     * Sort deals by distance from user's location.
     * Populates each deal's `distance` string field as a side-effect.
     * Uses a separate numeric array for sorting to avoid mutating deal objects.
     */
    const sortByDistance = useCallback((deals: Deal[]): Deal[] => {
        if (!userLocation) return deals;

        // Map each deal to { deal, distanceStr, numericDist } without mutating deal
        const annotated = deals.map(deal => {
            const distStr = getDistanceTo(deal.latitude, deal.longitude);
            const newDistance = distStr || deal.distance;
            return {
                deal, // keep original reference to evaluate in map-back
                newDistance,
                numericDist: distStr ? parseFloat(distStr) : Infinity,
            };
        });

        annotated.sort((a, b) => a.numericDist - b.numericDist);

        return annotated.map(({ deal, newDistance }) => {
            if (deal.distance !== newDistance) {
                return { ...deal, distance: newDistance };
            }
            return deal;
        });
    }, [userLocation, getDistanceTo]);

    const value = useMemo(
        () => ({
            userLocation,
            isLoading,
            errorMsg,
            permissionGranted,
            requestLocationPermission,
            getDistanceTo,
            sortByDistance,
        }),
        [userLocation, isLoading, errorMsg, permissionGranted, requestLocationPermission, getDistanceTo, sortByDistance]
    );

    return (
        <LocationContext.Provider value={value}>
            {children}
        </LocationContext.Provider>
    );
};
