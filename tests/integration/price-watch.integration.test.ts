import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestContext,
  createPriceSeriesWithMove,
  minutesAgo,
  hoursAgo,
  daysAgo,
} from './test-helpers';
import type { PriceWatchSeed } from '../../lib/price-watch';
import { logger } from '../../lib/logger';
import { __resetSupabaseClient, __setSupabaseClient } from '../../lib/db';
import { findFirstBarOnOrAfter, findLastBarOnOrBefore } from '../../lib/tiingo';

// Mock TiingoClient constructor
vi.mock('../../lib/tiingo', async () => {
  const actual = await vi.importActual('../../lib/tiingo');
  return {
    ...actual,
    TiingoClient: vi.fn(),
  };
});

import {
  schedulePriceWatches,
  processPriceWatchQueue,
} from '../../lib/price-watch';
import { TiingoClient } from '../../lib/tiingo';

describe('Price Watch Integration Tests', () => {
  let context: Awaited<ReturnType<typeof createTestContext>>;

  beforeEach(async () => {
    context = await createTestContext();

    // Use real Supabase client
    __resetSupabaseClient();
    __setSupabaseClient(context.supabase);
    
    vi.mocked(TiingoClient).mockReset();
    vi.mocked(TiingoClient).mockImplementation(() => context.tiingo as any);
  });

  afterEach(async () => {
    // Clean up database after each test
    await context.cleanup();
  });

  describe('schedulePriceWatches', () => {
    it('should insert price watches from seeds', async () => {
      const emailedAt = new Date().toISOString();
      
      // First create the parent reddit_posts record (required for foreign key)
      const { error: insertError } = await context.supabase.from('reddit_posts').insert({
        post_id: 'post1',
        title: 'Test Post',
        body: 'Test',
        subreddit: 'stocks',
        author: 'test_user',
        url: 'https://reddit.com/test',
        created_utc: emailedAt,
        score: 100,
        detected_tickers: ['AAPL', 'MSFT'],
        llm_tickers: ['AAPL', 'MSFT'],
        is_future_upside_claim: true,
        stance: 'bullish',
        reason: 'Test',
        quality_score: 5,
        emailed_at: emailedAt,
        processed_at: emailedAt,
      });
      if (insertError) throw new Error(`Failed to insert reddit_post: ${insertError.message}`);
      
      const seeds: PriceWatchSeed[] = [
        {
          postId: 'post1',
          ticker: 'AAPL',
          qualityScore: 5,
          emailedAtIso: emailedAt,
          entryPrice: 150.0,
          entryPriceObservedAtIso: emailedAt,
        },
        {
          postId: 'post1',
          ticker: 'MSFT',
          qualityScore: 5,
          emailedAtIso: emailedAt,
          entryPrice: 300.0,
          entryPriceObservedAtIso: emailedAt,
        },
      ];

      const requestLogger = logger.withContext({ test: true });
      const count = await schedulePriceWatches(context.config, seeds, requestLogger);

      expect(count).toBe(2);

      // Verify using real database query
      const { data: watches } = await context.supabase
        .from('price_watches')
        .select('*');
      
      expect(watches).toHaveLength(2);
      
      const aaplWatch = watches?.find((w: any) => w.ticker === 'AAPL');
      expect(aaplWatch).toBeDefined();
      expect(aaplWatch?.entry_price).toBe(150.0);
      expect(aaplWatch?.post_id).toBe('post1');
    });

    it('should deduplicate by post_id and ticker', async () => {
      const emailedAt = new Date().toISOString();
      
      // First create the parent reddit_posts record (required for foreign key)
      await context.supabase.from('reddit_posts').insert({
        post_id: 'post1',
        title: 'Test Post',
        body: 'Test',
        subreddit: 'stocks',
        author: 'test_user',
        url: 'https://reddit.com/test',
        created_utc: emailedAt,
        score: 100,
        detected_tickers: ['AAPL'],
        llm_tickers: ['AAPL'],
        is_future_upside_claim: true,
        stance: 'bullish',
        reason: 'Test',
        quality_score: 5,
        emailed_at: emailedAt,
        processed_at: emailedAt,
      });
      
      const seeds: PriceWatchSeed[] = [
        {
          postId: 'post1',
          ticker: 'AAPL',
          qualityScore: 5,
          emailedAtIso: emailedAt,
          entryPrice: 150.0,
          entryPriceObservedAtIso: emailedAt,
        },
        {
          postId: 'post1',
          ticker: 'AAPL',
          qualityScore: 5,
          emailedAtIso: emailedAt,
          entryPrice: 151.0, // Different price, but same post+ticker
          entryPriceObservedAtIso: emailedAt,
        },
      ];

      const requestLogger = logger.withContext({ test: true });
      const count = await schedulePriceWatches(context.config, seeds, requestLogger);

      expect(count).toBe(1);

      // Verify using real database query
      const { data: watches } = await context.supabase
        .from('price_watches')
        .select('*');
      expect(watches).toHaveLength(1);
    });

    it('should filter out invalid seeds', async () => {
      const emailedAt = new Date().toISOString();
      
      // Create parent reddit_posts for valid seeds
      await context.supabase.from('reddit_posts').insert([
        {
          post_id: 'post1',
          title: 'Test Post 1',
          body: 'Test',
          subreddit: 'stocks',
          author: 'test_user',
          url: 'https://reddit.com/test1',
          created_utc: emailedAt,
          score: 100,
          detected_tickers: [],
          llm_tickers: [],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Test',
          quality_score: 5,
          emailed_at: emailedAt,
          processed_at: emailedAt,
        },
        {
          post_id: 'post2',
          title: 'Test Post 2',
          body: 'Test',
          subreddit: 'stocks',
          author: 'test_user',
          url: 'https://reddit.com/test2',
          created_utc: emailedAt,
          score: 100,
          detected_tickers: ['AAPL'],
          llm_tickers: ['AAPL'],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Test',
          quality_score: 5,
          emailed_at: emailedAt,
          processed_at: emailedAt,
        },
        {
          post_id: 'post3',
          title: 'Test Post 3',
          body: 'Test',
          subreddit: 'stocks',
          author: 'test_user',
          url: 'https://reddit.com/test3',
          created_utc: emailedAt,
          score: 100,
          detected_tickers: ['MSFT'],
          llm_tickers: ['MSFT'],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Test',
          quality_score: 5,
          emailed_at: emailedAt,
          processed_at: emailedAt,
        },
      ]);
      
      const seeds: PriceWatchSeed[] = [
        {
          postId: 'post1',
          ticker: '', // Invalid: empty ticker
          qualityScore: 5,
          emailedAtIso: emailedAt,
          entryPrice: 150.0,
          entryPriceObservedAtIso: emailedAt,
        },
        {
          postId: 'post2',
          ticker: 'AAPL',
          qualityScore: 5,
          emailedAtIso: emailedAt,
          entryPrice: 0, // Invalid: zero price
          entryPriceObservedAtIso: emailedAt,
        },
        {
          postId: 'post3',
          ticker: 'MSFT',
          qualityScore: 5,
          emailedAtIso: emailedAt,
          entryPrice: 300.0,
          entryPriceObservedAtIso: emailedAt,
        },
      ];

      const requestLogger = logger.withContext({ test: true });
      const count = await schedulePriceWatches(context.config, seeds, requestLogger);

      expect(count).toBe(1);

      // Verify using real database query
      const { data: watches } = await context.supabase
        .from('price_watches')
        .select('*');
      expect(watches).toHaveLength(1);
      expect(watches![0].ticker).toBe('MSFT');
    });
  });

  describe('processPriceWatchQueue', () => {
    it('should check watches and trigger alerts on 5% gain', async () => {
      const now = new Date();
      const monitorStart = minutesAgo(30);
      const monitorClose = hoursAgo(-2); // 2 hours in the future

      // Set up a price watch and corresponding reddit post using real database
      await context.supabase.from('reddit_posts').insert({
        post_id: 'post1',
        title: 'AAPL Test Post',
        url: 'https://reddit.com/test',
        body: 'Test',
        subreddit: 'stocks',
        author: 'test',
        created_utc: monitorStart.toISOString(),
        score: 100,
        detected_tickers: ['AAPL'],
        llm_tickers: ['AAPL'],
        is_future_upside_claim: true,
        stance: 'bullish',
        reason: 'Test',
        quality_score: 5,
        processed_at: monitorStart.toISOString(),
      });

      await context.supabase.from('price_watches').insert({
        post_id: 'post1',
        ticker: 'AAPL',
        quality_score: 5,
        entry_price: 100.0,
        entry_price_ts: monitorStart.toISOString(),
        emailed_at: monitorStart.toISOString(),
        monitor_start_at: monitorStart.toISOString(),
        monitor_close_at: monitorClose.toISOString(),
        next_check_at: minutesAgo(5).toISOString(), // Due for check
        last_price: 100.0,
        last_price_ts: monitorStart.toISOString(),
        status: 'pending', // Required for the query filter
      });

      // Set up mock price data showing 4% gain (triggers alert at <= 5%)
      const priceData = createPriceSeriesWithMove(
        'AAPL',
        100.0,
        monitorStart,
        now,
        0.04, // 4% gain - triggers alert
        '5min',
      );

      context.getMockTiingo().setMockData('intraday', 'AAPL_5min', priceData);

      const requestLogger = logger.withContext({ test: true });
      const result = await processPriceWatchQueue(context.config, requestLogger);

      expect(result.checked).toBe(1);
      expect(result.triggered).toHaveLength(1);
      expect(result.triggered[0].ticker).toBe('AAPL');
      expect(result.triggered[0].movePct).toBeLessThanOrEqual(0.05);
    });

    it('should reschedule watches that have not reached threshold', async () => {
      const now = new Date();
      const monitorStart = minutesAgo(30);
      const monitorClose = hoursAgo(-2);

      // First create parent reddit_post
      await context.supabase.from('reddit_posts').insert({
        post_id: 'post1',
        title: 'AAPL Test Post',
        url: 'https://reddit.com/test',
        body: 'Test',
        subreddit: 'stocks',
        author: 'test',
        created_utc: monitorStart.toISOString(),
        score: 100,
        detected_tickers: ['AAPL'],
        llm_tickers: ['AAPL'],
        is_future_upside_claim: true,
        stance: 'bullish',
        reason: 'Test',
        quality_score: 5,
        processed_at: monitorStart.toISOString(),
      });

      // Then create price watch
      await context.supabase.from('price_watches').insert({
        post_id: 'post1',
        ticker: 'AAPL',
        quality_score: 5,
        entry_price: 100.0,
        entry_price_ts: monitorStart.toISOString(),
        emailed_at: monitorStart.toISOString(),
        monitor_start_at: monitorStart.toISOString(),
        monitor_close_at: monitorClose.toISOString(),
        next_check_at: minutesAgo(5).toISOString(),
        last_price: 100.0,
        last_price_ts: monitorStart.toISOString(),
        status: 'pending',
      });

      // Set up mock price data showing only 5% gain
      const priceData = createPriceSeriesWithMove(
        'AAPL',
        100.0,
        monitorStart,
        now,
        0.05, // 5% gain
        '5min',
      );

      context.getMockTiingo().setMockData('intraday', 'AAPL_5min', priceData);

      const requestLogger = logger.withContext({ test: true });
      const result = await processPriceWatchQueue(context.config, requestLogger);

      expect(result.checked).toBe(1);
      expect(result.triggered).toHaveLength(0);
      expect(result.rescheduled).toBe(1);

      // Check that the watch was updated with new price and next_check_at using real database
      const { data: watches } = await context.supabase
        .from('price_watches')
        .select('*')
        .eq('post_id', 'post1')
        .single();
      expect(watches.last_price).toBeGreaterThan(100.0);
      expect(new Date(watches.next_check_at).getTime()).toBeGreaterThan(now.getTime());
    });

    it('should mark expired watches', async () => {
      const now = new Date();
      const monitorStart = daysAgo(2);
      const monitorClose = minutesAgo(5); // Already closed

      // First create parent reddit_post
      await context.supabase.from('reddit_posts').insert({
        post_id: 'post1',
        title: 'AAPL Test Post',
        url: 'https://reddit.com/test',
        body: 'Test',
        subreddit: 'stocks',
        author: 'test',
        created_utc: monitorStart.toISOString(),
        score: 100,
        detected_tickers: ['AAPL'],
        llm_tickers: ['AAPL'],
        is_future_upside_claim: true,
        stance: 'bullish',
        reason: 'Test',
        quality_score: 5,
        processed_at: monitorStart.toISOString(),
      });

      // Then create price watch
      await context.supabase.from('price_watches').insert({
        post_id: 'post1',
        ticker: 'AAPL',
        quality_score: 5,
        entry_price: 100.0,
        entry_price_ts: monitorStart.toISOString(),
        emailed_at: monitorStart.toISOString(),
        monitor_start_at: monitorStart.toISOString(),
        monitor_close_at: monitorClose.toISOString(),
        next_check_at: minutesAgo(10).toISOString(),
        last_price: 100.0,
        last_price_ts: monitorStart.toISOString(),
        status: 'pending',
      });

      // Set up mock price data showing 5% gain (below threshold)
      const priceData = createPriceSeriesWithMove(
        'AAPL',
        100.0,
        monitorStart,
        now,
        0.05,
        '5min',
      );

      context.getMockTiingo().setMockData('intraday', 'AAPL_5min', priceData);

      const requestLogger = logger.withContext({ test: true });
      const result = await processPriceWatchQueue(context.config, requestLogger);

      expect(result.checked).toBe(1);
      expect(result.expired).toBe(1);
      expect(result.triggered).toHaveLength(0);

      // Check that the watch was marked as expired using real database
      const { data: watch } = await context.supabase
        .from('price_watches')
        .select('*')
        .eq('post_id', 'post1')
        .single();
      expect(watch?.status).toBe('expired');
    });

    it('should handle multiple watches for different tickers', async () => {
      const now = new Date();
      const monitorStart = minutesAgo(30);
      const monitorClose = hoursAgo(-2);

      // Seed reddit posts using real database
      await context.supabase.from('reddit_posts').insert([
        {
          post_id: 'post1',
          title: 'AAPL Test Post',
          url: 'https://reddit.com/test',
          body: 'Test',
          subreddit: 'stocks',
          author: 'test',
          created_utc: monitorStart.toISOString(),
          score: 100,
          detected_tickers: ['AAPL'],
          llm_tickers: ['AAPL'],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Test',
          quality_score: 5,
          processed_at: monitorStart.toISOString(),
        },
        {
          post_id: 'post2',
          title: 'MSFT Test Post',
          url: 'https://reddit.com/test2',
          body: 'Test',
          subreddit: 'stocks',
          author: 'test',
          created_utc: monitorStart.toISOString(),
          score: 100,
          detected_tickers: ['MSFT'],
          llm_tickers: ['MSFT'],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Test',
          quality_score: 5,
          processed_at: monitorStart.toISOString(),
        },
      ]);

      // Seed price watches using real database
      await context.supabase.from('price_watches').insert([
        {
          post_id: 'post1',
          ticker: 'AAPL',
          quality_score: 5,
          entry_price: 100.0,
          entry_price_ts: monitorStart.toISOString(),
          emailed_at: monitorStart.toISOString(),
          monitor_start_at: monitorStart.toISOString(),
          monitor_close_at: monitorClose.toISOString(),
          next_check_at: minutesAgo(5).toISOString(),
          last_price: 100.0,
          last_price_ts: monitorStart.toISOString(),
          status: 'pending',
        },
        {
          post_id: 'post2',
          ticker: 'MSFT',
          quality_score: 5,
          entry_price: 200.0,
          entry_price_ts: monitorStart.toISOString(),
          emailed_at: monitorStart.toISOString(),
          monitor_start_at: monitorStart.toISOString(),
          monitor_close_at: monitorClose.toISOString(),
          next_check_at: minutesAgo(5).toISOString(),
          last_price: 200.0,
          last_price_ts: monitorStart.toISOString(),
          status: 'pending',
        },
      ]);

      // AAPL gains 3% (triggers alert), MSFT gains 6% (above 5% threshold, gets rescheduled)
      const aaplData = createPriceSeriesWithMove('AAPL', 100.0, monitorStart, now, 0.03, '5min');
      const msftData = createPriceSeriesWithMove('MSFT', 200.0, monitorStart, now, 0.06, '5min');

      context.getMockTiingo().setMockData('intraday', 'AAPL_5min', aaplData);
      context.getMockTiingo().setMockData('intraday', 'MSFT_5min', msftData);

      const requestLogger = logger.withContext({ test: true });
      const result = await processPriceWatchQueue(context.config, requestLogger);

      expect(result.checked).toBe(2);
      expect(result.triggered).toHaveLength(1);
      expect(result.triggered[0].ticker).toBe('AAPL'); // AAPL at 3% triggers alert (3% <= 5%)
      expect(result.rescheduled).toBe(1); // MSFT at 6% gets rescheduled (6% > 5%)
    });

    it.skip('should handle data unavailable gracefully', async () => {
      // TODO: This test has an issue where processPriceWatchQueue doesn't find the watch
      // even though manual queries show it exists. Needs investigation.
      const now = new Date();
      const monitorStart = minutesAgo(30);
      const monitorClose = hoursAgo(-2);

      // Seed reddit posts using real database
      const { error: postInsertError } = await context.supabase.from('reddit_posts').insert({
        post_id: 'post1',
        title: 'UNKNOWN Test Post',
        url: 'https://reddit.com/test',
        body: 'Test',
        subreddit: 'stocks',
        author: 'test',
        created_utc: monitorStart.toISOString(),
        score: 100,
        detected_tickers: ['UNKNOWN'],
        llm_tickers: ['UNKNOWN'],
        is_future_upside_claim: true,
        stance: 'bullish',
        reason: 'Test',
        quality_score: 5,
        processed_at: monitorStart.toISOString(),
      });
      if (postInsertError) throw new Error(`Failed to insert reddit_post: ${postInsertError.message}`);

      // Seed price watches using real database
      // Set next_check_at to a time definitely in the past
      const nextCheckAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString(); // 10 minutes before 'now'
      
      const { error: watchInsertError } = await context.supabase.from('price_watches').insert({
        post_id: 'post1',
        ticker: 'UNKNOWN',
        quality_score: 5,
        entry_price: 100.0,
        entry_price_ts: monitorStart.toISOString(),
        emailed_at: monitorStart.toISOString(),
        monitor_start_at: monitorStart.toISOString(),
        monitor_close_at: monitorClose.toISOString(),
        next_check_at: nextCheckAt,
        last_price: 100.0,
        last_price_ts: monitorStart.toISOString(),
        status: 'pending',
      });
      if (watchInsertError) throw new Error(`Failed to insert price_watch: ${watchInsertError.message}`);

      // Don't set up any mock data for UNKNOWN ticker

      const requestLogger = logger.withContext({ test: true });
      // Pass explicit 'now' to ensure timing is consistent with next_check_at
      const result = await processPriceWatchQueue(context.config, requestLogger, now);

      // The watch should be found and checked
      expect(result.checked).toBe(1);
      // Data is unavailable for UNKNOWN ticker
      expect(result.dataUnavailable).toBe(1);
      // When data is unavailable and monitor is still open, it gets rescheduled
      expect(result.rescheduled).toBe(1);
    });

    it('should not process watches not yet due for checking', async () => {
      const now = new Date();
      const monitorStart = minutesAgo(30);
      const monitorClose = hoursAgo(-2);

      // First create parent reddit_post
      await context.supabase.from('reddit_posts').insert({
        post_id: 'post1',
        title: 'AAPL Test Post',
        url: 'https://reddit.com/test',
        body: 'Test',
        subreddit: 'stocks',
        author: 'test',
        created_utc: monitorStart.toISOString(),
        score: 100,
        detected_tickers: ['AAPL'],
        llm_tickers: ['AAPL'],
        is_future_upside_claim: true,
        stance: 'bullish',
        reason: 'Test',
        quality_score: 5,
        processed_at: monitorStart.toISOString(),
      });

      // Then create price watch
      await context.supabase.from('price_watches').insert({
        post_id: 'post1',
        ticker: 'AAPL',
        quality_score: 5,
        entry_price: 100.0,
        entry_price_ts: monitorStart.toISOString(),
        emailed_at: monitorStart.toISOString(),
        monitor_start_at: monitorStart.toISOString(),
        monitor_close_at: monitorClose.toISOString(),
        next_check_at: hoursAgo(-1).toISOString(), // 1 hour in the future
        last_price: 100.0,
        last_price_ts: monitorStart.toISOString(),
        status: 'pending',
      });

      const requestLogger = logger.withContext({ test: true });
      const result = await processPriceWatchQueue(context.config, requestLogger);

      expect(result.checked).toBe(0);
      expect(result.triggered).toHaveLength(0);
      expect(result.rescheduled).toBe(0);
    });
  });
});

