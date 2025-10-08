import { describe, it, expect, beforeEach } from 'vitest';
import { createMockTiingoClient } from '../__mocks__/tiingo-mock';
import { hoursAgo, daysAgo } from './test-helpers';

describe('Tiingo Client Integration Tests', () => {
  let tiingo: ReturnType<typeof createMockTiingoClient>;

  beforeEach(() => {
    tiingo = createMockTiingoClient();
  });

  describe('fetchIntraday', () => {
    it('should fetch intraday data within date range', async () => {
      const start = hoursAgo(2);
      const end = new Date();

      const bars = await tiingo.fetchIntraday({
        ticker: 'AAPL',
        start,
        end,
        frequency: '5min',
      });

      expect(bars.length).toBeGreaterThan(0);
      expect(bars[0]).toHaveProperty('timestamp');
      expect(bars[0]).toHaveProperty('open');
      expect(bars[0]).toHaveProperty('high');
      expect(bars[0]).toHaveProperty('low');
      expect(bars[0]).toHaveProperty('close');
      expect(bars[0]).toHaveProperty('volume');
    });

    it('should filter bars by date range', async () => {
      const start = hoursAgo(2);
      const end = new Date();

      const bars = await tiingo.fetchIntraday({
        ticker: 'AAPL',
        start,
        end,
        frequency: '5min',
      });

      const startMs = start.getTime();
      const endMs = end.getTime();

      bars.forEach(bar => {
        const barMs = new Date(bar.timestamp).getTime();
        expect(barMs).toBeGreaterThanOrEqual(startMs);
        expect(barMs).toBeLessThanOrEqual(endMs);
      });
    });

    it('should generate reasonable price movements', async () => {
      const start = hoursAgo(1);
      const end = new Date();

      const bars = await tiingo.fetchIntraday({
        ticker: 'AAPL',
        start,
        end,
        frequency: '5min',
      });

      // Verify OHLC relationships
      bars.forEach(bar => {
        expect(bar.high).toBeGreaterThanOrEqual(bar.open);
        expect(bar.high).toBeGreaterThanOrEqual(bar.close);
        expect(bar.low).toBeLessThanOrEqual(bar.open);
        expect(bar.low).toBeLessThanOrEqual(bar.close);
        expect(bar.high).toBeGreaterThanOrEqual(bar.low);
      });
    });

    it('should use cached data on subsequent calls', async () => {
      const start = hoursAgo(1);
      const end = new Date();

      const bars1 = await tiingo.fetchIntraday({
        ticker: 'AAPL',
        start,
        end,
        frequency: '5min',
      });

      const bars2 = await tiingo.fetchIntraday({
        ticker: 'AAPL',
        start,
        end,
        frequency: '5min',
      });

      // Should use cache, so request count only increments by 1
      expect(tiingo.getRequestCount()).toBe(2);
      expect(bars1.length).toBe(bars2.length);
    });

    it('should handle custom mock data', async () => {
      const start = hoursAgo(1);
      const end = new Date();

      // Set custom mock data
      const customBars = [
        {
          timestamp: start.toISOString(),
          open: 100,
          high: 105,
          low: 99,
          close: 103,
          volume: 1000000,
        },
        {
          timestamp: end.toISOString(),
          open: 103,
          high: 106,
          low: 102,
          close: 105,
          volume: 1200000,
        },
      ];

      tiingo.setMockData('intraday', 'AAPL_5min', customBars);

      const bars = await tiingo.fetchIntraday({
        ticker: 'AAPL',
        start,
        end,
        frequency: '5min',
      });

      expect(bars).toHaveLength(2);
      expect(bars[0].close).toBe(103);
      expect(bars[1].close).toBe(105);
    });
  });

  describe('fetchDaily', () => {
    it('should fetch daily data', async () => {
      const start = daysAgo(30);
      const end = new Date();

      const bars = await tiingo.fetchDaily({
        ticker: 'AAPL',
        start,
        end,
      });

      expect(bars.length).toBeGreaterThan(0);
      expect(bars[0]).toHaveProperty('timestamp');
      expect(bars[0]).toHaveProperty('open');
      expect(bars[0]).toHaveProperty('adjClose');
    });

    it('should generate daily bars with proper OHLC', async () => {
      const start = daysAgo(10);
      const end = new Date();

      const bars = await tiingo.fetchDaily({
        ticker: 'AAPL',
        start,
        end,
      });

      bars.forEach(bar => {
        expect(bar.high).toBeGreaterThanOrEqual(bar.open);
        expect(bar.high).toBeGreaterThanOrEqual(bar.close);
        expect(bar.low).toBeLessThanOrEqual(bar.open);
        expect(bar.low).toBeLessThanOrEqual(bar.close);
      });
    });
  });

  describe('fetchNews', () => {
    it('should return empty array when no news is cached', async () => {
      const articles = await tiingo.fetchNews({
        tickers: ['AAPL'],
        limit: 10,
      });

      expect(articles).toEqual([]);
    });

    it('should return cached news when available', async () => {
      const mockNews = [
        {
          id: '1',
          url: 'https://example.com/news1',
          title: 'Apple announces new product',
          description: 'Test description',
          publishedAt: new Date().toISOString(),
          source: 'Test Source',
          tickers: ['AAPL'],
          tags: ['technology'],
        },
      ];

      tiingo.setMockData('news', 'AAPL', mockNews);

      const articles = await tiingo.fetchNews({
        tickers: ['AAPL'],
        limit: 10,
      });

      expect(articles).toHaveLength(1);
      expect(articles[0].title).toBe('Apple announces new product');
    });
  });

  describe('request counting', () => {
    it('should track request count', async () => {
      expect(tiingo.getRequestCount()).toBe(0);

      await tiingo.fetchIntraday({
        ticker: 'AAPL',
        start: hoursAgo(1),
        end: new Date(),
      });

      expect(tiingo.getRequestCount()).toBe(1);

      await tiingo.fetchDaily({
        ticker: 'MSFT',
        start: daysAgo(7),
      });

      expect(tiingo.getRequestCount()).toBe(2);
    });

    it('should reset request count', async () => {
      await tiingo.fetchIntraday({
        ticker: 'AAPL',
        start: hoursAgo(1),
        end: new Date(),
      });

      expect(tiingo.getRequestCount()).toBe(1);

      tiingo.resetRequestCount();

      expect(tiingo.getRequestCount()).toBe(0);
    });

    it('should provide usage snapshot', async () => {
      await tiingo.fetchIntraday({
        ticker: 'AAPL',
        start: hoursAgo(1),
        end: new Date(),
      });

      const usage = tiingo.getUsage();
      expect(usage.requests).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should throw error when configured to fail', async () => {
      tiingo.setFailure(true, 'Mock failure');

      await expect(
        tiingo.fetchIntraday({
          ticker: 'AAPL',
          start: hoursAgo(1),
          end: new Date(),
        })
      ).rejects.toThrow('Mock failure');
    });

    it('should recover after failure is disabled', async () => {
      tiingo.setFailure(true);

      await expect(
        tiingo.fetchIntraday({
          ticker: 'AAPL',
          start: hoursAgo(1),
          end: new Date(),
        })
      ).rejects.toThrow();

      tiingo.setFailure(false);

      await expect(
        tiingo.fetchIntraday({
          ticker: 'AAPL',
          start: hoursAgo(1),
          end: new Date(),
        })
      ).resolves.toBeDefined();
    });
  });
});

