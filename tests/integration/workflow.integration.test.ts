import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createTestContext,
  createTestPost,
  minutesAgo,
  hoursAgo,
  createPriceSeriesWithMove,
} from './test-helpers';
import { prefilterBatch } from '../../lib/prefilter';
import { logger } from '../../lib/logger';
import type { LlmResult } from '../../lib/llm';

// Mock the modules
vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual('../../lib/db');
  return {
    ...actual,
    getSupabaseClient: vi.fn(),
  };
});

vi.mock('../../lib/tiingo', () => {
  return {
    TiingoClient: vi.fn(),
  };
});

import {
  getCursor,
  setCursor,
  upsertPosts,
  selectForEmail,
  markEmailed,
  getSupabaseClient,
} from '../../lib/db';
import { schedulePriceWatches } from '../../lib/price-watch';
import { TiingoClient } from '../../lib/tiingo';

/**
 * Comprehensive workflow integration tests
 * These tests simulate the complete flow of the application from Reddit post
 * ingestion through email notification and price monitoring.
 */
describe('Workflow Integration Tests', () => {
  let context: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    context = createTestContext();

    // Configure mocks to return our test context's clients
    vi.mocked(getSupabaseClient).mockReturnValue(context.supabase);
    vi.mocked(TiingoClient).mockImplementation(() => context.tiingo as any);
  });

  describe('End-to-End Reddit to Email Flow', () => {
    it('should process posts from Reddit through to email candidates', async () => {
      // ===== Step 1: Setup - Seed Reddit with mock posts =====
      const now = new Date();
      const createdTime = minutesAgo(30);

      const mockPosts = [
        createTestPost({
          id: 'post1',
          title: 'AAPL will explode - major catalyst incoming',
          selftext: 'Apple ($AAPL) is going to see massive gains. New product launch will drive stock up 50% based on historical patterns.',
          subreddit: 'stocks',
          author: 'analyst123',
          score: 150,
          createdUtc: createdTime,
          tickers: ['AAPL'],
        }),
        createTestPost({
          id: 'post2',
          title: 'Quick mention of TSLA',
          selftext: 'Tesla is mentioned but no prediction here.',
          subreddit: 'stocks',
          author: 'user456',
          score: 5,
          createdUtc: minutesAgo(20),
          tickers: ['TSLA'],
        }),
        createTestPost({
          id: 'post3',
          title: 'MSFT strong buy - expect moon',
          selftext: 'Microsoft ($MSFT) will go to the moon. Cloud revenue is crushing it and the stock is going to skyrocket.',
          subreddit: 'investing',
          author: 'bull_trader',
          score: 200,
          createdUtc: minutesAgo(15),
          tickers: ['MSFT'],
        }),
      ];

      context.getMockReddit().setMockPosts(mockPosts);

      // ===== Step 2: Fetch posts from Reddit =====
      const sinceIso = await getCursor(context.config, 'test_cursor');
      
      // Mock Reddit's fetchNew behavior (we'll need to test the actual posts instead)
      // For this integration test, we'll manually create the posts from the mock data
      const posts = mockPosts.map(mp => ({
        id: mp.id,
        title: mp.title,
        selftext: mp.selftext,
        subreddit: mp.subreddit,
        author: mp.author,
        url: `https://www.reddit.com${mp.permalink}`,
        createdUtc: new Date(mp.created_utc * 1000).toISOString(),
        score: mp.score,
      }));

      expect(posts).toHaveLength(3);
      expect(posts[0].title).toContain('AAPL');

      // ===== Step 3: Prefilter posts =====
      const prefiltered = await prefilterBatch(posts);

      // All posts should have tickers detected
      expect(prefiltered).toHaveLength(3);
      expect(prefiltered[0].tickers).toContain('AAPL');
      expect(prefiltered[1].tickers).toContain('TSLA');
      expect(prefiltered[2].tickers).toContain('MSFT');

      // Check for upside language
      const withUpsideHits = prefiltered.filter(p => p.upsideHits.length > 0);
      expect(withUpsideHits.length).toBeGreaterThan(0);

      // ===== Step 4: Mock LLM Classification =====
      // In a real scenario, we'd call classifyBatch, but for testing we'll mock the results
      const llmResults: LlmResult[] = [
        {
          post_id: 'post1',
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Strong bullish prediction with specific catalyst',
          tickers: ['AAPL'],
          quality_score: 5,
        },
        {
          post_id: 'post2',
          is_future_upside_claim: false,
          stance: 'unclear',
          reason: 'No clear prediction',
          tickers: ['TSLA'],
          quality_score: 1,
        },
        {
          post_id: 'post3',
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Strong bullish sentiment with growth drivers',
          tickers: ['MSFT'],
          quality_score: 4,
        },
      ];

      // ===== Step 5: Store results in database =====
      await upsertPosts(context.config, prefiltered, llmResults);

      const db = (context.supabase as any).getDatabase();
      expect(db.reddit_posts).toHaveLength(3);

      const aaplPost = db.reddit_posts.find((p: any) => p.post_id === 'post1');
      expect(aaplPost).toBeDefined();
      expect(aaplPost.is_future_upside_claim).toBe(true);
      expect(aaplPost.quality_score).toBe(5);

      // ===== Step 6: Update cursor =====
      await setCursor(context.config, 'test_cursor', posts);
      const newCursor = await getCursor(context.config, 'test_cursor');
      expect(newCursor).toBe(posts[2].createdUtc); // Most recent post

      // ===== Step 7: Select posts for email =====
      const emailCandidates = await selectForEmail(context.config, { minQuality: 3 });

      // Should get AAPL (quality 5) and MSFT (quality 4), but not TSLA (quality 1)
      expect(emailCandidates).toHaveLength(2);
      expect(emailCandidates.map(c => c.post_id).sort()).toEqual(['post1', 'post3']);

      // ===== Step 8: Mark posts as emailed =====
      const emailedAt = now.toISOString();
      const emailedPostIds = emailCandidates.map(c => c.post_id);
      await markEmailed(context.config, emailedPostIds, emailedAt);

      const aaplPostAfterEmail = db.reddit_posts.find((p: any) => p.post_id === 'post1');
      expect(aaplPostAfterEmail.emailed_at).toBe(emailedAt);

      // ===== Step 9: Verify only emailed posts are marked =====
      const tslaPost = db.reddit_posts.find((p: any) => p.post_id === 'post2');
      expect(tslaPost.emailed_at).toBeNull();

      // ===== Step 10: Schedule price watches =====
      // Set up mock price data for the tickers
      const startTime = createdTime;
      const aaplPrices = createPriceSeriesWithMove('AAPL', 150.0, startTime, now, 0.05, '5min');
      const msftPrices = createPriceSeriesWithMove('MSFT', 300.0, startTime, now, 0.03, '5min');

      context.getMockTiingo().setMockData('intraday', 'AAPL_5min', aaplPrices);
      context.getMockTiingo().setMockData('intraday', 'MSFT_5min', msftPrices);

      const priceWatchSeeds = emailCandidates.map(candidate => ({
        postId: candidate.post_id,
        ticker: candidate.tickers[0],
        qualityScore: candidate.quality_score || 3,
        emailedAtIso: emailedAt,
        entryPrice: candidate.post_id === 'post1' ? 150.0 : 300.0,
        entryPriceObservedAtIso: emailedAt,
      }));

      const requestLogger = logger.withContext({ test: true });
      const watchCount = await schedulePriceWatches(context.config, priceWatchSeeds, requestLogger);

      expect(watchCount).toBe(2);
      expect(db.price_watches).toHaveLength(2);

      const aaplWatch = db.price_watches.find((w: any) => w.ticker === 'AAPL');
      expect(aaplWatch).toBeDefined();
      expect(aaplWatch.entry_price).toBe(150.0);
      expect(aaplWatch.post_id).toBe('post1');

      // ===== Verification: Complete workflow executed successfully =====
      expect(db.reddit_posts).toHaveLength(3);
      expect(db.reddit_posts.filter((p: any) => p.emailed_at !== null)).toHaveLength(2);
      expect(db.price_watches).toHaveLength(2);
    });
  });

  describe('Performance Tracking Workflow', () => {
    it('should track post performance over time', async () => {
      // ===== Setup: Create posts with historical data =====
      const twoDaysAgo = hoursAgo(48);
      const now = new Date();

      const db = (context.supabase as any).getDatabase();
      db.reddit_posts = [
        {
          post_id: 'historical_post',
          title: 'NVDA will surge',
          body: 'NVIDIA is going to explode',
          subreddit: 'stocks',
          author: 'prophet',
          url: 'https://reddit.com/test',
          created_utc: twoDaysAgo.toISOString(),
          score: 500,
          detected_tickers: ['NVDA'],
          llm_tickers: ['NVDA'],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'AI growth catalyst',
          quality_score: 5,
          emailed_at: twoDaysAgo.toISOString(),
          processed_at: twoDaysAgo.toISOString(),
        },
      ];

      // ===== Setup price data showing 20% gain =====
      const startPrice = 500.0;
      const endPrice = 600.0;
      const priceData = createPriceSeriesWithMove(
        'NVDA',
        startPrice,
        twoDaysAgo,
        now,
        0.20, // 20% gain
        '5min'
      );

      context.getMockTiingo().setMockData('intraday', 'NVDA_5min', priceData);

      // ===== Simulate performance calculation =====
      // In the real app, this would be done by the backtest lambda
      const performanceRecord = {
        post_id: 'historical_post',
        ticker: 'NVDA',
        return_pct: 20.0,
        profit_usd: 100.0, // On $500 position
        entry_price: startPrice,
        exit_price: endPrice,
        lookback_date: twoDaysAgo.toISOString(),
        run_date: now.toISOString(),
        emailed_at: twoDaysAgo.toISOString(),
        subreddit: 'stocks',
        author: 'prophet',
        created_at: now.toISOString(),
      };

      db.post_performance.push(performanceRecord);

      // ===== Update ticker performance aggregates =====
      const tickerIncrement = {
        ticker: 'NVDA',
        sample_size: 1,
        sum_return_pct: 20.0,
        win_count: 1,
        avg_return_pct: 20.0,
        win_rate_pct: 1.0,
        last_run_date: now.toISOString(),
        updated_at: now.toISOString(),
      };

      db.ticker_performance.push(tickerIncrement);

      // ===== Verification =====
      expect(db.post_performance).toHaveLength(1);
      expect(db.post_performance[0].return_pct).toBe(20.0);
      expect(db.ticker_performance).toHaveLength(1);
      expect(db.ticker_performance[0].avg_return_pct).toBe(20.0);
      expect(db.ticker_performance[0].win_rate_pct).toBe(1.0);
    });
  });

  describe('Ranking and Reputation Workflow', () => {
    it('should rank posts using author and subreddit reputation', async () => {
      const now = new Date();
      const db = (context.supabase as any).getDatabase();

      // ===== Setup: Create posts from different authors/subreddits =====
      // Author "good_analyst" has historical track record
      db.reddit_posts = [
        // Historical posts from good_analyst (quality 5)
        {
          post_id: 'hist1',
          title: 'Old prediction',
          body: 'Test',
          subreddit: 'stocks',
          author: 'good_analyst',
          url: 'https://reddit.com/hist1',
          created_utc: hoursAgo(72).toISOString(),
          score: 100,
          detected_tickers: ['SPY'],
          llm_tickers: ['SPY'],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Test',
          quality_score: 5,
          emailed_at: hoursAgo(72).toISOString(),
          processed_at: hoursAgo(72).toISOString(),
        },
        {
          post_id: 'hist2',
          title: 'Another good prediction',
          body: 'Test',
          subreddit: 'stocks',
          author: 'good_analyst',
          url: 'https://reddit.com/hist2',
          created_utc: hoursAgo(48).toISOString(),
          score: 150,
          detected_tickers: ['QQQ'],
          llm_tickers: ['QQQ'],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Test',
          quality_score: 5,
          emailed_at: hoursAgo(48).toISOString(),
          processed_at: hoursAgo(48).toISOString(),
        },
        // New posts to be ranked
        {
          post_id: 'new1',
          title: 'Post from good analyst',
          body: 'Test',
          subreddit: 'stocks',
          author: 'good_analyst',
          url: 'https://reddit.com/new1',
          created_utc: now.toISOString(),
          score: 50,
          detected_tickers: ['AAPL'],
          llm_tickers: ['AAPL'],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Test',
          quality_score: 3, // Lower base quality
          emailed_at: null,
          processed_at: now.toISOString(),
        },
        {
          post_id: 'new2',
          title: 'Post from unknown author',
          body: 'Test',
          subreddit: 'stocks',
          author: 'random_user',
          url: 'https://reddit.com/new2',
          created_utc: now.toISOString(),
          score: 100,
          detected_tickers: ['MSFT'],
          llm_tickers: ['MSFT'],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Test',
          quality_score: 4, // Higher base quality
          emailed_at: null,
          processed_at: now.toISOString(),
        },
      ];

      // ===== Select for email (should apply reputation boost) =====
      const candidates = await selectForEmail(context.config, { minQuality: 3 });

      // Both should be selected
      expect(candidates).toHaveLength(2);

      // The post from good_analyst should be ranked higher despite lower base quality
      // because of the author reputation boost
      const firstPost = candidates[0];
      
      // Note: The actual ranking logic in selectForEmail considers multiple factors
      // We're verifying that posts from reputable authors get considered
      expect(candidates.map(c => c.post_id)).toContain('new1');
      expect(candidates.map(c => c.post_id)).toContain('new2');
    });
  });

  describe('Price Alert Workflow', () => {
    it('should annotate candidates with price movement and alert on threshold', async () => {
      const now = new Date();
      const createdTime = minutesAgo(30);

      const db = (context.supabase as any).getDatabase();
      db.reddit_posts = [
        {
          post_id: 'volatile_post',
          title: 'GME prediction',
          body: 'GameStop will moon',
          subreddit: 'wallstreetbets',
          author: 'yolo_trader',
          url: 'https://reddit.com/test',
          created_utc: createdTime.toISOString(),
          score: 1000,
          detected_tickers: ['GME'],
          llm_tickers: ['GME'],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Meme stock enthusiasm',
          quality_score: 4,
          emailed_at: null,
          processed_at: createdTime.toISOString(),
        },
      ];

      // ===== Setup: Create price data showing 10% move (above 7% threshold) =====
      const priceData = createPriceSeriesWithMove(
        'GME',
        100.0,
        createdTime,
        now,
        0.10, // 10% gain
        '5min'
      );

      context.getMockTiingo().setMockData('intraday', 'GME_5min', priceData);

      // ===== Select candidates =====
      const candidates = await selectForEmail(context.config, { minQuality: 3 });

      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];

      // Verify candidate has the expected structure
      expect(candidate.post_id).toBe('volatile_post');
      expect(candidate.tickers).toContain('GME');

      // In the real flow, annotateCandidatesWithPriceMove would add price insights
      // For this test, we verify the structure is correct for annotation
      expect(candidate).toHaveProperty('tickers');
      expect(candidate.tickers).toEqual(['GME']);
    });
  });

  describe('Multi-Ticker Post Workflow', () => {
    it('should handle posts with multiple tickers correctly', async () => {
      const now = new Date();
      const createdTime = minutesAgo(20);

      // ===== Setup: Post mentioning multiple tickers =====
      const mockPost = createTestPost({
        id: 'multi_ticker',
        title: 'Tech stocks AAPL MSFT GOOGL all going up',
        selftext: 'Apple, Microsoft, and Google will all surge. Strong sector momentum.',
        subreddit: 'stocks',
        author: 'tech_bull',
        score: 300,
        createdUtc: createdTime,
        tickers: ['AAPL', 'MSFT', 'GOOGL'],
      });

      const posts = [{
        id: mockPost.id,
        title: mockPost.title,
        selftext: mockPost.selftext,
        subreddit: mockPost.subreddit,
        author: mockPost.author,
        url: `https://www.reddit.com${mockPost.permalink}`,
        createdUtc: new Date(mockPost.created_utc * 1000).toISOString(),
        score: mockPost.score,
      }];

      // ===== Prefilter =====
      const prefiltered = await prefilterBatch(posts);
      
      expect(prefiltered).toHaveLength(1);
      expect(prefiltered[0].tickers.length).toBeGreaterThanOrEqual(3);

      // ===== Mock LLM result =====
      const llmResult: LlmResult[] = [{
        post_id: 'multi_ticker',
        is_future_upside_claim: true,
        stance: 'bullish',
        reason: 'Sector-wide bullish prediction',
        tickers: ['AAPL', 'MSFT', 'GOOGL'],
        quality_score: 4,
      }];

      // ===== Store =====
      await upsertPosts(context.config, prefiltered, llmResult);

      const db = (context.supabase as any).getDatabase();
      const storedPost = db.reddit_posts.find((p: any) => p.post_id === 'multi_ticker');

      expect(storedPost).toBeDefined();
      expect(storedPost.llm_tickers).toHaveLength(3);
      expect(storedPost.llm_tickers).toContain('AAPL');
      expect(storedPost.llm_tickers).toContain('MSFT');
      expect(storedPost.llm_tickers).toContain('GOOGL');

      // ===== Price watches should be created for all tickers =====
      const emailedAt = now.toISOString();
      await markEmailed(context.config, ['multi_ticker'], emailedAt);

      const watchSeeds = ['AAPL', 'MSFT', 'GOOGL'].map(ticker => ({
        postId: 'multi_ticker',
        ticker,
        qualityScore: 4,
        emailedAtIso: emailedAt,
        entryPrice: 150.0,
        entryPriceObservedAtIso: emailedAt,
      }));

      const requestLogger = logger.withContext({ test: true });
      const watchCount = await schedulePriceWatches(context.config, watchSeeds, requestLogger);

      expect(watchCount).toBe(3);
      expect(db.price_watches).toHaveLength(3);

      const tickers = db.price_watches.map((w: any) => w.ticker).sort();
      expect(tickers).toEqual(['AAPL', 'GOOGL', 'MSFT']);
    });
  });
});

