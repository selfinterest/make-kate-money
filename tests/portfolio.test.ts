import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { processWatchedPositions } from '../lib/portfolio';
import type { Config } from '../lib/config';
import { logger } from '../lib/logger';
import { TiingoClient } from '../lib/tiingo';
import { MockSupabaseClient } from './__mocks__/supabase-mock';
import { __resetSupabaseClient, __setSupabaseClient } from '../lib/db';

const baseConfig: Config = {
  reddit: {
    clientId: 'clientId',
    clientSecret: 'clientSecret',
    username: 'user',
    password: 'pass',
    userAgent: 'test-agent',
  },
  supabase: {
    url: 'https://example.supabase.co',
    apiKey: 'service-key',
  },
  llm: {
    provider: 'openai',
    openaiApiKey: 'openai-key',
  },
  marketData: {
    tiingoApiKey: 'tiingo-key',
  },
  email: {
    resendApiKey: 'resend-key',
    from: 'alerts@example.com',
    to: 'user@example.com',
  },
  app: {
    subreddits: ['stocks'],
    cronWindowMinutes: 30,
    llmBatchSize: 10,
    llmMaxBodyChars: 8000,
    minScoreForLlm: 10,
    qualityThreshold: 4,
    maxPostsPerRun: 50,
    minVotesPerMinuteForLlm: 1,
    maxPriceMovePctForAlert: 0.2,
  },
};

describe('processWatchedPositions', () => {
  const requestLogger = logger.withContext({ test: 'portfolio' });
  let supabaseMock: MockSupabaseClient;

  beforeEach(() => {
    supabaseMock = new MockSupabaseClient({
      portfolio_positions: [
        {
          id: 'pos-1',
          user_id: 'user-1',
          ticker: 'AMZN',
          shares: 10,
          watch: true,
          last_price: 100,
          last_price_ts: '2024-01-01T14:00:00Z',
          last_price_source: 'tiingo_intraday',
          alert_threshold_pct: 0.05,
          last_alert_at: null,
          last_alert_price: null,
          last_alert_move_pct: null,
          notes: null,
          created_at: '2024-01-01T13:00:00Z',
          updated_at: '2024-01-01T14:00:00Z',
        },
        {
          id: 'pos-2',
          user_id: 'user-1',
          ticker: 'MSFT',
          shares: 5,
          watch: true,
          last_price: 320,
          last_price_ts: '2024-01-01T14:00:00Z',
          last_price_source: 'tiingo_intraday',
          alert_threshold_pct: 0.05,
          last_alert_at: null,
          last_alert_price: null,
          last_alert_move_pct: null,
          notes: null,
          created_at: '2024-01-01T13:00:00Z',
          updated_at: '2024-01-01T14:00:00Z',
        },
      ],
    });
    __setSupabaseClient(supabaseMock as unknown as any);
  });

  afterEach(() => {
    __resetSupabaseClient();
    vi.restoreAllMocks();
  });

  it('updates positions and emits alerts when price drops beyond threshold', async () => {
    const fetchSpy = vi
      .spyOn(TiingoClient.prototype, 'fetchIntraday')
      .mockResolvedValueOnce([
        { timestamp: '2024-01-01T14:55:00Z', open: 96, high: 97, low: 95, close: 94 },
        { timestamp: '2024-01-01T15:00:00Z', open: 94, high: 95, low: 93, close: 94 },
      ])
      .mockResolvedValueOnce([
        { timestamp: '2024-01-01T14:55:00Z', open: 322, high: 323, low: 321, close: 322 },
        { timestamp: '2024-01-01T15:00:00Z', open: 323, high: 324, low: 322, close: 323 },
      ]);

    const now = new Date('2024-01-01T15:05:00Z');
    const result = await processWatchedPositions(baseConfig, requestLogger, now);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.checked).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.dataUnavailable).toBe(0);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({
      ticker: 'AMZN',
      previousPrice: 100,
      currentPrice: 94,
    });

    const db = supabaseMock.getDatabase();
    const amzn = db.portfolio_positions.find(row => row.ticker === 'AMZN');
    expect(amzn?.last_price).toBe(94);
    expect(amzn?.last_alert_price).toBe(94);
    expect(amzn?.last_alert_move_pct).toBeLessThan(0);
    expect(amzn?.last_alert_at).toBeTruthy();
  });

  it('skips alerts when market data is unavailable', async () => {
    vi.spyOn(TiingoClient.prototype, 'fetchIntraday').mockResolvedValue([]);

    // Only evaluate the first position for this scenario
    const db = supabaseMock.getDatabase();
    const msft = db.portfolio_positions.find(row => row.ticker === 'MSFT');
    if (msft) {
      msft.watch = false;
    }

    const now = new Date('2024-01-01T15:05:00Z');
    const result = await processWatchedPositions(baseConfig, requestLogger, now);

    expect(result.checked).toBe(1);
    expect(result.alerts).toHaveLength(0);
    expect(result.dataUnavailable).toBe(1);

    const amzn = supabaseMock.getDatabase().portfolio_positions.find(row => row.ticker === 'AMZN');
    expect(amzn?.last_price).toBe(100);
    expect(amzn?.last_alert_at).toBeNull();
  });
});
