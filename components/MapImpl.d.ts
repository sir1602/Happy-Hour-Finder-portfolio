import { ComponentType } from 'react';

interface MapImplProps {
    focusDealId?: string;
    focusLat?: number;
    focusLng?: number;
    focusNonce?: string;
}

declare const MapImpl: ComponentType<MapImplProps>;
export default MapImpl;
