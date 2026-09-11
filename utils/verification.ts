import { Deal, VerificationStatus } from '../types';

/**
 * Verification states that mean "the pipeline looked, and what it found does
 * not match what we are showing."
 *
 * Deliberately NOT including `unverified`. That is the never-checked default
 * and, as of writing, 187 of 342 active deals carry it — badging those too
 * would put a warning on ~89% of cards, which testers would tune out within a
 * session and which would drown the ~117 deals we have a concrete reason to
 * doubt. `unverified` means "no claim either way", and the honest presentation
 * of no claim is no badge.
 *
 * If you would rather warn on everything not positively verified, this is the
 * one place to change: make `isUnconfirmed` test `status !== 'verified'`.
 */
export const UNCONFIRMED_STATUSES: readonly VerificationStatus[] = [
    'conflict',
    'changed',
    'unreachable',
];

/**
 * Whether a deal should carry the "Unconfirmed" badge.
 *
 * Until this existed nothing in the app read `verification_status` at all, so
 * a deal the pipeline had positively flagged as wrong was presented exactly
 * like one it had just confirmed.
 */
export function isUnconfirmed(deal: Pick<Deal, 'verificationStatus'>): boolean {
    const status = deal.verificationStatus;
    if (!status) return false;
    return UNCONFIRMED_STATUSES.includes(status);
}

/**
 * Why a deal is flagged, in the user's terms rather than the pipeline's.
 *
 * Shown on the detail screen, where there is room to say more than a badge.
 * Never names the internal status: "conflict" means nothing to someone
 * standing outside a bar.
 */
export function unconfirmedReason(deal: Pick<Deal, 'verificationStatus'>): string | null {
    switch (deal.verificationStatus) {
        case 'changed':
            return 'The venue has published different details since we last checked, so this may be out of date.';
        case 'conflict':
            return 'Our sources disagree about this one, so the times or price may not be right.';
        case 'unreachable':
            return "We couldn't reach the venue's listing to confirm this recently.";
        default:
            return null;
    }
}
