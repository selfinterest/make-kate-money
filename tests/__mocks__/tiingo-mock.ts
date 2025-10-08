import type {
  IntradayBar,
  DailyBar,
  TiingoNewsArticle,
  TiingoFundamentalStatement,
  FetchIntradayOptions,
  FetchDailyOptions,
  FetchNewsOptions,
  FetchFundamentalsOptions,
  TiingoUsageSnapshot,
} from '../../lib/tiingo';

export interface MockTiingoData {
  intraday: Map<string, IntradayBar[]>;
  daily: Map<string, DailyBar[]>;
  news: Map<string, TiingoNewsArticle[]>;
  fundamentals: Map<string, TiingoFundamentalStatement[]>;
}

export class MockTiingoClient {
  private data: MockTiingoData;
  private requestCount = 0;
  private shouldFail: boolean = false;
  private failureMessage: string = 'Mock Tiingo request failed';

  constructor(initialData?: Partial<MockTiingoData>) {
    this.data = {
      intraday: new Map(),
      daily: new Map(),
      news: new Map(),
      fundamentals: new Map(),
      ...initialData,
    };
  }

  // Helper methods for testing
  setMockData(type: keyof MockTiingoData, key: string, data: any): void {
    this.data[type].set(key, data);
  }

  setFailure(shouldFail: boolean, message?: string): void {
    this.shouldFail = shouldFail;
    if (message) {
      this.failureMessage = message;
    }
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  resetRequestCount(): void {
    this.requestCount = 0;
  }

  getUsage(): TiingoUsageSnapshot {
    return { requests: this.requestCount };
  }

  async fetchIntraday(opts: FetchIntradayOptions): Promise<IntradayBar[]> {
    this.requestCount++;

    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }

    const key = `${opts.ticker.toUpperCase()}_${opts.frequency || '1min'}`;
    const cachedData = this.data.intraday.get(key);

    if (cachedData) {
      // Filter by date range
      const startMs = opts.start.getTime();
      const endMs = opts.end.getTime();

      return cachedData.filter(bar => {
        const barMs = new Date(bar.timestamp).getTime();
        return barMs >= startMs && barMs <= endMs;
      });
    }

    // Generate mock data if none exists
    return this.generateMockIntradayBars(opts);
  }

  async fetchDaily(opts: FetchDailyOptions): Promise<DailyBar[]> {
    this.requestCount++;

    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }

    const key = `${opts.ticker.toUpperCase()}_${opts.frequency || 'daily'}`;
    const cachedData = this.data.daily.get(key);

    if (cachedData) {
      const startMs = opts.start.getTime();
      const endMs = opts.end ? opts.end.getTime() : Date.now();

      return cachedData.filter(bar => {
        const barMs = new Date(bar.timestamp).getTime();
        return barMs >= startMs && barMs <= endMs;
      });
    }

    // Generate mock data if none exists
    return this.generateMockDailyBars(opts);
  }

  async fetchNews(opts: FetchNewsOptions): Promise<TiingoNewsArticle[]> {
    this.requestCount++;

    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }

    const key = opts.tickers?.join(',') || 'general';
    const cachedData = this.data.news.get(key);

    if (cachedData) {
      return cachedData.slice(0, opts.limit || 50);
    }

    return [];
  }

  async fetchFundamentals(opts: FetchFundamentalsOptions): Promise<TiingoFundamentalStatement[]> {
    this.requestCount++;

    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }

    const key = `${opts.ticker.toUpperCase()}_${opts.statementType || 'income'}`;
    const cachedData = this.data.fundamentals.get(key);

    if (cachedData) {
      return cachedData.slice(0, opts.limit || 4);
    }

    return [];
  }

  // Helper methods to generate mock data
  private generateMockIntradayBars(opts: FetchIntradayOptions): IntradayBar[] {
    const bars: IntradayBar[] = [];
    const basePrice = 100 + Math.random() * 50;
    const frequencyMinutes = opts.frequency === '5min' ? 5 : opts.frequency === '15min' ? 15 : 1;
    const startMs = opts.start.getTime();
    const endMs = opts.end.getTime();

    let currentTime = startMs;
    let currentPrice = basePrice;

    while (currentTime <= endMs) {
      const volatility = 0.005; // 0.5% random move
      const change = (Math.random() - 0.5) * 2 * volatility * currentPrice;
      currentPrice += change;

      const open = currentPrice;
      const close = currentPrice + (Math.random() - 0.5) * 2 * volatility * currentPrice;
      const high = Math.max(open, close) * (1 + Math.random() * volatility);
      const low = Math.min(open, close) * (1 - Math.random() * volatility);

      bars.push({
        timestamp: new Date(currentTime).toISOString(),
        open,
        high,
        low,
        close,
        volume: Math.floor(Math.random() * 1000000 + 100000),
      });

      currentTime += frequencyMinutes * 60 * 1000;
      currentPrice = close;
    }

    return bars;
  }

  private generateMockDailyBars(opts: FetchDailyOptions): DailyBar[] {
    const bars: DailyBar[] = [];
    const basePrice = 100 + Math.random() * 50;
    const startMs = opts.start.getTime();
    const endMs = opts.end ? opts.end.getTime() : Date.now();

    let currentTime = startMs;
    let currentPrice = basePrice;

    while (currentTime <= endMs) {
      const volatility = 0.02; // 2% daily move
      const change = (Math.random() - 0.5) * 2 * volatility * currentPrice;
      currentPrice += change;

      const open = currentPrice;
      const close = currentPrice + (Math.random() - 0.5) * 2 * volatility * currentPrice;
      const high = Math.max(open, close) * (1 + Math.random() * volatility);
      const low = Math.min(open, close) * (1 - Math.random() * volatility);

      bars.push({
        timestamp: new Date(currentTime).toISOString(),
        open,
        high,
        low,
        close,
        adjClose: close,
        volume: Math.floor(Math.random() * 10000000 + 1000000),
        divCash: null,
        splitFactor: null,
      });

      currentTime += 24 * 60 * 60 * 1000; // Next day
      currentPrice = close;
    }

    return bars;
  }
}

// Factory function to create a mock TiingoClient
export function createMockTiingoClient(initialData?: Partial<MockTiingoData>): MockTiingoClient {
  return new MockTiingoClient(initialData);
}

