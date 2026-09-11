# Benchmarks

Micro-benchmarks for list-rendering hot paths — the work that repeats per deal, per
render, on Home and Explore.

```bash
npm run bench
```

No dependencies and no build step: these run on Node 22's built-in TypeScript
stripping (`node --experimental-strip-types`).

## What each one measures

| Benchmark | Question | Measured |
|---|---|---|
| `set_vs_array.bench.ts` | Membership lookup while filtering 1,000 items against 100 ids — `Array.includes` vs `Set.has` | **~10×** faster with a `Set` (167 ms → 16 ms per 1,000 iterations) |
| `sort_vs_reduce.bench.ts` | Finding the single nearest deal among 1,000 — sorting the whole list vs one pass | **~17×** faster in one pass (4.2 ms → 0.24 ms per iteration) |
| `memo_benchmark.bench.ts` | Stable vs unstable callback identity across 10,000 rows | **~1.4×** faster with stable callbacks |

Numbers come from a single machine and will vary. The ratio is the point, not the
absolute milliseconds.

## How they relate to the app

- **Set membership** — `hooks/useExploreScreen.ts` holds the active tag and neighbourhood
  filters as `Set<string>`, so each deal's filter check is a hash lookup rather than a
  scan. `app/(tabs)/settings.tsx` does the same for earned badge ids.
- **Stable callbacks** — the list screens wrap rows in `memo()` and their handlers in
  `useCallback` (see `app/(tabs)/index.tsx`), so changing one row doesn't re-render the
  rest.
- **Sort vs one pass** — exploratory rather than shipped. The app sorts by distance
  (`sortByDistance`) because the list screens need the full ordering; this benchmark
  quantifies what a single pass would save *if* only the nearest deal were needed, which
  is the shape of a future "closest deal to you" feature.
