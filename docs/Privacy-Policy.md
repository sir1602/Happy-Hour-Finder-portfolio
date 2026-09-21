# Privacy Policy — Happy Hour Chicago

**Last updated: 2026-09-21**

> **Draft — needs review before publication.** This policy describes what the app's code actually collects, stores, and transmits. It is an alpha draft and should be reviewed for applicable privacy-law obligations before production release.

---

## Who we are

Happy Hour Chicago ("the app", "we", "us") is operated by `Simon Addo`. You can reach us at `SirAddo11@gmail.com`.

## What we collect

### Information you give us

| Data | When | Why |
|---|---|---|
| Email address | When you create an account | Authentication, account recovery |
| Password | When you sign up with email | Authentication. Stored only as a salted hash by our authentication provider — we never see or store the plaintext. |
| Display name and avatar | If you edit your profile | Shown next to reviews you write |
| Reviews (1–5 rating, optional comment) | When you review a venue | Displayed publicly alongside your display name and avatar |
| Check-ins (venue, deal, timestamp) | When you check in | Your visit history, points, and badges |
| Submitted deals (venue name, address, neighborhood, schedule, price, tags, optional photo) | When you submit a deal | Reviewed by us, then published to all users if approved |
| Photos | If you attach one to a deal submission | Published with the approved deal |

### Information collected automatically

| Data | Why |
|---|---|
| Precise location (GPS) | To show deals near you, sort by distance, and center the map. Only collected while the app is in the foreground, and only if you grant permission. We do **not** collect background location. |
| Push notification token | To send deal reminders you've opted into |
| Crash and error reports | Diagnosing crashes (via Sentry) |
| Product analytics — screens viewed, deals viewed/saved/shared, searches, filters, check-ins | Understanding which features are used (via PostHog) |
| Saved deals | Syncing your bookmarks across devices |

### What we do NOT collect

- Background or "always-on" location
- Contacts, calendar, microphone, or health data
- Payment or financial information — the app does not process payments
- Any data from your device's photo library beyond the specific images you choose to attach

## How your location is used

Your precise location is used **on your device** to calculate distances and center the map. Location coordinates are **not** transmitted to or stored on our servers, and are not shared with any third party. Denying location permission leaves the app fully usable — you lose distance sorting and map auto-centering.

## Who we share it with

We do not sell your personal information. We do not share it with advertisers.

We use these processors, who handle data on our behalf:

| Processor | What it receives | Purpose |
|---|---|---|
| [Supabase](https://supabase.com/privacy) | Account, profile, reviews, check-ins, saved deals, submitted deals, photos | Database, authentication, file storage |
| [Sentry](https://sentry.io/privacy/) | Crash reports, user ID, email | Crash reporting |
| [PostHog](https://posthog.com/privacy) | Product usage events, user ID, email | Product analytics |
| [Expo](https://expo.dev/privacy) | Push notification token | Push notification delivery |
| [OpenStreetMap Nominatim](https://osmfoundation.org/wiki/Privacy_Policy) | The venue address text you type when submitting a deal | Converting addresses to map coordinates |
| Apple / Google | Sign-in identity, if you use social sign-in | Authentication |

We may also disclose information if required by law, or to protect our rights or the safety of our users.

## What's public

The following are visible to all users of the app:

- Your display name and avatar, shown next to reviews you write
- The content and rating of your reviews
- Deals you submit, once approved (without your name attached)

The following are private to you:

- Your email address
- Your check-in history
- Your saved deals
- Your points, level, and badges

## How long we keep it

We retain your data for as long as your account exists. Delete your account (Settings → Delete Account) and your profile, reviews, check-ins, saved deals, and rewards are permanently deleted. This cannot be undone.

Deals you submitted that were already approved and published remain in the app, since they're community content that isn't attributed to you publicly.

Crash reports and analytics events are retained according to the schedules of Sentry and PostHog respectively.

## Your choices and rights

- **Location** — grant or revoke any time in your device settings.
- **Notifications** — turn off in Settings, or revoke in device settings.
- **Profile** — edit your display name and avatar in Settings.
- **Delete your account** — Settings → Delete Account, which permanently erases your data.
- **Access, correction, portability, objection** — depending on where you live (e.g. under GDPR or CCPA), you may have additional rights over your data. Contact us at `SirAddo11@gmail.com` and we'll respond within the timeframe the applicable law requires.

## Children

The app is about happy hour deals at bars and restaurants and is **not intended for anyone under the legal drinking age in their jurisdiction (21 in the United States)**. We do not knowingly collect data from children. If you believe a child has given us data, contact us and we'll delete it.

## Security

Data is transmitted over TLS and stored with our processors under row-level security policies that restrict each user's data to that user. No system is perfectly secure, and we can't guarantee absolute security.

## Alpha testing

The app is currently in closed alpha. During this period:

- Features may change or be removed without notice.
- We may contact you at your registered email about the test.
- Data may be reset between test builds. **Do not treat the app as a system of record for anything you need to keep.**

## Changes

We'll update the "Last updated" date above when this policy changes, and notify you in-app of material changes.

## Contact

Questions about this policy or your data: `SirAddo11@gmail.com`

Governing law: Not specified for the closed alpha; confirm before production release.
