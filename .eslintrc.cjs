module.exports = {
    extends: ['expo'],
    ignorePatterns: ['/dist/*', '/.expo/*', '/node_modules/*'],
    env: {
        node: true,
        jest: true,
    },
    rules: {
        // eslint-config-expo 56 turns on the React Compiler `react-hooks`
        // rules. They flag 81 findings in code that predates the SDK upgrade
        // and that works as written, so they are warnings here rather than
        // errors: the upgrade should not be gated on an unrelated refactor.
        //
        // `refs` accounts for ~71 of them and is almost entirely
        // `useRef(new Animated.Value(x)).current` -- React Native's own
        // documented idiom for holding an Animated value, which this rule does
        // not model. Rewriting those would churn working animation code.
        //
        // `set-state-in-effect` (8 sites) and `static-components` (1) are
        // fair signals worth acting on, but each is a behavioral change that
        // needs the app running to verify. Tracked as follow-up work; drop
        // these overrides once addressed.
        'react-hooks/refs': 'warn',
        'react-hooks/set-state-in-effect': 'warn',
        'react-hooks/static-components': 'warn',
    },
};
