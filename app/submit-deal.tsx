import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Icon } from '../components/Icon';
import { useAuth } from '../context/AuthContext';
import { useSubmitDealForm } from '../hooks/useSubmitDealForm';
import { Colors } from '../constants/colors';
import { FormField } from '../components/submit/FormField';
import { SubmitCard } from '../components/submit/SubmitCard';
import { DraftBanner } from '../components/submit/DraftBanner';
import { VenueAutocomplete } from '../components/submit/VenueAutocomplete';
import { PhotoScanBlock } from '../components/submit/PhotoScanBlock';
import { VenuePhotoBlock } from '../components/submit/VenuePhotoBlock';
import { ScheduleCard } from '../components/submit/ScheduleCard';
import { TagPicker } from '../components/submit/TagPicker';
import { MySubmissions } from '../components/submit/MySubmissions';

export default function SubmitDealScreen() {
    const router = useRouter();
    const { user } = useAuth();
    const form = useSubmitDealForm();

    if (!user) {
        return (
            <SafeAreaView className="flex-1 items-center justify-center bg-background-light dark:bg-background-dark p-4">
                <Icon name="lock" size={64} color={Colors.borderMuted} />
                <Text className="text-xl font-bold text-slate-800 dark:text-slate-200 mt-4 text-center">Authentication Required</Text>
                <Text className="text-slate-600 dark:text-slate-400 mt-2 text-center mb-6">
                    You must be logged in to submit a new deal to the community.
                </Text>
                <TouchableOpacity
                    onPress={() => router.push('/login')}
                    className="bg-primary px-8 py-3 rounded-xl w-full"
                    accessibilityRole="button"
                    accessibilityLabel="Log in or sign up"
                >
                    <Text className="font-bold text-center text-background-dark text-lg">Log In / Sign Up</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => router.back()}
                    className="mt-4 py-2"
                    accessibilityRole="button"
                    accessibilityLabel="Go back"
                >
                    <Text className="font-semibold text-slate-500">Go Back</Text>
                </TouchableOpacity>
            </SafeAreaView>
        );
    }

    // A picked venue brings its own address and neighborhood, so showing the
    // fields again is two inputs asking to be re-checked for no reason.
    const venueIsConfirmed = Boolean(form.resolvedVenueId);

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            className="flex-1 bg-background-light dark:bg-background-dark"
        >
            <SafeAreaView className="flex-1 flex-col" edges={['top']}>
                <View className="flex-row items-center px-4 py-3 border-b border-slate-200 dark:border-slate-800">
                    <TouchableOpacity
                        onPress={() => router.back()}
                        className="p-2 -ml-2 rounded-full active:bg-slate-200 dark:active:bg-slate-800"
                        accessibilityRole="button"
                        accessibilityLabel="Close"
                    >
                        <Icon name="close" size={24} color={Colors.closeIconMuted} />
                    </TouchableOpacity>
                    <Text className="flex-1 text-center text-lg font-bold text-slate-900 dark:text-white mr-8">Submit a Deal</Text>
                </View>

                <ScrollView
                    ref={form.scrollRef}
                    keyboardDismissMode="on-drag"
                    keyboardShouldPersistTaps="handled"
                    className="flex-1 px-4 py-4"
                    contentContainerStyle={{ paddingBottom: 100 }}
                >
                    {form.draftRestored ? (
                        <DraftBanner onDiscard={form.discardDraft} onDismiss={form.dismissDraftBanner} />
                    ) : null}

                    <SubmitCard title="Venue & Location">
                        <PhotoScanBlock
                            selectedImage={form.selectedImage}
                            canScanPhoto={form.canScanPhoto}
                            isScanning={form.isScanning}
                            scanNotice={form.scanNotice}
                            onPickImage={form.handlePickImage}
                            onTakePhoto={form.handleTakePhoto}
                            onRemoveImage={form.handleRemoveImage}
                            onScanPhoto={form.handleScanPhoto}
                        />

                        <VenueAutocomplete
                            value={form.venueName}
                            onChangeText={form.setVenueName}
                            results={form.venueResults}
                            isSearching={form.isSearchingVenues}
                            resolvedVenueId={form.resolvedVenueId}
                            onSelect={form.selectVenue}
                            onUseTypedName={form.useTypedVenueName}
                            onClearVenue={form.clearResolvedVenue}
                            error={form.errors.venueName}
                            onRegisterOffset={(y) => form.registerFieldOffset('venueName', y)}
                            onSubmitEditing={() => form.addressInputRef.current?.focus()}
                        />

                        {venueIsConfirmed ? (
                            <View className="flex-row items-start gap-2 px-3 py-3 rounded-xl bg-slate-100 dark:bg-slate-800/60">
                                <Icon name="place" size={18} color={Colors.iconMuted} />
                                <Text className="flex-1 text-sm text-slate-700 dark:text-slate-300">
                                    {[form.address, form.neighborhood].filter(Boolean).join(' · ')}
                                </Text>
                                <TouchableOpacity
                                    onPress={form.clearResolvedVenue}
                                    accessibilityRole="button"
                                    accessibilityLabel="Edit the address and neighborhood"
                                >
                                    <Text className="text-xs font-bold text-primary underline">Edit</Text>
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <>
                                <FormField
                                    label="Address"
                                    required
                                    placeholder="e.g. 123 W Main St"
                                    value={form.address}
                                    onChangeText={form.setAddress}
                                    inputRef={form.addressInputRef}
                                    returnKeyType="next"
                                    onSubmitEditing={() => form.neighborhoodInputRef.current?.focus()}
                                    maxLength={150}
                                    error={form.errors.address}
                                    onRegisterOffset={(y) => form.registerFieldOffset('address', y)}
                                />
                                <FormField
                                    label="Neighborhood"
                                    required
                                    placeholder="e.g. Logan Square"
                                    value={form.neighborhood}
                                    onChangeText={form.setNeighborhood}
                                    inputRef={form.neighborhoodInputRef}
                                    returnKeyType="next"
                                    maxLength={100}
                                    error={form.errors.neighborhood}
                                    onRegisterOffset={(y) => form.registerFieldOffset('neighborhood', y)}
                                />
                            </>
                        )}

                        <VenuePhotoBlock
                            selectedVenuePhoto={form.selectedVenuePhoto}
                            onPickVenuePhoto={form.handlePickVenuePhoto}
                            onTakeVenuePhoto={form.handleTakeVenuePhoto}
                            onRemoveVenuePhoto={form.handleRemoveVenuePhoto}
                        />
                    </SubmitCard>

                    <SubmitCard title="When & Hours">
                        {form.schedules.map((schedule, index) => (
                            <ScheduleCard
                                key={index}
                                index={index}
                                schedule={schedule}
                                total={form.schedules.length}
                                errors={form.errors.schedules?.[index]}
                                range={form.scheduleTimeRange(schedule.timeWindow)}
                                onRemove={() => form.removeSchedule(index)}
                                onToggleDay={(dayIdx) => form.toggleScheduleDay(index, dayIdx)}
                                onApplyDayPreset={(preset) => form.applyDayPreset(index, preset)}
                                onApplyTimePreset={(preset) => form.applyTimePreset(index, preset)}
                                onSelectRange={(start, end) => form.setScheduleTimeRange(index, start, end)}
                                onChangeTimeText={(text) => form.updateSchedule(index, { timeWindow: text })}
                                onBlurTimeText={() => form.normalizeScheduleTime(index)}
                                onChangeDealTitle={(text) => form.updateSchedule(index, { dealTitle: text })}
                                onAppendSnippet={(snippet) => form.appendDealSnippet(index, snippet)}
                                onRegisterOffset={(y) => form.registerFieldOffset(`schedule-${index}`, y)}
                            />
                        ))}

                        <TouchableOpacity
                            className="flex-row items-center justify-center py-2 px-4 rounded-xl border border-dashed border-primary"
                            onPress={form.addSchedule}
                            accessibilityRole="button"
                            accessibilityLabel="Add another schedule"
                        >
                            <Icon name="add" size={16} color={Colors.addScheduleAccent} />
                            <Text className="text-primary font-bold ml-2">Add Another Schedule</Text>
                        </TouchableOpacity>
                    </SubmitCard>

                    <SubmitCard title="What's the Deal?">
                        <View className="mb-4">
                            <Text className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Price Level</Text>
                            <View className="flex-row">
                                {[1, 2, 3, 4].map(level => (
                                    <TouchableOpacity
                                        key={level}
                                        onPress={() => form.setPriceLevel(level)}
                                        className={`flex-1 mx-1 py-3 rounded-lg border ${
                                            form.priceLevel === level
                                                ? 'bg-primary/20 border-primary'
                                                : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                                        }`}
                                        accessibilityRole="radio"
                                        accessibilityLabel={`Price level ${'$'.repeat(level)}`}
                                        accessibilityState={{ selected: form.priceLevel === level }}
                                    >
                                        <Text className={`text-center font-bold ${
                                            form.priceLevel === level ? 'text-primary dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'
                                        }`}>
                                            {'$'.repeat(level)}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </View>

                        <TagPicker
                            suggestions={form.tagSuggestions}
                            selected={form.selectedTags}
                            onToggle={form.toggleTag}
                            value={form.tagsInput}
                            onChangeText={form.setTagsInput}
                            inputRef={form.tagsInputRef}
                        />
                    </SubmitCard>

                    <TouchableOpacity
                        onPress={form.handleSubmit}
                        disabled={form.isSubmitting}
                        className={`w-full py-4 rounded-xl items-center justify-center flex-row ${
                            form.isSubmitting ? 'bg-slate-400' : 'bg-primary active:bg-primary/90'
                        }`}
                        accessibilityRole="button"
                        accessibilityLabel="Submit deal"
                        accessibilityState={{ disabled: form.isSubmitting, busy: form.isSubmitting }}
                    >
                        {form.isSubmitting ? (
                            <ActivityIndicator size="small" color={Colors.white} />
                        ) : (
                            <>
                                <Icon name="send" size={20} color={Colors.onPrimary} />
                                <Text className="font-bold text-lg text-background-dark ml-2">Submit Deal</Text>
                            </>
                        )}
                    </TouchableOpacity>

                    <MySubmissions userId={user.id} refreshKey={form.submissionCount} />
                </ScrollView>
            </SafeAreaView>
        </KeyboardAvoidingView>
    );
}
