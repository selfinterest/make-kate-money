-- Enable Row Level Security on all tables with deny all policy
-- This prevents public access to tables while allowing service role access

-- Enable RLS on reddit_posts table
ALTER TABLE reddit_posts ENABLE ROW LEVEL SECURITY;

-- Create deny all policy for reddit_posts
CREATE POLICY "deny_all_reddit_posts" ON reddit_posts
  FOR ALL
  TO public
  USING (false);

-- Enable RLS on app_meta table
ALTER TABLE app_meta ENABLE ROW LEVEL SECURITY;

-- Create deny all policy for app_meta
CREATE POLICY "deny_all_app_meta" ON app_meta
  FOR ALL
  TO public
  USING (false);

-- Enable RLS on prices table
ALTER TABLE prices ENABLE ROW LEVEL SECURITY;

-- Create deny all policy for prices
CREATE POLICY "deny_all_prices" ON prices
  FOR ALL
  TO public
  USING (false);

-- Enable RLS on post_performance table
ALTER TABLE post_performance ENABLE ROW LEVEL SECURITY;

-- Create deny all policy for post_performance
CREATE POLICY "deny_all_post_performance" ON post_performance
  FOR ALL
  TO public
  USING (false);

-- Enable RLS on ticker_performance table
ALTER TABLE ticker_performance ENABLE ROW LEVEL SECURITY;

-- Create deny all policy for ticker_performance
CREATE POLICY "deny_all_ticker_performance" ON ticker_performance
  FOR ALL
  TO public
  USING (false);
