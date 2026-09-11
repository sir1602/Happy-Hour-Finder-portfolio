/**
 * Validates that the input is a valid array of strings (deal IDs).
 * Used to sanitize data loaded from AsyncStorage before use.
 * @param data The unknown data to validate.
 * @returns A string array containing only string elements. If input is invalid, returns an empty array.
 */
export const validateSavedDeals = (data: unknown): string[] => {
    if (!Array.isArray(data)) {
        return [];
    }
    // Filter out any non-string elements to ensure type safety
    return data.filter((item): item is string => typeof item === 'string');
};
