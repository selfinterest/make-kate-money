import type { EventBridgeEvent, Context } from 'aws-lambda';
import { parseEnv } from '../lib/config';
import type { Config } from '../lib/config';
import { fetchNew } from '../lib/reddit';
import { prefilterBatch } from '../lib/prefilter';
import { classifyBatch } from '../lib/llm';
import { getCursor, setCursor, upsertPosts, selectForEmail, markEmailed } from '../lib/db';
import type { EmailCandidate } from '../lib/db';
import { sendDigest, sendPriceWatchAlerts } from '../lib/email';
import { logger } from '../lib/logger';
import { TiingoClient, findFirstBarOnOrAfter, findLastBarOnOrBefore } from '../lib/tiingo';
import {
  schedulePriceWatches,
  processPriceWatchQueue,
  type PriceWatchProcessResult,
  type PriceWatchSeed,
} from '../lib/price-watch';

interface PollResponse {
  ok: boolean;
  fetched: number;
  candidates: number;
  llmClassified: number;
  emailed: number;
  error?: string;
  executionTime?: number;
}

function computeVotesPerMinute(createdUtc: string, score: number, referenceMs: number): number {
  const createdMs = new Date(createdUtc).getTime();
  if (Number.isNaN(createdMs)) {
    return 0;
  }

  const ageMinutes = Math.max((referenceMs - createdMs) / 60000, 1 / 60);
  return score / ageMinutes;
}

async function annotateCandidatesWithPriceMove(
  candidates: EmailCandidate[],
  config: Config,
  requestLogger: ReturnType<typeof logger.withContext>,
): Promise<{ annotated: EmailCandidate[]; exceededCount: number; dataUnavailableCount: number }> {
  if (candidates.length === 0) {
    return { annotated: candidates, exceededCount: 0, dataUnavailableCount: 0 };
  }

  const maxMove = config.app.maxPriceMovePctForAlert;
  const thresholdForComparison = maxMove > 0 ? maxMove : Number.POSITIVE_INFINITY;

  const tiingo = new TiingoClient(config.marketData.tiingoApiKey);
  const now = new Date();
  const nowMs = now.getTime();
  const paddingMs = 60 * 60 * 1000; // 1 hour to ensure we capture the first tradable bar
  const maxLookbackMs = 3 * 24 * 60 * 60 * 1000; // limit to last 3 days of intraday data

  const tickerWindows = new Map<string, { startMs: number }>();

  for (const candidate of candidates) {
    const createdMs = new Date(candidate.created_utc).getTime();
    if (Number.isNaN(createdMs)) {
      continue;
    }

    const startMs = Math.max(createdMs - paddingMs, nowMs - maxLookbackMs);
    const sourceTickers = (candidate.tickers && candidate.tickers.length > 0
      ? candidate.tickers
      : candidate.detected_tickers ?? []);
    const uniqueTickers = Array.from(new Set(sourceTickers.map(t => t.toUpperCase())));

    for (const ticker of uniqueTickers) {
      const current = tickerWindows.get(ticker);
      if (!current || startMs < current.startMs) {
        tickerWindows.set(ticker, { startMs });
      }
    }
  }

  const tickerSeries = new Map<string, Awaited<ReturnType<TiingoClient['fetchIntraday']>> | null>();

  for (const [ticker, window] of tickerWindows.entries()) {
    try {
      const bars = await tiingo.fetchIntraday({
        ticker,
        start: new Date(window.startMs),
        end: now,
        frequency: '5min',
      });
      tickerSeries.set(ticker, bars);
    } catch (error) {
      requestLogger.warn('Failed to fetch Tiingo data for ticker', {
        ticker,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      tickerSeries.set(ticker, null);
    }
  }

  const annotated: EmailCandidate[] = [];
  let exceededCount = 0;
  let dataUnavailableCount = 0;

  for (const candidate of candidates) {
    const createdMs = new Date(candidate.created_utc).getTime();
    const tickers = Array.from(new Set((candidate.tickers && candidate.tickers.length > 0
      ? candidate.tickers
      : candidate.detected_tickers ?? []).map(t => t.toUpperCase())));

    const insights: EmailCandidate['priceInsights'] = [];
    let anyExceeded = false;
    let maxObservedMove: number | null = null;
    let unavailableForCandidate = 0;

    if (!Number.isNaN(createdMs) && tickers.length > 0) {
      for (const ticker of tickers) {
        const series = tickerSeries.get(ticker);
        if (!series || series.length === 0) {
          insights.push({ ticker, dataUnavailable: true });
          unavailableForCandidate += 1;
          continue;
        }

        const createdDate = new Date(createdMs);
        // Use the most recent bar at or before the post time so we capture
        // a price even if the next bar hasn't printed yet (e.g. post created
        // between intraday intervals). If none exists, fall back to the next
        // available bar so we still provide a reasonable entry price.
        const entryBar = findLastBarOnOrBefore(series, createdDate)
          ?? findFirstBarOnOrAfter(series, createdDate);
        const latestBar = findLastBarOnOrBefore(series, now);

        const entryPrice = entryBar?.close ?? entryBar?.open ?? null;
        const latestPrice = latestBar?.close ?? latestBar?.open ?? null;
        const entryTimestamp = entryBar?.timestamp ?? null;
        const latestTimestamp = latestBar?.timestamp ?? null;

        if (!entryPrice || !latestPrice || entryPrice <= 0 || latestPrice <= 0) {
          insights.push({ ticker, entryPrice, entryTimestamp, latestPrice, latestTimestamp, dataUnavailable: true });
          unavailableForCandidate += 1;
          continue;
        }

        const movePct = (latestPrice - entryPrice) / entryPrice;
        const absMove = Math.abs(movePct);
        if (absMove >= thresholdForComparison && thresholdForComparison !== Number.POSITIVE_INFINITY) {
          anyExceeded = true;
        }
        if (maxObservedMove === null || absMove > maxObservedMove) {
          maxObservedMove = absMove;
        }

        insights.push({
          ticker,
          entryPrice,
          entryTimestamp,
          latestPrice,
          latestTimestamp,
          movePct,
          exceedsThreshold: thresholdForComparison !== Number.POSITIVE_INFINITY && absMove >= thresholdForComparison,
        });
      }
    } else {
      if (tickers.length === 0) {
        insights.push({ ticker: 'N/A', dataUnavailable: true });
        unavailableForCandidate += 1;
      } else {
        unavailableForCandidate += tickers.length;
        for (const ticker of tickers) {
          insights.push({ ticker, dataUnavailable: true });
        }
      }
    }

    if (anyExceeded) {
      exceededCount += 1;
    }
    dataUnavailableCount += unavailableForCandidate;

    annotated.push({
      ...candidate,
      priceInsights: insights,
      priceAlert: {
        thresholdPct: maxMove,
        anyExceeded,
        maxMovePct: maxObservedMove,
        dataUnavailableCount: unavailableForCandidate,
      },
    });
  }

  return { annotated, exceededCount, dataUnavailableCount };
}

const EMPTY_PRICE_WATCH_RESULT: PriceWatchProcessResult = {
  checked: 0,
  triggered: [],
  expired: 0,
  rescheduled: 0,
  dataUnavailable: 0,
  exceededFifteenPct: 0,
};

async function handlePriceWatchProcessing(
  config: Config,
  requestLogger: ReturnType<typeof logger.withContext>,
  phase: string,
): Promise<PriceWatchProcessResult> {
  try {
    const result = await processPriceWatchQueue(config, requestLogger);

    if (result.checked > 0 || result.triggered.length > 0 || result.expired > 0 || result.rescheduled > 0) {
      requestLogger.info('Processed price watch queue', {
        phase,
        checked: result.checked,
        triggered: result.triggered.length,
        expired: result.expired,
        rescheduled: result.rescheduled,
        dataUnavailable: result.dataUnavailable,
        exceededFifteenPct: result.exceededFifteenPct,
      });
    }

    if (result.triggered.length > 0) {
      try {
        await sendPriceWatchAlerts(result.triggered, config);
      } catch (error) {
        requestLogger.error('Failed to send price watch alerts', {
          phase,
          alertCount: result.triggered.length,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return result;
  } catch (error) {
    requestLogger.error('Price watch processing failed', {
      phase,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return { ...EMPTY_PRICE_WATCH_RESULT };
  }
}

function buildPriceWatchSeeds(
  candidates: EmailCandidate[],
  emailedAtIso: string,
): PriceWatchSeed[] {
  const seeds: PriceWatchSeed[] = [];
  for (const candidate of candidates) {
    const quality = typeof candidate.quality_score === 'number' ? candidate.quality_score : null;
    if (!quality || quality < 4) {
      continue;
    }

    const insights = candidate.priceInsights ?? [];
    for (const insight of insights) {
      if (insight.dataUnavailable) {
        continue;
      }
      const latestPrice = typeof insight.latestPrice === 'number' ? insight.latestPrice : null;
      if (!latestPrice || latestPrice <= 0) {
        continue;
      }

      const ticker = insight.ticker?.toUpperCase?.() ?? insight.ticker;
      if (!ticker) {
        continue;
      }

      const observedAt = insight.latestTimestamp ?? emailedAtIso;
      seeds.push({
        postId: candidate.post_id,
        ticker,
        qualityScore: quality,
        emailedAtIso,
        entryPrice: latestPrice,
        entryPriceObservedAtIso: observedAt,
      });
    }
  }
  return seeds;
}

export async function handler(
  event: EventBridgeEvent<string, any>,
  context: Context,
): Promise<PollResponse> {
  const startTime = Date.now();
  const requestLogger = logger.withContext({
    requestId: context.awsRequestId,
    functionName: context.functionName,
    source: event.source,
  });

  requestLogger.info('Poll request started');

  try {
    // Parse and validate configuration
    const config = await parseEnv();
    requestLogger.info('Configuration loaded', {
      subreddits: config.app.subreddits,
      llmProvider: config.llm.provider,
      maxPosts: config.app.maxPostsPerRun,
    });

    await handlePriceWatchProcessing(config, requestLogger, 'pre-run');

    // Optional: test email path
    const testEmailFlag = (event as any)?.testEmail ?? (event as any)?.detail?.testEmail;
    if (testEmailFlag) {
      requestLogger.info('Test email flag detected; sending test email');
      const nowIso = new Date().toISOString();
      const sample: EmailCandidate = {
        post_id: 'test-post',
        title: 'Test email from Reddit Stock Watcher',
        url: 'https://example.com/test',
        reason: 'This is a test of the email pipeline.',
        tickers: ['TEST'],
        detected_tickers: ['TEST'],
        llm_tickers: ['TEST'],
        quality_score: 5,
        created_utc: nowIso,
      };
      await sendDigest([sample], config);
      const executionTime = Date.now() - startTime;
      return {
        ok: true,
        fetched: 0,
        candidates: 0,
        llmClassified: 0,
        emailed: 1,
        executionTime,
      };
    }

    // Step 1: Get cursor and fetch new posts from Reddit
    const sinceIso = await getCursor(config, 'last_cursor');
    requestLogger.info('Starting Reddit fetch', { sinceIso });

    const posts = await fetchNew(
      config,
      config.app.subreddits,
      sinceIso,
      config.app.cronWindowMinutes,
      config.app.maxPostsPerRun,
    );

    requestLogger.info('Reddit fetch completed', { postCount: posts.length });

    if (posts.length === 0) {
      await setCursor(config, 'last_cursor', []);
      const executionTime = Date.now() - startTime;
      requestLogger.info('No new posts found, ending early', { executionTime });
      return {
        ok: true,
        fetched: 0,
        candidates: 0,
        llmClassified: 0,
        emailed: 0,
        executionTime,
      };
    }

    // Step 2: Prefilter posts for tickers and upside language
    requestLogger.info('Starting prefilter', { postCount: posts.length });

    const allPrefiltered = await prefilterBatch(posts);

    const nowMs = Date.now();
    const candidates: typeof allPrefiltered = [];
    let scoreQualified = 0;
    let velocityQualified = 0;
    let acceptedVelocitySum = 0;

    for (const item of allPrefiltered) {
      if (item.tickers.length === 0 || item.upsideHits.length === 0) {
        continue;
      }

      const votesPerMinute = computeVotesPerMinute(item.post.createdUtc, item.post.score, nowMs);
      const passesScore = item.post.score >= config.app.minScoreForLlm;
      const passesVelocity = votesPerMinute >= config.app.minVotesPerMinuteForLlm;

      if (passesScore) {
        scoreQualified += 1;
      }

      if (passesVelocity) {
        velocityQualified += 1;
      }

      if (passesScore || passesVelocity) {
        candidates.push(item);
        acceptedVelocitySum += votesPerMinute;
      }
    }

    const averageVotesPerMinute = candidates.length > 0 ? acceptedVelocitySum / candidates.length : 0;

    requestLogger.info('Prefilter completed', {
      totalPosts: posts.length,
      candidateCount: candidates.length,
      minScore: config.app.minScoreForLlm,
      minVotesPerMinute: config.app.minVotesPerMinuteForLlm,
      scoreQualified,
      velocityQualified,
      averageVotesPerMinute: Number(averageVotesPerMinute.toFixed(2)),
    });

    if (candidates.length === 0) {
      await setCursor(config, 'last_cursor', posts);
      const executionTime = Date.now() - startTime;
      requestLogger.info('No candidates found after prefilter', { executionTime });
      return {
        ok: true,
        fetched: posts.length,
        candidates: 0,
        llmClassified: 0,
        emailed: 0,
        executionTime,
      };
    }

    // Step 3: Prepare items for LLM classification
    const llmItems = candidates.map(c => ({
      post_id: c.post.id,
      title: c.post.title,
      body: (c.post.selftext ?? '').slice(0, config.app.llmMaxBodyChars),
      tickers: c.tickers,
    }));

    // Step 4: Classify in batches to avoid token limits
    requestLogger.info('Starting LLM classification', {
      itemCount: llmItems.length,
      batchSize: config.app.llmBatchSize,
    });

    const allResults = [];
    for (let i = 0; i < llmItems.length; i += config.app.llmBatchSize) {
      const batch = llmItems.slice(i, i + config.app.llmBatchSize);
      const batchLogger = requestLogger.withContext({
        batchIndex: Math.floor(i / config.app.llmBatchSize) + 1,
        batchSize: batch.length,
      });

      try {
        batchLogger.info('Processing LLM batch');
        const batchResults = await classifyBatch(batch, config);
        allResults.push(...batchResults);
        batchLogger.info('LLM batch completed', { resultCount: batchResults.length });
      } catch (error) {
        batchLogger.error('LLM batch failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Continue with other batches even if one fails
      }
    }

    requestLogger.info('LLM classification completed', {
      totalResults: allResults.length,
      candidateCount: candidates.length,
    });

    // Step 5: Store results in database
    await upsertPosts(config, candidates, allResults);
    requestLogger.info('Posts upserted to database');

    // Step 6: Select and send email digest
    let emailCandidates = await selectForEmail(config, {
      minQuality: config.app.qualityThreshold,
    });

    let emailedCount = 0;
    let priceExceededCount = 0;
    let priceDataUnavailable = 0;

    if (emailCandidates.length > 0) {
      try {
        const { annotated, exceededCount, dataUnavailableCount } = await annotateCandidatesWithPriceMove(
          emailCandidates,
          config,
          requestLogger,
        );
        emailCandidates = annotated;
        priceExceededCount = exceededCount;
        priceDataUnavailable = dataUnavailableCount;
        requestLogger.info('Price move annotations completed', {
          annotatedCount: annotated.length,
          exceededThresholdCount: exceededCount,
          dataUnavailableObservations: dataUnavailableCount,
          thresholdPct: config.app.maxPriceMovePctForAlert,
        });
      } catch (error) {
        requestLogger.error('Price move annotation failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    if (emailCandidates.length > 0) {
      try {
        await sendDigest(emailCandidates, config);
        const emailSentAt = new Date().toISOString();
        const postIds = emailCandidates.map(c => c.post_id);
        await markEmailed(config, postIds, emailSentAt);
        emailedCount = emailCandidates.length;
        requestLogger.info('Email digest sent successfully', {
          emailedCount,
          priceExceededCount,
          priceDataUnavailable,
        });

        const watchSeeds = buildPriceWatchSeeds(emailCandidates, emailSentAt);
        if (watchSeeds.length > 0) {
          try {
            const scheduled = await schedulePriceWatches(config, watchSeeds, requestLogger);
            requestLogger.info('Scheduled price watches for emailed candidates', {
              scheduled,
              seedCount: watchSeeds.length,
            });
            await handlePriceWatchProcessing(config, requestLogger, 'post-email');
          } catch (error) {
            requestLogger.error('Failed to schedule price watch tasks', {
              seedCount: watchSeeds.length,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }
      } catch (error) {
        requestLogger.error('Failed to send email digest', {
          candidateCount: emailCandidates.length,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Don't fail the entire request if email fails
      }
    } else {
      requestLogger.info('No posts met email quality threshold', {
        threshold: config.app.qualityThreshold,
        priceExceededCount,
        priceDataUnavailable,
      });
    }

    // Step 7: Update cursor
    await setCursor(config, 'last_cursor', posts);

    const executionTime = Date.now() - startTime;
    const response: PollResponse = {
      ok: true,
      fetched: posts.length,
      candidates: candidates.length,
      llmClassified: allResults.length,
      emailed: emailedCount,
      executionTime,
    };

    requestLogger.info('Poll request completed successfully', response);
    return response;

  } catch (error) {
    const executionTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    requestLogger.error('Poll request failed', {
      error: errorMessage,
      executionTime,
    });

    return {
      ok: false,
      fetched: 0,
      candidates: 0,
      llmClassified: 0,
      emailed: 0,
      error: errorMessage,
      executionTime,
    };
  }
}
