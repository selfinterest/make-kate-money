import { logger } from './logger';
import type { Post } from './reddit';

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

async function loadAssets(): Promise<{ tickers: Set<string>; stoplist: Set<string> }> {
  if (TICKERS && STOPLIST) {
    return { tickers: TICKERS, stoplist: STOPLIST };
  }
  
  try {
    logger.debug('Loading ticker and stoplist assets');
    
    // Load tickers from assets file
    const tickersModule = await import('@/assets/tickers.json');
    const tickers = Array.isArray(tickersModule.default) ? tickersModule.default : tickersModule;
    TICKERS = new Set<string>(tickers);
    
    // Load stoplist from assets file
    const stoplistModule = await import('@/assets/stoplist.json');
    const stoplist = Array.isArray(stoplistModule.default) ? stoplistModule.default : stoplistModule;
    STOPLIST = new Set<string>(stoplist);
    
    logger.info('Assets loaded successfully', { 
      tickerCount: TICKERS.size,
      stoplistCount: STOPLIST.size 
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
  const upperText = combinedText.toUpperCase();
  const lowerText = combinedText.toLowerCase();
  
  logger.debug('Prefiltering post', { 
    postId: post.id,
    titleLength: post.title.length,
    bodyLength: post.selftext?.length ?? 0
  });
  
  // 1) Find cashtags ($SYMBOL)
  const cashtagMatches = upperText.match(CASHTAG) || [];
  const detectedTickers = new Set<string>();
  
  cashtagMatches.forEach(match => {
    const ticker = match.slice(1); // Remove $ prefix
    if (tickerSet.has(ticker) && !stopSet.has(ticker)) {
      detectedTickers.add(ticker);
    }
  });
  
  // 2) Find bare tickers (SYMBOL as standalone words)
  const bareTickerMatches = upperText.match(BARE_TICKER) || [];
  
  bareTickerMatches.forEach(match => {
    if (tickerSet.has(match) && !stopSet.has(match)) {
      detectedTickers.add(match);
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