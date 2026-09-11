/**
 * The one picture the app shows for a venue that has none.
 *
 * There used to be two, disagreeing. `services/dealService.ts` mapped a missing
 * `venues.image_url` onto a picsum URL, and `components/DealCard.tsx` fell back
 * to an unrelated Unsplash photograph when an image failed to *load* — so a
 * venue with no artwork and a venue whose artwork 404ed showed different
 * pictures, neither of them chosen. Worse, the picsum URL was also written into
 * the database on insert, which is what made "which venues still need artwork?"
 * unanswerable and is now `venues.image_source` / Workflow 6's job.
 *
 * A stock photograph is a placeholder, not data. It belongs here, in the render
 * path, where it is obviously one — and nowhere near a table.
 */
export const VENUE_FALLBACK_IMAGE =
    'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?q=80&w=600&auto=format&fit=crop';
