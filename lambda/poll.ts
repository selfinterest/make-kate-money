import type { EventBridgeEvent, Context } from 'aws-lambda';
import { parseEnv } from '../lib/config';
import { fetchNew } from '../lib/reddit';
import { prefilterBatch } from '../lib/prefilter';
import { classifyBatch } from '../lib/llm';
import { getCursor, setCursor, upsertPosts, selectForEmail, markEmailed } from '../lib/db';
import type { EmailCandidate } from '../lib/db';
import { sendDigest } from '../lib/email';
import { logger } from '../lib/logger';

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

export async function handler(
  event: EventBridgeEvent<string, any>,
  context: Context
): Promise<PollResponse> {
  const startTime = Date.now();
  const requestLogger = logger.withContext({
    requestId: context.awsRequestId,
    functionName: context.functionName,
    source: event.source
  });

  requestLogger.info('Poll request started');

  try {
    // Parse and validate configuration
    const config = await parseEnv();
    requestLogger.info('Configuration loaded', {
      subreddits: config.app.subreddits,
      llmProvider: config.llm.provider,
      maxPosts: config.app.maxPostsPerRun
    });

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
      config.app.maxPostsPerRun
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
        executionTime
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
      averageVotesPerMinute: Number(averageVotesPerMinute.toFixed(2))
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
        executionTime
      };
    }

    // Step 3: Prepare items for LLM classification
    const llmItems = candidates.map(c => ({
      post_id: c.post.id,
      title: c.post.title,
      body: (c.post.selftext ?? '').slice(0, config.app.llmMaxBodyChars),
      tickers: c.tickers
    }));

    // Step 4: Classify in batches to avoid token limits
    requestLogger.info('Starting LLM classification', {
      itemCount: llmItems.length,
      batchSize: config.app.llmBatchSize
    });

    const allResults = [];
    for (let i = 0; i < llmItems.length; i += config.app.llmBatchSize) {
      const batch = llmItems.slice(i, i + config.app.llmBatchSize);
      const batchLogger = requestLogger.withContext({
        batchIndex: Math.floor(i / config.app.llmBatchSize) + 1,
        batchSize: batch.length
      });

      try {
        batchLogger.info('Processing LLM batch');
        const batchResults = await classifyBatch(batch, config);
        allResults.push(...batchResults);
        batchLogger.info('LLM batch completed', { resultCount: batchResults.length });
      } catch (error) {
        batchLogger.error('LLM batch failed', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        // Continue with other batches even if one fails
      }
    }

    requestLogger.info('LLM classification completed', {
      totalResults: allResults.length,
      candidateCount: candidates.length
    });

    // Step 5: Store results in database
    await upsertPosts(config, candidates, allResults);
    requestLogger.info('Posts upserted to database');

    // Step 6: Select and send email digest
    const emailCandidates = await selectForEmail(config, {
      minQuality: config.app.qualityThreshold
    });

    let emailedCount = 0;
    if (emailCandidates.length > 0) {
      try {
        await sendDigest(emailCandidates, config);
        await markEmailed(config, emailCandidates.map(c => c.post_id));
        emailedCount = emailCandidates.length;
        requestLogger.info('Email digest sent successfully', { emailedCount });
      } catch (error) {
        requestLogger.error('Failed to send email digest', {
          candidateCount: emailCandidates.length,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        // Don't fail the entire request if email fails
      }
    } else {
      requestLogger.info('No posts met email quality threshold', {
        threshold: config.app.qualityThreshold
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
      executionTime
    };

    requestLogger.info('Poll request completed successfully', response);
    return response;

  } catch (error) {
    const executionTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    requestLogger.error('Poll request failed', {
      error: errorMessage,
      executionTime
    });

    return {
      ok: false,
      fetched: 0,
      candidates: 0,
      llmClassified: 0,
      emailed: 0,
      error: errorMessage,
      executionTime
    };
  }
}
