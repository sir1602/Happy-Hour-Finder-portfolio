/**
 * Centralized color tokens for values previously scattered as ad-hoc hex
 * literals across screens/components. Each entry is a straight 1:1
 * extraction of an existing literal — no shades were changed or merged, so
 * adopting this file is a pure rename with zero visual change. Consolidating
 * visually-near-duplicate grays into a smaller palette is a separate,
 * visually-reviewed follow-up, not bundled into this pass.
 */
export const Colors = {
  // Brand
  primary: '#FFC107', // Brand amber — icons, accents, active/selected states
  onPrimary: '#1E293B', // Text/icon color rendered on top of primary amber
  onPrimaryAlt: '#0F172A', // A near-duplicate of onPrimary used by the ui/* primitives — kept distinct rather than merged (same reasoning as iconMutedAlt)

  // Semantic
  danger: '#EF4444', // Errors, destructive actions, remove icons
  success: '#16A34A', // Confirmed / checked-in / active state
  successAlt: '#22C55E', // Magic-link-sent confirmation icon

  // Neutrals
  white: '#FFFFFF',
  black: '#000000',
  textMuted: '#757575', // Secondary text/icons on light backgrounds
  iconMuted: '#9CA3AF', // Muted icons/placeholders (light + dark)
  iconMutedAlt: '#94A3B8', // A near-duplicate of iconMuted (slate-400 vs gray-400) — kept distinct rather than merged, since merging would be a real (if tiny) shade change, not a pure rename
  borderMuted: '#CBD5E1', // Inactive star rating, subtle borders
  closeIconMuted: '#64748B', // Header close/back icon on light screens
  placeholderDark: '#A9A9A9', // Placeholder text on dark auth inputs

  // Map / dark surfaces
  mapSheetBackground: '#1E293B', // Bottom sheet background on the map
  mapSheetHandle: '#94A3B8', // Bottom sheet drag handle
  mapLocationIcon: '#333333', // "My location" button icon
  mapDirectionsIcon: '#60A5FA', // Directions button icon (on dark surface)
  // Google Maps' own default pin hue, stated explicitly. A marker's colour has
  // to be passed on every render rather than only when the pin is selected:
  // toggling the prop between a value and `undefined` makes the selection a
  // prop *removal* for the native view, which the new architecture's interop
  // layer handles differently from an ordinary value change. Same red as
  // before, said out loud.
  mapMarkerDefault: '#FF0000',

  // One-off accents (single call site each — named for clarity, not reuse)
  reviewIcon: '#E2E8F0', // Empty review-list icon
  mapAccent: '#D97706', // "Show on map" icon in deal detail
  directionsAccent: '#2563EB', // "Get directions" icon in deal detail
  addScheduleAccent: '#0EA5E9', // "Add another schedule" icon
  charcoal: '#36454F', // Submit button loading spinner on login
  googleBlue: '#4285F4', // Google brand color (icon + spinner)
} as const;
