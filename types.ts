export type DealType = 'regular' | 'trending' | 'ends-soon' | 'new';
export type DealStatus = 'active' | 'pending' | 'rejected' | 'expired';
export type DealCategory = 'drink' | 'food' | 'both';

/**
 * How the re-validation pipeline last judged this deal against its source.
 *
 *   verified     — matched the source on the last check
 *   changed      — the source now says something different
 *   conflict     — sources disagree with each other
 *   unreachable  — the source could not be read
 *   unverified   — never checked (the default; most rows)
 */
export type VerificationStatus =
  | 'verified'
  | 'changed'
  | 'conflict'
  | 'unreachable'
  | 'unverified';

export interface Schedule {
  days: number[];
  timeWindow: string;
  dealTitle: string;
  category?: DealCategory;
}

export interface Venue {
  id: string;
  name: string;
  address: string;
  neighborhood: string;
  latitude: number;
  longitude: number;
  image?: string;
  rating: number;
  reviewCount: number;
  website?: string;
  phone?: string;
}

export interface Deal {
  id: string;
  venueId: string;
  name: string;
  deal: string;
  image: string;
  neighborhood: string;
  distance: string;
  price: number;
  rating: number;
  reviewCount: number;
  tags: string[];
  address: string;
  website: string;
  phone: string;
  type: DealType;
  endsIn?: string;
  time: string;
  latitude: number;
  longitude: number;
  status?: DealStatus;
  daysActive: number[];
  parentDealId?: string;
  description?: string | null;
  category?: DealCategory;
  verificationStatus?: VerificationStatus | null;
}

export interface DealFilters {
  query?: string;
  tags?: string[];
  priceMax?: number;
  type?: DealType;
  category?: DealCategory;
  neighborhood?: string;
  neighborhoods?: string[];
  dayOfWeek?: number;
  limit?: number;
  offset?: number;
}

export interface SubmitDealData {
  venueName: string;
  /**
   * The venue the submitter picked out of autocomplete, when they picked one.
   *
   * Present means "this deal belongs to a venue we already have", which lets
   * submitUserDeal() skip both the name-match lookup and the geocode. Absent
   * means the name was typed freehand and has to be resolved the slow way.
   *
   * Cleared the moment the user edits the venue name, address or neighborhood,
   * because `venues` has no UPDATE policy: holding on to the id would silently
   * discard the correction they just made.
   */
  venueId?: string;
  neighborhood: string;
  address: string;
  priceLevel: number;
  tags: string[];
  type: DealType;
  /**
   * The menu-board photo. Evidence a reviewer checks the submission against,
   * stored on every deal row of the group -- deliberately NOT the venue's
   * artwork, which is what venuePhotoUrl is for. A photo of a menu is proof,
   * not a picture of the place.
   */
  imageUrl?: string;
  /**
   * An optional photo of the venue itself, used as its artwork.
   *
   * Written straight onto the row when this submission also creates the venue,
   * and otherwise handed to hh_attach_venue_image, which is the only way a
   * client can fill in artwork for a venue that already exists.
   */
  venuePhotoUrl?: string;
  schedules: Schedule[];
}

export interface MapRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}
