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

export async function fetchNew(
  config: Config,
  subreddits: string[],
  sinceIso: string,
  windowMinutes: number,
  maxPosts: number
): Promise<Post[]> {
  const reddit = getRedditClient(config);
  
  try {
    const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;
    const windowMs = windowMinutes * 60 * 1000;
    
    logger.info('Fetching new posts from Reddit', {
      subreddits,
      sinceIso,
      windowMinutes,
      maxPosts
    });
    
    const allPosts: Post[] = [];
    
    for (const subreddit of subreddits) {
      try {
        logger.debug('Fetching from subreddit', { subreddit });
        
        const listings = await reddit.getSubreddit(subreddit).getNew({ limit: 100 });
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
          postCount: subredditPosts 
        });
        
      } catch (error) {
        logger.error('Failed to fetch from subreddit', {
          subreddit,
          error: error instanceof Error ? error.message : 'Unknown error'
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
      newestPost: sortedPosts.length > 0 ? sortedPosts[sortedPosts.length - 1].createdUtc : null
    });
    
    return sortedPosts;
    
  } catch (error) {
    logger.error('Failed to fetch posts from Reddit', {
      subreddits,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw new Error(`Reddit fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}