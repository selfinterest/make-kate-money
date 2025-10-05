import type { Context } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../lib/logger';
import { parseEnv } from '../lib/config';
import { getSupabaseClient } from '../lib/db';
import { TiingoClient, findFirstBarOnOrAfter, findLastBarOnOrBefore } from '../lib/tiingo';
import { addDays, easternDateTime, getEasternComponents, isEasternWeekend, startOfEasternDay } from '../lib/time';
import type { PositionReport, ReportPayload, ReportSummary } from '../lib/performance-types';
import { sendPerformanceReportEmail } from '../lib/email';

interface LambdaEvent {
  runDate?: string;
}

interface SupabaseRow {
  post_id: string;
  title: string;
  body?: string | null;
  author: string | null;
  url: string;
  detected_tickers: string[] | null;
  reason: string | null;
  emailed_at: string;
  created_utc: string;
  subreddit: string | null;
}

interface PositionCandidate {
  ticker: string;
  postId: string;
  title: string;
  author: string | null;
  url: string;
  reason: string | null;
  emailedAt: string;
  createdUtc: string;
  subreddit: string | null;
  entryTime?: Date;
  entryAdjustment?: string;
  error?: string;
}

const INVESTMENT_USD = 1000;
const MARKET_OPEN_MINUTES = 10 * 60; // 10:00 ET
const MARKET_CLOSE_MINUTES = 16 * 60; // 16:00 ET

function sanitizeTicker(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed || trimmed.length > 8) return null;
  if (!/^[A-Z\.]+$/.test(trimmed)) return null;
  return trimmed;
}

function appearsInTitleAsTicker(title: string, ticker: string): boolean {
  if (!title) return false;
  // Allow cashtag in any case, but bare ticker must be uppercase in source
  const cashtag = new RegExp(`\\$${ticker}\\b`, 'i');
  const bareUpper = new RegExp(`\\b${ticker}\\b`);
  return cashtag.test(title) || bareUpper.test(title);
}

function appearsInTextAsTicker(title: string, body: string | null | undefined, ticker: string): boolean {
  const text = `${title}\n${body ?? ''}`;
  if (!text) return false;
  const cashtag = new RegExp(`\\$${ticker}\\b`, 'i');
  const bareUpper = new RegExp(`\\b${ticker}\\b`);
  return cashtag.test(text) || bareUpper.test(text);
}

// Some tokens are common English words and generate legacy false positives.
// For these, require explicit presence in the text; otherwise trust detected_tickers.
const AMBIGUOUS_TICKERS = new Set<string>([
  'CAN', 'ARE', 'ALL', 'FOR', 'RUN', 'EDIT', 'IT', 'ON', 'OR', 'ANY', 'ONE', 'AI', 'EV', 'DD'
]);

function nextTradingDayStart(day: Date): Date {
  let candidate = addDays(day, 1);
  while (isEasternWeekend(candidate)) {
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

function computeEntryTime(emailedAtIso: string): { entry: Date | null; note?: string; error?: string } {
  const emailed = new Date(emailedAtIso);
  if (Number.isNaN(emailed.getTime())) {
    return { entry: null, error: 'Invalid emailed_at timestamp' };
  }

  const components = getEasternComponents(emailed);
  const minutes = components.hour * 60 + components.minute;
  const sameDayStart = startOfEasternDay(emailed);

  if (isEasternWeekend(emailed)) {
    const next = nextTradingDayStart(sameDayStart);
    const nextComp = getEasternComponents(next);
    const entry = easternDateTime(nextComp.year, nextComp.month, nextComp.day, 10, 0);
    return { entry, note: 'Weekend -> Monday 10:00 ET' };
  }

  if (minutes < MARKET_OPEN_MINUTES) {
    const entry = easternDateTime(components.year, components.month, components.day, 10, 0);
    return { entry, note: 'Pre-market -> 10:00 ET' };
  }

  if (minutes >= MARKET_CLOSE_MINUTES) {
    const next = nextTradingDayStart(sameDayStart);
    const nextComp = getEasternComponents(next);
    const entry = easternDateTime(nextComp.year, nextComp.month, nextComp.day, 10, 0);
    return { entry, note: 'Post-market -> next trading day 10:00 ET' };
  }

  const entry = easternDateTime(components.year, components.month, components.day, components.hour, components.minute);
  return { entry }; // In-hours, no adjustment needed
}

function ensurePrice(value?: number): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return null;
}

async function findNearestLookbackDayWithEmails(
  supabase: ReturnType<typeof getSupabaseClient>,
  startEtDayStart: Date,
  runEtDayStart: Date,
  maxBackDays: number,
  logCtx: ReturnType<typeof logger.withContext>
): Promise<{ selected: Date; shiftedBy: number }> {
  for (let delta = 0; delta <= maxBackDays; delta += 1) {
    const candidates: Array<{ date: Date; shift: number }> = [];
    // Prefer exact, then previous days, then forward days, per delta ordering
    candidates.push({ date: addDays(startEtDayStart, -delta), shift: -delta });
    if (delta > 0) {
      const forward = addDays(startEtDayStart, delta);
      // Do not go beyond the run day (can't look into the future window)
      if (forward.getTime() < runEtDayStart.getTime()) {
        candidates.push({ date: forward, shift: delta });
      }
    }

    for (const c of candidates) {
      const next = addDays(c.date, 1);
      const { data, error } = await supabase
        .from('reddit_posts')
        .select('post_id')
        .not('emailed_at', 'is', null)
        .gte('emailed_at', c.date.toISOString())
        .lt('emailed_at', next.toISOString())
        .limit(1);
      if (error) {
        throw error;
      }
      if ((data ?? []).length > 0) {
        if (c.shift !== 0) {
          logCtx.info('Adjusted lookback ET day to nearest with emails', {
            requestedEtStart: startEtDayStart.toISOString(),
            selectedEtStart: c.date.toISOString(),
            shiftedByDays: c.shift,
          });
        }
        return { selected: c.date, shiftedBy: c.shift };
      }
    }
  }
  return { selected: startEtDayStart, shiftedBy: 0 };
}

export async function handler(event: LambdaEvent, context: Context): Promise<ReportPayload> {
  const start = Date.now();
  const log = logger.withContext({ requestId: context.awsRequestId, fn: 'performance-report' });

  try {
    const config = await parseEnv();
    const supabase = getSupabaseClient(config);
    const tiingo = new TiingoClient(config.marketData.tiingoApiKey);

    const runBase = event?.runDate ? new Date(event.runDate) : new Date();
    if (Number.isNaN(runBase.getTime())) {
      throw new Error('Invalid runDate provided to performance report lambda');
    }

    const runDayStart = startOfEasternDay(runBase);
    let lookbackDayStart = addDays(runDayStart, -14);
    // If the target day is a weekend, shift to the previous trading day
    while (isEasternWeekend(lookbackDayStart)) {
      lookbackDayStart = addDays(lookbackDayStart, -1);
    }

    // Probe up to 7 days back to find the nearest ET day with any emailed posts
    const { selected: selectedLookbackStart } = await findNearestLookbackDayWithEmails(
      supabase,
      lookbackDayStart,
      runDayStart,
      7,
      log
    );

    lookbackDayStart = selectedLookbackStart;
    const lookbackDayEnd = addDays(lookbackDayStart, 1);

    const runComponents = getEasternComponents(runDayStart);
    const lookbackComponents = getEasternComponents(lookbackDayStart);
    const runCloseTarget = easternDateTime(runComponents.year, runComponents.month, runComponents.day, 16, 0);

    log.info('Generating performance report', {
      runDay: runDayStart.toISOString(),
      lookbackDay: lookbackDayStart.toISOString(),
      supabaseUrl: config.supabase.url,
    });

    const { data, error } = await supabase
      .from('reddit_posts')
      .select('post_id, title, body, author, url, detected_tickers, reason, emailed_at, created_utc, subreddit')
      .not('emailed_at', 'is', null)
      .gte('emailed_at', lookbackDayStart.toISOString())
      .lt('emailed_at', lookbackDayEnd.toISOString())
      .order('emailed_at', { ascending: true });

    if (error) {
      throw error;
    }

    const rows: SupabaseRow[] = (data ?? []) as SupabaseRow[];
    log.info('Supabase query completed', { rowCount: rows.length });

    const candidates: PositionCandidate[] = [];

    for (const row of rows) {
      const tickers = (row.detected_tickers ?? [])
        .map(sanitizeTicker)
        .filter((t): t is string => Boolean(t))
        .filter(t => {
          if (AMBIGUOUS_TICKERS.has(t)) {
            return appearsInTextAsTicker(row.title, row.body, t);
          }
          return true;
        });

      if (!tickers.length) {
        continue;
      }

      const entryInfo = computeEntryTime(row.emailed_at);
      for (const ticker of tickers) {
        candidates.push({
          ticker,
          postId: row.post_id,
          title: row.title,
          author: row.author,
          url: row.url,
          reason: row.reason,
          emailedAt: row.emailed_at,
          createdUtc: row.created_utc,
          subreddit: row.subreddit,
          entryTime: entryInfo.entry ?? undefined,
          entryAdjustment: entryInfo.note,
          error: entryInfo.error,
        });
      }
    }

    // Dedupe: keep only the first emailed post per ticker within the selected ET day
    const dedupedCandidates: PositionCandidate[] = [];
    const seenTickers = new Set<string>();
    for (const c of candidates) {
      if (seenTickers.has(c.ticker)) continue;
      seenTickers.add(c.ticker);
      dedupedCandidates.push(c);
    }

    log.info('Deduped candidates by ticker', { before: candidates.length, after: dedupedCandidates.length });

    const tickerWindows = new Map<string, { start: Date; end: Date }>();

    for (const candidate of dedupedCandidates) {
      if (!candidate.entryTime) {
        continue;
      }
      const start = startOfEasternDay(candidate.entryTime);
      const existing = tickerWindows.get(candidate.ticker);
      if (!existing) {
        tickerWindows.set(candidate.ticker, { start, end: runCloseTarget });
      } else {
        if (start.getTime() < existing.start.getTime()) {
          existing.start = start;
        }
        if (runCloseTarget.getTime() > existing.end.getTime()) {
          existing.end = runCloseTarget;
        }
      }
    }

    const seriesByTicker = new Map<string, Awaited<ReturnType<TiingoClient['fetchIntraday']>>>();
    const tickerErrors = new Map<string, string>();

    for (const [ticker, window] of tickerWindows.entries()) {
      try {
        const series = await tiingo.fetchIntraday({
          ticker,
          start: window.start,
          end: window.end,
          frequency: '1min',
        });
        if (!series.length) {
          tickerErrors.set(ticker, 'No intraday data returned');
        } else {
          seriesByTicker.set(ticker, series);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown Tiingo error';
        tickerErrors.set(ticker, msg);
        log.error('Tiingo fetch failed', { ticker, error: msg });
      }
    }

    const positions: PositionReport[] = [];

    for (const candidate of dedupedCandidates) {
      const { entryTime, ...rest } = candidate;
      const baseReport: PositionReport = {
        ...rest,
        entry: {
          requested: entryTime ? entryTime.toISOString() : candidate.emailedAt,
        },
        exit: {
          requested: runCloseTarget.toISOString(),
        },
      };

      if (candidate.error) {
        baseReport.error = candidate.error;
        positions.push(baseReport);
        continue;
      }

      const series = seriesByTicker.get(candidate.ticker);
      if (!series) {
        const errMsg = tickerErrors.get(candidate.ticker) ?? 'Price series unavailable';
        baseReport.error = errMsg;
        positions.push(baseReport);
        continue;
      }

      const entryBar = entryTime ? findFirstBarOnOrAfter(series, entryTime) : undefined;
      if (!entryBar) {
        baseReport.error = 'No intraday bar on/after entry time';
        positions.push(baseReport);
        continue;
      }

      const exitBar = findLastBarOnOrBefore(series, runCloseTarget);
      if (!exitBar) {
        baseReport.error = 'No intraday bar before close';
        positions.push(baseReport);
        continue;
      }

      const entryPrice = ensurePrice(entryBar.close) ?? ensurePrice(entryBar.open);
      const exitPrice = ensurePrice(exitBar.close) ?? ensurePrice(exitBar.open);

      if (!entryPrice) {
        baseReport.error = 'Entry price unavailable';
        positions.push(baseReport);
        continue;
      }

      if (!exitPrice) {
        baseReport.error = 'Exit price unavailable';
        positions.push(baseReport);
        continue;
      }

      const shares = INVESTMENT_USD / entryPrice;
      const finalValue = shares * exitPrice;
      const profitUsd = finalValue - INVESTMENT_USD;
      const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;

      baseReport.entry.actual = entryBar.timestamp;
      baseReport.entry.price = Number(entryPrice.toFixed(4));
      baseReport.exit.actual = exitBar.timestamp;
      baseReport.exit.price = Number(exitPrice.toFixed(4));
      baseReport.shares = Number(shares.toFixed(6));
      baseReport.finalValue = Number(finalValue.toFixed(2));
      baseReport.profitUsd = Number(profitUsd.toFixed(2));
      baseReport.returnPct = Number(returnPct.toFixed(4));

      positions.push(baseReport);
    }

    const completed = positions.filter(p => !p.error);
    const errored = positions.filter(p => Boolean(p.error));

    const grossInvested = completed.length * INVESTMENT_USD;
    const grossFinalValue = completed.reduce((sum, p) => sum + (p.finalValue ?? 0), 0);
    const netProfit = grossFinalValue - grossInvested;
    const avgReturn = completed.length
      ? completed.reduce((sum, p) => sum + (p.returnPct ?? 0), 0) / completed.length
      : null;
    const wins = completed.filter(p => (p.profitUsd ?? 0) > 0).length;
    const winRate = completed.length ? (wins / completed.length) * 100 : null;

    const best = completed.reduce<{ ticker: string; returnPct: number; profitUsd: number; postId: string } | undefined>((acc, p) => {
      if (!p.returnPct) return acc;
      if (!acc || p.returnPct > acc.returnPct) {
        return {
          ticker: p.ticker,
          returnPct: p.returnPct,
          profitUsd: p.profitUsd ?? 0,
          postId: p.postId,
        };
      }
      return acc;
    }, undefined);

    const worst = completed.reduce<{ ticker: string; returnPct: number; profitUsd: number; postId: string } | undefined>((acc, p) => {
      if (!p.returnPct) return acc;
      if (!acc || p.returnPct < acc.returnPct) {
        return {
          ticker: p.ticker,
          returnPct: p.returnPct,
          profitUsd: p.profitUsd ?? 0,
          postId: p.postId,
        };
      }
      return acc;
    }, undefined);

    const summary: ReportSummary = {
      runDateEt: `${runComponents.year}-${String(runComponents.month).padStart(2, '0')}-${String(runComponents.day).padStart(2, '0')}`,
      lookbackDateEt: `${lookbackComponents.year}-${String(lookbackComponents.month).padStart(2, '0')}-${String(lookbackComponents.day).padStart(2, '0')}`,
      generatedAt: new Date().toISOString(),
      totalPositions: positions.length,
      completedPositions: completed.length,
      erroredPositions: errored.length,
      grossInvestedUsd: Number(grossInvested.toFixed(2)),
      grossFinalValueUsd: Number(grossFinalValue.toFixed(2)),
      netProfitUsd: Number(netProfit.toFixed(2)),
      averageReturnPct: avgReturn !== null ? Number(avgReturn.toFixed(4)) : null,
      winRatePct: winRate !== null ? Number(winRate.toFixed(2)) : null,
      bestPosition: best,
      worstPosition: worst,
      tiingoRequestsUsed: tiingo.getRequestCount(),
    };

    const payload: ReportPayload = {
      meta: summary,
      positions,
    };

    const bucket = process.env.PERFORMANCE_REPORT_BUCKET;
    if (!bucket) {
      throw new Error('PERFORMANCE_REPORT_BUCKET env var is required');
    }

    const [year, month, day] = summary.runDateEt.split('-');
    const key = `reports/${year}/${month}/${day}/lookback-${summary.lookbackDateEt}.json`;

    const s3 = new S3Client({});
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(payload, null, 2),
      ContentType: 'application/json',
    }));

    const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 7 * 24 * 60 * 60 });

    await sendPerformanceReportEmail({
      report: summary,
      completed: completed.map(p => ({
        ticker: p.ticker,
        title: p.title,
        url: p.url,
        author: p.author,
        returnPct: p.returnPct ?? 0,
        profitUsd: p.profitUsd ?? 0,
        entryPrice: p.entry.price,
        exitPrice: p.exit.price,
      })),
      errors: errored.map(p => ({
        ticker: p.ticker,
        title: p.title,
        url: p.url,
        author: p.author,
        error: p.error ?? 'unknown error',
      })),
      downloadUrl,
    }, config);

    log.info('Performance report ready', {
      positions: positions.length,
      completed: completed.length,
      errors: errored.length,
      tiingoRequests: summary.tiingoRequestsUsed,
      bucket,
      key,
    });

    return payload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Performance report failed', { error: msg });
    throw err;
  } finally {
    logger.info('Performance report finished', { ms: Date.now() - start });
  }
}
