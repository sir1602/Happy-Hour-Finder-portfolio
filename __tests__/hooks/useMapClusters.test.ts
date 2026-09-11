import { renderHook } from '@testing-library/react-native';
import { useMapClusters } from '../../hooks/useMapClusters';
import { Deal, MapRegion } from '../../types';

const region = (over: Partial<MapRegion> = {}): MapRegion => ({
    latitude: 41.9613,
    longitude: -87.6755,
    latitudeDelta: 0.02,
    longitudeDelta: 0.02,
    ...over,
});

const deal = (id: string, latitude: number, longitude: number): Deal => ({
    id,
    venueId: `venue-${id}`,
    name: `Venue ${id}`,
    deal: '$5 drafts',
    image: 'https://example.test/a.jpg',
    neighborhood: 'Ravenswood',
    distance: '',
    price: 2,
    rating: 4,
    reviewCount: 3,
    tags: [],
    address: '',
    website: '',
    phone: '',
    type: 'regular',
    time: '4-6pm',
    latitude,
    longitude,
    status: 'active',
    daysActive: [1, 2, 3, 4, 5],
});

const idsOf = (items: { id: string }[]) => items.map(i => i.id).sort();

describe('useMapClusters', () => {
    it('drops deals whose coordinates cannot be plotted', async () => {
        // A `<Marker>` handed one of these does not render an off-screen pin --
        // the value goes straight into the Google Maps SDK and takes the
        // process with it.
        const deals = [
            deal('good', 41.9613, -87.6755),
            deal('nan', NaN, -87.6755),
            deal('infinite', 41.9613, Infinity),
            deal('offworld', 120, -87.6755),
        ];

        const { result } = await renderHook(() => useMapClusters(deals, region()));

        expect(result.current).toHaveLength(1);
        expect(result.current[0].id).toBe('good');
    });

    it('returns nothing rather than clustering against a broken region', async () => {
        const deals = [deal('a', 41.9613, -87.6755)];
        const { result } = await renderHook(() =>
            useMapClusters(deals, region({ longitudeDelta: 0 }))
        );

        expect(result.current).toEqual([]);
    });

    // The camera moves on its own on Android: tapping a marker near an edge
    // makes Google Maps pan to fit the info window. When the cluster box was
    // drawn exactly at the viewport edge, that pan silently unmounted the
    // markers it pushed off-screen -- native views being torn down underneath
    // an open callout, which is the crash this padding exists to avoid.
    it('keeps the same markers mounted through a small pan', async () => {
        const deals = [
            deal('west', 41.9613, -87.6855),
            deal('centre', 41.9613, -87.6755),
            deal('east', 41.9613, -87.6655),
        ];

        const { result, rerender } = await renderHook(
            ({ r }) => useMapClusters(deals, r),
            { initialProps: { r: region() } }
        );

        const before = idsOf(result.current);
        expect(before).toEqual(['centre', 'east', 'west']);

        // Pan east by just under the fraction of the viewport that triggers a
        // re-fetch (see `REGION_MOVE_FRACTION`): any camera move too small to
        // be worth new deals is also too small to change which markers are
        // mounted. Without padding this pan alone dropped the west pin.
        await rerender({ r: region({ longitude: -87.6755 + 0.02 * 0.24 }) });

        expect(idsOf(result.current)).toEqual(before);
    });

    it('clusters nearby deals at low zoom and splits them at high zoom', async () => {
        const deals = [
            deal('a', 41.9613, -87.6755),
            deal('b', 41.9614, -87.6756),
            deal('c', 41.9615, -87.6757),
        ];

        const { result, rerender } = await renderHook(
            ({ r }) => useMapClusters(deals, r),
            { initialProps: { r: region({ latitudeDelta: 2, longitudeDelta: 2 }) } }
        );

        expect(result.current).toHaveLength(1);
        expect(result.current[0].type).toBe('cluster');

        await rerender({ r: region({ latitudeDelta: 0.002, longitudeDelta: 0.002 }) });

        expect(result.current.every(item => item.type === 'point')).toBe(true);
        expect(idsOf(result.current)).toEqual(['a', 'b', 'c']);
    });
});
