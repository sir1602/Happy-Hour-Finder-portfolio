
import { Tabs } from "expo-router";
import { Platform, useColorScheme } from "react-native";
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../../components/Icon';

export default function TabLayout() {
    const colorScheme = useColorScheme();
    const insets = useSafeAreaInsets();
    const activeColor = '#FFC107';
    const inactiveColor = '#757575';

    // Ensure the tab bar clears Android's system navigation (home/back buttons)
    const bottomPadding = Math.max(insets.bottom, Platform.OS === 'android' ? 12 : 8);

    return (
        <Tabs
            screenOptions={{
                headerShown: false,
                tabBarStyle: {
                    borderTopColor: colorScheme === 'dark' ? 'rgba(255,255,255,0.1)' : '#E5E5E5',
                    backgroundColor: colorScheme === 'dark' ? '#212121' : '#F5F5F5',
                    height: 64 + bottomPadding,
                    paddingBottom: bottomPadding,
                    paddingTop: 8,
                },
                tabBarActiveTintColor: activeColor,
                tabBarInactiveTintColor: inactiveColor,
            }}
        >
            <Tabs.Screen
                name="index"
                options={{
                    title: "Home",
                    tabBarIcon: ({ color, size }) => <Icon name="home" size={size} color={color} />,
                }}
            />
            <Tabs.Screen
                name="explore"
                options={{
                    title: "Explore",
                    tabBarIcon: ({ color, size }) => <Icon name="search" size={size} color={color} />,
                }}
            />
            <Tabs.Screen
                name="map"
                options={{
                    title: "Map",
                    tabBarIcon: ({ color, size }) => <Icon name="map" size={size} color={color} />,
                }}
            />
            <Tabs.Screen
                name="visits"
                options={{
                    title: "Visits",
                    tabBarIcon: ({ color, focused, size }) => <Icon name={focused ? "place" : "near-me"} size={size} color={color} />,
                }}
            />
            <Tabs.Screen
                name="saved"
                options={{
                    title: "Saved",
                    tabBarIcon: ({ color, focused, size }) => <Icon name={focused ? "bookmark" : "bookmark-border"} size={size} color={color} />,
                }}
            />
            <Tabs.Screen
                name="settings"
                options={{
                    title: "Settings",
                    tabBarIcon: ({ color, size }) => <Icon name="settings" size={size} color={color} />,
                }}
            />
        </Tabs>
    );
}
