import type { Config } from './config';
import { getSupabaseClient } from './db';
import { logger } from './logger';
import { TiingoClient, findLastBarOnOrBefore, type IntradayBar } from './tiingo';
import { parseNumber } from './price-watch';

const DEFAULT_ALERT_THRESHOLD = 0.05;
const FETCH_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

type SupabaseClient = ReturnType<typeof getSupabaseClient>;
type Logger = ReturnType<typeof logger.withContext>;

export interface PortfolioPositionRow {
  id: string;
  user_id: string;
  ticker: string;
  shares: number | string;
  watch: boolean;
  last_price: number | string | null;
  last_price_ts: string | null;
  last_price_source?: string | null;
  alert_threshold_pct: number | string | null;
  last_alert_at: string | null;
  last_alert_price: number | string | null;
  last_alert_move_pct: number | string | null;
  created_at: string;
  updated_at: string;
}

export interface PositionDropAlertInfo {
  positionId: string;
  userId: string;
  ticker: string;
  shares: number;
  previousPrice: number;
  currentPrice: number;
  movePct: number;
  thresholdPct: number;
  checkedAtIso: string;
}

export interface WatchedPositionProcessResult {
  checked: number;
  updated: number;
  alerts: PositionDropAlertInfo[];
  dataUnavailable: number;
}

function groupByTicker(rows: PortfolioPositionRow[]): Map<string, PortfolioPositionRow[]> {
  const map = new Map<string, PortfolioPositionRow[]>();
  for (const row of rows) {
    const ticker = (row.ticker ?? '').toUpperCase();
    if (!ticker) continue;
    if (!map.has(ticker)) {
      map.set(ticker, []);
    }
    map.get(ticker)!.push(row);
  }
  return map;
}

async function fetchWatchedPositions(
  supabase: SupabaseClient,
): Promise<PortfolioPositionRow[]> {
  const { data, error } = await supabase
    .from('portfolio_positions')
    .select(`
      id,
      user_id,
      ticker,
      shares,
      watch,
      last_price,
      last_price_ts,
      last_price_source,
      alert_threshold_pct,
      last_alert_at,
      last_alert_price,
      last_alert_move_pct,
      created_at,
      updated_at
    `)
    .eq('watch', true)
    .gt('shares', 0)
    .limit(500);

  if (error) {
    throw new Error(`Failed to load watched positions: ${error.message}`);
  }

  return (data ?? []) as PortfolioPositionRow[];
}

export async function processWatchedPositions(
  config: Config,
  requestLogger: Logger,
  now: Date = new Date(),
): Promise<WatchedPositionProcessResult> {
  const supabase = getSupabaseClient(config);
  const positions = await fetchWatchedPositions(supabase);

  if (positions.length === 0) {
    return {
      checked: 0,
      updated: 0,
      alerts: [],
      dataUnavailable: 0,
    };
  }

  const grouped = groupByTicker(positions);
  const tiingo = new TiingoClient(config.marketData.tiingoApiKey);
  const updates: Array<Record<string, any>> = [];
  const alerts: PositionDropAlertInfo[] = [];
  const nowIso = now.toISOString();

  let checked = 0;
  let updated = 0;
  let dataUnavailable = 0;

  for (const [ticker, rows] of grouped.entries()) {
    const seriesStart = new Date(now.getTime() - FETCH_LOOKBACK_MS);
    let series: IntradayBar[] = [];

    try {
      series = await tiingo.fetchIntraday({
        ticker,
        start: seriesStart,
        end: now,
        frequency: '5min',
      });
    } catch (error) {
      requestLogger.warn('Failed to fetch Tiingo data for watched position', {
        ticker,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      series = [];
    }

    for (const row of rows) {
      checked += 1;
      const lastBar = series.length > 0 ? findLastBarOnOrBefore(series, now) : undefined;
      if (!lastBar) {
        dataUnavailable += 1;
        continue;
      }

      const currentPrice = parseNumber(lastBar.close) ?? parseNumber(lastBar.open);
      if (!currentPrice || currentPrice <= 0) {
        dataUnavailable += 1;
        continue;
      }

      const previousPrice = parseNumber(row.last_price);
      const shares = parseNumber(row.shares) ?? 0;
      const thresholdRaw = parseNumber(row.alert_threshold_pct);
      const thresholdPct = thresholdRaw && thresholdRaw > 0 ? thresholdRaw : DEFAULT_ALERT_THRESHOLD;

      const update: Record<string, any> = {
        id: row.id,
        user_id: row.user_id,
        ticker: row.ticker.toUpperCase(),
        last_price: currentPrice,
        last_price_ts: lastBar.timestamp,
        last_price_source: 'tiingo_intraday',
        updated_at: nowIso,
      };

      let movePct: number | null = null;
      if (previousPrice && previousPrice > 0) {
        movePct = (currentPrice - previousPrice) / previousPrice;
        if (movePct <= -thresholdPct) {
          alerts.push({
            positionId: row.id,
            userId: row.user_id,
            ticker: row.ticker.toUpperCase(),
            shares,
            previousPrice,
            currentPrice,
            movePct,
            thresholdPct,
            checkedAtIso: nowIso,
          });
          update.last_alert_at = nowIso;
          update.last_alert_price = currentPrice;
          update.last_alert_move_pct = movePct;
        }
      }

      updates.push(update);
      updated += 1;
    }
  }

  if (updates.length > 0) {
    const { error } = await supabase
      .from('portfolio_positions')
      .upsert(updates, { onConflict: 'id' });

    if (error) {
      requestLogger.error('Failed to persist watched position updates', {
        error: error.message,
        updateCount: updates.length,
      });
      throw new Error(`Failed to update portfolio positions: ${error.message}`);
    }
  }

  return {
    checked,
    updated,
    alerts,
    dataUnavailable,
  };
}
