import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger';
import type { Config } from './config';
import type { Prefiltered } from './prefilter';
import type { LlmResult } from './llm';

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(config: Config): SupabaseClient {
  if (!supabaseClient) {
    supabaseClient = createClient(
      config.supabase.url,
      config.supabase.apiKey,
    );
  }
  return supabaseClient;
}

export interface DatabasePost {
  post_id: string;
  title: string;
  body: string;
  subreddit: string;
  author: string;
  url: string;
  created_utc: string;
  score: number;
  detected_tickers: string[];
  llm_tickers: string[];
  is_future_upside_claim: boolean | null;
  stance: string | null;
  reason: string | null;
  quality_score: number | null;
  emailed_at: string | null;
  processed_at: string;
}

export interface EmailCandidate {
  post_id: string;
  title: string;
  url: string;
  reason: string;
  tickers: string[];
  llm_tickers: string[];
  detected_tickers: string[];
  quality_score: number;
  created_utc: string;
  priceInsights?: Array<{
    ticker: string;
    entryPrice?: number | null;
    entryTimestamp?: string | null;
    latestPrice?: number | null;
    latestTimestamp?: string | null;
    movePct?: number | null;
    exceedsThreshold?: boolean;
    dataUnavailable?: boolean;
  }>;
  priceAlert?: {
    thresholdPct: number;
    anyExceeded: boolean;
    maxMovePct?: number | null;
    dataUnavailableCount?: number;
  };
  performance_hint?: {
    bestAvgReturnPct: number;
    roiBoost: number;
  };
}

export interface PerformanceRecord {
  postId: string;
  ticker: string;
  returnPct?: number | null;
  profitUsd?: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  lookbackDate?: string | null;
  runDate?: string | null;
  emailedAt?: string | null;
  subreddit?: string | null;
  author?: string | null;
}

export interface TickerPerformanceIncrement {
  ticker: string;
  sampleSize: number;
  sumReturnPct: number;
  winCount: number;
  lastRunDate?: string | null;
}

export async function getCursor(config: Config, key: string): Promise<string> {
  const supabase = getSupabaseClient(config);

  try {
    logger.debug('Fetching cursor from database', { key });

    const { data, error } = await supabase
      .from('app_meta')
      .select('value')
      .eq('key', key)
      .single();

    if (error) {
      if (error.code === 'PGRST116') { // No rows returned
        logger.info('No cursor found, using epoch', { key });
        return '1970-01-01T00:00:00Z';
      }
      throw error;
    }

    const cursorValue = (data as any)?.value?.created_utc ?? '1970-01-01T00:00:00Z';
    logger.debug('Retrieved cursor', { key, cursor: cursorValue });
    return cursorValue;

  } catch (error) {
    logger.error('Failed to get cursor', {
      key,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error(`Failed to get cursor: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function setCursor(
  config: Config,
  key: string,
  posts: { createdUtc: string }[],
): Promise<void> {
  if (posts.length === 0) {
    logger.debug('No posts to update cursor with', { key });
    return;
  }

  const supabase = getSupabaseClient(config);

  try {
    const latest = posts.reduce((max, post) => {
      const postTime = new Date(post.createdUtc).getTime();
      const maxTime = new Date(max).getTime();
      return postTime > maxTime ? post.createdUtc : max;
    }, '1970-01-01T00:00:00Z');

    logger.debug('Updating cursor', { key, newCursor: latest, postCount: posts.length });

    const { error } = await supabase
      .from('app_meta')
      .upsert({
        key,
        value: { created_utc: latest } as any,
        updated_at: new Date().toISOString(),
      } as any);

    if (error) {
      throw error;
    }

    logger.info('Cursor updated successfully', { key, cursor: latest });

  } catch (error) {
    logger.error('Failed to set cursor', {
      key,
      postCount: posts.length,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error(`Failed to set cursor: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function upsertPosts(
  config: Config,
  candidates: Prefiltered[],
  results: LlmResult[],
): Promise<void> {
  if (candidates.length === 0) {
    logger.debug('No candidates to upsert');
    return;
  }

  const supabase = getSupabaseClient(config);

  try {
    const resultsById = new Map(results.map(r => [r.post_id, r]));

    const rows = candidates.map(candidate => {
      const llmResult = resultsById.get(candidate.post.id);

      return {
        post_id: candidate.post.id,
        title: candidate.post.title,
        body: candidate.post.selftext ?? '',
        subreddit: candidate.post.subreddit,
        author: candidate.post.author,
        url: candidate.post.url,
        created_utc: candidate.post.createdUtc,
        score: candidate.post.score,
        detected_tickers: candidate.tickers,
        llm_tickers: llmResult?.tickers ?? [],
        is_future_upside_claim: llmResult?.is_future_upside_claim ?? null,
        stance: llmResult?.stance ?? null,
        reason: llmResult?.reason ?? null,
        quality_score: llmResult?.quality_score ?? null,
        processed_at: new Date().toISOString(),
      };
    });

    logger.info('Upserting posts to database', {
      candidateCount: candidates.length,
      llmResultCount: results.length,
      rowCount: rows.length,
    });

    const { error } = await supabase
      .from('reddit_posts')
      .upsert(rows as any, { onConflict: 'post_id' });

    if (error) {
      throw error;
    }

    logger.info('Posts upserted successfully', { rowCount: rows.length });

  } catch (error) {
    logger.error('Failed to upsert posts', {
      candidateCount: candidates.length,
      resultCount: results.length,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error(`Failed to upsert posts: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function selectForEmail(
  config: Config,
  options: { minQuality: number },
): Promise<EmailCandidate[]> {
  const supabase = getSupabaseClient(config);

  try {
    logger.debug('Selecting posts for email', { minQuality: options.minQuality });

    const { data, error } = await supabase
      .from('reddit_posts')
      .select('post_id, title, url, reason, detected_tickers, llm_tickers, quality_score, created_utc')
      .is('emailed_at', null)
      .eq('is_future_upside_claim', true)
      .eq('stance', 'bullish')
      .gte('quality_score', options.minQuality)
      .order('created_utc', { ascending: true });

    if (error) {
      throw error;
    }

    const candidates: EmailCandidate[] = (data ?? []).map(row => {
      const llmTickers = Array.isArray((row as any).llm_tickers)
        ? ((row as any).llm_tickers as string[])
        : [];
      const detectedTickers = Array.isArray((row as any).detected_tickers)
        ? ((row as any).detected_tickers as string[])
        : [];

      return {
        ...(row as any),
        llm_tickers: llmTickers,
        detected_tickers: detectedTickers,
        tickers: llmTickers.length > 0 ? llmTickers : detectedTickers,
      };
    });

    const tickerSet = new Set<string>();
    candidates.forEach(candidate => {
      (candidate.tickers ?? []).forEach(t => tickerSet.add(t.toUpperCase()));
    });

    // Reputation-aware ranking: compute author and subreddit reputation
    // Fetch recent history for involved authors and subreddits and compute average quality
    const authorSet = new Set<string>();
    const subredditSet = new Set<string>();

    // We need authors and subreddits; fetch them for the candidate posts
    // Pull minimal extra fields for authors/subreddits lookup
    const { data: metaRows } = await supabase
      .from('reddit_posts')
      .select('post_id, author, subreddit')
      .in('post_id', candidates.map(c => c.post_id));

    metaRows?.forEach((row: any) => {
      if (row.author) authorSet.add(row.author);
      if (row.subreddit) subredditSet.add(row.subreddit);
    });

    const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Author history
    let authorHistory: any[] = [];
    if (authorSet.size > 0) {
      const { data: ah } = await supabase
        .from('reddit_posts')
        .select('author, quality_score, is_future_upside_claim, stance, created_utc')
        .in('author', Array.from(authorSet))
        .gte('created_utc', thirtyDaysAgoIso)
        .limit(2000);
      authorHistory = ah ?? [];
    }

    // Subreddit history
    let subredditHistory: any[] = [];
    if (subredditSet.size > 0) {
      const { data: sh } = await supabase
        .from('reddit_posts')
        .select('subreddit, quality_score, is_future_upside_claim, stance, created_utc')
        .in('subreddit', Array.from(subredditSet))
        .gte('created_utc', thirtyDaysAgoIso)
        .limit(5000);
      subredditHistory = sh ?? [];
    }

    const authorToAvgQuality = new Map<string, number>();
    const subredditToAvgQuality = new Map<string, number>();

    if (authorHistory.length > 0) {
      const sums = new Map<string, { sum: number; count: number }>();
      authorHistory.forEach(row => {
        if (row.is_future_upside_claim && row.stance === 'bullish' && typeof row.quality_score === 'number') {
          const prev = sums.get(row.author) || { sum: 0, count: 0 };
          prev.sum += row.quality_score;
          prev.count += 1;
          sums.set(row.author, prev);
        }
      });
      sums.forEach((v, k) => {
        authorToAvgQuality.set(k, v.count > 0 ? v.sum / v.count : 0);
      });
    }

    if (subredditHistory.length > 0) {
      const sums = new Map<string, { sum: number; count: number }>();
      subredditHistory.forEach(row => {
        if (row.is_future_upside_claim && row.stance === 'bullish' && typeof row.quality_score === 'number') {
          const prev = sums.get(row.subreddit) || { sum: 0, count: 0 };
          prev.sum += row.quality_score;
          prev.count += 1;
          sums.set(row.subreddit, prev);
        }
      });
      sums.forEach((v, k) => {
        subredditToAvgQuality.set(k, v.count > 0 ? v.sum / v.count : 0);
      });
    }

    const tickerToStats = new Map<string, { avgReturnPct: number; winRatePct: number; sampleSize: number }>();
    if (tickerSet.size > 0) {
      const { data: tickerRows, error: tickerError } = await supabase
        .from('ticker_performance')
        .select('ticker, avg_return_pct, win_rate_pct, sample_size')
        .in('ticker', Array.from(tickerSet));

      if (tickerError) {
        throw tickerError;
      }

      (tickerRows ?? []).forEach((row: any) => {
        const ticker = typeof row.ticker === 'string' ? row.ticker.toUpperCase() : '';
        if (!ticker) return;
        const avgReturn = typeof row.avg_return_pct === 'number' ? row.avg_return_pct : Number(row.avg_return_pct ?? 0);
        const winRate = typeof row.win_rate_pct === 'number' ? row.win_rate_pct : Number(row.win_rate_pct ?? 0);
        const sampleSize = typeof row.sample_size === 'number' ? row.sample_size : Number(row.sample_size ?? 0);
        tickerToStats.set(ticker, {
          avgReturnPct: avgReturn,
          winRatePct: winRate,
          sampleSize,
        });
      });
    }

    // Map candidate post_id to author/subreddit for scoring
    const idToMeta = new Map<string, { author?: string; subreddit?: string }>();
    metaRows?.forEach((row: any) => idToMeta.set(row.post_id, { author: row.author, subreddit: row.subreddit }));

    // Compute composite score: base quality + author/subreddit reputation boosts
    const scored = candidates.map(c => {
      const meta = idToMeta.get(c.post_id) || {};
      const authorAvg = meta.author ? authorToAvgQuality.get(meta.author) ?? 0 : 0;
      const subredditAvg = meta.subreddit ? subredditToAvgQuality.get(meta.subreddit) ?? 0 : 0;
      const base = typeof (c as any).quality_score === 'number' ? (c as any).quality_score : 0;
      const tickerRois = (c.tickers ?? []).map(t => tickerToStats.get(t.toUpperCase())?.avgReturnPct ?? 0);
      const bestTickerRoi = tickerRois.length ? Math.max(...tickerRois) : 0;
      const roiBoost = Math.max(-1, Math.min(bestTickerRoi * 6, 3));
      const score = base + 0.3 * authorAvg + 0.2 * subredditAvg + roiBoost;
      (c as any).performance_hint = {
        bestAvgReturnPct: bestTickerRoi,
        roiBoost,
      };
      return { c, score, authorAvg, subredditAvg, roiBoost };
    });

    scored.sort((a, b) => b.score - a.score);
    const ranked = scored.map(s => s.c);

    logger.info('Selected posts for email', {
      candidateCount: candidates.length,
      minQuality: options.minQuality,
      authorsConsidered: authorSet.size,
      subredditsConsidered: subredditSet.size,
      tickersConsidered: tickerSet.size,
      tickersWithPerformance: Array.from(tickerToStats.keys()).length,
    });

    return ranked;

  } catch (error) {
    logger.error('Failed to select posts for email', {
      minQuality: options.minQuality,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error(`Failed to select posts for email: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function markEmailed(config: Config, postIds: string[], emailedAtIso?: string): Promise<void> {
  if (postIds.length === 0) {
    logger.debug('No posts to mark as emailed');
    return;
  }

  const supabase = getSupabaseClient(config);
  const timestamp = emailedAtIso ?? new Date().toISOString();

  try {
    logger.info('Marking posts as emailed', { postCount: postIds.length });

    const { error } = await supabase
      .from('reddit_posts')
      .update({ emailed_at: timestamp } as any)
      .in('post_id', postIds);

    if (error) {
      throw error;
    }

    logger.info('Posts marked as emailed successfully', { postCount: postIds.length });

  } catch (error) {
    logger.error('Failed to mark posts as emailed', {
      postCount: postIds.length,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error(`Failed to mark posts as emailed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function upsertPostPerformance(
  config: Config,
  records: PerformanceRecord[],
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  const supabase = getSupabaseClient(config);

  const rows = records.map(record => ({
    post_id: record.postId,
    ticker: record.ticker,
    return_pct: record.returnPct ?? null,
    profit_usd: record.profitUsd ?? null,
    entry_price: record.entryPrice ?? null,
    exit_price: record.exitPrice ?? null,
    lookback_date: record.lookbackDate ?? null,
    run_date: record.runDate ?? null,
    emailed_at: record.emailedAt ?? null,
    subreddit: record.subreddit ?? null,
    author: record.author ?? null,
    created_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('post_performance')
    .upsert(rows as any, { onConflict: 'post_id' });

  if (error) {
    logger.error('Failed to upsert post performance', {
      error: error.message,
      recordCount: records.length,
    });
    throw error;
  }
}

export async function applyTickerPerformanceIncrements(
  config: Config,
  increments: TickerPerformanceIncrement[],
): Promise<void> {
  if (increments.length === 0) {
    return;
  }

  const supabase = getSupabaseClient(config);
  const tickers = increments.map(inc => inc.ticker);

  const { data: existingRows, error: selectError } = await supabase
    .from('ticker_performance')
    .select('ticker, sample_size, sum_return_pct, win_count')
    .in('ticker', tickers);

  if (selectError) {
    logger.error('Failed to fetch existing ticker performance', {
      error: selectError.message,
    });
    throw selectError;
  }

  const existingMap = new Map<string, { sample_size: number; sum_return_pct: number; win_count: number }>();
  (existingRows ?? []).forEach(row => {
    existingMap.set(row.ticker, {
      sample_size: row.sample_size ?? 0,
      sum_return_pct: Number(row.sum_return_pct ?? 0),
      win_count: row.win_count ?? 0,
    });
  });

  const rows = increments.map(inc => {
    const prior = existingMap.get(inc.ticker) ?? { sample_size: 0, sum_return_pct: 0, win_count: 0 };
    const newSampleSize = prior.sample_size + inc.sampleSize;
    const newSum = prior.sum_return_pct + inc.sumReturnPct;
    const newWinCount = prior.win_count + inc.winCount;
    const avgReturn = newSampleSize > 0 ? newSum / newSampleSize : 0;
    const winRate = newSampleSize > 0 ? newWinCount / newSampleSize : 0;

    return {
      ticker: inc.ticker,
      sample_size: newSampleSize,
      sum_return_pct: newSum,
      win_count: newWinCount,
      avg_return_pct: avgReturn,
      win_rate_pct: winRate,
      last_run_date: inc.lastRunDate ?? null,
      updated_at: new Date().toISOString(),
    };
  });

  const { error } = await supabase
    .from('ticker_performance')
    .upsert(rows as any, { onConflict: 'ticker' });

  if (error) {
    logger.error('Failed to update ticker performance', {
      error: error.message,
      tickerCount: increments.length,
    });
    throw error;
  }
}
