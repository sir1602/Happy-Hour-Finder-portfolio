import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import MapImpl from '../../components/MapImpl';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { isFiniteCoordinate } from '../../utils/mapRegion';

/**
 * `lat`/`lng` arrive as strings from whatever pushed this route. `parseFloat`
 * on a value that is not a number returns NaN, which is not null, not
 * undefined, and passes every truthiness check downstream — it simply travels
 * on until the Google Maps SDK receives it and the process dies. Screened here
 * so the rest of the screen only ever sees a number or nothing.
 */
const parseCoordinate = (raw?: string): number | undefined => {
    if (raw == null || raw.trim() === '') return undefined;
    const value = Number.parseFloat(raw);
    return isFiniteCoordinate(value) ? value : undefined;
};

export default function MapScreen() {
    const { focusDealId, lat, lng, ts } = useLocalSearchParams<{
        focusDealId?: string;
        lat?: string;
        lng?: string;
        ts?: string;
    }>();

    return (
        // Scoped to this screen rather than relying on the root boundary. A
        // render error inside the map otherwise unmounts the entire app tree,
        // which is indistinguishable from a native crash from the outside —
        // and the two need completely different fixes. Caught here the tab
        // shows a retry, the rest of the app keeps working, and Sentry gets a
        // component stack naming the offending component.
        <ErrorBoundary>
            <MapImpl
                focusDealId={focusDealId}
                focusLat={parseCoordinate(lat)}
                focusLng={parseCoordinate(lng)}
                focusNonce={ts}
            />
        </ErrorBoundary>
    );
}
