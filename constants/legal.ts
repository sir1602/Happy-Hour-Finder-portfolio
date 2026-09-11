/**
 * Public URLs for the app's legal documents.
 *
 * A publicly reachable privacy policy URL is a hard requirement for Google Play
 * closed testing and for App Store review, so these must resolve before any
 * build is distributed to testers.
 *
 * The default points at the rendered Markdown in this repository, which is a
 * real, publicly reachable URL and is enough for a closed test track. Override
 * it with `EXPO_PUBLIC_PRIVACY_POLICY_URL` / `EXPO_PUBLIC_TERMS_URL` once the
 * documents are hosted on a real domain.
 *
 * REPLACE THIS with your own fork's URL before distributing a build — a policy
 * URL that 404s is rejected by both stores.
 */

const REPO_DOCS_BASE =
    'https://github.com/sir1602/Happy-Hour-Finder-portfolio/blob/main/docs';

export const PRIVACY_POLICY_URL =
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL || `${REPO_DOCS_BASE}/Privacy-Policy.md`;

export const TERMS_URL = process.env.EXPO_PUBLIC_TERMS_URL || '';
