import type { Post } from '../../lib/reddit';

export interface MockRedditPost {
  id: string;
  title: string;
  selftext?: string;
  subreddit: string;
  author: string;
  permalink: string;
  created_utc: number;
  score: number;
}

export class MockRedditClient {
  private posts: MockRedditPost[] = [];
  private shouldFail: boolean = false;
  private failureMessage: string = 'Mock Reddit request failed';

  constructor(initialPosts?: MockRedditPost[]) {
    if (initialPosts) {
      this.posts = initialPosts;
    }
  }

  // Helper methods for testing
  setMockPosts(posts: MockRedditPost[]): void {
    this.posts = posts;
  }

  addMockPost(post: MockRedditPost): void {
    this.posts.push(post);
  }

  setFailure(shouldFail: boolean, message?: string): void {
    this.shouldFail = shouldFail;
    if (message) {
      this.failureMessage = message;
    }
  }

  getSubreddit(subreddit: string) {
    return {
      getNew: async (opts: { limit: number }) => {
        if (this.shouldFail) {
          throw new Error(this.failureMessage);
        }

        return this.posts
          .filter(post => post.subreddit === subreddit)
          .slice(0, opts.limit)
          .map(post => ({
            ...post,
            author: { name: post.author },
          }));
      },
    };
  }
}

// Helper function to create mock posts
export function createMockPost(overrides: Partial<MockRedditPost> = {}): MockRedditPost {
  const id = overrides.id || `post_${Math.random().toString(36).substr(2, 9)}`;
  const createdMs = overrides.created_utc
    ? overrides.created_utc
    : Math.floor(Date.now() / 1000);

  return {
    id,
    title: overrides.title || 'Test Post Title',
    selftext: overrides.selftext || 'Test post body with some content.',
    subreddit: overrides.subreddit || 'stocks',
    author: overrides.author || 'test_user',
    permalink: overrides.permalink || `/r/stocks/comments/${id}/test_post/`,
    created_utc: createdMs,
    score: overrides.score !== undefined ? overrides.score : 10,
  };
}

// Helper to convert mock posts to the Post interface used in the app
export function convertMockPostToPost(mockPost: MockRedditPost): Post {
  return {
    id: mockPost.id,
    title: mockPost.title,
    selftext: mockPost.selftext,
    subreddit: mockPost.subreddit,
    author: mockPost.author,
    url: `https://www.reddit.com${mockPost.permalink}`,
    createdUtc: new Date(mockPost.created_utc * 1000).toISOString(),
    score: mockPost.score,
  };
}

// Factory function
export function createMockRedditClient(initialPosts?: MockRedditPost[]): MockRedditClient {
  return new MockRedditClient(initialPosts);
}

