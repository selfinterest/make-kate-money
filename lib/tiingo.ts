import { logger } from './logger';

export interface IntradayBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface FetchIntradayOptions {
  ticker: string;
  start: Date;
  end: Date;
  frequency?: '1min' | '5min' | '15min';
}

const HOURLY_LIMIT = 50;
const DAILY_LIMIT = 500;
const SAFETY_MARGIN = 5;

type Frequency = NonNullable<FetchIntradayOptions['frequency']>;

const DEFAULT_FREQUENCY: Frequency = '1min';

const tiingoLogger = logger.withContext({ service: 'tiingo-client' });

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * TiingoClient handles low-rate-limit querying of the Tiingo IEX API.
 * It keeps per-invocation counters so we never exceed documented limits.
 */
export class TiingoClient {
  private readonly apiKey: string;
  private readonly cache = new Map<string, IntradayBar[]>();
  private requestCount = 0;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('Tiingo API key is required');
    }
    this.apiKey = apiKey;
  }

  private buildCacheKey(opts: FetchIntradayOptions & { frequency: Frequency }): string {
    return [
      opts.ticker.toUpperCase(),
      opts.frequency,
      formatDate(opts.start),
      formatDate(opts.end)
    ].join('::');
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  private assertBudget(additional: number = 1) {
    const projected = this.requestCount + additional;
    if (projected > HOURLY_LIMIT - SAFETY_MARGIN) {
      throw new Error(`Tiingo hourly request budget exceeded (>${HOURLY_LIMIT - SAFETY_MARGIN} attempted)`);
    }
    if (projected > DAILY_LIMIT - SAFETY_MARGIN) {
      throw new Error(`Tiingo daily request budget exceeded (>${DAILY_LIMIT - SAFETY_MARGIN} attempted)`);
    }
  }

  private async getJson(url: string): Promise<any> {
    this.assertBudget(1);
    this.requestCount += 1;

    const fetchFn = (globalThis as any).fetch as ((input: string, init?: any) => Promise<any>) | undefined;
    if (typeof fetchFn !== 'function') {
      throw new Error('global fetch is not available in this runtime');
    }

    const res: any = await fetchFn(url, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Tiingo request failed (${res.status} ${res.statusText}): ${body}`);
    }

    return res.json();
  }

  async fetchIntraday(opts: FetchIntradayOptions): Promise<IntradayBar[]> {
    const frequency: Frequency = opts.frequency ?? DEFAULT_FREQUENCY;
    const key = this.buildCacheKey({ ...opts, frequency });
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    // Expand end date by one day so we always capture the final trading session fully.
    const paddedEnd = new Date(opts.end.getTime() + 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      token: String(this.apiKey),
      startDate: formatDate(opts.start),
      endDate: formatDate(paddedEnd),
      resampleFreq: frequency as string,
      columns: 'date,open,high,low,close,volume',
    } as Record<string, string>);

    const url = `https://api.tiingo.com/iex/${encodeURIComponent(opts.ticker)}/prices?${params.toString()}`;

    tiingoLogger.debug('Fetching Tiingo intraday data', {
      ticker: opts.ticker,
      start: opts.start.toISOString(),
      end: opts.end.toISOString(),
      frequency,
    });

    const json = await this.getJson(url);
    if (!Array.isArray(json)) {
      throw new Error(`Unexpected Tiingo response for ${opts.ticker}`);
    }

    const rows: IntradayBar[] = [];
    const startMs = opts.start.getTime();
    const endMs = paddedEnd.getTime();

    for (const row of json) {
      if (!row?.date) continue;
      const ts = new Date(row.date);
      if (Number.isNaN(ts.getTime())) continue;
      const tsMs = ts.getTime();
      if (tsMs < startMs || tsMs > endMs) continue;
      rows.push({
        timestamp: ts.toISOString(),
        open: typeof row.open === 'number' ? row.open : Number(row.open ?? NaN),
        high: typeof row.high === 'number' ? row.high : Number(row.high ?? NaN),
        low: typeof row.low === 'number' ? row.low : Number(row.low ?? NaN),
        close: typeof row.close === 'number' ? row.close : Number(row.close ?? NaN),
        volume: typeof row.volume === 'number' ? row.volume : Number(row.volume ?? NaN),
      });
    }

    rows.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    this.cache.set(key, rows);
    return rows;
  }
}

export function findFirstBarOnOrAfter(series: IntradayBar[], target: Date): IntradayBar | undefined {
  const targetMs = target.getTime();
  return series.find(bar => new Date(bar.timestamp).getTime() >= targetMs);
}

export function findLastBarOnOrBefore(series: IntradayBar[], target: Date): IntradayBar | undefined {
  const targetMs = target.getTime();
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const barMs = new Date(series[i].timestamp).getTime();
    if (barMs <= targetMs) {
      return series[i];
    }
  }
  return undefined;
}
