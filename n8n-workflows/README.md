# Content automation pipeline (n8n + Supabase)

The app's deal data is not hand-curated. A set of [n8n](https://n8n.io/) workflows discovers
venues, reads happy hours off their websites, re-checks them on a schedule, and routes anything
uncertain to a human before it reaches the app. This document describes how that pipeline is
shaped and why.

The SQL half lives in this repo under [`scripts/`](../scripts) — principally
[`migration_n8n_content_pipeline.sql`](../scripts/migration_n8n_content_pipeline.sql), extended by
[`migration_metros.sql`](../scripts/migration_metros.sql),
[`migration_hh_deep_verification.sql`](../scripts/migration_hh_deep_verification.sql),
[`migration_hh_deep_probe_proposals.sql`](../scripts/migration_hh_deep_probe_proposals.sql),
[`migration_deal_photo_intake.sql`](../scripts/migration_deal_photo_intake.sql) and
[`migration_venue_artwork.sql`](../scripts/migration_venue_artwork.sql). The workflow definitions
themselves live in an n8n instance; the Code-node logic inside them is mirrored and
regression-tested in [`__tests__/n8n/`](../__tests__/n8n).

## The workflows

| # | Workflow | Trigger |
|---|----------|---------|
| 1 | Deal Intake API | Webhook `POST /hh-deal-intake` and `POST /hh-deal-scan` |
| 2 | Daily Deal Re-Validation | Schedule, nightly |
| 3 | Weekly Area Discovery | Schedule, weekly |
| 4 | Review Digest & Approvals | Weekly schedule + review/approval webhooks |
| 5 | Burst Area Scan | On-demand form submission |
| 6 | Venue Artwork Backfill | Schedule, nightly |
| — | Area Scan Engine (sub-workflow) | Called by 3 and 5 |
| — | Site Crawler (sub-workflow) | Called by 2 and the Area Scan Engine |
| — | Deep Probe, Tier 4 (sub-workflow) | Called by 2 |
| — | Menu Photo OCR (sub-workflow) | Called by 1 |
| — | Failure Alert (error workflow) | Fires when any of the above fails |

## Why it is shaped this way

Every source funnels through **one** intake endpoint (Workflow 1) instead of writing to Supabase
directly. Dedupe, geocoding, and the publish decision therefore exist in exactly one place, and
adding a fifth source later means pointing it at the same webhook.

```
 WF3 weekly (home city) ─┐
                         ├─► Area Scan Engine ─┐
 WF5 burst (any area) ───┘                     │
                                               ├─► WF1 Intake API ─► hh_intake_deal()
 Spreadsheet / app submissions ────────────────┘         │              │
                                                         │              ▼
                                                         │        venues + deals
                                                         ▼              │
 WF2 Re-validation ──► hh_record_verification() ──► content_audit_log ──┘
                                               │
 WF4 Digest / WF5 report ◄── pending queue + quality views + audit log
        └─► Approve/Reject links ──► hh_review_deal()

 WF6 nightly ─► hh_venues_needing_image() ─► the venue's own site ─► venue-images bucket
                                                              └─► hh_record_venue_image()

 App: photo of a menu ─► venue-images bucket ─► WF1 /hh-deal-scan ─► Menu Photo OCR
                                                       │                    │
                                                       ▼                    │
                                         extracted fields, no write ◄───────┘
                                                       │
                              user checks them in the form, then submits as usual
```

The scan path is the one arrow that goes **backwards** — everything else writes towards Supabase,
and the scan deliberately returns to the person instead. A photo is supplied by whoever pointed the
camera and OCR misreads menu boards, so the answer goes back into an editable form rather than into
the database.

### A venue can have several happy hours

A happy hour whose hours change with the day is **a group of sibling deal rows**, not one row with
a clever time string. That is the app's model and it predates this pipeline: `SubmitDealData`
carries a `Schedule[]`, `submitUserDeal()` inserts one row per schedule joined by a self-referencing
`parent_deal_id`, and the browse queries filter on `days_active @> [today]` with no parent filter —
so only the sibling running today surfaces, and the detail screen lists the whole group.

The pipeline has to respect that model rather than flatten it, which is what most of the
sibling-aware guards below are about.

### The publish gate

`hh_intake_deal()` publishes a deal as `active` only when **both** hold:

- extraction confidence `>= 0.80`, and
- the time window parses under the app's `parseDealTime()` in
  [`utils/dealTime.ts`](../utils/dealTime.ts) — i.e. `H[:MM] AM/PM - H[:MM] AM/PM`.

Anything else lands as `pending` for review. This is the rule that matters: the app renders an
unparseable window as a dead string with no live countdown, which is how rows like `"All Day"` and
`"4:00pm - Close"` end up needing a human.

### Safety rails

These are enforced in SQL, not in the workflow, so they hold no matter what an LLM returns or what
a scraped page claims:

- **A parseable stored window is never overwritten by an unparseable one**, regardless of
  confidence. The rejected value is written to `content_audit_log.field_changes` as
  `rejected_time_window` and surfaced in the weekly digest.
- **Unpublishing needs confidence `>= 0.80`.** A weaker "this deal is gone" reading only marks
  `verification_status = 'conflict'` and leaves the deal live.
- **Nothing is ever hard-deleted.** The strongest automated action is moving a deal to `pending`.
- **A lower-confidence extraction never overwrites a higher-confidence one.**
- **A venue that cannot be placed is refused, not guessed.** Intake answers 400 (bad address) or
  503 (geocoder unreachable) and writes nothing, rather than falling back to a city centre.
- **Approving a deal with an unparseable window is refused**, so a click in an email cannot publish
  a broken card.
- **A reading that belongs to a different sibling is refused.** At a venue with more than one deal,
  `hh_record_verification()` writes nothing when the days it read do not overlap the stored row's,
  when the window it read is (in minutes) another sibling's, or when applying it would make this row
  newly collide with a sibling. Pre-existing overlaps are tolerated — the guard's job is to stop the
  sweep creating a new one, not to reject rows for a mess it inherited. The reading is logged as
  `wrong_sibling` or `rejected_collision` and the row is flagged `conflict` for a human.
- **The Tier 4 deep probe cannot change a deal at all.** Its only write path is
  `hh_propose_deal_change()`, which touches `hh_deal_proposals` and `content_audit_log` and never
  `deals`. Everything it produces waits for a human click.

One rail sits in the workflow rather than in SQL, because it is about *what was read* and the
database cannot see that: **re-validation will not turn "no happy hour on this page" into a removal
unless the crawl actually reached a page that would carry one.** A site that timed out is not
evidence that a deal ended.

Scraped page text is untrusted input fed to an LLM whose output drives writes. The gates above are
what bound the blast radius; every change is logged to `content_audit_log`.

## The review console

Workflow 4 emails a digest of everything pending and serves a small HTML review console. Three
properties of it are load-bearing, and each is regression-tested in
[`__tests__/n8n/reviewApplyRequest.test.js`](../__tests__/n8n/reviewApplyRequest.test.js) and
[`buildConsoleHtml.test.js`](../__tests__/n8n/buildConsoleHtml.test.js):

1. **A field whitelist.** The console can edit a deal's title and description. A field that is not
   on the list must not reach the RPC at all — `status`, `venue_id` and `submitted_by` are all
   columns a crafted form field could otherwise name. The RPC ignores unknown keys too; the
   whitelist is the outer of two doors, not the only one.
2. **Blank is not empty.** The form posts every input on every submit, so a reviewer who clears a
   box — or a browser that autofills one empty — must not thereby wipe a column. A blank field means
   "leave it alone".
3. **Cross-site posts are refused.** The console sits behind HTTP basic auth, and basic auth rides a
   cross-site request exactly like a cookie does, so authentication alone is *not* CSRF protection.
   The check compares `Origin`, not `Sec-Fetch-Site`: a page can suppress the latter (a document
   with `Referrer-Policy: no-referrer` posts with `Origin: null`, and the browser may then report a
   same-origin navigation as `cross-site`), whereas a hostile page always sends its own real origin,
   so a mismatch is real evidence.

Clicking an approve link never applies a change on its own — it opens a confirmation page, and the
POST behind that page is what writes. Link prefetchers and email scanners follow links; they do not
submit forms.

## Testing

Code nodes live inside the workflow definition, where n8n cannot unit-test them. Each non-trivial
node's source is therefore mirrored into [`__tests__/n8n/`](../__tests__/n8n) and tested there — 16
suites covering intake geocoding, verdict logic, crawler evidence assembly, deep-probe budgeting,
menu OCR parsing, metro resolution, the review console, and failure-alert formatting.

These are mirrors, not imports: editing a node means updating its copy here and re-running
`npm test`. The duplication is deliberate — it buys a reviewable, regression-tested contract for
logic that otherwise only exists inside a workflow editor.

## Configuration

The workflows read their endpoints and tuning knobs from n8n environment variables rather than
hardcoded literals, so a URL that turns out wrong is fixed by setting a variable instead of editing
several Code nodes. The app side needs only one of them:

| Variable | Used by | Purpose |
|---|---|---|
| `EXPO_PUBLIC_HH_SCAN_URL` | the app ([`services/dealScanService.ts`](../services/dealScanService.ts)) | the `POST /hh-deal-scan` endpoint |

Leave it unset and the app hides the scan button and behaves exactly as before — a photo is still
uploaded and still attached to the submission, it just is not read. See [`.env.example`](../.env.example).

The scan endpoint ships **no shared secret**. It authenticates the end user with their own Supabase
access token, precisely because every `EXPO_PUBLIC_*` value is inlined into the JS bundle at build
time and can be extracted from the binary.
