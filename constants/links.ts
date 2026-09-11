/**
 * Public web origin for shareable links (e.g. https://happyhourchicago.app).
 *
 * The app already builds for web via `react-native-web` + expo-router, so once
 * that build is deployed to a domain, `<origin>/deal/<id>` resolves to the same
 * detail route and is a link anyone can open.
 *
 * Until a domain is configured this is empty on purpose. Sharing previously
 * emitted `Linking.createURL('deal/<id>')`, i.e. `happyhourfinder://deal/<id>`
 * — a custom-scheme URL that does nothing for any recipient who doesn't already
 * have the app installed, which during a closed alpha is essentially everyone.
 * A share with no link is better than a share with a dead one.
 *
 * Setting this also unblocks proper universal/app links, which additionally
 * require `ios.associatedDomains` and `android.intentFilters` in app.json plus
 * the matching `.well-known` files served from the domain.
 */
export const WEB_BASE_URL = (process.env.EXPO_PUBLIC_WEB_BASE_URL || '').replace(/\/+$/, '');

/** Shareable https URL for a deal, or null when no web origin is configured. */
export function getDealShareUrl(dealId: string): string | null {
    if (!WEB_BASE_URL) return null;
    return `${WEB_BASE_URL}/deal/${dealId}`;
}
