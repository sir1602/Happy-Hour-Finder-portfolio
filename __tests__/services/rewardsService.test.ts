import { getLevelForPoints, getNextLevel, LEVELS, POINTS, BADGES, rewardsService } from '../../services/rewardsService';
import { supabase } from '../../services/supabase';

// Mock Supabase to avoid native module and env var issues during testing
jest.mock('../../services/supabase', () => ({
    supabase: { from: jest.fn(), rpc: jest.fn() },
}));

describe('getLevelForPoints', () => {
    it('returns Newbie for 0 points', () => {
        const level = getLevelForPoints(0);
        expect(level.level).toBe(1);
        expect(level.title).toBe('Newbie');
    });

    it('returns Regular for 100 points', () => {
        const level = getLevelForPoints(100);
        expect(level.level).toBe(2);
        expect(level.title).toBe('Regular');
    });

    it('returns Explorer for 300 points', () => {
        const level = getLevelForPoints(300);
        expect(level.level).toBe(3);
        expect(level.title).toBe('Explorer');
    });

    it('returns Connoisseur for 600 points', () => {
        const level = getLevelForPoints(600);
        expect(level.level).toBe(4);
        expect(level.title).toBe('Connoisseur');
    });

    it('returns Happy Hour Hero for 1000 points', () => {
        const level = getLevelForPoints(1000);
        expect(level.level).toBe(5);
        expect(level.title).toBe('Happy Hour Hero');
    });

    it('returns Legend for 2000+ points', () => {
        const level = getLevelForPoints(2000);
        expect(level.level).toBe(6);
        expect(level.title).toBe('Legend');
    });

    it('returns correct level for points between thresholds', () => {
        // 450 is between Regular (100) and Explorer (300) -> should be Explorer (300)
        // Actually 450 > 300, so Explorer
        const level = getLevelForPoints(450);
        expect(level.level).toBe(3);
        expect(level.title).toBe('Explorer');
    });

    it('handles very large point values', () => {
        const level = getLevelForPoints(99999);
        expect(level.level).toBe(6);
        expect(level.title).toBe('Legend');
    });
});

describe('getNextLevel', () => {
    it('returns the next level up', () => {
        const current = LEVELS[0]; // Newbie
        const next = getNextLevel(current);
        expect(next).not.toBeNull();
        expect(next!.level).toBe(2);
        expect(next!.title).toBe('Regular');
    });

    it('returns null for max level', () => {
        const current = LEVELS[LEVELS.length - 1]; // Legend
        const next = getNextLevel(current);
        expect(next).toBeNull();
    });
});

describe('POINTS constants', () => {
    it('has expected point values', () => {
        expect(POINTS.CHECK_IN).toBe(10);
        expect(POINTS.FIRST_VISIT).toBe(25);
        expect(POINTS.REVIEW).toBe(15);
        expect(POINTS.DEAL_SUBMITTED).toBe(50);
        expect(POINTS.WEEKLY_STREAK).toBe(30);
        expect(POINTS.SHARE_DEAL).toBe(5);
    });
});

describe('BADGES definitions', () => {
    it('has at least 5 badges defined', () => {
        expect(BADGES.length).toBeGreaterThanOrEqual(5);
    });

    it('each badge has required fields', () => {
        BADGES.forEach(badge => {
            expect(badge.id).toBeTruthy();
            expect(badge.name).toBeTruthy();
            expect(badge.description).toBeTruthy();
            expect(badge.icon).toBeTruthy();
        });
    });

    it('has unique badge IDs', () => {
        const ids = BADGES.map(b => b.id);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(ids.length);
    });
});


describe('rewardsService.awardAction', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (supabase.rpc as jest.Mock).mockResolvedValue({ data: { total_points: 35 }, error: null });
    });

    // The RPC takes an action name and looks the value up server-side. Passing a
    // client-chosen point total is the hole this replaced, so the argument shape
    // is the thing worth pinning: p_action only, and never p_points.
    it.each([
        ['check_in'],
        ['check_in_first'],
        ['review'],
        ['deal_submitted'],
    ] as const)('sends %s as p_action and nothing else', async (action) => {
        await rewardsService.awardAction(action);

        expect(supabase.rpc).toHaveBeenCalledWith('increment_rewards', { p_action: action });
        const [, args] = (supabase.rpc as jest.Mock).mock.calls[0];
        expect(args).not.toHaveProperty('p_points');
        expect(args).not.toHaveProperty('p_user_id');
        expect(args).not.toHaveProperty('p_stat_field');
    });

    it('returns null and does not throw when the RPC errors', async () => {
        (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: { message: 'boom' } });

        await expect(rewardsService.awardAction('review')).resolves.toBeNull();
    });

    it('keeps the presentational POINTS table in step with the server values', () => {
        // These are duplicated in increment_rewards(). If someone changes one
        // side, this fails rather than the UI quietly promising the wrong number.
        expect(POINTS.CHECK_IN).toBe(10);
        expect(POINTS.CHECK_IN + POINTS.FIRST_VISIT).toBe(35);
        expect(POINTS.REVIEW).toBe(15);
        expect(POINTS.DEAL_SUBMITTED).toBe(50);
    });
});
