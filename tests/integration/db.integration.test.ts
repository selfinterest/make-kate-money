import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestContext, createTestPost, daysAgo } from './test-helpers';
import type { Prefiltered } from '../../lib/prefilter';
import type { LlmResult } from '../../lib/llm';

// Mock the db module
vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual('../../lib/db');
  return {
    ...actual,
    getSupabaseClient: vi.fn(),
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

describe('Database Integration Tests', () => {
  let context: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    context = createTestContext();
    
    // Configure the mock to return our test context's supabase client
    vi.mocked(getSupabaseClient).mockReturnValue(context.supabase);
  });

  describe('getCursor and setCursor', () => {
    it('should return epoch time when cursor does not exist', async () => {
      const cursor = await getCursor(context.config, 'test_cursor');
      expect(cursor).toBe('1970-01-01T00:00:00Z');
    });

    it('should store and retrieve cursor', async () => {
      const posts = [
        { createdUtc: '2024-01-15T10:00:00Z' },
        { createdUtc: '2024-01-15T11:00:00Z' },
        { createdUtc: '2024-01-15T09:00:00Z' },
      ];

      await setCursor(context.config, 'test_cursor', posts);
      const cursor = await getCursor(context.config, 'test_cursor');

      // Should return the most recent timestamp
      expect(cursor).toBe('2024-01-15T11:00:00Z');
    });

    it('should update existing cursor', async () => {
      await setCursor(context.config, 'test_cursor', [
        { createdUtc: '2024-01-15T10:00:00Z' },
      ]);

      await setCursor(context.config, 'test_cursor', [
        { createdUtc: '2024-01-15T12:00:00Z' },
      ]);

      const cursor = await getCursor(context.config, 'test_cursor');
      expect(cursor).toBe('2024-01-15T12:00:00Z');
    });

    it('should handle empty posts array', async () => {
      await setCursor(context.config, 'test_cursor', []);
      const cursor = await getCursor(context.config, 'test_cursor');
      expect(cursor).toBe('1970-01-01T00:00:00Z');
    });
  });

  describe('upsertPosts', () => {
    it('should insert new posts with LLM results', async () => {
      const mockPost = createTestPost({
        id: 'post1',
        title: 'Test Post',
        tickers: ['AAPL', 'MSFT'],
      });

      const candidates: Prefiltered[] = [
        {
          post: {
            id: 'post1',
            title: 'Test Post',
            selftext: 'Test body',
            subreddit: 'stocks',
            author: 'test_user',
            url: 'https://reddit.com/test',
            createdUtc: new Date().toISOString(),
            score: 50,
          },
          tickers: ['AAPL', 'MSFT'],
          upsideHits: ['will go up'],
        },
      ];

      const llmResults: LlmResult[] = [
        {
          post_id: 'post1',
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Strong bullish sentiment',
          tickers: ['AAPL'],
          quality_score: 4,
        },
      ];

      await upsertPosts(context.config, candidates, llmResults);

      const db = (context.supabase as any).getDatabase();
      expect(db.reddit_posts).toHaveLength(1);
      expect(db.reddit_posts[0]).toMatchObject({
        post_id: 'post1',
        is_future_upside_claim: true,
        stance: 'bullish',
        quality_score: 4,
        llm_tickers: ['AAPL'],
      });
    });

    it('should update existing posts on conflict', async () => {
      const candidates: Prefiltered[] = [
        {
          post: {
            id: 'post1',
            title: 'Test Post',
            selftext: 'Test body',
            subreddit: 'stocks',
            author: 'test_user',
            url: 'https://reddit.com/test',
            createdUtc: new Date().toISOString(),
            score: 50,
          },
          tickers: ['AAPL'],
          upsideHits: ['will go up'],
        },
      ];

      const llmResults1: LlmResult[] = [
        {
          post_id: 'post1',
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'First analysis',
          tickers: ['AAPL'],
          quality_score: 3,
        },
      ];

      await upsertPosts(context.config, candidates, llmResults1);

      const llmResults2: LlmResult[] = [
        {
          post_id: 'post1',
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: 'Updated analysis',
          tickers: ['AAPL'],
          quality_score: 5,
        },
      ];

      await upsertPosts(context.config, candidates, llmResults2);

      const db = (context.supabase as any).getDatabase();
      expect(db.reddit_posts).toHaveLength(1);
      expect(db.reddit_posts[0].quality_score).toBe(5);
      expect(db.reddit_posts[0].reason).toBe('Updated analysis');
    });
  });

  describe('selectForEmail', () => {
    beforeEach(async () => {
      // Seed database with test posts
      const db = (context.supabase as any).getDatabase();
      db.reddit_posts = [
        {
          post_id: 'post1',
          title: 'High Quality Bullish Post',
          url: 'https://reddit.com/post1',
          reason: 'Strong catalyst',
          detected_tickers: ['AAPL'],
          llm_tickers: ['AAPL'],
          quality_score: 5,
          is_future_upside_claim: true,
          stance: 'bullish',
          emailed_at: null,
          created_utc: new Date().toISOString(),
          body: 'Test',
          subreddit: 'stocks',
          author: 'user1',
          score: 100,
          processed_at: new Date().toISOString(),
        },
        {
          post_id: 'post2',
          title: 'Low Quality Post',
          url: 'https://reddit.com/post2',
          reason: 'Weak signal',
          detected_tickers: ['TSLA'],
          llm_tickers: ['TSLA'],
          quality_score: 2,
          is_future_upside_claim: true,
          stance: 'bullish',
          emailed_at: null,
          created_utc: new Date().toISOString(),
          body: 'Test',
          subreddit: 'stocks',
          author: 'user2',
          score: 50,
          processed_at: new Date().toISOString(),
        },
        {
          post_id: 'post3',
          title: 'Already Emailed',
          url: 'https://reddit.com/post3',
          reason: 'Strong catalyst',
          detected_tickers: ['GOOGL'],
          llm_tickers: ['GOOGL'],
          quality_score: 5,
          is_future_upside_claim: true,
          stance: 'bullish',
          emailed_at: daysAgo(1).toISOString(),
          created_utc: new Date().toISOString(),
          body: 'Test',
          subreddit: 'stocks',
          author: 'user3',
          score: 200,
          processed_at: new Date().toISOString(),
        },
        {
          post_id: 'post4',
          title: 'Bearish Post',
          url: 'https://reddit.com/post4',
          reason: 'Bearish signal',
          detected_tickers: ['NFLX'],
          llm_tickers: ['NFLX'],
          quality_score: 4,
          is_future_upside_claim: true,
          stance: 'bearish',
          emailed_at: null,
          created_utc: new Date().toISOString(),
          body: 'Test',
          subreddit: 'stocks',
          author: 'user4',
          score: 150,
          processed_at: new Date().toISOString(),
        },
      ];
    });

    it('should select only bullish posts above quality threshold', async () => {
      const candidates = await selectForEmail(context.config, { minQuality: 3 });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].post_id).toBe('post1');
      expect(candidates[0].quality_score).toBe(5);
    });

    it('should exclude already emailed posts', async () => {
      const candidates = await selectForEmail(context.config, { minQuality: 3 });

      const postIds = candidates.map(c => c.post_id);
      expect(postIds).not.toContain('post3');
    });

    it('should respect quality threshold', async () => {
      const candidates = await selectForEmail(context.config, { minQuality: 5 });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].quality_score).toBe(5);
    });

    it('should order by created_utc ascending', async () => {
      const db = (context.supabase as any).getDatabase();
      
      // Add another high-quality post with earlier timestamp
      db.reddit_posts.push({
        post_id: 'post5',
        title: 'Earlier High Quality Post',
        url: 'https://reddit.com/post5',
        reason: 'Strong catalyst',
        detected_tickers: ['AMZN'],
        llm_tickers: ['AMZN'],
        quality_score: 5,
        is_future_upside_claim: true,
        stance: 'bullish',
        emailed_at: null,
        created_utc: daysAgo(2).toISOString(),
        body: 'Test',
        subreddit: 'stocks',
        author: 'user5',
        score: 100,
        processed_at: new Date().toISOString(),
      });

      const candidates = await selectForEmail(context.config, { minQuality: 3 });

      expect(candidates.length).toBeGreaterThan(1);
      // Earlier post should come first
      expect(candidates[0].post_id).toBe('post5');
    });
  });

  describe('markEmailed', () => {
    beforeEach(() => {
      const db = (context.supabase as any).getDatabase();
      db.reddit_posts = [
        {
          post_id: 'post1',
          title: 'Test Post 1',
          url: 'https://reddit.com/post1',
          emailed_at: null,
          body: '',
          subreddit: 'stocks',
          author: 'user1',
          score: 50,
          detected_tickers: [],
          llm_tickers: [],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: '',
          quality_score: 3,
          created_utc: new Date().toISOString(),
          processed_at: new Date().toISOString(),
        },
        {
          post_id: 'post2',
          title: 'Test Post 2',
          url: 'https://reddit.com/post2',
          emailed_at: null,
          body: '',
          subreddit: 'stocks',
          author: 'user2',
          score: 50,
          detected_tickers: [],
          llm_tickers: [],
          is_future_upside_claim: true,
          stance: 'bullish',
          reason: '',
          quality_score: 3,
          created_utc: new Date().toISOString(),
          processed_at: new Date().toISOString(),
        },
      ];
    });

    it('should mark posts as emailed with timestamp', async () => {
      const emailedAt = new Date().toISOString();
      await markEmailed(context.config, ['post1'], emailedAt);

      const db = (context.supabase as any).getDatabase();
      const post1 = db.reddit_posts.find((p: any) => p.post_id === 'post1');
      const post2 = db.reddit_posts.find((p: any) => p.post_id === 'post2');

      expect(post1.emailed_at).toBe(emailedAt);
      expect(post2.emailed_at).toBeNull();
    });

    it('should handle multiple post IDs', async () => {
      const emailedAt = new Date().toISOString();
      await markEmailed(context.config, ['post1', 'post2'], emailedAt);

      const db = (context.supabase as any).getDatabase();
      const post1 = db.reddit_posts.find((p: any) => p.post_id === 'post1');
      const post2 = db.reddit_posts.find((p: any) => p.post_id === 'post2');

      expect(post1.emailed_at).toBe(emailedAt);
      expect(post2.emailed_at).toBe(emailedAt);
    });

    it('should handle empty array gracefully', async () => {
      await expect(markEmailed(context.config, [], new Date().toISOString())).resolves.not.toThrow();
    });
  });
});

