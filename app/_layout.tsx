// MUST stay first. Initializes Sentry before any application module is
// imported, so a throw during module evaluation is still reported. See
// services/instrument.ts for why this cannot live further down the file.
import "../services/instrument";

import { Stack } from "expo-router";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { cssInterop } from "nativewind";
import "../global.css";
import * as Sentry from '@sentry/react-native';

import { DealsProvider } from "../context/DealsContext";
import { AuthProvider } from "../context/AuthContext";
import { VisitsProvider } from '../context/VisitsContext';
import { RewardsProvider } from '../context/RewardsContext';
import { LocationProvider } from '../context/LocationContext';
import { GlobalBadgeCelebration } from '../components/GlobalBadgeCelebration';
import { NetworkBanner } from '../components/NetworkBanner';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ConfigErrorScreen } from '../components/ConfigErrorScreen';
import { supabaseConfigError } from '../services/supabase';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

cssInterop(SafeAreaView as any, { className: "style" });



const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 1000 * 60 * 5, // 5 minutes
            gcTime: 1000 * 60 * 30, // 30 minutes
            retry: 2,
            refetchOnWindowFocus: false,
        },
    },
});

function RootLayout() {
    // A build with no Supabase configuration cannot do anything useful, and
    // every provider below assumes a working client. Say so plainly instead of
    // mounting a tree that will fail in a dozen unhelpful ways.
    if (supabaseConfigError) {
        return <ConfigErrorScreen missing={supabaseConfigError} />;
    }

    // Deep links for `deal/{id}` are handled by expo-router's own linking
    // integration, which maps the incoming URL onto the file-based route
    // automatically. A manual Linking listener that also called
    // `router.push('/deal/' + id)` used to live here — it pushed the detail
    // screen a *second* time on top of the one expo-router had already routed
    // to, so every shared link needed two back-presses to dismiss.

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <QueryClientProvider client={queryClient}>
                <ErrorBoundary>
                    <AuthProvider>
                        <SafeAreaProvider>
                            <DealsProvider>
                                <VisitsProvider>
                                    <RewardsProvider>
                                        <LocationProvider>
                                            <StatusBar style="auto" />
                                            <Stack>
                                                <Stack.Screen name="index" options={{ headerShown: false }} />
                                                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                                                <Stack.Screen name="deal/[id]" options={{ headerShown: false }} />
                                                {/* submit-deal draws its own header row with a close
                                                    button. Undeclared routes fall back to the Stack's
                                                    default options, which show the native header — so
                                                    without this it rendered two stacked headers, the
                                                    upper one titled "submit-deal". */}
                                                <Stack.Screen name="submit-deal" options={{ headerShown: false }} />
                                                <Stack.Screen name="login" options={{ headerShown: false }} />
                                                <Stack.Screen name="onboarding" options={{ headerShown: false }} />
                                                {/* Landing routes for emailed auth links. Declared
                                                    so they inherit no native header — both draw
                                                    their own full-screen layout. */}
                                                <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
                                                <Stack.Screen name="auth/reset-password" options={{ headerShown: false }} />
                                                <Stack.Screen name="+not-found" options={{ headerShown: false }} />
                                            </Stack>
                                            <GlobalBadgeCelebration />
                                            <NetworkBanner />
                                        </LocationProvider>
                                    </RewardsProvider>
                                </VisitsProvider>
                            </DealsProvider>
                        </SafeAreaProvider>
                    </AuthProvider>
                </ErrorBoundary>
            </QueryClientProvider>
        </GestureHandlerRootView>
    );
}

export default Sentry.wrap(RootLayout);
