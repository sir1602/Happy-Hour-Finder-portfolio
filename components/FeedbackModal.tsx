import React from 'react';
import {
    View, Text, TextInput, TouchableOpacity, ActivityIndicator,
    Modal, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Icon } from './Icon';
import { Colors } from '../constants/colors';
import { submitFeedback, FeedbackKind, MAX_FEEDBACK_LENGTH } from '../services/feedbackService';
import { Deal } from '../types';

interface Props {
    visible: boolean;
    onClose: () => void;
    kind: FeedbackKind;
    /** The deal being reported, for kind: 'deal_report'. */
    deal?: Pick<Deal, 'id' | 'name' | 'deal' | 'time' | 'verificationStatus'> | null;
}

/**
 * The alpha's only route for a tester to tell us something is wrong.
 *
 * Deliberately one text box and a send button. Every field added here is a
 * field someone has to fill in while standing outside a bar that turned out
 * not to have the deal we promised — the failure mode this exists to capture
 * is exactly the moment they are least inclined to fill in a form.
 *
 * Suggestion chips do the categorising instead: tapping one seeds the box with
 * a sentence they can send as-is or add to.
 */
const DEAL_SUGGESTIONS = [
    'The times are wrong',
    'The deal is different',
    "This place has closed",
    "They don't run this any more",
];

/**
 * The form itself, split out so the wrapper can mount it fresh on each open.
 *
 * State used to be cleared in an effect keyed on `visible`, which triggers a
 * cascading render and is the pattern React's own guidance steers away from.
 * Rendering this only while open gets the same reset for free: closing
 * unmounts it, reopening mounts it with initial state.
 */
function FeedbackForm({ onClose, kind, deal }: Omit<Props, 'visible'>) {
    const [message, setMessage] = React.useState('');
    const [isSending, setIsSending] = React.useState(false);
    const [sent, setSent] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const handleSend = async () => {
        if (!message.trim() || isSending) return;
        setIsSending(true);
        setError(null);

        const ok = await submitFeedback({ kind, message, deal });
        setIsSending(false);

        if (ok) {
            setSent(true);
        } else {
            setError("That didn't send. Check your connection and try again.");
        }
    };

    const title = kind === 'deal_report' ? 'Report this deal' : 'Send feedback';

    return (
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}
            >
                <View className="rounded-t-3xl bg-background-light dark:bg-background-dark p-5 pb-8 max-h-[85%]">
                    <View className="flex-row items-center justify-between mb-4">
                        <Text className="text-xl font-bold text-slate-900 dark:text-white">{title}</Text>
                        <TouchableOpacity
                            onPress={onClose}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            accessibilityRole="button"
                            accessibilityLabel="Close"
                        >
                            <Icon name="close" size={24} color={Colors.iconMuted} />
                        </TouchableOpacity>
                    </View>

                    {sent ? (
                        <View className="items-center py-8" accessibilityLiveRegion="polite">
                            <Icon name="check-circle" size={48} color={Colors.success} />
                            <Text className="text-lg font-bold text-slate-900 dark:text-white mt-3">Thank you</Text>
                            <Text className="text-center text-slate-600 dark:text-slate-400 mt-1 px-4">
                                {kind === 'deal_report'
                                    ? "We'll check this one. Reports like yours are the fastest way we find out something has changed."
                                    : "That's gone through — thanks for taking the time."}
                            </Text>
                            <TouchableOpacity
                                onPress={onClose}
                                className="mt-6 bg-primary px-8 py-3 rounded-xl"
                                accessibilityRole="button"
                                accessibilityLabel="Done"
                            >
                                <Text className="font-bold text-background-dark">Done</Text>
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <ScrollView keyboardShouldPersistTaps="handled">
                            {deal ? (
                                <Text className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                                    About <Text className="font-bold">{deal.name}</Text> — {deal.deal}
                                </Text>
                            ) : (
                                <Text className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                                    Anything that&apos;s broken, confusing, or just annoying. We read all of it.
                                </Text>
                            )}

                            {kind === 'deal_report' && (
                                <View className="flex-row flex-wrap gap-2 mb-3">
                                    {DEAL_SUGGESTIONS.map((suggestion) => (
                                        <TouchableOpacity
                                            key={suggestion}
                                            onPress={() => setMessage(suggestion)}
                                            className="rounded-full border border-slate-300 dark:border-slate-600 px-3 py-1.5 active:bg-slate-100 dark:active:bg-slate-800"
                                            accessibilityRole="button"
                                            accessibilityLabel={`Use suggestion: ${suggestion}`}
                                        >
                                            <Text className="text-sm text-slate-700 dark:text-slate-300">{suggestion}</Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            )}

                            <TextInput
                                className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl p-3 text-slate-900 dark:text-white min-h-[110px]"
                                placeholder={kind === 'deal_report' ? "What's wrong with it?" : 'What would you like to tell us?'}
                                placeholderTextColor={Colors.iconMuted}
                                value={message}
                                onChangeText={(v) => { setMessage(v); setError(null); }}
                                multiline
                                textAlignVertical="top"
                                maxLength={MAX_FEEDBACK_LENGTH}
                                autoFocus
                            />

                            {error ? (
                                <Text className="text-red-500 text-sm mt-2" accessibilityLiveRegion="polite">{error}</Text>
                            ) : null}

                            <TouchableOpacity
                                onPress={handleSend}
                                disabled={!message.trim() || isSending}
                                className={`mt-4 py-3.5 rounded-xl ${!message.trim() || isSending ? 'bg-slate-300 dark:bg-slate-700' : 'bg-primary active:scale-95'}`}
                                accessibilityRole="button"
                                accessibilityLabel="Send"
                                accessibilityState={{ disabled: !message.trim() || isSending, busy: isSending }}
                            >
                                {isSending ? (
                                    <ActivityIndicator size="small" color={Colors.white} />
                                ) : (
                                    <Text className="font-bold text-center text-background-dark text-base">Send</Text>
                                )}
                            </TouchableOpacity>
                        </ScrollView>
                    )}
                </View>
            </KeyboardAvoidingView>
    );
}

export function FeedbackModal({ visible, onClose, kind, deal }: Props) {
    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
            {visible ? <FeedbackForm onClose={onClose} kind={kind} deal={deal} /> : null}
        </Modal>
    );
}
