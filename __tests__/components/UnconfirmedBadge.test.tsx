import React from 'react';
import { render } from '@testing-library/react-native';
import { ExploreCard } from '../../components/DealCard';
import { Deal, VerificationStatus } from '../../types';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-haptics', () => ({
    impactAsync: jest.fn().mockResolvedValue(undefined),
    ImpactFeedbackStyle: { Light: 'light' },
}));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));

const buildDeal = (verificationStatus: VerificationStatus | null): Deal => ({
    id: 'deal-1', venueId: 'venue-1', name: 'The Draft House', deal: '$5 Craft Beers',
    image: '', neighborhood: 'River North', distance: '', price: 2, rating: 4.5,
    reviewCount: 10, tags: ['Beer'], address: '745 N Birch Ave', website: '', phone: '',
    type: 'regular', time: '4 PM - 6 PM', latitude: 41.89, longitude: -87.63,
    daysActive: [0, 1, 2, 3, 4, 5, 6], verificationStatus,
});

// `render` is async in @testing-library/react-native 14.0.1 here — it returns
// a Promise, so the queries are only available once it is awaited.
const renderCard = async (status: VerificationStatus | null) =>
    await render(
        <ExploreCard
            deal={buildDeal(status)}
            onSelectDeal={jest.fn()}
            onToggleSave={jest.fn()}
            isSaved={false}
        />
    );

describe('the Unconfirmed badge on a deal card', () => {
    it.each(['conflict', 'changed', 'unreachable'] as VerificationStatus[])(
        'appears for a deal the pipeline judged %s',
        async (status) => {
            const view = await renderCard(status);
            expect(view.getByText('Unconfirmed')).toBeTruthy();
        },
    );

    it('does not appear on a verified deal', async () => {
        expect((await renderCard('verified')).queryByText('Unconfirmed')).toBeNull();
    });

    it('does not appear on a deal that was never checked', async () => {
        expect((await renderCard('unverified')).queryByText('Unconfirmed')).toBeNull();
    });

    it('does not appear when the deal carries no status', async () => {
        expect((await renderCard(null)).queryByText('Unconfirmed')).toBeNull();
    });

    it('is announced to screen readers, not just shown', async () => {
        expect((await renderCard('conflict')).getByLabelText(/could not confirm these details/i)).toBeTruthy();
    });
});
