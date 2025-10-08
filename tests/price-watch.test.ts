import { describe, expect, it } from 'vitest';
import {
  computeMonitorWindow,
  uniqueSeeds,
  isValidSeed,
  groupByTicker,
  parseNumber,
  computeTiingoWindow,
  type PriceWatchSeed,
  type DbPriceWatchRow,
} from '../lib/price-watch';
import { easternDateTime, easternMarketClose, easternMarketOpen } from '../lib/time';

describe('computeMonitorWindow', () => {
  it('keeps the start when emailed during market hours', () => {
    const emailedAt = new Date('2023-12-15T16:00:00Z'); // Friday 11:00 ET
    const { start, close } = computeMonitorWindow(emailedAt);

    expect(start.toISOString()).toBe(emailedAt.toISOString());
    expect(close.toISOString()).toBe(easternMarketClose(emailedAt).toISOString());
  });

  it('moves weekend emails to the next business open', () => {
    const emailedAt = new Date('2023-12-16T15:00:00Z'); // Saturday
    const { start, close } = computeMonitorWindow(emailedAt);
    const expectedStart = easternMarketOpen(easternDateTime(2023, 12, 18, 9, 30));
    const expectedClose = easternMarketClose(expectedStart);

    expect(start.toISOString()).toBe(expectedStart.toISOString());
    expect(close.toISOString()).toBe(expectedClose.toISOString());
  });

  it('moves pre-market emails to the same day open', () => {
    const emailedAt = easternDateTime(2023, 12, 15, 8, 0);
    const { start, close } = computeMonitorWindow(emailedAt);
    const expectedOpen = easternMarketOpen(emailedAt);
    const expectedClose = easternMarketClose(emailedAt);

    expect(start.toISOString()).toBe(expectedOpen.toISOString());
    expect(close.toISOString()).toBe(expectedClose.toISOString());
  });

  it('moves after-close emails to the next session open', () => {
    const emailedAt = easternDateTime(2023, 12, 15, 17, 10); // Friday 5:10 PM ET
    const { start, close } = computeMonitorWindow(emailedAt);
    const expectedStart = easternMarketOpen(easternDateTime(2023, 12, 18, 9, 30));
    const expectedClose = easternMarketClose(expectedStart);

    expect(start.toISOString()).toBe(expectedStart.toISOString());
    expect(close.toISOString()).toBe(expectedClose.toISOString());
  });
});

describe('uniqueSeeds', () => {
  it('deduplicates by post and ticker and normalises tickers', () => {
    const seeds: PriceWatchSeed[] = [
      {
        postId: 'abc',
        ticker: 'spy',
        qualityScore: 0.8,
        emailedAtIso: '2023-12-15T14:30:00.000Z',
        entryPrice: 100,
        entryPriceObservedAtIso: '2023-12-15T14:30:00.000Z',
      },
      {
        postId: 'abc',
        ticker: 'SPY',
        qualityScore: 0.9,
        emailedAtIso: '2023-12-15T14:30:00.000Z',
        entryPrice: 102,
        entryPriceObservedAtIso: '2023-12-15T14:32:00.000Z',
      },
      {
        postId: 'def',
        ticker: 'qqq',
        qualityScore: 0.7,
        emailedAtIso: '2023-12-15T14:30:00.000Z',
        entryPrice: 200,
        entryPriceObservedAtIso: '2023-12-15T14:30:00.000Z',
      },
    ];

    const result = uniqueSeeds(seeds);
    expect(result).toHaveLength(2);
    expect(result[0].ticker).toBe('SPY');
    expect(result[1].ticker).toBe('QQQ');
  });
});

describe('isValidSeed', () => {
  it('accepts well-formed seeds', () => {
    const seed: PriceWatchSeed = {
      postId: 'abc',
      ticker: 'SPY',
      qualityScore: 0.8,
      emailedAtIso: '2023-12-15T14:30:00.000Z',
      entryPrice: 100,
      entryPriceObservedAtIso: '2023-12-15T14:30:00.000Z',
    };
    expect(isValidSeed(seed)).toBe(true);
  });

  it('rejects missing identifiers or non-positive entry prices', () => {
    const badTicker: PriceWatchSeed = { postId: 'abc', ticker: '', qualityScore: 0.1, emailedAtIso: '2023-12-15T14:30:00.000Z', entryPrice: 100, entryPriceObservedAtIso: '2023-12-15T14:30:00.000Z' };
    const badEntryPrice: PriceWatchSeed = { postId: 'abc', ticker: 'SPY', qualityScore: 0.1, emailedAtIso: '2023-12-15T14:30:00.000Z', entryPrice: 0, entryPriceObservedAtIso: '2023-12-15T14:30:00.000Z' };

    expect(isValidSeed(badTicker)).toBe(false);
    expect(isValidSeed(badEntryPrice)).toBe(false);
  });
});

describe('groupByTicker', () => {
  it('groups rows by upper-cased ticker', () => {
    const rows: DbPriceWatchRow[] = [
      {
        id: 1,
        post_id: 'p1',
        ticker: 'spy',
        quality_score: 1,
        entry_price: 100,
        entry_price_ts: '2023-12-15T14:30:00.000Z',
        emailed_at: '2023-12-15T14:30:00.000Z',
        monitor_start_at: '2023-12-15T14:30:00.000Z',
        monitor_close_at: '2023-12-15T21:00:00.000Z',
        next_check_at: '2023-12-15T14:30:00.000Z',
        last_price: 100,
        last_price_ts: '2023-12-15T14:30:00.000Z',
      },
      {
        id: 2,
        post_id: 'p2',
        ticker: 'SPY',
        quality_score: 1,
        entry_price: 101,
        entry_price_ts: '2023-12-15T14:35:00.000Z',
        emailed_at: '2023-12-15T14:35:00.000Z',
        monitor_start_at: '2023-12-15T14:35:00.000Z',
        monitor_close_at: '2023-12-15T21:00:00.000Z',
        next_check_at: '2023-12-15T14:35:00.000Z',
        last_price: 101,
        last_price_ts: '2023-12-15T14:35:00.000Z',
      },
    ];

    const grouped = groupByTicker(rows);
    expect(grouped.size).toBe(1);
    expect(grouped.has('SPY')).toBe(true);
    expect(grouped.get('SPY')).toHaveLength(2);
  });
});

describe('parseNumber', () => {
  it('returns numbers for valid inputs and null otherwise', () => {
    expect(parseNumber(5)).toBe(5);
    expect(parseNumber('5.5')).toBe(5.5);
    expect(parseNumber('not-a-number')).toBeNull();
    expect(parseNumber(null)).toBeNull();
  });
});

describe('computeTiingoWindow', () => {
  it('uses the earliest timestamp minus padding', () => {
    const now = new Date('2024-01-10T15:00:00.000Z');
    const rows: DbPriceWatchRow[] = [
      {
        id: 1,
        post_id: 'p1',
        ticker: 'SPY',
        quality_score: 1,
        entry_price: 100,
        entry_price_ts: '2024-01-10T12:15:00.000Z',
        emailed_at: '2024-01-10T12:00:00.000Z',
        monitor_start_at: '2024-01-10T12:00:00.000Z',
        monitor_close_at: '2024-01-10T21:00:00.000Z',
        next_check_at: '2024-01-10T12:00:00.000Z',
        last_price: 100,
        last_price_ts: '2024-01-10T12:15:00.000Z',
      },
      {
        id: 2,
        post_id: 'p2',
        ticker: 'SPY',
        quality_score: 1,
        entry_price: 105,
        entry_price_ts: '2024-01-10T13:00:00.000Z',
        emailed_at: '2024-01-10T12:45:00.000Z',
        monitor_start_at: '2024-01-10T12:45:00.000Z',
        monitor_close_at: '2024-01-10T21:00:00.000Z',
        next_check_at: '2024-01-10T12:45:00.000Z',
        last_price: 105,
        last_price_ts: '2024-01-10T13:00:00.000Z',
      },
    ];

    const window = computeTiingoWindow(rows, now);
    expect(window.end.toISOString()).toBe(now.toISOString());
    expect(window.start.toISOString()).toBe('2024-01-10T11:30:00.000Z'); // 30 minute padding
  });

  it('caps the lookback at three days', () => {
    const now = new Date('2024-01-10T15:00:00.000Z');
    const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
    const rows: DbPriceWatchRow[] = [
      {
        id: 1,
        post_id: 'p1',
        ticker: 'SPY',
        quality_score: 1,
        entry_price: 100,
        entry_price_ts: fourDaysAgo.toISOString(),
        emailed_at: fourDaysAgo.toISOString(),
        monitor_start_at: fourDaysAgo.toISOString(),
        monitor_close_at: new Date(fourDaysAgo.getTime() + 6 * 60 * 60 * 1000).toISOString(),
        next_check_at: fourDaysAgo.toISOString(),
        last_price: 100,
        last_price_ts: fourDaysAgo.toISOString(),
      },
    ];

    const window = computeTiingoWindow(rows, now);
    const maxLookback = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

    expect(window.start.toISOString()).toBe(maxLookback);
    expect(window.end.toISOString()).toBe(now.toISOString());
  });
});
