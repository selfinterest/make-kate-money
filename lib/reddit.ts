import Snoowrap from 'snoowrap';
import { logger } from './logger';
import type { Config } from './config';

export interface Post {
  id: string;
  title: string;
  selftext?: string;
  subreddit: string;
  author: string;
  url: string;
  createdUtc: string;   // ISO string
  score: number;
}

let redditClient: Snoowrap | null = null;

function getRedditClient(config: Config): Snoowrap {
  if (!redditClient) {
    logger.debug('Initializing Reddit client');

    redditClient = new Snoowrap({
      userAgent: config.reddit.userAgent,
      clientId: config.reddit.clientId,
      clientSecret: config.reddit.clientSecret,
      username: config.reddit.username,
      password: config.reddit.password,
    });
  }

  return redditClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function computeBackoffDelayMs(attempt: number, baseMs = 400, capMs = 10_000): number {
  const expo = Math.min(capMs, baseMs * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * baseMs);
  return expo + jitter;
}

function isRateLimitOrRetryableError(error: any): boolean {
  const status = (error as any)?.status ?? (error as any)?.statusCode;
  const message = String((error as any)?.message ?? '');
  if (status === 429) return true;
  if (/rate.?limit/i.test(message)) return true;
  if (/ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i.test(message)) return true;
  return false;
}

async function getNewWithRetry(reddit: Snoowrap, subreddit: string, limit: number): Promise<any[]> {
  const maxAttempts = 4;
  let lastError: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await reddit.getSubreddit(subreddit).getNew({ limit });
    } catch (error) {
      lastError = error;
      if (!isRateLimitOrRetryableError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      const delay = computeBackoffDelayMs(attempt);
      logger.warn('Reddit API retry due to throttling/temporary error', { subreddit, attempt: attempt + 1, delayMs: delay, error: (error as any)?.message });
      await sleep(delay);
    }
  }
  throw lastError ?? new Error('Unknown error fetching subreddit');
}

export async function fetchNew(
  config: Config,
  subreddits: string[],
  sinceIso: string,
  windowMinutes: number,
  maxPosts: number,
): Promise<Post[]> {
  const reddit = getRedditClient(config);

  try {
    const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;
    const windowMs = windowMinutes * 60 * 1000;

    logger.info('Fetching new posts from Reddit', {
      subreddits,
      sinceIso,
      windowMinutes,
      maxPosts,
    });

    const allPosts: Post[] = [];

    for (const subreddit of subreddits) {
      try {
        logger.debug('Fetching from subreddit', { subreddit });
        // Small pacing delay between subreddits to avoid bursty calls
        await sleep(200 + Math.floor(Math.random() * 300));

        const listings = await getNewWithRetry(reddit, subreddit, 100);
        let subredditPosts = 0;

        for (const submission of listings) {
          const createdMs = (submission.created_utc ?? 0) * 1000;

          // Keep overlap window to tolerate retries/clock skew
          // Ignore posts that are too old beyond the window
          if (sinceMs && createdMs + windowMs < sinceMs) {
            continue;
          }

          const post: Post = {
            id: submission.id,
            title: submission.title,
            selftext: (submission as any).selftext ?? '',
            subreddit,
            author: (submission as any).author?.name ?? 'unknown',
            url: `https://www.reddit.com${submission.permalink}`,
            createdUtc: new Date(createdMs).toISOString(),
            score: submission.score ?? 0,
          };

          allPosts.push(post);
          subredditPosts++;
        }

        logger.debug('Fetched posts from subreddit', {
          subreddit,
          postCount: subredditPosts,
        });

      } catch (error) {
        logger.error('Failed to fetch from subreddit', {
          subreddit,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Continue with other subreddits
      }
    }

    // Deduplicate by post ID (in case of cross-posts)
    const postsById = new Map<string, Post>();
    allPosts.forEach(post => {
      postsById.set(post.id, post);
    });

    // Sort by creation time and apply limit
    const sortedPosts = Array.from(postsById.values())
      .sort((a, b) => new Date(a.createdUtc).getTime() - new Date(b.createdUtc).getTime())
      .slice(-maxPosts); // Keep most recent posts up to limit

    logger.info('Reddit fetch completed', {
      totalFetched: allPosts.length,
      afterDeduplication: sortedPosts.length,
      maxPosts,
      oldestPost: sortedPosts.length > 0 ? sortedPosts[0].createdUtc : null,
      newestPost: sortedPosts.length > 0 ? sortedPosts[sortedPosts.length - 1].createdUtc : null,
    });

    return sortedPosts;

  } catch (error) {
    logger.error('Failed to fetch posts from Reddit', {
      subreddits,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error(`Reddit fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
