/**
 * Crash reporting and analytics bootstrap.
 *
 * MUST be the first import in `app/_layout.tsx`, before any context, service or
 * component import. This file exists purely to own that ordering.
 *
 * The previous arrangement called `Logger.init()` at module scope inside
 * `_layout.tsx` and carried a comment claiming that made the `services/supabase.ts`
 * startup throw reportable. It did not. `_layout.tsx` imports `DealsProvider`,
 * which transitively imports `dealService` -> `supabase`, and ES module imports
 * are fully evaluated before any statement in the importing module's body runs.
 * So `supabase.ts` threw first and `Sentry.init()` never got the chance to run:
 * the single most likely startup failure was also the one guaranteed to produce
 * no telemetry.
 *
 * Importing this module first inverts that. Nothing here imports application
 * code, so it cannot drag a throwing module in ahead of itself.
 */
import { Logger } from './logger';
import { Analytics } from './analytics';

Logger.init();
Analytics.init();
