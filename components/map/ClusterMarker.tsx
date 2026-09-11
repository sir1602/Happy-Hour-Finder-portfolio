import React, { memo } from 'react';
import { View, Text } from 'react-native';

let Marker: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const maps = require('react-native-maps');
  Marker = maps.Marker;
} catch {
  // Graceful fallback
}

export interface ClusterMarkerProps {
  latitude: number;
  longitude: number;
  pointCount: number;
  onPress: () => void;
}

export const ClusterMarker = memo(({ latitude, longitude, pointCount, onPress }: ClusterMarkerProps) => {
  if (!Marker) return null;

  return (
    <Marker
      coordinate={{ latitude, longitude }}
      onPress={onPress}
      tracksViewChanges={false}
    >
      <View className="size-10 rounded-full bg-amber-500 border-2 border-slate-900 items-center justify-center shadow-lg">
        <Text className="text-xs font-bold text-slate-950">{pointCount}</Text>
      </View>
    </Marker>
  );
});

ClusterMarker.displayName = 'ClusterMarker';
