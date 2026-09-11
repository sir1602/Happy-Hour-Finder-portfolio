-- Migration: create rewards tables for the gamification system
-- Tables: user_rewards, user_badges

-- ── User Rewards (one row per user) ─────────────────────────────
CREATE TABLE IF NOT EXISTS user_rewards (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
    total_points INT DEFAULT 0,
    level INT DEFAULT 1,
    current_streak INT DEFAULT 0,
    longest_streak INT DEFAULT 0,
    unique_venues_visited INT DEFAULT 0,
    total_visits INT DEFAULT 0,
    total_reviews INT DEFAULT 0,
    deals_submitted INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE user_rewards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own rewards"
    ON user_rewards FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own rewards"
    ON user_rewards FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own rewards"
    ON user_rewards FOR UPDATE
    USING (auth.uid() = user_id);

-- ── User Badges (many per user) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS user_badges (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    badge_id TEXT NOT NULL,
    earned_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(user_id, badge_id)
);

ALTER TABLE user_badges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own badges"
    ON user_badges FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own badges"
    ON user_badges FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- ── Indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_rewards_user_id ON user_rewards(user_id);
CREATE INDEX IF NOT EXISTS idx_user_badges_user_id ON user_badges(user_id);
