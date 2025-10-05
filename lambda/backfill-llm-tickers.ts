import type { Context } from 'aws-lambda';
import { parseEnv } from '../lib/config';
import { getSupabaseClient } from '../lib/db';
import { logger } from '../lib/logger';
import tickers from '../assets/tickers.json';

interface BackfillEvent {
  limit?: number;
  dryRun?: boolean;
  after?: string;
  post_ids?: string[];
  concurrency?: number;
}

interface PostRow {
  post_id: string;
  title: string;
  body: string | null;
  detected_tickers: string[] | null;
  llm_tickers: string[] | null;
  quality_score: number | null;
  created_utc: string;
}

const KNOWN_TICKERS = new Set((tickers as string[]).map(t => t.toUpperCase()));

const SYSTEM_PROMPT = `You are a meticulous assistant that extracts U.S. stock tickers from Reddit posts.

Rules:
- Only return uppercase ticker symbols that explicitly appear in the text.
- Valid tickers are 1-5 uppercase letters.
- Do not invent or infer symbols – if unsure, exclude it.
- If no valid tickers appear, return an empty array.
- Respond with strict JSON only.`;

function buildUserPrompt(post: PostRow): string {
  const body = (post.body ?? '').trim();
  const text = [
    `POST ID: ${post.post_id}`,
    `TITLE: ${post.title}`,
    'BODY:',
    body.length > 0 ? body : '(no body provided)',
    '',
    'Return JSON with the shape: { "post_id": string, "tickers": string[] }',
    'Only include ticker symbols that actually appear in the title or body.'
  ].join('\n');

  return text;
}

function sanitizeTickers(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map(token => (typeof token === 'string' ? token : String(token ?? '')).
      trim().toUpperCase())
    .filter(token => /^[A-Z]{1,5}$/.test(token))
    .filter(token => KNOWN_TICKERS.has(token));
}

async function extractTickers(
  client: any,
  post: PostRow
): Promise<string[]> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(post) }
    ]
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from OpenAI');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    logger.warn('Failed to parse OpenAI response', {
      postId: post.post_id,
      preview: content.slice(0, 200),
      error: error instanceof Error ? error.message : 'unknown'
    });
    return [];
  }

  if (parsed?.post_id && parsed.post_id !== post.post_id) {
    logger.warn('OpenAI response post_id mismatch', {
      expected: post.post_id,
      received: parsed.post_id
    });
  }

  return sanitizeTickers(parsed?.tickers);
}

export async function handler(event: BackfillEvent = {}, context: Context) {
  const requestLogger = logger.withContext({
    requestId: context.awsRequestId,
    dryRun: event.dryRun ?? false,
    limit: event.limit,
    after: event.after,
    postIdsProvided: Array.isArray(event.post_ids) ? event.post_ids.length : 0,
    concurrency: event.concurrency
  });

  requestLogger.info('Starting LLM ticker backfill');

  const config = await parseEnv();
  const supabase = getSupabaseClient(config);

  const { data, error } = await supabase
    .from('reddit_posts')
    .select('post_id, title, body, detected_tickers, llm_tickers, quality_score, created_utc, emailed_at, is_future_upside_claim, stance')
    .eq('is_future_upside_claim', true)
    .eq('stance', 'bullish')
    .gte('quality_score', 4)
    .not('emailed_at', 'is', null)
    .order('created_utc', { ascending: true })
    .limit(event.limit ?? 1000);

  if (error) {
    throw error;
  }

  const candidates = (data ?? []).filter((row: any) => {
    if (Array.isArray(row.llm_tickers) && row.llm_tickers.length > 0) {
      return false;
    }
    if (event.after && new Date(row.created_utc).getTime() < new Date(event.after).getTime()) {
      return false;
    }
    if (event.post_ids && event.post_ids.length > 0) {
      return event.post_ids.includes(row.post_id);
    }
    return true;
  }).map(row => ({
    post_id: row.post_id as string,
    title: row.title as string,
    body: row.body as string | null,
    detected_tickers: Array.isArray(row.detected_tickers) ? row.detected_tickers as string[] : [],
    llm_tickers: Array.isArray(row.llm_tickers) ? row.llm_tickers as string[] : [],
    quality_score: typeof row.quality_score === 'number' ? row.quality_score as number : null,
    created_utc: row.created_utc as string
  }));

  if (candidates.length === 0) {
    requestLogger.info('No posts require backfill');
    return { ok: true, processed: 0, updated: 0 };
  }

  requestLogger.info('Backfill candidates fetched', { count: candidates.length });

  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: config.llm.openaiApiKey! });

  let processed = 0;
  let updated = 0;
  const failures: Array<{ post_id: string; error: string }> = [];

  const maxConcurrency = Math.max(1, Math.min(event.concurrency ?? 2, 5));
  requestLogger.info('Processing posts with concurrency limit', { maxConcurrency });

  let cursor = 0;
  const workers = Array.from({ length: maxConcurrency }).map(async () => {
    while (cursor < candidates.length) {
      const index = cursor++;
      const post = candidates[index];
      if (!post) {
        break;
      }
      processed += 1;
      const postLogger = requestLogger.withContext({ postId: post.post_id });

      try {
        const tickers = await extractTickers(client, post);

        if (tickers.length === 0) {
          postLogger.info('No validated tickers found by OpenAI');
          continue;
        }

        postLogger.info('Tickers extracted', { tickers });

        if (event.dryRun) {
          continue;
        }

        const { error: updateError } = await supabase
          .from('reddit_posts')
          .update({ llm_tickers: tickers })
          .eq('post_id', post.post_id);

        if (updateError) {
          throw updateError;
        }

        updated += 1;

      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        failures.push({ post_id: post.post_id, error: message });
        postLogger.error('Failed to backfill tickers', { error: message });
      }
    }
  });

  await Promise.all(workers);

  requestLogger.info('Backfill run complete', {
    processed,
    updated,
    failures: failures.length
  });

  return { ok: failures.length === 0, processed, updated, failures };
}
