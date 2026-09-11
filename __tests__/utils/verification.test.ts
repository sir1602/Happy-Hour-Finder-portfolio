import { isUnconfirmed, unconfirmedReason, UNCONFIRMED_STATUSES } from '../../utils/verification';
import { VerificationStatus } from '../../types';

const deal = (verificationStatus: VerificationStatus | null | undefined) => ({ verificationStatus });

describe('isUnconfirmed', () => {
    it.each(['conflict', 'changed', 'unreachable'] as VerificationStatus[])(
        'flags a deal the pipeline judged %s',
        (status) => expect(isUnconfirmed(deal(status))).toBe(true),
    );

    it('does not flag a verified deal', () => {
        expect(isUnconfirmed(deal('verified'))).toBe(false);
    });

    // `unverified` is the never-checked default and covers most rows. Badging
    // it would put a warning on the overwhelming majority of cards, which
    // testers tune out — and it would bury the ones we have a concrete reason
    // to doubt. See the note in utils/verification.
    it('does not flag a deal that was simply never checked', () => {
        expect(isUnconfirmed(deal('unverified'))).toBe(false);
    });

    it('does not flag a deal with no status at all', () => {
        expect(isUnconfirmed(deal(null))).toBe(false);
        expect(isUnconfirmed(deal(undefined))).toBe(false);
    });

    it('agrees with the exported status list', () => {
        for (const status of UNCONFIRMED_STATUSES) {
            expect(isUnconfirmed(deal(status))).toBe(true);
        }
        expect(UNCONFIRMED_STATUSES).not.toContain('unverified');
        expect(UNCONFIRMED_STATUSES).not.toContain('verified');
    });
});

describe('unconfirmedReason', () => {
    it('gives a distinct, plain-language reason for each flagged state', () => {
        const reasons = UNCONFIRMED_STATUSES.map((s) => unconfirmedReason(deal(s)));

        expect(reasons.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
        expect(new Set(reasons).size).toBe(UNCONFIRMED_STATUSES.length);
    });

    it('never leaks the internal status name to the user', () => {
        for (const status of UNCONFIRMED_STATUSES) {
            expect(unconfirmedReason(deal(status))?.toLowerCase()).not.toContain(status);
        }
    });

    it('has nothing to say about a deal that is not flagged', () => {
        expect(unconfirmedReason(deal('verified'))).toBeNull();
        expect(unconfirmedReason(deal('unverified'))).toBeNull();
        expect(unconfirmedReason(deal(null))).toBeNull();
    });
});
