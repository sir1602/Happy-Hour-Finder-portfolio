/** Price levels run 1–4 ($ … $$$$). */
export const MAX_PRICE_LEVEL = 4;

/**
 * Clamp a raw `price_level` to the renderable 0–4 range.
 *
 * `deals.price_level` is a plain nullable integer with no CHECK constraint, so
 * a row can carry a value outside 1–4 (or null). Feeding that straight to
 * `'$'.repeat()` throws `RangeError: Invalid count value` for negatives and
 * silently renders a runaway string for large values — either way it takes out
 * the whole card, since the throw happens during render.
 */
export function clampPriceLevel(price: number | null | undefined): number {
    if (typeof price !== 'number' || !Number.isFinite(price)) return 0;
    return Math.min(MAX_PRICE_LEVEL, Math.max(0, Math.floor(price)));
}

/** Filled portion of the price indicator, e.g. `$$`. */
export function priceSymbols(price: number | null | undefined): string {
    return '$'.repeat(clampPriceLevel(price));
}

/** Unfilled remainder, e.g. `$$` for a price level of 2. */
export function priceSymbolsRemainder(price: number | null | undefined): string {
    return '$'.repeat(MAX_PRICE_LEVEL - clampPriceLevel(price));
}
