import { logger } from './logger';
import type { Post } from './reddit';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

// These will be loaded from assets files that user will provide
let TICKERS: Set<string> | null = null;
let STOPLIST: Set<string> | null = null;

// Regex patterns for ticker detection
const CASHTAG = /\$[A-Z]{1,5}\b/g;
const BARE_TICKER = /\b[A-Z]{2,5}\b/g;

// Upside language clues
const UPSIDE_CLUES = [
  'will go up',
  'bullish',
  'undervalued',
  'catalyst',
  'breakout',
  'run-up',
  'gap up',
  'moon',
  'pump',
  'squeeze',
  'price target',
  'upside',
  'rerate',
  're-rate',
  'fda approval',
  'pdufa',
  'earnings beat',
  'raise guidance',
  'beat and raise',
  'new highs',
  'break resistance',
  'to the moon',
  'rocket',
  '🚀',
  'lambo',
  'diamond hands',
  'hodl',
  'buy the dip',
  'calls',
  'yolo'
];

export interface Prefiltered {
  post: Post;
  tickers: string[];
  upsideHits: string[];
}

async function loadTickersFromS3(bucket: string): Promise<string[]> {
  try {
    const s3 = new S3Client({});
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: 'tickers/current.json',
    }));

    if (!response.Body) {
      throw new Error('No body in S3 response');
    }

    const body = await response.Body.transformToString();
    const tickers = JSON.parse(body);

    if (!Array.isArray(tickers)) {
      throw new Error('Invalid tickers format in S3');
    }

    logger.debug('Loaded tickers from S3', { count: tickers.length });
    return tickers;
  } catch (error) {
    logger.warn('Failed to load tickers from S3', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw error;
  }
}

async function loadAssets(): Promise<{ tickers: Set<string>; stoplist: Set<string> }> {
  if (TICKERS && STOPLIST) {
    return { tickers: TICKERS, stoplist: STOPLIST };
  }

  try {
    logger.debug('Loading ticker and stoplist assets');

    let tickers: string[] = [];

    // Try to load tickers from S3 first (if TICKERS_BUCKET is available)
    const tickersBucket = process.env.TICKERS_BUCKET;
    if (tickersBucket) {
      try {
        tickers = await loadTickersFromS3(tickersBucket);
        logger.info('Loaded tickers from S3', { count: tickers.length });
      } catch (error) {
        logger.warn('Failed to load tickers from S3, falling back to static file', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        // Fall through to static file loading
      }
    }

    // If S3 loading failed or bucket not configured, try static file
    if (tickers.length === 0) {
      try {
        const tickersModule = await import('../assets/tickers.json');
        tickers = Array.isArray(tickersModule.default) ? tickersModule.default : tickersModule;
        logger.info('Loaded tickers from static file', { count: tickers.length });
      } catch (error) {
        logger.error('Failed to load tickers from static file', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        // Will fall through to fallback logic below
      }
    }

    // Load stoplist from static file (this doesn't change frequently)
    let stoplist: string[] = [];
    try {
      const stoplistModule = await import('../assets/stoplist.json');
      stoplist = Array.isArray(stoplistModule.default) ? stoplistModule.default : stoplistModule;
      logger.debug('Loaded stoplist from static file', { count: stoplist.length });
    } catch (error) {
      logger.warn('Failed to load stoplist from static file, using default', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      stoplist = ['ON', 'ALL', 'FOR', 'IT', 'OR', 'ANY', 'ONE', 'META', 'SHOP', 'RUN', 'EDIT', 'EV', 'AI'];
    }

    // If we still don't have tickers, use empty set as fallback
    if (tickers.length === 0) {
      logger.warn('No tickers loaded, using empty set');
      tickers = [];
    }

    TICKERS = new Set<string>(tickers);
    STOPLIST = new Set<string>(stoplist);

    logger.info('Assets loaded successfully', {
      tickerCount: TICKERS.size,
      stoplistCount: STOPLIST.size,
      source: tickersBucket ? 'S3' : 'static'
    });

    return { tickers: TICKERS, stoplist: STOPLIST };

  } catch (error) {
    logger.error('Failed to load assets', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    // Fallback to empty sets if assets can't be loaded
    TICKERS = new Set<string>();
    STOPLIST = new Set<string>(['ON', 'ALL', 'FOR', 'IT', 'OR', 'ANY', 'ONE', 'META', 'SHOP', 'RUN', 'EDIT', 'EV', 'AI']);

    logger.warn('Using fallback asset data', {
      tickerCount: TICKERS.size,
      stoplistCount: STOPLIST.size
    });

    return { tickers: TICKERS, stoplist: STOPLIST };
  }
}

export async function prefilter(post: Post): Promise<Prefiltered> {
  const { tickers: tickerSet, stoplist: stopSet } = await loadAssets();

  const combinedText = `${post.title}\n${post.selftext ?? ''}`;
  const lowerText = combinedText.toLowerCase();

  logger.debug('Prefiltering post', {
    postId: post.id,
    titleLength: post.title.length,
    bodyLength: post.selftext?.length ?? 0
  });

  // 1) Find cashtags ($SYMBOL) — case-insensitive symbol, normalized to upper
  const cashtagMatches = (combinedText.match(/\$[A-Za-z]{1,5}\b/g) || []);
  const detectedTickers = new Set<string>();

  cashtagMatches.forEach(match => {
    const ticker = match.slice(1).toUpperCase(); // Remove $ prefix and normalize
    if (tickerSet.has(ticker) && !stopSet.has(ticker)) {
      detectedTickers.add(ticker);
    }
  });

  // 2) Find bare tickers (SYMBOL as standalone words) — only match if text is already ALL CAPS in source
  const bareTickerMatches = combinedText.match(BARE_TICKER) || [];

  bareTickerMatches.forEach(match => {
    const ticker = match.toUpperCase();
    if (tickerSet.has(ticker) && !stopSet.has(ticker)) {
      detectedTickers.add(ticker);
    }
  });

  // 3) Find upside language clues
  const upsideHits = UPSIDE_CLUES.filter(clue => {
    return lowerText.includes(clue.toLowerCase());
  });

  const result: Prefiltered = {
    post,
    tickers: Array.from(detectedTickers),
    upsideHits
  };

  logger.debug('Prefilter results', {
    postId: post.id,
    tickerCount: result.tickers.length,
    tickers: result.tickers,
    upsideHitCount: result.upsideHits.length,
    upsideHits: result.upsideHits
  });

  return result;
}

// Batch prefilter for better performance when processing many posts
export async function prefilterBatch(posts: Post[]): Promise<Prefiltered[]> {
  logger.info('Starting batch prefilter', { postCount: posts.length });

  const results = await Promise.all(
    posts.map(post => prefilter(post))
  );

  const withHits = results.filter(r => r.tickers.length > 0 && r.upsideHits.length > 0);

  logger.info('Batch prefilter completed', {
    totalPosts: posts.length,
    withTickersAndUpside: withHits.length,
    filteredOut: posts.length - withHits.length
  });

  return results;
}