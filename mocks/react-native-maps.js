import React from 'react';
import { View, Text } from 'react-native';

export const Marker = (props) => {
    return <View>{props.children}</View>;
};

export const Callout = (props) => {
    return <View>{props.children}</View>;
};

const MapView = (props) => {
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#e0e0e0' }}>
            <Text>Map View (Not supported on Web)</Text>
            {props.children}
        </View>
    );
};

export default MapView;
