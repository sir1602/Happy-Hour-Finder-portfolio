/**
 * Calculates the number of full, half, and empty stars based on a rating.
 * @param rating - A number representing the rating (usually 0-5).
 * @returns An object containing the counts for full, half, and empty stars.
 */
export const getStarConfig = (rating: number) => {
    // Clamp rating between 0 and 5
    const normalizedRating = Math.max(0, Math.min(5, rating));

    const fullStars = Math.floor(normalizedRating);
    // A half star is shown if the fractional part is 0.5 or greater
    const halfStar = (normalizedRating % 1) >= 0.5 && fullStars < 5;
    // Total stars should always be 5
    const emptyStars = Math.max(0, 5 - fullStars - (halfStar ? 1 : 0));

    return { fullStars, halfStar, emptyStars };
};
