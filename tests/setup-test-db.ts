/**
 * Test Database Setup Utilities
 * 
 * This module provides utilities for setting up and tearing down the test database
 * using local Supabase. It should be run before and after each test to ensure a
 * clean database state.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Local Supabase test configuration
 * 
 * IMPORTANT: These are the DEFAULT keys that come with EVERY local Supabase installation.
 * They are NOT secrets and are safe to commit. They are documented at:
 * https://supabase.com/docs/guides/local-development
 * 
 * These keys ONLY work with local Supabase (127.0.0.1) and have no access to production.
 * 
 * The JWT tokens decode to:
 * - Issuer: "supabase-demo" (not a real issuer)
 * - Role: "anon" or "service_role"
 * - Expiry: 2033 (far future for demo purposes)
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';

// Standard local Supabase anon key (same for all local installations)
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// Standard local Supabase service_role key (used in tests to bypass RLS)
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

/**
 * Creates a Supabase client for testing
 * Uses service role key to bypass RLS policies
 */
export function createTestSupabaseClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Clears all data from test tables
 * This is idempotent and safe to run multiple times
 * 
 * Note: We use .not('post_id', 'is', null) which matches all rows where post_id is not null
 * This is a reliable way to select all rows for deletion in Supabase
 */
export async function clearTestDatabase(client: SupabaseClient): Promise<void> {
  // Delete in order to respect foreign key constraints
  
  // Price watches reference reddit_posts - delete first
  const { error: pwError } = await client
    .from('price_watches')
    .delete()
    .not('post_id', 'is', null);
  if (pwError && pwError.code !== 'PGRST116') {
    console.error('Error clearing price_watches:', pwError);
  }
  
  // Post performance references reddit_posts
  const { error: ppError } = await client
    .from('post_performance')
    .delete()
    .not('post_id', 'is', null);
  if (ppError && ppError.code !== 'PGRST116') {
    console.error('Error clearing post_performance:', ppError);
  }
  
  // Ticker performance has no dependencies
  const { error: tpError } = await client
    .from('ticker_performance')
    .delete()
    .not('ticker', 'is', null);
  if (tpError && tpError.code !== 'PGRST116') {
    console.error('Error clearing ticker_performance:', tpError);
  }
  
  // Reddit posts (no dependencies from other tables)
  const { error: rpError } = await client
    .from('reddit_posts')
    .delete()
    .not('post_id', 'is', null);
  if (rpError && rpError.code !== 'PGRST116') {
    console.error('Error clearing reddit_posts:', rpError);
  }
  
  // App metadata
  const { error: amError } = await client
    .from('app_meta')
    .delete()
    .not('key', 'is', null);
  if (amError && amError.code !== 'PGRST116') {
    console.error('Error clearing app_meta:', amError);
  }
}

/**
 * Seeds the test database with initial data
 */
export async function seedTestDatabase(
  client: SupabaseClient,
  data?: {
    appMeta?: Array<{ key: string; value: any }>;
    redditPosts?: Array<any>;
    priceWatches?: Array<any>;
    postPerformance?: Array<any>;
    tickerPerformance?: Array<any>;
  }
): Promise<void> {
  if (data?.appMeta && data.appMeta.length > 0) {
    const rows = data.appMeta.map(item => ({
      key: item.key,
      value: item.value,
      updated_at: new Date().toISOString(),
    }));
    await client.from('app_meta').insert(rows);
  }

  if (data?.redditPosts && data.redditPosts.length > 0) {
    await client.from('reddit_posts').insert(data.redditPosts);
  }

  if (data?.priceWatches && data.priceWatches.length > 0) {
    await client.from('price_watches').insert(data.priceWatches);
  }

  if (data?.postPerformance && data.postPerformance.length > 0) {
    await client.from('post_performance').insert(data.postPerformance);
  }

  if (data?.tickerPerformance && data.tickerPerformance.length > 0) {
    await client.from('ticker_performance').insert(data.tickerPerformance);
  }
}

/**
 * Verifies that the local Supabase instance is running and accessible
 */
export async function verifySupabaseConnection(): Promise<boolean> {
  try {
    const client = createTestSupabaseClient();
    const { error } = await client.from('app_meta').select('key').limit(1);
    return !error;
  } catch (error) {
    return false;
  }
}

/**
 * Setup function to run before each test
 */
export async function setupTestDatabase(seedData?: Parameters<typeof seedTestDatabase>[1]): Promise<SupabaseClient> {
  const client = createTestSupabaseClient();
  await clearTestDatabase(client);
  if (seedData) {
    await seedTestDatabase(client, seedData);
  }
  return client;
}

/**
 * Teardown function to run after each test
 */
export async function teardownTestDatabase(client: SupabaseClient): Promise<void> {
  await clearTestDatabase(client);
}

