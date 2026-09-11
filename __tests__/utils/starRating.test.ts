import { getStarConfig } from '../../utils/starRating';

describe('getStarConfig', () => {
    it('returns 5 empty stars for rating 0', () => {
        expect(getStarConfig(0)).toEqual({
            fullStars: 0,
            halfStar: false,
            emptyStars: 5
        });
    });

    it('returns 5 full stars for rating 5', () => {
        expect(getStarConfig(5)).toEqual({
            fullStars: 5,
            halfStar: false,
            emptyStars: 0
        });
    });

    it('returns 3 full stars and 2 empty stars for rating 3', () => {
        expect(getStarConfig(3)).toEqual({
            fullStars: 3,
            halfStar: false,
            emptyStars: 2
        });
    });

    it('returns 4 full stars and a half star for rating 4.5', () => {
        expect(getStarConfig(4.5)).toEqual({
            fullStars: 4,
            halfStar: true,
            emptyStars: 0
        });
    });

    it('returns 0 full stars and a half star for rating 0.7', () => {
        expect(getStarConfig(0.7)).toEqual({
            fullStars: 0,
            halfStar: true,
            emptyStars: 4
        });
    });

    it('handles rounding: 3.4 should have no half star', () => {
        expect(getStarConfig(3.4)).toEqual({
            fullStars: 3,
            halfStar: false,
            emptyStars: 2
        });
    });

    it('handles rounding: 3.5 should have a half star', () => {
        expect(getStarConfig(3.5)).toEqual({
            fullStars: 3,
            halfStar: true,
            emptyStars: 1
        });
    });

    it('handles ratings below 0 by clamping to 0', () => {
        expect(getStarConfig(-1)).toEqual({
            fullStars: 0,
            halfStar: false,
            emptyStars: 5
        });
    });

    it('handles ratings above 5 by clamping to 5', () => {
        expect(getStarConfig(6)).toEqual({
            fullStars: 5,
            halfStar: false,
            emptyStars: 0
        });
    });

    it('handles edge case near 5: 4.9 should show 4 full and 1 half star', () => {
        expect(getStarConfig(4.9)).toEqual({
            fullStars: 4,
            halfStar: true,
            emptyStars: 0
        });
    });
});
