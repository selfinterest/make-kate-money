import { logger } from './logger';

export interface IntradayBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface DailyBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose?: number | null;
  volume?: number | null;
  divCash?: number | null;
  splitFactor?: number | null;
}

export interface TiingoNewsArticle {
  id: string;
  url: string;
  title: string;
  description?: string | null;
  publishedAt: string;
  source?: string | null;
  tickers: string[];
  tags: string[];
  sentiment?: {
    value: number | null;
    label?: string | null;
  };
}

export interface TiingoFundamentalStatement {
  ticker: string;
  fiscalDate: string | null;
  period: string | null;
  statementType: string | null;
  data: Record<string, number>;
}

export interface TiingoTickerContext {
  ticker: string;
  news: TiingoNewsArticle[];
  fundamentals?: TiingoFundamentalStatement | null;
}

export interface FetchIntradayOptions {
  ticker: string;
  start: Date;
  end: Date;
  frequency?: '1min' | '5min' | '15min';
}

export interface FetchDailyOptions {
  ticker: string;
  start: Date;
  end?: Date;
  frequency?: 'daily' | 'weekly' | 'monthly';
  adjusted?: boolean;
}

export interface FetchNewsOptions {
  tickers?: string[];
  tags?: string[];
  sources?: string[];
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}

export interface FetchFundamentalsOptions {
  ticker: string;
  statementType?: 'income' | 'balanceSheet' | 'cashFlow';
  period?: 'annual' | 'quarterly';
  limit?: number;
}

export interface TiingoUsageSnapshot {
  requests: number;
}

const HOURLY_LIMIT = 50;
const DAILY_LIMIT = 500;
const SAFETY_MARGIN = 5;

type IntradayFrequency = NonNullable<FetchIntradayOptions['frequency']>;
type DailyFrequency = NonNullable<FetchDailyOptions['frequency']>;

const DEFAULT_INTRADAY_FREQUENCY: IntradayFrequency = '1min';
const DEFAULT_DAILY_FREQUENCY: DailyFrequency = 'daily';

const tiingoLogger = logger.withContext({ service: 'tiingo-client' });

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateTime(date: Date): string {
  return date.toISOString().split('.')[0] + 'Z';
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function buildCacheKey(parts: Array<string | number | undefined | null>): string {
  return parts.map(p => (p === undefined || p === null ? '' : String(p))).join('::');
}

/**
 * TiingoClient handles low-rate-limit querying of the Tiingo API surface.
 * It keeps per-invocation counters so we never exceed documented limits
 * and exposes convenient helpers for the endpoints we rely on.
 */
export class TiingoClient {
  private readonly apiKey: string;
  private readonly intradayCache = new Map<string, IntradayBar[]>();
  private readonly dailyCache = new Map<string, DailyBar[]>();
  private readonly newsCache = new Map<string, TiingoNewsArticle[]>();
  private readonly fundamentalsCache = new Map<string, TiingoFundamentalStatement[]>();
  private requestCount = 0;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('Tiingo API key is required');
    }
    this.apiKey = apiKey;
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  getUsage(): TiingoUsageSnapshot {
    return { requests: this.requestCount };
  }

  private assertBudget(additional: number = 1) {
    const projected = this.requestCount + additional;
    if (projected > HOURLY_LIMIT - SAFETY_MARGIN) {
      throw new Error(`Tiingo hourly request budget exceeded (> ${HOURLY_LIMIT - SAFETY_MARGIN} attempted)`);
    }
    if (projected > DAILY_LIMIT - SAFETY_MARGIN) {
      throw new Error(`Tiingo daily request budget exceeded (> ${DAILY_LIMIT - SAFETY_MARGIN} attempted)`);
    }
  }

  private async request(path: string, params: Record<string, string | number | boolean | string[] | undefined | null> = {}): Promise<any> {
    const url = new URL(`https://api.tiingo.com${path}`);
    const search = url.searchParams;
    search.set('token', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        search.set(key, value.join(','));
      } else {
        search.set(key, String(value));
      }
    }

    this.assertBudget(1);
    this.requestCount += 1;

    const fetchFn = (globalThis as any).fetch as ((input: string, init?: any) => Promise<any>) | undefined;
    if (typeof fetchFn !== 'function') {
      throw new Error('global fetch is not available in this runtime');
    }

    const res: any = await fetchFn(url.toString(), {
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
    const frequency: IntradayFrequency = opts.frequency ?? DEFAULT_INTRADAY_FREQUENCY;
    const cacheKey = buildCacheKey([
      'intraday',
      opts.ticker.toUpperCase(),
      frequency,
      formatDate(opts.start),
      formatDate(opts.end),
    ]);
    const cached = this.intradayCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const paddedEnd = new Date(opts.end.getTime() + 24 * 60 * 60 * 1000);
    const json = await this.request(
      `/iex/${encodeURIComponent(opts.ticker)}/prices`,
      {
        startDate: formatDate(opts.start),
        endDate: formatDate(paddedEnd),
        resampleFreq: frequency,
        columns: 'date,open,high,low,close,volume',
      },
    );

    if (!Array.isArray(json)) {
      throw new Error(`Unexpected Tiingo response for ${opts.ticker}`);
    }

    tiingoLogger.debug('Fetched Tiingo intraday data', {
      ticker: opts.ticker,
      start: opts.start.toISOString(),
      end: opts.end.toISOString(),
      frequency,
      rowCount: json.length,
    });

    const rows: IntradayBar[] = [];
    const startMs = opts.start.getTime();
    const endMs = paddedEnd.getTime();

    for (const row of json) {
      if (!row?.date) continue;
      const ts = new Date(row.date);
      if (Number.isNaN(ts.getTime())) continue;
      const tsMs = ts.getTime();
      if (tsMs < startMs || tsMs > endMs) continue;

      const open = toNumber(row.open);
      const high = toNumber(row.high);
      const low = toNumber(row.low);
      const close = toNumber(row.close);
      if (![open, high, low, close].every(v => typeof v === 'number' && Number.isFinite(v))) {
        continue;
      }

      const volume = toNumber(row.volume);
      rows.push({
        timestamp: ts.toISOString(),
        open: open!,
        high: high!,
        low: low!,
        close: close!,
        volume: typeof volume === 'number' && Number.isFinite(volume) ? volume : undefined,
      });
    }

    rows.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    this.intradayCache.set(cacheKey, rows);
    return rows;
  }

  async fetchDaily(opts: FetchDailyOptions): Promise<DailyBar[]> {
    const frequency: DailyFrequency = opts.frequency ?? DEFAULT_DAILY_FREQUENCY;
    const endDate = opts.end ?? new Date();
    const cacheKey = buildCacheKey([
      'daily',
      opts.ticker.toUpperCase(),
      frequency,
      formatDate(opts.start),
      formatDate(endDate),
      opts.adjusted !== false ? 'adj' : 'unadj',
    ]);
    const cached = this.dailyCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const json = await this.request(
      `/tiingo/daily/${encodeURIComponent(opts.ticker)}/prices`,
      {
        startDate: formatDate(opts.start),
        endDate: formatDate(endDate),
        resampleFreq: frequency,
        adjusted: opts.adjusted !== false,
      },
    );

    if (!Array.isArray(json)) {
      throw new Error(`Unexpected Tiingo daily response for ${opts.ticker}`);
    }

    tiingoLogger.debug('Fetched Tiingo daily data', {
      ticker: opts.ticker,
      start: opts.start.toISOString(),
      end: endDate.toISOString(),
      frequency,
      rowCount: json.length,
    });

    const rows: DailyBar[] = [];
    for (const row of json) {
      if (!row?.date) continue;
      const ts = new Date(row.date);
      if (Number.isNaN(ts.getTime())) continue;

      const open = toNumber(row.open);
      const high = toNumber(row.high);
      const low = toNumber(row.low);
      const close = toNumber(row.close);
      if (![open, high, low, close].every(v => typeof v === 'number' && Number.isFinite(v))) {
        continue;
      }

      rows.push({
        timestamp: ts.toISOString(),
        open: open!,
        high: high!,
        low: low!,
        close: close!,
        adjClose: toNumber(row.adjClose),
        volume: toNumber(row.volume),
        divCash: toNumber(row.divCash),
        splitFactor: toNumber(row.splitFactor),
      });
    }

    rows.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    this.dailyCache.set(cacheKey, rows);
    return rows;
  }

  async fetchNews(opts: FetchNewsOptions): Promise<TiingoNewsArticle[]> {
    const cacheKey = buildCacheKey([
      'news',
      (opts.tickers ?? []).map(t => t.toUpperCase()).join(','),
      (opts.tags ?? []).join(','),
      (opts.sources ?? []).join(','),
      opts.startDate ? formatDateTime(opts.startDate) : undefined,
      opts.endDate ? formatDateTime(opts.endDate) : undefined,
      opts.limit ?? 50,
    ]);
    const cached = this.newsCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const json = await this.request(
      '/tiingo/news',
      {
        tickers: opts.tickers?.map(t => t.toUpperCase()),
        tags: opts.tags,
        sources: opts.sources,
        startDate: opts.startDate ? formatDateTime(opts.startDate) : undefined,
        endDate: opts.endDate ? formatDateTime(opts.endDate) : undefined,
        limit: opts.limit ?? 50,
      },
    );

    if (!Array.isArray(json)) {
      throw new Error('Unexpected Tiingo news response');
    }

    const articles: TiingoNewsArticle[] = [];
    for (const item of json) {
      if (!item) continue;
      const publishedRaw = item.publishedDate ?? item.publishedDateUtc ?? item.publishedAt ?? item.date ?? item.timestamp;
      const published = publishedRaw ? new Date(publishedRaw) : null;
      if (!published || Number.isNaN(published.getTime())) {
        continue;
      }

      const sentimentRaw = item.sentiment ?? item.sentimentScore ?? item.sentimentSummary;
      let sentimentValue: number | null = null;
      let sentimentLabel: string | null = null;
      if (typeof sentimentRaw === 'number') {
        sentimentValue = sentimentRaw;
      } else if (sentimentRaw && typeof sentimentRaw === 'object') {
        const maybeValue = sentimentRaw.value ?? sentimentRaw.score ?? sentimentRaw.sentimentScore;
        const maybeLabel = sentimentRaw.classification ?? sentimentRaw.label ?? sentimentRaw.sentiment;
        const parsedValue = toNumber(maybeValue);
        if (typeof parsedValue === 'number' && Number.isFinite(parsedValue)) {
          sentimentValue = parsedValue;
        }
        if (typeof maybeLabel === 'string' && maybeLabel.trim() !== '') {
          sentimentLabel = maybeLabel;
        }
      }

      const url = typeof item.url === 'string' && item.url.trim().length > 0
        ? item.url
        : typeof item.href === 'string'
          ? item.href
          : '';

      articles.push({
        id: String(item.id ?? `${url}-${published.getTime()}`),
        url,
        title: typeof item.title === 'string' ? item.title : 'Untitled',
        description: typeof item.description === 'string' ? item.description : null,
        publishedAt: published.toISOString(),
        source: typeof item.source === 'string' ? item.source : null,
        tickers: Array.isArray(item.tickers)
          ? item.tickers.map((t: unknown) => (typeof t === 'string' ? t.toUpperCase() : '')).filter(Boolean)
          : [],
        tags: Array.isArray(item.tags)
          ? item.tags.map((t: unknown) => (typeof t === 'string' ? t : '')).filter(Boolean)
          : [],
        sentiment: sentimentValue !== null || (sentimentLabel && sentimentLabel.length > 0)
          ? {
            value: sentimentValue,
            label: sentimentLabel ?? undefined,
          }
          : undefined,
      });
    }

    articles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    this.newsCache.set(cacheKey, articles);
    return articles;
  }

  async fetchFundamentals(opts: FetchFundamentalsOptions): Promise<TiingoFundamentalStatement[]> {
    const statementType = opts.statementType ?? 'income';
    const period = opts.period ?? 'quarterly';
    const limit = opts.limit ?? 4;
    const cacheKey = buildCacheKey([
      'fundamentals',
      opts.ticker.toUpperCase(),
      statementType,
      period,
      limit,
    ]);
    const cached = this.fundamentalsCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const json = await this.request(
      `/tiingo/fundamentals/${encodeURIComponent(opts.ticker)}/statements`,
      {
        statementType,
        timeFrame: period,
        limit,
      },
    );

    const items = Array.isArray(json)
      ? json
      : Array.isArray(json?.data)
        ? json.data
        : [];

    const statements: TiingoFundamentalStatement[] = [];
    for (const item of items) {
      if (!item) continue;
      const fiscalRaw = item.reportDate ?? item.date ?? item.fiscalDate ?? item.periodEndingDate;
      const fiscalDate = fiscalRaw ? new Date(fiscalRaw) : null;
      const normalizedData: Record<string, number> = {};
      if (item.data && typeof item.data === 'object') {
        for (const [key, value] of Object.entries(item.data as Record<string, unknown>)) {
          if (!key) continue;
          const normalized = normalizeKey(key);
          const parsed = toNumber(value);
          if (normalized && typeof parsed === 'number' && Number.isFinite(parsed)) {
            normalizedData[normalized] = parsed;
          }
        }
      }

      statements.push({
        ticker: (item.ticker ?? opts.ticker ?? '').toUpperCase(),
        fiscalDate: fiscalDate && !Number.isNaN(fiscalDate.getTime()) ? fiscalDate.toISOString() : null,
        period: typeof item.period === 'string' ? item.period : (typeof item.timeFrame === 'string' ? item.timeFrame : period),
        statementType: typeof item.statementType === 'string'
          ? item.statementType
          : (typeof item.reportType === 'string' ? item.reportType : statementType),
        data: normalizedData,
      });
    }

    statements.sort((a, b) => {
      const aTime = a.fiscalDate ? new Date(a.fiscalDate).getTime() : 0;
      const bTime = b.fiscalDate ? new Date(b.fiscalDate).getTime() : 0;
      return bTime - aTime;
    });

    this.fundamentalsCache.set(cacheKey, statements);
    return statements;
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
