-- Seed data for Reddit Stock Watcher
-- This file contains initial data that should be loaded after migrations

-- Initialize app metadata with default cursor
INSERT INTO app_meta(key, value) VALUES
  ('last_cursor', jsonb_build_object('created_utc', '1970-01-01T00:00:00Z'))
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = NOW();

-- Add any other initial configuration data here
-- For example, you might want to initialize other app_meta keys:
-- INSERT INTO app_meta(key, value) VALUES
--   ('app_version', jsonb_build_object('version', '1.0.0')),
--   ('last_cleanup', jsonb_build_object('timestamp', '1970-01-01T00:00:00Z'))
-- ON CONFLICT (key) DO NOTHING;
