# Device Testing Guide

CI runs typecheck, lint, and the Jest suite. It never builds the app natively,
so it cannot see anything that only appears once real native modules are
compiled and running. This guide covers that gap.

Reach for it after any dependency upgrade that touches native code — an Expo
SDK bump, a React Native version change, or a new library with a config plugin.

---

## 1. Build a development client

**Expo Go will not work.** This app has custom native modules and config
plugins; Expo Go ships a fixed module set and cannot load them. You need your
own binary.

### Local builds

Fastest iteration, no queue, and native build errors surface directly — which
is what you want when validating an upgrade.

```bash
npx expo prebuild --clean   # regenerate ios/ and android/ from app.json
npx expo run:android        # device or emulator
npx expo run:ios --device   # physical iPhone (macOS + Xcode)
```

`--clean` is safe: `ios/` and `android/` are generated, not committed, so there
are no hand-edited native files to lose. If that ever stops being true, drop
the flag.

After the first build, `npx expo start --dev-client` is enough for JS changes.
Rebuild when native dependencies or `app.json` change.

### EAS builds

When you lack the local toolchain, or want to hand a build to someone else:

```bash
eas build --profile development           --platform android   # APK to sideload
eas build --profile development-simulator --platform ios       # no Apple signing
eas build --profile development           --platform ios       # physical device
```

The plain `development` profile targets a **physical** iPhone, which needs an
Apple Developer account and the device registered for provisioning.
`development-simulator` skips all of that.

**EAS never sees your local `.env`** — it is gitignored, so it is not in the
uploaded archive. Set variables on EAS explicitly:

```bash
eas env:create --environment development \
  --name EXPO_PUBLIC_SUPABASE_URL --value "https://your-project.supabase.co"
```

A build missing `EXPO_PUBLIC_SUPABASE_URL` or `EXPO_PUBLIC_SUPABASE_ANON_KEY`
crashes on launch by design (`services/supabase.ts`). That is a useful early
signal: if the app opens at all, those two arrived.

---

### Sentry source map upload is disabled

Release builds run a Sentry gradle task (`sentry.gradle`) and Xcode phase that
upload source maps via `sentry-cli`. That needs `SENTRY_ORG`, `SENTRY_PROJECT`,
and `SENTRY_AUTH_TOKEN` at build time. None are configured, so the upload
fails and **takes the whole build down with it**:

```
Execution failed for task ':app:createBundleReleaseJsAndAssets_SentryUpload_...'
> Process 'command '.../sentry-cli'' finished with non-zero exit value 1
```

Every profile in `eas.json` therefore sets `SENTRY_DISABLE_AUTO_UPLOAD=true`.
Crash reporting itself still works — only the source map upload is skipped.

**The tradeoff:** release-build stack traces in Sentry point at minified
bundle positions rather than your source, which makes them close to unreadable.
Worth revisiting before you rely on Sentry for real triage. To turn it back on:
register a Sentry org and project, add them to the `@sentry/react-native`
plugin config in `app.json`, create an auth token, store it with
`eas env:create --name SENTRY_AUTH_TOKEN` (as a **secret**, never in the repo),
then drop the `SENTRY_DISABLE_AUTO_UPLOAD` entries.

`eas.json` only covers EAS builds. For a **local** release build, pass the
variable yourself:

```bash
SENTRY_DISABLE_AUTO_UPLOAD=true npx expo run:android --variant release
```

### Image files must match their extension

Android compiles bundled images through AAPT2, which trusts the file
extension. A JPEG named `.png` fails release resource compilation:

```
Execution failed for task ':app:mergeReleaseResources'.
> Android resource compilation failed
  ERROR: .../drawable-mdpi/assets_images_onboarding_hero.png:
  AAPT: error: file failed to compile.
```

This only breaks **release** builds — AGP disables PNG crunching for
debuggable builds, so a mislabelled file passes debug and dies in release.

To check the whole asset tree:

```bash
find assets -type f -exec file {} \;
```

Rename to the true extension rather than re-encoding. Converting a
photographic JPEG into a real PNG is lossless compression of a lossy source
and typically multiplies its size for no visual gain.

---

## 2. Test in release mode, not just dev

**This is the step most likely to be skipped and most likely to matter.** Hermes
and NativeWind both behave differently between dev and release builds, so a dev
build can hide exactly the class of bug an SDK upgrade introduces.

```bash
SENTRY_DISABLE_AUTO_UPLOAD=true npx expo run:android --variant release
SENTRY_DISABLE_AUTO_UPLOAD=true npx expo run:ios --configuration Release
eas build --profile preview --platform android   # eas.json sets it already
```

If you do only one thing beyond a dev smoke test, make it a release-mode build
on a physical Android device.

---

## 3. What to check

### NativeWind styling — highest priority

NativeWind (`nativewind` + `tailwindcss` + `react-native-css-interop`) is the
most fragile layer across React Native upgrades, and it **fails silently**:
styles stop applying rather than throwing, so nothing appears in the logs and
tests stay green.

Walk **every screen** and compare against a build from `main`. Do not sample —
partial breakage is common, where most styles survive and one utility class
family stops resolving.

Pay particular attention to dark mode, which routes through
`Appearance.getColorScheme()` in css-interop.

### Map

- Markers render at the right coordinates
- Supercluster clustering behaves across several zoom levels
- Tapping a cluster expands it
- Map tiles actually load

**A blank map (often with just a Google logo) means the tiles were rejected,
not that the map component failed.** If `react-native-maps` had failed to load,
you would instead see the explicit *"Map not available"* fallback from
`components/MapImpl.native.tsx`. Blank tiles are always the API key. Two causes:

1. **The key was missing at build time.** `app.config.ts` bakes
   `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` into the native manifest during prebuild.
   It now throws when the variable is absent, so this cannot happen silently
   any more — but a build made before that guard existed has an empty key
   compiled in, and no amount of granting permissions at runtime will fix it.
   Rebuild with the variable set.

   Remember EAS never sees a local `.env`:

   ```bash
   eas env:create --environment preview \
     --name EXPO_PUBLIC_GOOGLE_MAPS_API_KEY --value "AIza..."
   ```

2. **The key was present but rejected.** Usually one of:
   - *Maps SDK for Android* (or iOS) is not enabled on the Google Cloud project.
   - The key is restricted to an app whose signing certificate does not match.
     **EAS signs with its own keystore, which has a different SHA-1 than your
     local debug keystore** — so a key that works locally can fail on an EAS
     build. Get the EAS fingerprint with `eas credentials` and add it to the
     key's Android restrictions.
   - Billing is not enabled on the Google Cloud project.

**The app now says which, on Android.** `hooks/useMapTiles.ts` watches
`onMapLoaded` — react-native-maps fires it only once tiles have finished
rendering — and after 12 seconds without it replaces the black rectangle with
a card naming the cause: no key compiled in, no connectivity, or a key Google
rejected. The two key-related causes are reported to Sentry as events (offline
is only a breadcrumb, since it is routine and self-healing), so a tester who
never opens a terminal still produces a usable report. The check is Android-only:
this app does not set `provider`, so iOS runs on Apple Maps, which never fires
`onMapLoaded` and does not use the Google key for tiles at all.

To confirm the exact reason from the device:

```bash
adb logcat -c && adb logcat | grep -iE "Google Maps|API_KEY|Authorization failure"
```

Google's SDK logs an explicit `Authorization failure` naming the reason, along
with the package name and SHA-1 it saw — paste those straight into the key's
restriction settings.

#### Selecting one marker after another

Tapping a second pin while the first one's sheet is open used to take the app
down on Android. Everything that made the marker set churn under an open info
window has been removed, since that is the state react-native-maps is known to
crash in ([#1940](https://github.com/react-native-maps/react-native-maps/issues/1940),
[#5214](https://github.com/react-native-maps/react-native-maps/issues/5214)):

- Google Maps pans the camera by itself to fit an info window. The cluster
  bounding box in `hooks/useMapClusters.ts` now carries a full extra viewport
  of padding on each side, so that self-initiated pan no longer unmounts the
  markers it pushes past the edge.
- A re-fetch that returns the same deals is now a no-op down to the native
  view: `reconcileDeals` in `utils/mapRegion.ts` keeps the existing object for
  every unchanged deal, so no marker gets a property update it did not need.
- The deal the bottom sheet is showing is pinned into the marker set even when
  a later response drops it, so its marker is never torn down while its
  callout is open.
- `pinColor` is always a colour. Selecting a different pin used to *remove* the
  prop from the previously-selected one, which is a different native update
  from a changed value under the new architecture's interop layer.
- Every coordinate is screened for NaN before it reaches a `<Marker>` or
  `animateToRegion` (`utils/mapRegion.ts`). A NaN there is a native exception,
  not a JS error, so it cannot be caught downstream.

The map tab also has its own `ErrorBoundary` now. That matters for diagnosis as
much as for recovery: if a *JavaScript* error is at fault you will see the "Something
went wrong" card in the tab with the rest of the app still running, and Sentry
will have a component stack. If the process still dies outright, the fault is
native and the only place it is written down is logcat:

```bash
adb logcat -c
# reproduce: tap one pin, then another
adb logcat -d | grep -iE "FATAL|AndroidRuntime|AirMap|react-native-maps"
```

That stack names the native frame; nothing in Sentry or the JS console will.

### Animations

Anything driven by Reanimated or worklets:

- The bottom sheet (`@gorhom/bottom-sheet`) — open, drag, snap points, dismiss
- `components/NetworkBanner.tsx` — toggle airplane mode
- `ui/Skeleton.tsx` — loading shimmer on a cold start

`react-native-worklets` is pre-1.0 and its API moves quickly, so treat any
animation regression as plausibly upstream rather than a bug in this app.

### Auth

- Apple Sign In — **physical iOS device only**; it does not work in the
  Simulator
- Session persistence across a full app restart (AsyncStorage)
- Sign out clears state

### Crash reporting

Trigger a deliberate error and confirm it reaches the Sentry dashboard with the
right `environment` tag. Sentry is initialized at module scope in
`app/_layout.tsx`, so it should also capture startup crashes.

### Startup and memory

Compare cold-start time and memory against a build from `main`. Expo SDK 56
carried a Hermes V1 memory regression affecting Reanimated and worklets that
SDK 57 fixes; this is the check that confirms it.

---

## 4. Device coverage

Minimum for a release:

- **One physical Android device** in release mode — the highest-value single
  test
- **One physical iPhone** — required for Apple Sign In, location, and camera
- **iOS Simulator** — fine for layout and navigation, useless for GPS, camera,
  and Apple Sign In
- **One low-end Android device**, if you have one — where Hermes and memory
  regressions show up first

Also worth a pass: the oldest OS versions you support. Expo SDK 56 raised the
iOS minimum to **16.4**, so iOS 15 devices can no longer install the app.

---

## 5. Recording results

Note what you tested against which build, so the next upgrade has a baseline:

```
Build:    <git sha> / <eas build id>
Mode:     release
Devices:  Pixel 7 (Android 15), iPhone 13 (iOS 18)
Result:   pass / fail + what broke
```
