
import React from 'react';
import { MaterialIcons } from '@expo/vector-icons';
import type { ColorValue } from 'react-native';

interface IconProps {
    name: keyof typeof MaterialIcons.glyphMap;
    size: number;
    // `ColorValue`, not `string`: expo-router's `tabBarIcon` hands its render
    // callback a `ColorValue`, which covers the opaque values `PlatformColor`
    // and `DynamicColorIOS` return. MaterialIcons already accepts the wider
    // type -- this wrapper was the only thing narrowing it.
    color: ColorValue;
}

export const Icon = ({ name, size, color }: IconProps) => (
    <MaterialIcons name={name} size={size} color={color} />
);
