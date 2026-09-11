import {
    hasRegionMovedEnough,
    isFiniteCoordinate,
    isPlottableDeal,
    isUsableRegion,
    reconcileDeals,
} from '../../utils/mapRegion';
import { Deal, MapRegion } from '../../types';

const region = (over: Partial<MapRegion> = {}): MapRegion => ({
    latitude: 41.8781,
    longitude: -87.6298,
    latitudeDelta: 0.0922,
    longitudeDelta: 0.0421,
    ...over,
});

let dealCounter = 0;
const deal = (over: Partial<Deal> = {}): Deal => ({
    id: `deal-${++dealCounter}`,
    venueId: 'venue-1',
    name: 'The Tap Room',
    deal: '$5 drafts',
    image: 'https://example.test/a.jpg',
    neighborhood: 'Ravenswood',
    distance: '',
    price: 2,
    rating: 4.2,
    reviewCount: 12,
    tags: ['beer'],
    address: '123 Main St',
    website: '',
    phone: '',
    type: 'regular',
    time: '4-6pm',
    latitude: 41.96,
    longitude: -87.68,
    status: 'active',
    daysActive: [1, 2, 3, 4, 5],
    ...over,
});

describe('isFiniteCoordinate', () => {
    it('accepts zero, which is a real coordinate', () => {
        expect(isFiniteCoordinate(0)).toBe(true);
    });

    it('rejects the values that reach the native map as a crash', () => {
        expect(isFiniteCoordinate(NaN)).toBe(false);
        expect(isFiniteCoordinate(Infinity)).toBe(false);
        expect(isFiniteCoordinate(undefined)).toBe(false);
        expect(isFiniteCoordinate(null)).toBe(false);
        expect(isFiniteCoordinate('41.9')).toBe(false);
    });
});

describe('isUsableRegion', () => {
    it('accepts a well-formed region', () => {
        expect(isUsableRegion(region())).toBe(true);
    });

    it('rejects a partial region, which is what a corrupt cached viewport looks like', () => {
        expect(isUsableRegion({ latitude: 41.8 } as unknown as MapRegion)).toBe(false);
        expect(isUsableRegion(null)).toBe(false);
    });

    it('rejects a zero span, which makes the zoom calculation infinite', () => {
        expect(isUsableRegion(region({ longitudeDelta: 0 }))).toBe(false);
    });
});

describe('isPlottableDeal', () => {
    it('accepts a deal with ordinary coordinates', () => {
        expect(isPlottableDeal(deal())).toBe(true);
    });

    it('rejects NaN and out-of-range coordinates', () => {
        expect(isPlottableDeal(deal({ latitude: NaN }))).toBe(false);
        expect(isPlottableDeal(deal({ longitude: 240 }))).toBe(false);
        expect(isPlottableDeal(null)).toBe(false);
    });
});

describe('hasRegionMovedEnough', () => {
    it('fetches when there is nothing to compare against', () => {
        expect(hasRegionMovedEnough(null, region())).toBe(true);
    });

    it('skips a pan of a few metres at neighbourhood zoom', () => {
        const from = region();
        const to = region({ latitude: from.latitude + 0.0005 });
        expect(hasRegionMovedEnough(from, to)).toBe(false);
    });

    it('fetches after panning a third of the viewport', () => {
        const from = region();
        const to = region({ latitude: from.latitude + from.latitudeDelta / 3 });
        expect(hasRegionMovedEnough(from, to)).toBe(true);
    });

    // The regression this replaced: the old rule was an absolute 0.002 degrees
    // in every axis, so once the whole viewport was narrower than that -- which
    // is just "zoomed in to a few blocks" -- panning right across it, twice
    // over, still compared as "barely moved" and no fetch was ever issued.
    it('fetches after panning a full screen at street zoom', () => {
        const from = region({ latitudeDelta: 0.001, longitudeDelta: 0.001 });
        const to = region({ latitudeDelta: 0.001, longitudeDelta: 0.001, latitude: from.latitude + 0.001 });
        expect(hasRegionMovedEnough(from, to)).toBe(true);
    });

    it('fetches on a zoom step that changes the span by less than the old fixed threshold', () => {
        const from = region({ latitudeDelta: 0.004, longitudeDelta: 0.004 });
        const to = region({ latitudeDelta: 0.002, longitudeDelta: 0.002 });
        expect(hasRegionMovedEnough(from, to)).toBe(true);
    });

    it('fetches rather than guessing when either region is unusable', () => {
        expect(hasRegionMovedEnough(region({ latitudeDelta: NaN }), region())).toBe(true);
        expect(hasRegionMovedEnough(region(), region({ longitude: NaN }))).toBe(true);
    });
});

describe('reconcileDeals', () => {
    it('returns the very same array when the response is unchanged', () => {
        const previous = [deal({ id: 'a' }), deal({ id: 'b' })];
        const refetched = previous.map(d => ({ ...d, tags: [...d.tags] }));

        expect(reconcileDeals(previous, refetched)).toBe(previous);
    });

    it('keeps the object identity of every deal that did not change', () => {
        const previous = [deal({ id: 'a' }), deal({ id: 'b' })];
        const added = deal({ id: 'c' });
        const merged = reconcileDeals(previous, [...previous.map(d => ({ ...d })), added]);

        expect(merged).not.toBe(previous);
        expect(merged[0]).toBe(previous[0]);
        expect(merged[1]).toBe(previous[1]);
        expect(merged[2]).toBe(added);
    });

    it('takes the new object when a deal’s content changed', () => {
        const previous = [deal({ id: 'a', deal: '$5 drafts' })];
        const updated = { ...previous[0], deal: '$4 drafts' };

        expect(reconcileDeals(previous, [updated])[0]).toBe(updated);
    });

    it('notices a changed array field', () => {
        const previous = [deal({ id: 'a', daysActive: [1, 2] })];
        const updated = { ...previous[0], daysActive: [1, 2, 3] };

        expect(reconcileDeals(previous, [updated])[0]).toBe(updated);
    });

    it('reports a removal as a new array', () => {
        const previous = [deal({ id: 'a' }), deal({ id: 'b' })];
        const merged = reconcileDeals(previous, [previous[0]]);

        expect(merged).not.toBe(previous);
        expect(merged).toHaveLength(1);
    });

    it('reports a reorder as a new array, since the array itself differs', () => {
        const previous = [deal({ id: 'a' }), deal({ id: 'b' })];
        const merged = reconcileDeals(previous, [previous[1], previous[0]]);

        expect(merged).not.toBe(previous);
        expect(merged[0]).toBe(previous[1]);
    });
});
