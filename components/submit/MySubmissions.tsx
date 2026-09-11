import React from 'react';
import { View, Text, Image } from 'react-native';
import { getMySubmittedDeals, SubmittedDeal } from '../../services/dealService';

const STATUS_STYLES: Record<string, { label: string; bgClassName: string; textClassName: string }> = {
    pending: { label: 'Pending review', bgClassName: 'bg-amber-100 dark:bg-amber-900/40', textClassName: 'text-amber-700 dark:text-amber-300' },
    active: { label: 'Published', bgClassName: 'bg-green-100 dark:bg-green-900/40', textClassName: 'text-green-700 dark:text-green-300' },
    rejected: { label: 'Not accepted', bgClassName: 'bg-red-100 dark:bg-red-900/40', textClassName: 'text-red-700 dark:text-red-300' },
};

/**
 * The submitter's own recent submissions and their moderation status.
 *
 * Before `deals.submitted_by` existed, RLS restricted SELECT to
 * `status = 'active'`, so a user was told their deal was "pending approval" and
 * then had no way to see it — or confirm it had been received — ever again.
 */
export const MySubmissions = ({ userId, refreshKey }: { userId: string; refreshKey: number }) => {
    const [submissions, setSubmissions] = React.useState<SubmittedDeal[]>([]);
    const [isLoading, setIsLoading] = React.useState(true);

    React.useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        getMySubmittedDeals(userId)
            .then((rows) => {
                if (!cancelled) setSubmissions(rows);
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [userId, refreshKey]);

    if (isLoading || submissions.length === 0) return null;

    return (
        <View className="mt-10">
            <Text className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">Your submissions</Text>
            <View className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                {submissions.map((submission, index) => {
                    const status = STATUS_STYLES[submission.status] ?? {
                        label: submission.status,
                        bgClassName: 'bg-slate-100 dark:bg-slate-800',
                        textClassName: 'text-slate-600 dark:text-slate-400',
                    };
                    return (
                        <View
                            key={submission.id}
                            className={`p-3 bg-white dark:bg-slate-900 ${index > 0 ? 'border-t border-slate-200 dark:border-slate-700' : ''}`}
                        >
                            <View className="flex-row items-start justify-between gap-2">
                                {submission.imageUrl && (
                                    <Image
                                        source={{ uri: submission.imageUrl }}
                                        className="w-12 h-12 rounded-lg bg-slate-100 dark:bg-slate-800"
                                        accessibilityLabel="Photo you submitted with this deal"
                                    />
                                )}
                                <View className="flex-1">
                                    <Text className="font-bold text-slate-900 dark:text-white" numberOfLines={1}>
                                        {submission.venueName}
                                    </Text>
                                    <Text className="text-sm text-slate-600 dark:text-slate-400 mt-0.5" numberOfLines={1}>
                                        {submission.title} · {submission.timeWindow}
                                    </Text>
                                </View>
                                {/* The wrapper takes the background, the Text
                                    takes the foreground. Applying the same
                                    combined class to both painted the pill's
                                    background twice, once behind the label. */}
                                <View className={`rounded-full px-2 py-1 ${status.bgClassName}`}>
                                    <Text className={`text-xs font-bold ${status.textClassName}`}>{status.label}</Text>
                                </View>
                            </View>
                        </View>
                    );
                })}
            </View>
            <Text className="text-xs text-slate-400 dark:text-slate-500 mt-2">
                Submissions are reviewed by a moderator before they appear in the app.
            </Text>
        </View>
    );
};
