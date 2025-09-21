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
      config.supabase.apiKey
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
  detected_tickers: string[];
  quality_score: number;
  created_utc: string;
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
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw new Error(`Failed to get cursor: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function setCursor(
  config: Config,
  key: string,
  posts: { createdUtc: string }[]
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
        updated_at: new Date().toISOString()
      } as any);

    if (error) {
      throw error;
    }

    logger.info('Cursor updated successfully', { key, cursor: latest });

  } catch (error) {
    logger.error('Failed to set cursor', {
      key,
      postCount: posts.length,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw new Error(`Failed to set cursor: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function upsertPosts(
  config: Config,
  candidates: Prefiltered[],
  results: LlmResult[]
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
      rowCount: rows.length
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
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw new Error(`Failed to upsert posts: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function selectForEmail(
  config: Config,
  options: { minQuality: number }
): Promise<EmailCandidate[]> {
  const supabase = getSupabaseClient(config);

  try {
    logger.debug('Selecting posts for email', { minQuality: options.minQuality });

    const { data, error } = await supabase
      .from('reddit_posts')
      .select('post_id, title, url, reason, detected_tickers, quality_score, created_utc')
      .is('emailed_at', null)
      .eq('is_future_upside_claim', true)
      .eq('stance', 'bullish')
      .gte('quality_score', options.minQuality)
      .order('created_utc', { ascending: true });

    if (error) {
      throw error;
    }

    const candidates = data as EmailCandidate[];
    logger.info('Selected posts for email', {
      candidateCount: candidates.length,
      minQuality: options.minQuality
    });

    return candidates;

  } catch (error) {
    logger.error('Failed to select posts for email', {
      minQuality: options.minQuality,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw new Error(`Failed to select posts for email: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function markEmailed(config: Config, postIds: string[]): Promise<void> {
  if (postIds.length === 0) {
    logger.debug('No posts to mark as emailed');
    return;
  }

  const supabase = getSupabaseClient(config);

  try {
    logger.info('Marking posts as emailed', { postCount: postIds.length });

    const { error } = await supabase
      .from('reddit_posts')
      .update({ emailed_at: new Date().toISOString() } as any)
      .in('post_id', postIds);

    if (error) {
      throw error;
    }

    logger.info('Posts marked as emailed successfully', { postCount: postIds.length });

  } catch (error) {
    logger.error('Failed to mark posts as emailed', {
      postCount: postIds.length,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw new Error(`Failed to mark posts as emailed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}