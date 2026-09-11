# Happy Hour Finder

A cross-platform mobile app for discovering happy hour deals nearby — built with Expo and React
Native, backed by Supabase, and kept up to date by an automated content pipeline that scrapes,
verifies, and re-checks deals without a human curating a spreadsheet.

One TypeScript codebase ships to iOS, Android, and the web.

<!-- Add build/CI badges here once the repository is public, e.g.
[![CI](https://github.com/sir1602/Happy-Hour-Finder-portfolio/actions/workflows/ci.yml/badge.svg)](https://github.com/sir1602/Happy-Hour-Finder-portfolio/actions/workflows/ci.yml)
-->

---

## ✨ Features

- **Clustered map view** — bars and restaurants with live happy hours on a native map, clustered
  with `supercluster` so a dense downtown stays readable at every zoom level.
- **Explore with real filtering** — search and filter by neighbourhood, deal type, price band, and
  time of day. Full-text search runs server-side against a Postgres `tsvector` column, not in the
  client.
- **Daily highlights** — a home feed of trending, newly added, and ending-soon deals.
- **Accounts** — email/password, magic link, Google and Apple sign-in, password recovery, and
  account deletion, with "continue as guest" available throughout.
- **Submit a deal from a photo** — photograph a menu board and the deal is read off the image
  (OCR + LLM extraction) and pre-fills the submission form for the user to correct. The extraction
  never writes to the database directly.
- **Check-ins, points, and badges** — check in at a venue, earn points, unlock badges, and review
  your visit history. Point values are server-authoritative.
- **Deal confidence badges** — deals the re-validation pipeline can no longer confirm against their
  source are badged *Unconfirmed* rather than presented as fact.
- **Report and feedback** — report an incorrect deal from its detail screen, or send general
  feedback from Settings, signed in or as a guest.
- **Offline-tolerant** — cached reads and a network banner instead of an empty screen.
- **Light and dark themes** — an amber-and-charcoal palette across both.

---

## 🛠️ Tech Stack

| Layer | Choice |
|---|---|
| Framework | [Expo](https://expo.dev/) (SDK 57) with [Expo Router](https://docs.expo.dev/router/introduction/) for file-based navigation |
| UI | [React Native](https://reactnative.dev/) 0.86 / React 19 |
| Language | [TypeScript](https://www.typescriptlang.org/) |
| Styling | [NativeWind](https://www.nativewind.dev/) (Tailwind CSS for React Native) |
| Maps | [react-native-maps](https://github.com/react-native-maps/react-native-maps) + [supercluster](https://github.com/mapbox/supercluster) |
| Backend | [Supabase](https://supabase.com/) — Postgres, Row Level Security, Auth, Storage |
| Server state | [TanStack Query](https://tanstack.com/query) |
| Automation | [n8n](https://n8n.io/) workflows for content discovery and verification |
| Observability | [Sentry](https://sentry.io/) (crashes) and [PostHog](https://posthog.com/) (product analytics) |
| Testing | [Jest](https://jestjs.io/) + [@testing-library/react-native](https://callstack.github.io/react-native-testing-library/) |

---

## 🏗️ Architecture Overview

The app is a universal Expo app. Screens never talk to Supabase directly — every read and write
goes through a module in `services/`, which is what makes the data layer mockable in tests and
swappable in principle.

```
┌─────────────────────────────────────────────────────────┐
│  app/  — Expo Router screens (tabs, deal detail, auth)  │
├─────────────────────────────────────────────────────────┤
│  components/  — presentational UI + feature blocks      │
├─────────────────────────────────────────────────────────┤
│  hooks/    screen logic, extracted and unit-tested      │
│  context/  auth, deals, location, rewards, visits       │
├─────────────────────────────────────────────────────────┤
│  services/  — the ONLY layer that talks to the network  │
├─────────────────────────────────────────────────────────┤
│  Supabase: Postgres + RLS + Auth + Storage              │
│     ▲                                                   │
│     │  n8n content pipeline (discovery, verification)   │
└─────────────────────────────────────────────────────────┘
```

Three decisions carry most of the weight:

**Authorization lives in the database, not the client.** Every table is RLS-enabled. Privileged
operations — incrementing reward points, deleting an account, attributing a submission — are
narrowly-scoped `SECURITY DEFINER` functions rather than broad table grants, so a client cannot
write a value it should not be able to compute. The rewards RPC takes an *action name* and looks the
point value up itself; it does not accept a client-supplied total.

**Screen logic is extracted into hooks.** `useExploreScreen`, `useMapClusters`, `useDealDetail`,
`useSubmitDealForm` and friends hold the behaviour, so it can be tested without rendering a native
map or a camera roll.

**The content pipeline cannot silently corrupt the catalogue.** Automated writes pass through one
intake endpoint with a confidence threshold and a time-window parse gate; nothing is ever
hard-deleted, a low-confidence reading never overwrites a high-confidence one, and anything
uncertain queues for human review. See
[`n8n-workflows/README.md`](./n8n-workflows/README.md) for the full design.

Deeper detail: [`docs/Architecture.md`](./docs/Architecture.md).

---

## 📸 Screenshots

> Screenshots pending. Drop images into `docs/screenshots/` and reference them here.

| Home | Explore | Map |
|---|---|---|
| _`docs/screenshots/home.png`_ | _`docs/screenshots/explore.png`_ | _`docs/screenshots/map.png`_ |

| Deal Detail | Submit a Deal | Rewards |
|---|---|---|
| _`docs/screenshots/deal-detail.png`_ | _`docs/screenshots/submit.png`_ | _`docs/screenshots/rewards.png`_ |

---

## 🚀 Installation

Requires **Node.js 20.19.4 or newer** (React Native 0.85+ dropped everything below that; CI runs
Node 22).

> **This app cannot run in Expo Go.** It depends on custom native modules — `react-native-maps`,
> `@sentry/react-native`, `expo-apple-authentication`, `expo-notifications`, `expo-image-picker`,
> `expo-location` — and on config plugins that modify the native projects. Expo Go ships a fixed
> module set and cannot load any of them. You need a **development build**: your own binary with
> these modules compiled in, plus the usual fast JS reload.

```bash
git clone https://github.com/sir1602/Happy-Hour-Finder-portfolio.git
cd Happy-Hour-Finder-portfolio
npm install
cp .env.example .env     # then fill it in — see Configuration below
```

Build and run:

```bash
npx expo prebuild        # generates ios/ and android/ from app.json
npx expo run:android     # device or emulator
npx expo run:ios         # simulator (macOS + Xcode required)
```

After the first native build, `npx expo start --dev-client` is enough for JS-only changes. Rebuild
only when native dependencies or `app.json` change.

Building in the cloud with [EAS](https://docs.expo.dev/build/introduction/) instead:

```bash
eas init                                                      # claim your own project id
eas build --profile development --platform android
eas build --profile development-simulator --platform ios      # skips Apple device provisioning
```

---

## ⚙️ Configuration

Copy `.env.example` to `.env` and fill it in. That file documents every variable and what happens
when each is missing; the short version:

| Variable | Required? | Missing behaviour |
| --- | --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | **Yes** | App opens to a configuration-error screen |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | **Yes** | App opens to a configuration-error screen |
| `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` | In practice | Map renders blank |
| `EXPO_PUBLIC_SENTRY_DSN` | No | Crash reporting off |
| `EXPO_PUBLIC_SENTRY_ENVIRONMENT` | No | Falls back to `NODE_ENV` |
| `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | No | Defaults to `0` (off) |
| `EXPO_PUBLIC_POSTHOG_API_KEY` | No | Analytics off |
| `EXPO_PUBLIC_POSTHOG_HOST` | No | Defaults to PostHog cloud |
| `EXPO_PUBLIC_PRIVACY_POLICY_URL` | No | Falls back to the document in this repo |
| `EXPO_PUBLIC_TERMS_URL` | No | Empty — the Settings row is hidden |
| `EXPO_PUBLIC_WEB_BASE_URL` | No | Deal sharing disabled |
| `EXPO_PUBLIC_HH_SCAN_URL` | No | Photo-scan button hidden; manual submission unaffected |

**Every `EXPO_PUBLIC_*` value is inlined into the JS bundle at build time and ships inside the
binary, so none of them is a secret.** The Supabase key here is the public anon key, whose real
boundary is Row Level Security; the Maps key must be restricted by API and by app in the Google
Cloud Console. Never put a service-role key or any server-side credential in this file.

A local `.env` covers local builds only — EAS Build never sees it, because `.env` is gitignored and
so is absent from the uploaded archive. Set those separately with `eas env:create`.

Backend setup (tables, RPCs, storage buckets) is documented in
[`docs/Backend-Setup.md`](./docs/Backend-Setup.md), with the SQL itself under `scripts/`.

---

## 💻 Usage

```bash
npm start            # Expo dev server
npm run android      # build and run on Android
npm run ios          # build and run on iOS
npm run web          # run in the browser

npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # jest
```

`typecheck`, `lint`, and `test` are exactly what CI runs on every pull request
(`.github/workflows/ci.yml`). None of them builds the app natively — see
[`docs/Device-Testing.md`](./docs/Device-Testing.md) for what only a real build can catch.

---

## 📁 Folder Structure

```
.
├── app/                 # Expo Router screens — file-based routing
│   ├── (tabs)/          #   Home, Explore, Map, Saved, Visits, Settings
│   ├── auth/            #   OAuth callback, password reset
│   ├── deal/[id].tsx    #   Deal detail: info, reviews, check-in
│   ├── login.tsx
│   ├── onboarding.tsx
│   └── submit-deal.tsx
├── components/          # UI components
│   ├── ui/              #   primitives: Button, Badge, Chip, Skeleton, states
│   ├── map/             #   cluster markers, tile fallbacks
│   └── submit/          #   submission form blocks
├── hooks/               # screen logic, extracted for testability
├── context/             # auth, deals, location, rewards, visits providers
├── services/            # the only layer that talks to Supabase or the network
├── utils/               # pure helpers: time parsing, geo, validation, pricing
├── constants/           # colours, links, legal URLs, form presets
├── types/               # database types generated from the live schema
├── scripts/             # SQL migrations + asset generation
├── n8n-workflows/       # content automation pipeline design docs
├── benchmarks/          # micro-benchmarks for hot paths
├── __tests__/           # Jest suites, mirroring the source tree
└── docs/                # architecture, backend setup, testing, roadmap
```

---

## 🔭 Future Improvements

- **Multi-city expansion.** The metro resolution layer exists and the burst-scan workflow can target
  any area; what's missing is the UI for choosing one.
- **Adopt TanStack Query for data fetching.** `QueryClientProvider` is wired up but the services
  layer still fetches directly — moving it would bring caching and revalidation for free.
- **Personalised recommendations** based on check-in history and saved venues.
- **Social layer** — friends, shared lists, and a leaderboard. The points/badges infrastructure is
  already in place; check-ins are currently private by design.
- **Reviews moderation** — reviews need report/block affordances before any public store release.
- **Venue-owner dashboard** for claiming a listing and correcting hours at the source.
- **Push notifications for saved venues** when a deal is starting soon.

The longer-range plan is in [`docs/Roadmap.md`](./docs/Roadmap.md).

---

## 📚 Documentation

- [Architecture](./docs/Architecture.md) — technical breakdown and design patterns
- [Backend Setup](./docs/Backend-Setup.md) — Supabase RPCs, columns, and storage buckets
- [Device Testing](./docs/Device-Testing.md) — building a dev client and verifying what CI cannot
- [Content Pipeline](./n8n-workflows/README.md) — how deals are discovered and verified
- [Roadmap](./docs/Roadmap.md) — planned features
- [Privacy Policy](./docs/Privacy-Policy.md) — template; placeholders must be completed before release

---

## 📄 License

Released under the [MIT License](./LICENSE).

---

## 📬 Contact

Built by **Simon** — [@sir1602](https://github.com/sir1602).

Questions and issues are welcome via
[GitHub Issues](https://github.com/sir1602/Happy-Hour-Finder-portfolio/issues).
