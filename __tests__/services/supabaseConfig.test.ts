/**
 * The module reads env vars at import time, so each case has to reset the
 * registry and re-require it under a different environment.
 */
const ENV_KEYS = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'] as const;

const loadWith = (env: Partial<Record<(typeof ENV_KEYS)[number], string>>) => {
    const saved = { ...process.env };
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);

    let mod!: typeof import('../../services/supabase');
    jest.isolateModules(() => {
        // require, not import: the module must be re-evaluated inside this
        // callback under the env vars set above, and a static import is hoisted
        // out of it and evaluated once.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require('../../services/supabase');
    });

    process.env = saved;
    return mod;
};

describe('supabase configuration', () => {
    // This module used to `throw` at import time. Because it is pulled in
    // through _layout.tsx's import graph, that happened during module
    // evaluation -- before React rendered and before ErrorBoundary existed to
    // catch it -- so a build with no configuration was a white screen with
    // nothing in the UI, the logs, or Sentry.
    it('does not throw when configuration is missing', () => {
        expect(() => loadWith({})).not.toThrow();
    });

    it('names every missing variable so the build can be fixed', () => {
        expect(loadWith({}).supabaseConfigError).toContain('EXPO_PUBLIC_SUPABASE_URL');
        expect(loadWith({}).supabaseConfigError).toContain('EXPO_PUBLIC_SUPABASE_ANON_KEY');
    });

    it('names only the one that is actually missing', () => {
        const error = loadWith({ EXPO_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' }).supabaseConfigError;

        expect(error).toContain('EXPO_PUBLIC_SUPABASE_ANON_KEY');
        expect(error).not.toContain('EXPO_PUBLIC_SUPABASE_URL');
    });

    it('reports no error when both are present', () => {
        const mod = loadWith({
            EXPO_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
            EXPO_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
        });

        expect(mod.supabaseConfigError).toBeNull();
        expect(mod.supabase).toBeDefined();
    });

    // Nothing should reach the client in this state -- _layout.tsx renders the
    // configuration screen instead -- but a stray call during startup must
    // reject, not crash the process before that screen can paint.
    it('rejects calls on the unconfigured client rather than crashing', async () => {
        const { supabase } = loadWith({});

        await expect(
            (supabase.from('deals') as any).select('*')
        ).rejects.toThrow(/not configured/i);
    });

    it('survives a full builder chain before rejecting', async () => {
        const { supabase } = loadWith({});

        // Reading through a long chain must not TypeError partway; only the
        // await rejects. This is the shape dealService actually builds.
        const query = (supabase.from('deals') as any)
            .select('*, venues!inner(*)')
            .eq('status', 'active')
            .contains('days_active', [1])
            .order('created_at', { ascending: false })
            .range(0, 29);

        await expect(query).rejects.toThrow(/not configured/i);
    });

    it('rejects auth calls too', async () => {
        const { supabase } = loadWith({});

        await expect(supabase.auth.getSession()).rejects.toThrow(/not configured/i);
    });
});
