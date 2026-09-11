import React from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AntDesign } from '@expo/vector-icons';
import { Icon } from '../components/Icon';
import { useLoginForm } from '../hooks/useLoginForm';
import { Colors } from '../constants/colors';

export default function LoginScreen() {
  const form = useLoginForm();

  return (
    <SafeAreaView className="flex-1 bg-background-light dark:bg-background-dark">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          className="px-4"
        >
          <Animated.View
            style={{ transform: [{ translateX: form.shakeAnim }] }}
            className="w-full max-w-md self-center"
          >
            {/* ── Header ─────────────────────────────────── */}
            <View className="items-center gap-2 mb-8">
              <Icon name="sports-bar" size={50} color={Colors.primary} />
              <Text className="text-charcoal dark:text-off-white tracking-tight text-3xl font-bold leading-tight text-center">
                Find Your Happy Hour
              </Text>
              <Text className="text-muted-gray text-base font-normal leading-normal text-center">
                {form.mode === 'login'
                  ? 'Log in to discover deals'
                  : 'Create an account to save deals'}
              </Text>
            </View>

            {/* ── Tab Switcher ────────────────────────────── */}
            <View className="flex-row mb-6 mx-4 p-1 bg-gray-200 dark:bg-slate-800 rounded-lg">
              <TouchableOpacity
                onPress={() => form.switchMode('login')}
                className={`flex-1 py-2 items-center rounded-md ${
                  form.mode === 'login'
                    ? 'bg-white dark:bg-slate-700'
                    : 'bg-transparent'
                }`}
                accessibilityRole="tab"
                accessibilityState={{ selected: form.mode === 'login' }}
              >
                <Text
                  className={`font-semibold ${
                    form.mode === 'login'
                      ? 'text-charcoal dark:text-white'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  Log In
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => form.switchMode('signup')}
                className={`flex-1 py-2 items-center rounded-md ${
                  form.mode === 'signup'
                    ? 'bg-white dark:bg-slate-700'
                    : 'bg-transparent'
                }`}
                accessibilityRole="tab"
                accessibilityState={{ selected: form.mode === 'signup' }}
              >
                <Text
                  className={`font-semibold ${
                    form.mode === 'signup'
                      ? 'text-charcoal dark:text-white'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  Sign Up
                </Text>
              </TouchableOpacity>
            </View>

            {/* ── Social Login Buttons ────────────────────── */}
            <View className="gap-3 px-4 mb-4">
              {/* Google */}
              <TouchableOpacity
                onPress={() => form.handleSocialLogin('google')}
                disabled={form.isLoading}
                className="flex-row h-12 items-center justify-center rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800"
                accessibilityRole="button"
                accessibilityLabel="Continue with Google"
              >
                {form.loadingAction === 'google' ? (
                  <ActivityIndicator color={Colors.googleBlue} />
                ) : (
                  <>
                    {/* Google 'G' brand icon using colored letter segments */}
                    <View style={{ width: 22, height: 22, marginRight: 10, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ fontSize: 18, fontWeight: '700', color: Colors.googleBlue, fontFamily: 'serif', lineHeight: 22 }}>G</Text>
                    </View>
                    <Text className="text-charcoal dark:text-off-white text-base font-semibold">
                      Continue with Google
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              {/* Apple – shown on all platforms for consistency */}
              <TouchableOpacity
                onPress={() => form.handleSocialLogin('apple')}
                disabled={form.isLoading}
                className="flex-row h-12 items-center justify-center rounded-lg bg-black dark:bg-white"
                accessibilityRole="button"
                accessibilityLabel="Continue with Apple"
              >
                {form.loadingAction === 'apple' ? (
                  <ActivityIndicator color={Platform.OS === 'ios' ? Colors.white : Colors.black} />
                ) : (
                  <>
                    {/* The glyph is `apple`. This was `apple1` behind a @ts-ignore
                        claiming it worked at runtime -- it does not: AntDesign
                        ships 449 glyphs and `apple1` is not among them, so the
                        button rendered a "?" on every platform, not just where
                        TypeScript complained. */}
                    <AntDesign name="apple" size={20} color="white" style={{ marginRight: 10 }} />
                    <Text className="text-white dark:text-black text-base font-semibold">
                      Continue with Apple
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {/* ── Divider ────────────────────────────────── */}
            <View className="flex-row items-center px-4 my-2">
              <View className="flex-1 h-px bg-gray-300 dark:bg-slate-600" />
              <Text className="mx-4 text-muted-gray text-sm">or</Text>
              <View className="flex-1 h-px bg-gray-300 dark:bg-slate-600" />
            </View>

            {/* ── Email & Password ────────────────────────── */}
            <View className="gap-4 px-4 py-3 w-full">
              {/* Email */}
              <View>
                <TextInput
                  className={`w-full h-12 px-4 rounded-lg bg-off-white dark:bg-charcoal/40 text-charcoal dark:text-off-white border ${
                    form.errors.email
                      ? 'border-red-500'
                      : 'border-gray-200 dark:border-charcoal/60'
                  }`}
                  placeholder="Email"
                  placeholderTextColor={Colors.placeholderDark}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  textContentType="emailAddress"
                  value={form.email}
                  onChangeText={form.onEmailChange}
                  returnKeyType="next"
                  onBlur={form.onEmailBlur}
                  accessibilityLabel="Email address"
                  editable={!form.isLoading}
                />
                {form.errors.email ? (
                  <Text className="text-red-500 text-xs mt-1 px-1">{form.errors.email}</Text>
                ) : null}
              </View>

              {/* Password */}
              <View>
                <View className="relative">
                  <TextInput
                    className={`w-full h-12 px-4 pr-12 rounded-lg bg-off-white dark:bg-charcoal/40 text-charcoal dark:text-off-white border ${
                      form.errors.password
                        ? 'border-red-500'
                        : 'border-gray-200 dark:border-charcoal/60'
                    }`}
                    placeholder="Password"
                    placeholderTextColor={Colors.placeholderDark}
                    secureTextEntry={!form.showPassword}
                    autoComplete={form.mode === 'signup' ? 'password-new' : 'password'}
                    textContentType={form.mode === 'signup' ? 'newPassword' : 'password'}
                    value={form.password}
                    onChangeText={form.onPasswordChange}
                    returnKeyType="done"
                    onSubmitEditing={form.onSubmit}
                    accessibilityLabel="Password"
                    editable={!form.isLoading}
                  />
                  {/* Password visibility toggle */}
                  <TouchableOpacity
                    onPress={form.togglePasswordVisibility}
                    className="absolute right-0 top-0 h-12 w-12 items-center justify-center"
                    accessibilityLabel={form.showPassword ? 'Hide password' : 'Show password'}
                    accessibilityRole="button"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Icon
                      name={form.showPassword ? 'visibility-off' : 'visibility'}
                      size={22}
                      color={Colors.placeholderDark}
                    />
                  </TouchableOpacity>
                </View>
                {form.errors.password ? (
                  <Text className="text-red-500 text-xs mt-1 px-1">{form.errors.password}</Text>
                ) : null}
                {form.mode === 'signup' && !form.errors.password && (
                  <Text className="text-muted-gray text-xs mt-1 px-1">
                    Must be at least 8 characters
                  </Text>
                )}
              </View>
            </View>

            {/* ── Submit Button ───────────────────────────── */}
            <View className="px-4 py-3 w-full">
              <TouchableOpacity
                onPress={form.onSubmit}
                className="w-full h-12 px-5 items-center justify-center rounded-lg bg-primary active:opacity-80"
                disabled={form.isLoading}
                accessibilityRole="button"
                accessibilityLabel={form.mode === 'login' ? 'Log In' : 'Sign Up'}
                accessibilityState={{ disabled: form.isLoading }}
              >
                {form.loadingAction === 'submit' ? (
                  <ActivityIndicator color={Colors.charcoal} />
                ) : (
                  <Text className="text-charcoal text-base font-bold">
                    {form.mode === 'login' ? 'Log In' : 'Sign Up'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>

            {/* ── Forgot Password & Magic Link (login mode only) ── */}
            {form.mode === 'login' && (
              <View className="items-center gap-4 mt-2 w-full px-4 pb-4">
                <TouchableOpacity
                  onPress={form.handleForgotPassword}
                  disabled={form.isLoading}
                  accessibilityRole="button"
                  accessibilityLabel="Forgot password"
                >
                  <Text className="text-charcoal dark:text-off-white text-sm font-semibold">
                    Forgot Password?
                  </Text>
                </TouchableOpacity>

                {/* Magic link divider */}
                <View className="flex-row items-center w-full my-1">
                  <View className="flex-1 h-px bg-gray-300 dark:bg-slate-600" />
                  <Text className="mx-4 text-muted-gray text-xs">
                    or sign in without a password
                  </Text>
                  <View className="flex-1 h-px bg-gray-300 dark:bg-slate-600" />
                </View>

                {/* Magic link button */}
                {form.magicLinkSent ? (
                  <View className="w-full items-center rounded-lg border border-green-500 bg-green-50 dark:bg-green-900/20 py-3 px-4">
                    <Icon name="mark-email-read" size={28} color={Colors.successAlt} />
                    <Text className="text-green-700 dark:text-green-400 text-sm font-semibold mt-2 text-center">
                      Magic link sent! Check your inbox.
                    </Text>
                    <TouchableOpacity
                      onPress={form.handleMagicLink}
                      className="mt-2"
                      disabled={form.isLoading}
                      accessibilityRole="button"
                      accessibilityLabel="Resend magic link"
                    >
                      <Text className="text-primary text-xs font-semibold underline">
                        Resend
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    onPress={form.handleMagicLink}
                    disabled={form.isLoading}
                    className="w-full h-12 flex-row items-center justify-center rounded-lg border-2 border-primary/50 active:opacity-80"
                    accessibilityRole="button"
                    accessibilityLabel="Send magic link to email"
                  >
                    {form.loadingAction === 'magic' ? (
                      <ActivityIndicator color={Colors.primary} />
                    ) : (
                      <>
                        <Icon name="auto-awesome" size={20} color={Colors.primary} />
                        <Text className="text-charcoal dark:text-off-white text-sm font-semibold ml-2">
                          Send Me a Magic Link
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                )}
              </View>
            )}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
