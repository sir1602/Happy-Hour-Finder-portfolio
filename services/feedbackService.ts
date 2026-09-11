import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';
import { Logger } from './logger';
import { Deal } from '../types';

export type FeedbackKind = 'deal_report' | 'general';

/** Matches the CHECK constraint on public.feedback.message. */
export const MAX_FEEDBACK_LENGTH = 2000;

export interface SubmitFeedbackInput {
    kind: FeedbackKind;
    message: string;
    /** The deal being reported, for kind: 'deal_report'. */
    deal?: Pick<Deal, 'id' | 'name' | 'deal' | 'time' | 'verificationStatus'> | null;
}

/**
 * Context attached to every submission.
 *
 * A report that says only "the times are wrong" costs a round trip to act on.
 * Capturing the app version, the platform, and what the deal looked like at
 * the moment of reporting makes most reports actionable on sight — and the
 * verification status in particular tells us whether the pipeline had already
 * flagged this one.
 */
const buildContext = (input: SubmitFeedbackInput) => ({
    appVersion: Constants.expoConfig?.version ?? null,
    platform: Platform.OS,
    ...(input.deal
        ? {
            dealName: input.deal.name,
            dealText: input.deal.deal,
            dealTime: input.deal.time,
            verificationStatus: input.deal.verificationStatus ?? null,
        }
        : {}),
});

/**
 * File a report or a piece of general feedback.
 *
 * Returns false rather than throwing: the caller shows a message either way,
 * and losing the user's typed text to an exception is worse than telling them
 * it did not send. Guests are supported deliberately — someone browsing
 * without an account who spots a wrong deal is exactly as useful as a
 * signed-in one, and the table's anon INSERT policy allows a null user_id.
 */
export const submitFeedback = async (input: SubmitFeedbackInput): Promise<boolean> => {
    const message = input.message.trim();
    if (!message) return false;

    try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id ?? null;

        const { error } = await supabase.from('feedback').insert({
            user_id: userId,
            deal_id: input.deal?.id ?? null,
            kind: input.kind,
            message: message.slice(0, MAX_FEEDBACK_LENGTH),
            context: buildContext(input),
        });

        if (error) {
            Logger.error('[feedback] Could not submit feedback', error);
            return false;
        }
        return true;
    } catch (e: unknown) {
        Logger.error('[feedback] Unexpected error submitting feedback', e);
        return false;
    }
};
