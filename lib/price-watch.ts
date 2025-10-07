import type { Config } from './config';
import { getSupabaseClient } from './db';
import { logger } from './logger';
import { TiingoClient, findLastBarOnOrBefore, type IntradayBar } from './tiingo';
import {
  easternMarketClose,
  easternMarketOpen,
  isDuringEasternMarketHours,
  isEasternWeekend,
  nextEasternBusinessDay,
} from './time';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DATA_UNAVAILABLE_BACKOFF_MS = 60 * 60 * 1000; // retry in 1 hour if no data
const TIINGO_LOOKBACK_PADDING_MS = 30 * 60 * 1000; // 30 minutes padding for intraday fetches
const DEFAULT_LIMIT = 200;

type SupabaseClient = ReturnType<typeof getSupabaseClient>;

type Logger = ReturnType<typeof logger.withContext>;

export interface PriceWatchSeed {
  postId: string;
  ticker: string;
  qualityScore: number;
  emailedAtIso: string;
  entryPrice: number;
  entryPriceObservedAtIso: string;
}

export interface PriceWatchAlertInfo {
  watchId: number;
  postId: string;
  ticker: string;
  title: string;
  url: string;
  qualityScore: number;
  entryPrice: number;
  entryPriceObservedAtIso: string;
  currentPrice: number;
  movePct: number;
  triggeredAtIso: string;
  emailedAtIso: string;
}

export interface PriceWatchProcessResult {
  checked: number;
  triggered: PriceWatchAlertInfo[];
  expired: number;
  rescheduled: number;
  dataUnavailable: number;
  exceededFifteenPct: number;
}

export interface DbPriceWatchRow {
  id: number;
  post_id: string;
  ticker: string;
  quality_score: number | null;
  entry_price: number | string | null;
  entry_price_ts: string | null;
  emailed_at: string;
  monitor_start_at: string;
  monitor_close_at: string;
  next_check_at: string | null;
  last_price: number | string | null;
  last_price_ts: string | null;
  reddit_posts?: {
    title?: string | null;
    url?: string | null;
  } | null;
}

interface PriceWatchUpdate {
  id: number;
  status?: 'pending' | 'triggered' | 'expired';
  stop_reason?: string | null;
  next_check_at?: string | null;
  last_price?: number | null;
  last_price_ts?: string | null;
  triggered_at?: string | null;
  triggered_price?: number | null;
  triggered_move_pct?: number | null;
}

export function computeMonitorWindow(emailedAt: Date): { start: Date; close: Date } {
  if (isDuringEasternMarketHours(emailedAt)) {
    return {
      start: emailedAt,
      close: easternMarketClose(emailedAt),
    };
  }

  if (isEasternWeekend(emailedAt)) {
    let next = emailedAt;
    do {
      next = nextEasternBusinessDay(next);
    } while (isEasternWeekend(next));
    const start = easternMarketOpen(next);
    return { start, close: easternMarketClose(start) };
  }

  const open = easternMarketOpen(emailedAt);
  const close = easternMarketClose(emailedAt);

  if (emailedAt < open) {
    return { start: open, close };
  }

  if (emailedAt >= close) {
    let next = emailedAt;
    do {
      next = nextEasternBusinessDay(next);
    } while (isEasternWeekend(next));
    const start = easternMarketOpen(next);
    return { start, close: easternMarketClose(start) };
  }

  return { start: emailedAt, close };
}

export function uniqueSeeds(seeds: PriceWatchSeed[]): PriceWatchSeed[] {
  const seen = new Set<string>();
  const result: PriceWatchSeed[] = [];
  for (const seed of seeds) {
    const key = `${seed.postId}::${seed.ticker.toUpperCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      ...seed,
      ticker: seed.ticker.toUpperCase(),
    });
  }
  return result;
}

export function isValidSeed(seed: PriceWatchSeed): boolean {
  return (
    typeof seed.postId === 'string'
    && seed.postId.length > 0
    && typeof seed.ticker === 'string'
    && seed.ticker.length > 0
    && Number.isFinite(seed.entryPrice)
    && seed.entryPrice > 0
  );
}

export async function schedulePriceWatches(
  config: Config,
  seeds: PriceWatchSeed[],
  requestLogger: Logger,
): Promise<number> {
  const supabase = getSupabaseClient(config);
  const validSeeds = uniqueSeeds(seeds).filter(isValidSeed);

  if (validSeeds.length === 0) {
    requestLogger.debug('No price watch seeds to schedule');
    return 0;
  }

  const rows = validSeeds.map(seed => {
    const emailedAt = new Date(seed.emailedAtIso);
    const { start, close } = computeMonitorWindow(emailedAt);
    const observedCandidate = new Date(seed.entryPriceObservedAtIso || seed.emailedAtIso);
    const entryObservedAt = Number.isNaN(observedCandidate.getTime())
      ? emailedAt
      : observedCandidate;

    return {
      post_id: seed.postId,
      ticker: seed.ticker.toUpperCase(),
      quality_score: seed.qualityScore,
      entry_price: seed.entryPrice,
      entry_price_ts: entryObservedAt.toISOString(),
      emailed_at: seed.emailedAtIso,
      monitor_start_at: start.toISOString(),
      monitor_close_at: close.toISOString(),
      next_check_at: start.toISOString(),
      status: 'pending',
      stop_reason: null,
    };
  });

  requestLogger.info('Scheduling price watch tasks', {
    taskCount: rows.length,
  });

  const { error } = await supabase
    .from('price_watches')
    .upsert(rows as any, {
      onConflict: 'post_id,ticker',
      ignoreDuplicates: true,
    });

  if (error) {
    requestLogger.error('Failed to schedule price watches', {
      error: error.message,
    });
    throw new Error(`Failed to schedule price watches: ${error.message}`);
  }

  return rows.length;
}

export function groupByTicker(rows: DbPriceWatchRow[]): Map<string, DbPriceWatchRow[]> {
  const map = new Map<string, DbPriceWatchRow[]>();
  for (const row of rows) {
    const ticker = (row.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (!map.has(ticker)) {
      map.set(ticker, []);
    }
    map.get(ticker)!.push(row);
  }
  return map;
}

export function parseNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function computeTiingoWindow(rows: DbPriceWatchRow[], now: Date): { start: Date; end: Date } {
  let earliest = now.getTime();
  for (const row of rows) {
    const candidates: Array<string | null | undefined> = [row.monitor_start_at, row.entry_price_ts];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const ms = new Date(candidate).getTime();
      if (!Number.isFinite(ms)) continue;
      if (ms < earliest) {
        earliest = ms;
      }
    }
  }
  const start = new Date(Math.max(earliest - TIINGO_LOOKBACK_PADDING_MS, now.getTime() - 3 * 24 * 60 * 60 * 1000));
  return { start, end: now };
}

async function fetchDuePriceWatches(
  supabase: SupabaseClient,
  nowIso: string,
): Promise<DbPriceWatchRow[]> {
  const { data, error } = await supabase
    .from('price_watches')
    .select(`
      id,
      post_id,
      ticker,
      quality_score,
      entry_price,
      entry_price_ts,
      emailed_at,
      monitor_start_at,
      monitor_close_at,
      next_check_at,
      last_price,
      last_price_ts,
      reddit_posts ( title, url )
    `)
    .eq('status', 'pending')
    .lte('next_check_at', nowIso)
    .order('next_check_at', { ascending: true })
    .limit(DEFAULT_LIMIT);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as DbPriceWatchRow[];
}

async function applyUpdates(
  supabase: SupabaseClient,
  updates: PriceWatchUpdate[],
  requestLogger: Logger,
) {
  for (const update of updates) {
    const payload: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (update.status) payload.status = update.status;
    if (update.stop_reason !== undefined) payload.stop_reason = update.stop_reason;
    if (update.next_check_at !== undefined) payload.next_check_at = update.next_check_at;
    if (update.last_price !== undefined) payload.last_price = update.last_price;
    if (update.last_price_ts !== undefined) payload.last_price_ts = update.last_price_ts;
    if (update.triggered_at !== undefined) payload.triggered_at = update.triggered_at;
    if (update.triggered_price !== undefined) payload.triggered_price = update.triggered_price;
    if (update.triggered_move_pct !== undefined) payload.triggered_move_pct = update.triggered_move_pct;

    const { error } = await supabase
      .from('price_watches')
      .update(payload as any)
      .eq('id', update.id);

    if (error) {
      requestLogger.error('Failed to update price watch row', {
        id: update.id,
        error: error.message,
      });
      throw new Error(`Failed to update price watch row: ${error.message}`);
    }
  }
}

export async function processPriceWatchQueue(
  config: Config,
  requestLogger: Logger,
  now: Date = new Date(),
): Promise<PriceWatchProcessResult> {
  const supabase = getSupabaseClient(config);
  const nowIso = now.toISOString();

  const pendingRows = await fetchDuePriceWatches(supabase, nowIso);
  if (pendingRows.length === 0) {
    return {
      checked: 0,
      triggered: [],
      expired: 0,
      rescheduled: 0,
      dataUnavailable: 0,
      exceededFifteenPct: 0,
    };
  }

  const tiingo = new TiingoClient(config.marketData.tiingoApiKey);
  const groups = groupByTicker(pendingRows);
  const updates: PriceWatchUpdate[] = [];
  const alerts: PriceWatchAlertInfo[] = [];

  let checked = 0;
  let expired = 0;
  let rescheduled = 0;
  let dataUnavailable = 0;
  let exceededFifteenPct = 0;

  for (const [ticker, rows] of groups.entries()) {
    const window = computeTiingoWindow(rows, now);
    let series: IntradayBar[] = [];
    try {
      series = await tiingo.fetchIntraday({
        ticker,
        start: window.start,
        end: window.end,
        frequency: '5min',
      });
    } catch (error) {
      requestLogger.warn('Failed to fetch Tiingo data for price watch', {
        ticker,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      series = [];
    }

    for (const row of rows) {
      checked += 1;
      const entryPrice = parseNumber(row.entry_price);
      if (!entryPrice || entryPrice <= 0) {
        updates.push({
          id: row.id,
          status: 'expired',
          stop_reason: 'invalid_entry_price',
          next_check_at: null,
        });
        expired += 1;
        continue;
      }

      const closeAt = new Date(row.monitor_close_at);
      const currentBar = series.length > 0 ? findLastBarOnOrBefore(series, now) : undefined;

      if (!currentBar) {
        dataUnavailable += 1;
        if (now >= closeAt) {
          updates.push({
            id: row.id,
            status: 'expired',
            stop_reason: 'market_close',
            next_check_at: null,
            last_price: null,
            last_price_ts: null,
          });
          expired += 1;
        } else {
          const nextCheckMs = Math.min(now.getTime() + DATA_UNAVAILABLE_BACKOFF_MS, closeAt.getTime());
          const nextCheckIso = new Date(nextCheckMs).toISOString();
          updates.push({
            id: row.id,
            next_check_at: nextCheckIso,
            last_price: null,
            last_price_ts: null,
          });
          rescheduled += 1;
        }
        continue;
      }

      const currentPrice = currentBar.close ?? currentBar.open;
      const barTimestamp = currentBar.timestamp;
      if (!currentPrice || currentPrice <= 0) {
        dataUnavailable += 1;
        const nextCheckMs = Math.min(now.getTime() + DATA_UNAVAILABLE_BACKOFF_MS, closeAt.getTime());
        updates.push({
          id: row.id,
          next_check_at: new Date(nextCheckMs).toISOString(),
          last_price: null,
          last_price_ts: null,
        });
        rescheduled += 1;
        continue;
      }

      const movePct = (currentPrice - entryPrice) / entryPrice;
      const fifteenPctThreshold = 0.15;
      const fivePctThreshold = 0.05;
      const update: PriceWatchUpdate = {
        id: row.id,
        last_price: currentPrice,
        last_price_ts: barTimestamp,
      };

      if (movePct >= fifteenPctThreshold) {
        update.status = 'expired';
        update.stop_reason = 'above_15pct';
        update.next_check_at = null;
        exceededFifteenPct += 1;
        expired += 1;
      } else if (movePct <= fivePctThreshold) {
        const triggeredAtIso = nowIso;
        update.status = 'triggered';
        update.stop_reason = 'triggered';
        update.next_check_at = null;
        update.triggered_at = triggeredAtIso;
        update.triggered_price = currentPrice;
        update.triggered_move_pct = movePct;

        const alert: PriceWatchAlertInfo = {
          watchId: row.id,
          postId: row.post_id,
          ticker,
          title: row.reddit_posts?.title ?? '(unknown title)',
          url: row.reddit_posts?.url ?? '',
          qualityScore: Number(row.quality_score ?? 0),
          entryPrice,
          entryPriceObservedAtIso: row.entry_price_ts ?? row.emailed_at,
          currentPrice,
          movePct,
          triggeredAtIso,
          emailedAtIso: row.emailed_at,
        };
        alerts.push(alert);
      } else if (now >= closeAt) {
        update.status = 'expired';
        update.stop_reason = 'market_close';
        update.next_check_at = null;
        expired += 1;
      } else {
        const nextCheckMs = Math.min(now.getTime() + CHECK_INTERVAL_MS, closeAt.getTime());
        update.next_check_at = new Date(nextCheckMs).toISOString();
        rescheduled += 1;
      }

      updates.push(update);
    }
  }

  if (updates.length > 0) {
    await applyUpdates(supabase, updates, requestLogger);
  }

  return {
    checked,
    triggered: alerts,
    expired,
    rescheduled,
    dataUnavailable,
    exceededFifteenPct,
  };
}
