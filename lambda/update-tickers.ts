import { Context } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '../lib/logger';

export interface UpdateTickersEvent {
  dryRun?: boolean;
  force?: boolean;
}

const TICKERS_S3_KEY = 'tickers/current.json';
const TICKERS_BACKUP_PREFIX = 'tickers/backups/';

const requestLogger = logger.withContext({ service: 'update-tickers' });

async function fetchTickersFromGitHub(): Promise<string[]> {
  const fetchFn = (globalThis as any).fetch as ((input: string, init?: any) => Promise<any>) | undefined;
  if (typeof fetchFn !== 'function') {
    throw new Error('global fetch is not available in this runtime');
  }

  requestLogger.info('Fetching ticker list from GitHub repository');

  const response = await fetchFn('https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/all/all_tickers.txt', {
    headers: {
      'Accept': 'text/plain',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status} ${response.statusText})`);
  }

  const text = await response.text();
  const tickers = text
    .split('\n')
    .map((line: string) => line.trim().toUpperCase())
    .filter((ticker: string) => ticker && ticker.length >= 1 && ticker.length <= 5 && /^[A-Z0-9.-]+$/.test(ticker));

  requestLogger.info('Successfully fetched tickers from GitHub', { count: tickers.length });
  return tickers;
}

async function filterTickers(tickers: string[]): Promise<string[]> {
  // Basic filtering for ticker symbols
  const filtered = tickers
    .filter(ticker => {
      // Must have a valid ticker symbol
      if (!ticker || typeof ticker !== 'string') {
        return false;
      }

      // Skip tickers that are too short or too long
      const tickerLength = ticker.length;
      if (tickerLength < 1 || tickerLength > 5) {
        return false;
      }

      // Skip tickers with invalid characters
      if (!/^[A-Z0-9.-]+$/.test(ticker)) {
        return false;
      }

      // Skip common words that aren't tickers
      const commonWords = new Set(['THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HER', 'WAS', 'ONE', 'OUR', 'HAD', 'BUT', 'WILL', 'THIS', 'THAT', 'WITH', 'HAVE', 'FROM', 'THEY', 'KNOW', 'WANT', 'BEEN', 'GOOD', 'MUCH', 'SOME', 'TIME', 'VERY', 'WHEN', 'COME', 'HERE', 'JUST', 'LIKE', 'LONG', 'MAKE', 'MANY', 'OVER', 'SUCH', 'TAKE', 'THAN', 'THEM', 'WELL', 'WERE', 'WHAT', 'YEAR', 'YOUR']);
      if (commonWords.has(ticker)) {
        return false;
      }

      return true;
    })
    .map(ticker => ticker.toUpperCase())
    .sort();

  // Remove duplicates
  const uniqueFiltered = Array.from(new Set(filtered));

  requestLogger.info('Filtered tickers', {
    originalCount: tickers.length,
    filteredCount: uniqueFiltered.length,
  });

  return uniqueFiltered;
}

async function getCurrentTickers(bucket: string): Promise<string[]> {
  try {
    const s3 = new S3Client({});
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: TICKERS_S3_KEY,
    }));

    if (!response.Body) {
      throw new Error('No body in S3 response');
    }

    const body = await response.Body.transformToString();
    const tickers = JSON.parse(body);

    if (!Array.isArray(tickers)) {
      throw new Error('Invalid tickers format in S3');
    }

    return tickers;
  } catch (error) {
    requestLogger.warn('Could not fetch current tickers from S3', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return [];
  }
}

async function saveTickers(bucket: string, tickers: string[], isBackup: boolean = false): Promise<void> {
  const s3 = new S3Client({});

  let key: string;
  if (isBackup) {
    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    key = `${TICKERS_BACKUP_PREFIX}${timestamp}.json`;
  } else {
    key = TICKERS_S3_KEY;
  }

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(tickers, null, 2),
    ContentType: 'application/json',
    Metadata: {
      'last-updated': new Date().toISOString(),
      'ticker-count': tickers.length.toString(),
    },
  }));

  requestLogger.info('Saved tickers to S3', { key, count: tickers.length });
}

function compareTickerLists(oldTickers: string[], newTickers: string[]): {
  added: string[];
  removed: string[];
  unchanged: string[];
} {
  const oldSet = new Set(oldTickers);
  const newSet = new Set(newTickers);

  const added = newTickers.filter(ticker => !oldSet.has(ticker));
  const removed = oldTickers.filter(ticker => !newSet.has(ticker));
  const unchanged = newTickers.filter(ticker => oldSet.has(ticker));

  return { added, removed, unchanged };
}

export async function handler(event: UpdateTickersEvent = {}, context: Context) {
  const handlerLogger = requestLogger.withContext({
    requestId: context.awsRequestId,
    dryRun: event.dryRun ?? false,
    force: event.force ?? false,
  });

  handlerLogger.info('Starting ticker update process (using GitHub repository)');

  try {
    const bucket = process.env.TICKERS_BUCKET;
    if (!bucket) {
      throw new Error('TICKERS_BUCKET environment variable is required');
    }

    // Fetch current tickers from S3
    const currentTickers = await getCurrentTickers(bucket);
    handlerLogger.info('Current tickers loaded', { count: currentTickers.length });

    // Fetch new tickers from GitHub repository
    const rawTickers = await fetchTickersFromGitHub();
    const newTickers = await filterTickers(rawTickers);

    // Compare with current tickers
    const comparison = compareTickerLists(currentTickers, newTickers);

    handlerLogger.info('Ticker comparison complete', {
      currentCount: currentTickers.length,
      newCount: newTickers.length,
      added: comparison.added.length,
      removed: comparison.removed.length,
      unchanged: comparison.unchanged.length,
    });

    // Log changes
    if (comparison.added.length > 0) {
      handlerLogger.info('Added tickers', {
        count: comparison.added.length,
        tickers: comparison.added.slice(0, 10), // Log first 10 for brevity
      });
    }

    if (comparison.removed.length > 0) {
      handlerLogger.info('Removed tickers', {
        count: comparison.removed.length,
        tickers: comparison.removed.slice(0, 10), // Log first 10 for brevity
      });
    }

    // Check if update is needed
    const hasChanges = comparison.added.length > 0 || comparison.removed.length > 0;

    if (!hasChanges && !event.force) {
      handlerLogger.info('No changes detected, skipping update');
      return {
        success: true,
        message: 'No changes detected',
        currentCount: currentTickers.length,
        newCount: newTickers.length,
        changes: comparison,
      };
    }

    if (event.dryRun) {
      handlerLogger.info('Dry run mode - would update tickers', {
        changes: comparison,
      });
      return {
        success: true,
        message: 'Dry run completed',
        currentCount: currentTickers.length,
        newCount: newTickers.length,
        changes: comparison,
        wouldUpdate: true,
      };
    }

    // Create backup of current tickers
    if (currentTickers.length > 0) {
      await saveTickers(bucket, currentTickers, true);
      handlerLogger.info('Created backup of current tickers');
    }

    // Save new tickers
    await saveTickers(bucket, newTickers, false);
    handlerLogger.info('Updated tickers successfully');

    return {
      success: true,
      message: 'Tickers updated successfully',
      currentCount: currentTickers.length,
      newCount: newTickers.length,
      changes: comparison,
    };

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    handlerLogger.error('Failed to update tickers', { error: message });

    return {
      success: false,
      message: `Failed to update tickers: ${message}`,
      error: message,
    };
  }
}
