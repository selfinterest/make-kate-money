import type { Config } from '../../lib/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestSupabaseClient, setupTestDatabase, teardownTestDatabase } from '../setup-test-db';
import { createMockTiingoClient, type MockTiingoData } from '../__mocks__/tiingo-mock';
import { createMockRedditClient, type MockRedditPost } from '../__mocks__/reddit-mock';

/**
 * Creates a test configuration with sensible defaults for integration tests
 * Uses local Supabase instance running on port 54321
 */
export function createTestConfig(overrides?: Partial<Config>): Config {
  return {
    reddit: {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      username: 'test_username',
      password: 'test_password',
      userAgent: 'Test Reddit Bot v1.0',
      ...overrides?.reddit,
    },
    supabase: {
      // Point to local Supabase instance (127.0.0.1)
      url: process.env.SUPABASE_URL || 'http://127.0.0.1:54321',
      // Standard local Supabase service_role key (same for all local installations)
      // This is NOT a secret - it's the default demo key documented by Supabase
      // See: https://supabase.com/docs/guides/local-development
      apiKey: process.env.SUPABASE_SERVICE_ROLE_KEY || 
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
      ...overrides?.supabase,
    },
    llm: {
      provider: 'openai',
      openaiApiKey: 'test_openai_key',
      ...overrides?.llm,
    },
    marketData: {
      tiingoApiKey: 'test_tiingo_key',
      ...overrides?.marketData,
    },
    email: {
      resendApiKey: 'test_resend_key',
      from: 'test@example.com',
      to: 'recipient@example.com',
      ...overrides?.email,
    },
    app: {
      subreddits: ['stocks', 'investing'],
      cronWindowMinutes: 5,
      llmBatchSize: 10,
      llmMaxBodyChars: 2000,
      minScoreForLlm: 1,
      qualityThreshold: 3,
      maxPostsPerRun: 100,
      minVotesPerMinuteForLlm: 0.5,
      maxPriceMovePctForAlert: 0.07,
      ...overrides?.app,
    },
  };
}

/**
 * Test context that holds all clients and test data
 * Uses REAL Supabase for database operations, mocks for external APIs
 */
export interface TestContext {
  config: Config;
  supabase: SupabaseClient;
  tiingo: ReturnType<typeof createMockTiingoClient>;
  reddit: ReturnType<typeof createMockRedditClient>;
  // Access to mock implementations for advanced testing
  getMockTiingo: () => ReturnType<typeof createMockTiingoClient>;
  getMockReddit: () => ReturnType<typeof createMockRedditClient>;
  // Cleanup function
  cleanup: () => Promise<void>;
}

/**
 * Creates a complete test context with real Supabase and mock external services
 * 
 * @param options.seedData - Optional initial database state
 * @param options.config - Optional config overrides
 * @param options.tiingoData - Optional mock Tiingo data
 * @param options.redditPosts - Optional mock Reddit posts
 */
export async function createTestContext(options?: {
  config?: Partial<Config>;
  seedData?: Parameters<typeof setupTestDatabase>[0];
  tiingoData?: Partial<MockTiingoData>;
  redditPosts?: MockRedditPost[];
}): Promise<TestContext> {
  const config = createTestConfig(options?.config);
  
  // Setup real Supabase with clean database
  const supabase = await setupTestDatabase(options?.seedData);
  
  // Create mock clients for external services
  const tiingo = createMockTiingoClient(options?.tiingoData);
  const reddit = createMockRedditClient(options?.redditPosts);

  return {
    config,
    supabase,
    tiingo,
    reddit,
    getMockTiingo: () => tiingo,
    getMockReddit: () => reddit,
    cleanup: async () => {
      await teardownTestDatabase(supabase);
    },
  };
}

/**
 * Helper to create a timestamp N days ago
 */
export function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

/**
 * Helper to create a timestamp N hours ago
 */
export function hoursAgo(hours: number): Date {
  const date = new Date();
  date.setHours(date.getHours() - hours);
  return date;
}

/**
 * Helper to create a timestamp N minutes ago
 */
export function minutesAgo(minutes: number): Date {
  const date = new Date();
  date.setMinutes(date.getMinutes() - minutes);
  return date;
}

/**
 * Helper to create a test Reddit post
 */
export function createTestPost(overrides?: {
  id?: string;
  title?: string;
  selftext?: string;
  subreddit?: string;
  author?: string;
  score?: number;
  createdUtc?: Date;
  tickers?: string[];
}): MockRedditPost {
  const createdUtc = overrides?.createdUtc || new Date();
  const id = overrides?.id || `test_${Math.random().toString(36).substr(2, 9)}`;

  let title = overrides?.title;
  let selftext = overrides?.selftext;

  // If tickers are provided, inject them into the title/body
  if (overrides?.tickers && overrides.tickers.length > 0) {
    const tickersStr = overrides.tickers.map(t => `$${t}`).join(' ');
    title = title || `Test post about ${tickersStr}`;
    selftext = selftext || `This is a test post discussing ${tickersStr}. I expect these stocks to go up based on recent catalysts.`;
  }

  return {
    id,
    title: title || 'Test Post',
    selftext: selftext || 'Test post body.',
    subreddit: overrides?.subreddit || 'stocks',
    author: overrides?.author || 'test_user',
    permalink: `/r/${overrides?.subreddit || 'stocks'}/comments/${id}/test/`,
    created_utc: Math.floor(createdUtc.getTime() / 1000),
    score: overrides?.score !== undefined ? overrides.score : 10,
  };
}

/**
 * Helper to wait for async operations in tests
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper to create sample intraday price data with a specific price movement
 */
export function createPriceSeriesWithMove(
  ticker: string,
  startPrice: number,
  startTime: Date,
  endTime: Date,
  percentMove: number,
  frequency: '1min' | '5min' = '5min',
): Array<{
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> {
  const bars: Array<any> = [];
  const frequencyMs = frequency === '1min' ? 60000 : 300000;
  const totalBars = Math.floor((endTime.getTime() - startTime.getTime()) / frequencyMs);
  const priceStep = (startPrice * percentMove) / totalBars;

  let currentTime = startTime.getTime();
  let currentPrice = startPrice;

  for (let i = 0; i <= totalBars; i++) {
    const open = currentPrice;
    currentPrice += priceStep;
    const close = currentPrice;
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;

    bars.push({
      timestamp: new Date(currentTime).toISOString(),
      open,
      high,
      low,
      close,
      volume: Math.floor(Math.random() * 100000 + 50000),
    });

    currentTime += frequencyMs;
  }

  return bars;
}

/**
 * Helper to verify that a mock client method was called
 */
export function mockMethodCallCount(mockObj: any, methodName: string): number {
  return mockObj[methodName]?.mock?.calls?.length || 0;
}

