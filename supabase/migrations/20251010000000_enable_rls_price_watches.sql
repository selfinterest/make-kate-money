-- Enable Row Level Security on price_watches table with deny all policy
-- This prevents public access to the table while allowing service role access

-- Enable RLS on price_watches table
ALTER TABLE price_watches ENABLE ROW LEVEL SECURITY;

-- Create deny all policy for price_watches
CREATE POLICY "deny_all_price_watches" ON price_watches
  FOR ALL
  TO public
  USING (false);

