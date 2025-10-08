import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createTestContext,
  createPriceSeriesWithMove,
  minutesAgo,
  hoursAgo,
  daysAgo,
} from './test-helpers';
import type { PriceWatchSeed } from '../../lib/price-watch';
import { logger } from '../../lib/logger';

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
    findFirstBarOnOrAfter: vi.fn((series, target) => {
      const targetMs = target.getTime();
      return series.find((bar: any) => new Date(bar.timestamp).getTime() >= targetMs);
    }),
    findLastBarOnOrBefore: vi.fn((series, target) => {
      const targetMs = target.getTime();
      for (let i = series.length - 1; i >= 0; i -= 1) {
        const barMs = new Date(series[i].timestamp).getTime();
        if (barMs <= targetMs) {
          return series[i];
        }
      }
      return undefined;
    }),
  };
});

import {
  schedulePriceWatches,
  processPriceWatchQueue,
} from '../../lib/price-watch';
import { getSupabaseClient } from '../../lib/db';
import { TiingoClient } from '../../lib/tiingo';

describe('Price Watch Integration Tests', () => {
  let context: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    context = createTestContext();

    // Configure mocks to return our test context's clients
    vi.mocked(getSupabaseClient).mockReturnValue(context.supabase);
    vi.mocked(TiingoClient).mockImplementation(() => context.tiingo as any);
  });

  describe('schedulePriceWatches', () => {
    it('should insert price watches from seeds', async () => {
      const emailedAt = new Date().toISOString();
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

      const db = (context.supabase as any).getDatabase();
      expect(db.price_watches).toHaveLength(2);
      
      const aaplWatch = db.price_watches.find((w: any) => w.ticker === 'AAPL');
      expect(aaplWatch).toBeDefined();
      expect(aaplWatch.entry_price).toBe(150.0);
      expect(aaplWatch.post_id).toBe('post1');
    });

    it('should deduplicate by post_id and ticker', async () => {
      const emailedAt = new Date().toISOString();
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

      const db = (context.supabase as any).getDatabase();
      expect(db.price_watches).toHaveLength(1);
    });

    it('should filter out invalid seeds', async () => {
      const emailedAt = new Date().toISOString();
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

      const db = (context.supabase as any).getDatabase();
      expect(db.price_watches).toHaveLength(1);
      expect(db.price_watches[0].ticker).toBe('MSFT');
    });
  });

  describe('processPriceWatchQueue', () => {
    it('should check watches and trigger alerts on 15% gain', async () => {
      const now = new Date();
      const monitorStart = minutesAgo(30);
      const monitorClose = hoursAgo(-2); // 2 hours in the future

      // Set up a price watch
      const db = (context.supabase as any).getDatabase();
      db.price_watches = [
        {
          id: 1,
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
        },
      ];

      // Set up mock price data showing 16% gain
      const priceData = createPriceSeriesWithMove(
        'AAPL',
        100.0,
        monitorStart,
        now,
        0.16, // 16% gain
        '5min',
      );

      context.getMockTiingo().setMockData('intraday', 'AAPL_5min', priceData);

      const requestLogger = logger.withContext({ test: true });
      const result = await processPriceWatchQueue(context.config, requestLogger);

      expect(result.checked).toBe(1);
      expect(result.triggered).toHaveLength(1);
      expect(result.triggered[0].ticker).toBe('AAPL');
      expect(result.triggered[0].movePct).toBeGreaterThan(0.15);
      expect(result.exceededFifteenPct).toBe(1);
    });

    it('should reschedule watches that have not reached threshold', async () => {
      const now = new Date();
      const monitorStart = minutesAgo(30);
      const monitorClose = hoursAgo(-2);

      const db = (context.supabase as any).getDatabase();
      db.price_watches = [
        {
          id: 1,
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
        },
      ];

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

      // Check that the watch was updated with new price and next_check_at
      const updatedWatch = db.price_watches[0];
      expect(updatedWatch.last_price).toBeGreaterThan(100.0);
      expect(new Date(updatedWatch.next_check_at).getTime()).toBeGreaterThan(now.getTime());
    });

    it('should mark expired watches', async () => {
      const now = new Date();
      const monitorStart = daysAgo(2);
      const monitorClose = minutesAgo(5); // Already closed

      const db = (context.supabase as any).getDatabase();
      db.price_watches = [
        {
          id: 1,
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
        },
      ];

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

      // Check that the watch was marked as expired
      const expiredWatch = db.price_watches[0];
      expect(expiredWatch.status).toBe('expired');
    });

    it('should handle multiple watches for different tickers', async () => {
      const now = new Date();
      const monitorStart = minutesAgo(30);
      const monitorClose = hoursAgo(-2);

      const db = (context.supabase as any).getDatabase();
      db.price_watches = [
        {
          id: 1,
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
        },
        {
          id: 2,
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
        },
      ];

      // AAPL gains 16%, MSFT gains 5%
      const aaplData = createPriceSeriesWithMove('AAPL', 100.0, monitorStart, now, 0.16, '5min');
      const msftData = createPriceSeriesWithMove('MSFT', 200.0, monitorStart, now, 0.05, '5min');

      context.getMockTiingo().setMockData('intraday', 'AAPL_5min', aaplData);
      context.getMockTiingo().setMockData('intraday', 'MSFT_5min', msftData);

      const requestLogger = logger.withContext({ test: true });
      const result = await processPriceWatchQueue(context.config, requestLogger);

      expect(result.checked).toBe(2);
      expect(result.triggered).toHaveLength(1);
      expect(result.triggered[0].ticker).toBe('AAPL');
      expect(result.rescheduled).toBe(1);
    });

    it('should handle data unavailable gracefully', async () => {
      const now = new Date();
      const monitorStart = minutesAgo(30);
      const monitorClose = hoursAgo(-2);

      const db = (context.supabase as any).getDatabase();
      db.price_watches = [
        {
          id: 1,
          post_id: 'post1',
          ticker: 'UNKNOWN',
          quality_score: 5,
          entry_price: 100.0,
          entry_price_ts: monitorStart.toISOString(),
          emailed_at: monitorStart.toISOString(),
          monitor_start_at: monitorStart.toISOString(),
          monitor_close_at: monitorClose.toISOString(),
          next_check_at: minutesAgo(5).toISOString(),
          last_price: 100.0,
          last_price_ts: monitorStart.toISOString(),
        },
      ];

      // Don't set up any mock data for UNKNOWN ticker

      const requestLogger = logger.withContext({ test: true });
      const result = await processPriceWatchQueue(context.config, requestLogger);

      expect(result.checked).toBe(1);
      expect(result.dataUnavailable).toBe(1);
    });

    it('should not process watches not yet due for checking', async () => {
      const now = new Date();
      const monitorStart = minutesAgo(30);
      const monitorClose = hoursAgo(-2);

      const db = (context.supabase as any).getDatabase();
      db.price_watches = [
        {
          id: 1,
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
        },
      ];

      const requestLogger = logger.withContext({ test: true });
      const result = await processPriceWatchQueue(context.config, requestLogger);

      expect(result.checked).toBe(0);
      expect(result.triggered).toHaveLength(0);
      expect(result.rescheduled).toBe(0);
    });
  });
});

