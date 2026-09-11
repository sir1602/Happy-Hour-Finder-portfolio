/**
 * `constants/links` reads EXPO_PUBLIC_WEB_BASE_URL at module load, so each case
 * sets the env var and re-imports the module in isolation.
 */
function loadLinks(webBaseUrl?: string): typeof import('../../constants/links') {
    jest.resetModules();
    if (webBaseUrl === undefined) {
        delete process.env.EXPO_PUBLIC_WEB_BASE_URL;
    } else {
        process.env.EXPO_PUBLIC_WEB_BASE_URL = webBaseUrl;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../../constants/links');
}

describe('getDealShareUrl', () => {
    afterEach(() => {
        delete process.env.EXPO_PUBLIC_WEB_BASE_URL;
        jest.resetModules();
    });

    it('returns null when no web origin is configured', () => {
        const { getDealShareUrl } = loadLinks();
        expect(getDealShareUrl('deal-1')).toBeNull();
    });

    it('returns null for an empty web origin', () => {
        const { getDealShareUrl } = loadLinks('');
        expect(getDealShareUrl('deal-1')).toBeNull();
    });

    it('builds an https URL when a web origin is configured', () => {
        const { getDealShareUrl } = loadLinks('https://example.test');
        expect(getDealShareUrl('deal-1')).toBe('https://example.test/deal/deal-1');
    });

    it('does not double up the slash when the origin has a trailing one', () => {
        const { getDealShareUrl } = loadLinks('https://example.test/');
        expect(getDealShareUrl('deal-1')).toBe('https://example.test/deal/deal-1');
    });

    /**
     * The regression this guards: sharing used to emit
     * `happyhourfinder://deal/<id>` via Linking.createURL(), a custom-scheme URL
     * that no recipient without the app installed can open.
     */
    it('never emits a custom-scheme URL', () => {
        const { getDealShareUrl } = loadLinks('https://example.test');
        expect(getDealShareUrl('deal-1')).toMatch(/^https:\/\//);
    });
});
