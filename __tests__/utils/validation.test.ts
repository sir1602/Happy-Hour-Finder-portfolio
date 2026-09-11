import { validateSavedDeals } from '../../utils/validation';

describe('validateSavedDeals', () => {
    it('returns array of strings if input is valid', () => {
        const input = ["1", "2", "3"];
        const result = validateSavedDeals(input);
        expect(result).toEqual(["1", "2", "3"]);
    });

    it('returns empty array if input is not an array', () => {
        expect(validateSavedDeals(null)).toEqual([]);
        expect(validateSavedDeals(undefined)).toEqual([]);
        expect(validateSavedDeals("invalid")).toEqual([]);
        expect(validateSavedDeals({ foo: 'bar' })).toEqual([]);
        expect(validateSavedDeals(123)).toEqual([]);
    });

    it('filters out non-string elements from mixed array', () => {
        const input = ["1", 2, "3", null, { id: "4" }, "5"];
        const result = validateSavedDeals(input);
        expect(result).toEqual(["1", "3", "5"]);
    });

    it('returns empty array if array contains no strings', () => {
        const input = [1, 2, 3, null, {}];
        const result = validateSavedDeals(input);
        expect(result).toEqual([]);
    });
});
