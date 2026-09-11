
# Application Architecture

This document describes the technical architecture of the Happy Hour Finder application.

## 1. High-Level Architecture

The application is a **universal app** built with the **Expo framework** and **React Native**, using **Expo Router** for file-based navigation. Data is backed by a real **Supabase** project (Postgres + Auth + Storage), not mock data — every screen reads/writes through a `services/` layer that talks to Supabase.

## 2. Core Technologies

- **Expo (~57)** — build/runtime platform for iOS, Android, and web from one codebase.
- **React Native 0.86 / React 19** — functional components and hooks throughout.
- **TypeScript** — `services/supabase.ts` creates a fully-typed client via `createClient<Database>(...)`, with `types/database.types.ts` generated directly from the live schema (`supabase gen types typescript`) rather than hand-written.
- **Expo Router** — file-based routing under `app/`.
- **NativeWind (Tailwind for RN)** — utility-class styling.
- **React Native Maps + Supercluster** (`hooks/useMapClusters.ts`) — clustered map rendering.
- **Expo Location** — geolocation with permission handling.
- **Supabase** (`@supabase/supabase-js`) — Postgres database, RLS-enforced authorization, Auth (email/password + Apple), and a `venue-images` Storage bucket (5 MB, images only, objects scoped to `<uid>/`).
- **Expo Image Manipulator** — downscales a submitted photo to a 1600px long edge before upload, which is what keeps the base64 upload path off the out-of-memory line on low-end Android.
- **n8n photo intake** (`services/dealScanService.ts`) — the submit form can read a happy hour off a photo of a menu board. The app uploads the photo, `POST /hh-deal-scan` returns what Gemini read, and the fields land in the form for the user to confirm. The endpoint writes nothing and authenticates the end user with their own Supabase access token, so no shared secret ships in the binary. See [`n8n-workflows/README.md`](../n8n-workflows/README.md).
- **Sentry** (`@sentry/react-native`, wrapped by `services/logger.ts`) and **PostHog** (`services/analytics.ts`) — error tracking and product analytics.
- **@tanstack/react-query** — installed and wired via `QueryClientProvider` in `app/_layout.tsx`; not yet used for actual data fetching (see audit report, action item #8).

## 3. Application Structure

### a. File-Based Routing (Expo Router)

```
app/
├── _layout.tsx           # Root layout: providers, ErrorBoundary
├── index.tsx             # Entry redirect
├── login.tsx             # Auth (email/password + Apple)
├── onboarding.tsx        # Onboarding
├── submit-deal.tsx       # User-submitted deal form (pending moderation)
├── deal/
│   └── [id].tsx          # Deal detail: info, reviews, check-in
└── (tabs)/
    ├── _layout.tsx       # Tab navigator (Home, Explore, Map, Saved, Visits, Settings)
    ├── index.tsx         # Home — daily highlights
    ├── explore.tsx        # Search & filter deals
    ├── map.tsx            # Interactive clustered map
    ├── saved.tsx          # Bookmarked deals
    ├── visits.tsx         # Check-in history, rewards/badges
    └── settings.tsx       # Profile, notification prefs, account
```

### b. Shared Components

```
components/
├── ui/                   # Design-system primitives: Button, Badge, Chip,
│                         # Skeleton, EmptyState, ErrorState
├── map/                  # ClusterMarker and other map-specific pieces
├── DealCard.tsx          # HighlightCard, SavedCard, ExploreCard
├── MapImpl.native.tsx / MapImpl.web.tsx  # Platform-specific map implementations
├── StarRating.tsx, FilterChip.tsx, SkeletonCard.tsx, Icon.tsx, NetworkBanner.tsx
├── BadgeCelebrationModal.tsx, GlobalBadgeCelebration.tsx
└── ErrorBoundary.tsx
```

### c. Data & Services Layer

```
services/
├── supabase.ts               # Typed Supabase client (Database generic from types/database.types.ts)
├── dealService.ts             # Deal queries: search_deals RPC (full-text) + PostgREST fallback
├── authService.ts             # Sign up/in/out, session
├── profileService.ts          # Own-profile read/update
├── reviewService.ts            # Reviews + get_public_profiles RPC for attribution
├── rewardsService.ts           # Points/levels/badges via increment_rewards RPC
├── visitService.ts             # Check-ins
├── notificationService.ts / notificationPreferences.ts
├── storageService.ts           # venue-images upload (<uid>/ scoped, downscaled)
├── dealScanService.ts          # Reads a deal off a menu photo via the n8n scan endpoint
├── cacheService.ts             # Stale-while-revalidate cache used by dealService
├── analytics.ts, logger.ts     # PostHog / Sentry wrappers
```

```
context/
├── AuthContext.tsx        # Session, sign in/out
├── DealsContext.tsx        # Saved deals (Supabase-backed, AsyncStorage migration path)
├── LocationContext.tsx     # Permission + current location
├── RewardsContext.tsx      # Points/level/badges
├── VisitsContext.tsx       # Check-in history
└── dealsReducer.ts

hooks/
├── useMapClusters.ts       # Supercluster wrapper for the map screen
├── useDeals.ts, useLocation.ts   # Currently dead code — see audit report action item #9
```

### d. Database (Supabase Postgres)

Tables: `venues`, `deals`, `profiles`, `reviews`, `user_deals`, `user_visits`, `user_rewards`, `user_badges` — all RLS-enabled. Full-text deal search runs server-side via the `search_deals` RPC against a `tsvector` column. Gamification (`increment_rewards`) and cross-user profile attribution (`get_public_profiles`) are exposed as narrowly-scoped `SECURITY DEFINER` functions rather than broad table grants. See `docs/Backend-Setup.md` for storage and RPC setup notes.

### e. State Management

- **Server state** (Supabase-backed): currently hand-rolled per-context `useState`/`useEffect`/try-catch (DealsContext, VisitsContext, RewardsContext). Migrating to `@tanstack/react-query` is planned (see audit report action item #8) to get loading/error/retry/caching for free.
- **UI state**: local component state per screen.
- **Auth state**: `AuthContext`, backed by Supabase Auth sessions (auto-refreshing, persisted via AsyncStorage).
- **Location state**: `LocationContext`, backed by `expo-location` with a foreground-permission check before requesting.
- **Data flow**: unidirectional — context providers and `services/` functions own data, screens consume via hooks and call back up through context actions.
