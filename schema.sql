-- Reddit Stock Watcher Database Schema
-- Run this in your Supabase SQL Editor

-- Main table for storing Reddit posts and analysis results
CREATE TABLE IF NOT EXISTS reddit_posts (
  post_id TEXT PRIMARY KEY,           -- e.g., 't3_abc123'
  title TEXT NOT NULL,
  body TEXT,
  subreddit TEXT NOT NULL,
  author TEXT,
  url TEXT NOT NULL,                  -- https://www.reddit.com/...
  created_utc TIMESTAMPTZ NOT NULL,
  score INT DEFAULT 0,
  detected_tickers TEXT[] DEFAULT '{}',   -- from prefilter

  -- LLM outputs
  is_future_upside_claim BOOLEAN,
  stance TEXT CHECK (stance IN ('bullish','bearish','unclear')),
  reason TEXT,
  quality_score INT CHECK (quality_score BETWEEN 0 AND 5),

  -- bookkeeping
  emailed_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_posts_created ON reddit_posts (created_utc DESC);
CREATE INDEX IF NOT EXISTS idx_posts_email ON reddit_posts (emailed_at);
CREATE INDEX IF NOT EXISTS idx_posts_quality ON reddit_posts (is_future_upside_claim, stance, quality_score);
CREATE INDEX IF NOT EXISTS idx_posts_tickers ON reddit_posts USING GIN (detected_tickers);

-- Application metadata table for storing cursors and other state
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Initialize the cursor for tracking processed posts
INSERT INTO app_meta(key, value) VALUES
  ('last_cursor', jsonb_build_object('created_utc', '1970-01-01T00:00:00Z'))
ON CONFLICT (key) DO NOTHING;

-- Note: For simplicity, use the service role key from serverless functions
-- and keep RLS disabled for these tables. If you need RLS later, add narrow
-- policies and switch to function-invoked RPCs.