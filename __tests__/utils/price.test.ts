import { clampPriceLevel, priceSymbols, priceSymbolsRemainder, MAX_PRICE_LEVEL } from '../../utils/price';

describe('clampPriceLevel', () => {
    it('passes valid levels through', () => {
        expect(clampPriceLevel(1)).toBe(1);
        expect(clampPriceLevel(4)).toBe(4);
    });

    it('treats null/undefined as zero', () => {
        expect(clampPriceLevel(null)).toBe(0);
        expect(clampPriceLevel(undefined)).toBe(0);
    });

    it('clamps out-of-range values', () => {
        expect(clampPriceLevel(-3)).toBe(0);
        expect(clampPriceLevel(99)).toBe(MAX_PRICE_LEVEL);
    });

    it('floors fractional values', () => {
        expect(clampPriceLevel(2.7)).toBe(2);
    });

    it('rejects NaN and Infinity', () => {
        expect(clampPriceLevel(NaN)).toBe(0);
        expect(clampPriceLevel(Infinity)).toBe(0);
        expect(clampPriceLevel(-Infinity)).toBe(0);
    });
});

describe('price symbols', () => {
    it('renders the filled and unfilled portions', () => {
        expect(priceSymbols(2)).toBe('$$');
        expect(priceSymbolsRemainder(2)).toBe('$$');
    });

    it('always totals MAX_PRICE_LEVEL symbols', () => {
        for (const level of [null, undefined, -5, 0, 1, 2, 3, 4, 7.5, NaN]) {
            const total = priceSymbols(level as number).length + priceSymbolsRemainder(level as number).length;
            expect(total).toBe(MAX_PRICE_LEVEL);
        }
    });

    /**
     * The regression this guards: `'$'.repeat(4 - deal.price)` throws
     * `RangeError: Invalid count value` for a price_level above 4, and
     * `'$'.repeat(deal.price)` throws for a negative one. Because it happens
     * during render, a single bad row took out the whole card. `deals.price_level`
     * is a plain nullable integer, so nothing in the DB prevented such a row.
     */
    it('never throws on out-of-range input', () => {
        for (const level of [-1, -100, 5, 1000, NaN, Infinity, null, undefined]) {
            expect(() => priceSymbols(level as number)).not.toThrow();
            expect(() => priceSymbolsRemainder(level as number)).not.toThrow();
        }
    });
});
