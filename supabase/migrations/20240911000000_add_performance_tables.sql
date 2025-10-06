-- Add performance tracking tables for ROI-based ranking

CREATE TABLE IF NOT EXISTS post_performance (
  post_id TEXT PRIMARY KEY REFERENCES reddit_posts(post_id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  return_pct NUMERIC,
  profit_usd NUMERIC,
  entry_price NUMERIC,
  exit_price NUMERIC,
  lookback_date DATE,
  run_date DATE,
  emailed_at TIMESTAMPTZ,
  subreddit TEXT,
  author TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_post_performance_ticker ON post_performance (ticker);
CREATE INDEX IF NOT EXISTS idx_post_performance_run_date ON post_performance (run_date DESC);

CREATE TABLE IF NOT EXISTS ticker_performance (
  ticker TEXT PRIMARY KEY,
  sample_size INT NOT NULL DEFAULT 0,
  sum_return_pct NUMERIC NOT NULL DEFAULT 0,
  win_count INT NOT NULL DEFAULT 0,
  avg_return_pct NUMERIC NOT NULL DEFAULT 0,
  win_rate_pct NUMERIC NOT NULL DEFAULT 0,
  last_run_date DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE post_performance DISABLE ROW LEVEL SECURITY;
ALTER TABLE ticker_performance DISABLE ROW LEVEL SECURITY;
