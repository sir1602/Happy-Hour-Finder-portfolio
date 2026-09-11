# Project Roadmap

This document outlines the development roadmap for the Happy Hour Finder application. It is divided into several phases, outlining our plans for future features and improvements. For the current architecture, see [Architecture.md](./Architecture.md).

## Current State — Completed

The application is a real, Supabase-backed universal app (iOS/Android/web), not a mock-up:

-   Real authentication (email/password + Apple), persistent sessions, guest browsing.
-   Live Postgres-backed deal, venue, review, and user data — no static/mock data.
-   A "Daily Highlights" home screen, an "Explore" screen with server-side full-text search (`search_deals` RPC) plus deal-type/price/time/neighborhood filtering, and a clustered interactive map with "Use My Location."
-   Deal detail screens with reviews and check-ins.
-   Persistent saved deals (Supabase-backed, synced across devices, with a local-to-account migration path).
-   User-submitted deals (`submit-deal`) with pending/moderation status.
-   A gamification system: points, levels, streaks, and badges (`user_rewards`, `user_badges`), awarded via a hardened `increment_rewards` RPC.
-   Notification preferences and push token registration.
-   Full support for light and dark modes.

---

## Short-Term Goals (Next Steps)

The backend/data-layer work described in the v1.1 plan below is done. The current short-term focus is architectural and UX hardening rather than new backend surface:

-   **State management:** migrate Supabase-backed reads in DealsContext/VisitsContext/RewardsContext onto `@tanstack/react-query` (already installed, not yet used) for built-in loading/error/retry/caching.
-   **Design system adoption:** consolidate screens onto the existing `components/ui/` primitives instead of the several ad-hoc duplicates that exist today.
-   **Service-layer consistency:** one shared error-handling convention and consistent Sentry logging across all `services/*.ts`.
-   **Accessibility & screen splits:** accessibility labels on interactive elements, and breaking up the largest screens (`deal/[id].tsx`, `login.tsx`, `explore.tsx`, `submit-deal.tsx`, `MapImpl.native.tsx`) into data hooks + presentational components.
-   **Dependencies:** a deliberate, separately-tested Expo SDK 54 → 57 upgrade to close out the outstanding `npm audit` findings (all currently dev-tooling-only, not runtime-exposed).

---

## Mid-Term Goals (Future Versions / v1.5)

Once the application is fully dynamic, the focus will shift to enhancing user engagement and content.

-   **User-Generated Content:**
    -   [ ] **Write Reviews:** Implement the "Write a Review" feature, allowing authenticated users to rate and review venues.
    -   [ ] **Submit a Deal:** Create a form for users or business owners to submit new happy hour deals for moderation and approval.

-   **Personalization & Notifications:**
    -   [ ] **Push Notifications:** Implement optional notifications for saved deals that are ending soon or new deals in a user's favorite neighborhood.
    -   [ ] **Personalized Recommendations:** Develop a basic algorithm to suggest deals based on a user's saved items and viewing history.

-   **Improved Social Features:**
    -   [ ] **Enhanced Sharing:** Improve the "Share" functionality to create rich previews for social media platforms.

---

## Long-Term Vision (v2.0+)

The long-term vision is to grow the platform into a comprehensive and intelligent guide for city nightlife.

-   **Platform Expansion:**
    -   [ ] **Multi-City Support:** Architect the backend and frontend to support multiple cities.
    -   [ ] **Progressive Web App (PWA):** Enhance the application with a service worker for offline capabilities and "Add to Home Screen" functionality.

-   **Advanced Features:**
    -   [ ] **Real-time Updates:** Integrate with venue APIs (where available) to show real-time crowd levels or special, limited-time offers.
    -   [ ] **AI-Powered Search:** Implement natural language search (e.g., "Find a patio with cheap beer near me").

-   **Monetization:**
    -   [ ] **Featured Listings:** Introduce an option for businesses to pay for premium placement on the Home and Explore screens.
    -   [ ] **Analytics for Businesses:** Offer a dashboard for venue owners to see how users are interacting with their listings.
