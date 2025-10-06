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
  llm_tickers TEXT[] DEFAULT '{}',        -- refined tickers from LLM

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
CREATE INDEX IF NOT EXISTS idx_posts_llm_tickers ON reddit_posts USING GIN (llm_tickers);

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

-- Disable RLS for API key access from serverless functions
-- This is appropriate since only the backend application accesses these tables
ALTER TABLE reddit_posts DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_meta DISABLE ROW LEVEL SECURITY;

-- Note: RLS is disabled because this is a backend-only application using
-- the API key. The data is public Reddit content, not sensitive user data.

-- Price cache for backtesting (Alpha Vantage daily or intraday aggregates)
CREATE TABLE IF NOT EXISTS prices (
  ticker TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC,
  PRIMARY KEY (ticker, ts)
);

CREATE INDEX IF NOT EXISTS idx_prices_ticker_ts ON prices (ticker, ts DESC);

ALTER TABLE prices DISABLE ROW LEVEL SECURITY;

-- Intraday price watch tasks
CREATE TABLE IF NOT EXISTS price_watches (
  id BIGSERIAL PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES reddit_posts(post_id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  quality_score INT NOT NULL,
  entry_price NUMERIC NOT NULL,
  entry_price_ts TIMESTAMPTZ NOT NULL,
  emailed_at TIMESTAMPTZ NOT NULL,
  monitor_start_at TIMESTAMPTZ NOT NULL,
  monitor_close_at TIMESTAMPTZ NOT NULL,
  next_check_at TIMESTAMPTZ,
  last_price NUMERIC,
  last_price_ts TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'triggered', 'expired')),
  stop_reason TEXT,
  triggered_at TIMESTAMPTZ,
  triggered_price NUMERIC,
  triggered_move_pct NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_watches_post_ticker ON price_watches (post_id, ticker);
CREATE INDEX IF NOT EXISTS idx_price_watches_status_next ON price_watches (status, next_check_at);
CREATE INDEX IF NOT EXISTS idx_price_watches_next_check ON price_watches (next_check_at);

ALTER TABLE price_watches DISABLE ROW LEVEL SECURITY;
