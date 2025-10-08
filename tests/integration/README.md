# Integration Tests

This directory contains integration tests for the Reddit Stock Watcher application.

## Overview

Integration tests use **real local Supabase** for database operations to ensure our database queries work correctly. External APIs (Tiingo, Reddit) are mocked to avoid rate limits and ensure test reliability.

### Testing Strategy

- ✅ **Database**: Real local Supabase (PostgreSQL)
- 🎭 **Tiingo API**: Mocked
- 🎭 **Reddit API**: Mocked

This hybrid approach gives us confidence in database operations while keeping tests fast and deterministic.

## Prerequisites

### 1. Install Supabase CLI

The Supabase CLI is already included as a dev dependency in `package.json`. If you need to install dependencies:

```bash
npm install
```

### 2. Start Local Supabase

Before running integration tests, start the local Supabase instance:

```bash
# Option 1: Use npm script (recommended)
npm run supabase:start

# Option 2: Use npx directly
npx supabase start

# Option 3: Use our helper script
./scripts/start-test-db.sh
```

This will start:
- PostgreSQL database on port `54322`
- API server on port `54321`
- Studio UI on port `54323` (http://127.0.0.1:54323)

The migrations in `supabase/migrations/` will be applied automatically.

### 3. Verify Setup

```bash
# Check Supabase status
npm run supabase:status

# Or use npx directly
npx supabase status
```

You should see all services running.

> **Note on API Keys**: The JWT tokens you see in the test files are the **standard demo keys** that come with every local Supabase installation. They are NOT secrets and are safe to commit. They only work with `127.0.0.1` and are documented in the [official Supabase docs](https://supabase.com/docs/guides/local-development). Every developer using local Supabase has these same keys.

## Running Tests

```bash
# Run all integration tests
npm run test:integration

# Run integration tests in watch mode
npm run test:integration -- --watch

# Run with verbose output
npm run test:integration -- --reporter=verbose

# Run a specific test file
npm run test:integration -- db.integration.test.ts
```

## Test Coverage

### ✅ Database Integration Tests (`db.integration.test.ts`) - 13 tests
- ✅ Cursor management (get/set) - 4 tests
- ✅ Post upsertion with LLM results - 2 tests
- ✅ Email candidate selection with reputation scoring - 4 tests  
- ✅ Post marking as emailed - 3 tests
- Uses **real Supabase** for all database operations

### ✅ Price Watch Integration Tests (`price-watch.integration.test.ts`) - 8 tests (1 skipped)
- ✅ Price watch scheduling from email seeds - 3 tests
- ✅ Price watch queue processing - 5 tests
  - Alert triggering on 5% gain
  - Watch rescheduling for sub-threshold moves
  - Watch expiration handling
  - Multiple tickers processing
  - ⏭️ Data unavailable handling (skipped - timing issue)
- Uses **real Supabase** + mocked Tiingo API

### ✅ Workflow Integration Tests (`workflow.integration.test.ts`) - 5 tests
- ✅ End-to-end Reddit → Email flow
- ✅ Performance tracking and metrics
- ✅ Reputation-based ranking
- ✅ Price alerts and monitoring
- ✅ Multi-ticker handling
- Uses **real Supabase** + mocked external APIs

### ✅ Tiingo Integration Tests (`tiingo.integration.test.ts`) - 14 tests
- ✅ Intraday price data fetching
- ✅ Daily price data fetching
- ✅ News fetching
- ✅ Request counting and caching
- ✅ Error handling
- Uses mocked Tiingo API (no Supabase needed)

**Total: 40 tests passing, 1 skipped**

## Writing Tests

### Test Structure

All integration tests follow this pattern:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext } from './test-helpers';

describe('My Integration Tests', () => {
  let context: Awaited<ReturnType<typeof createTestContext>>;

  beforeEach(async () => {
    // Creates clean database + mock external services
    context = await createTestContext();
    
    // Set up the Supabase client for your code to use
    __resetSupabaseClient();
    __setSupabaseClient(context.supabase);
  });

  afterEach(async () => {
    // Clean up database
    await context.cleanup();
  });

  it('should do something', async () => {
    // Your test here
  });
});
```

### Seeding Test Data

Use real Supabase inserts to seed data:

```typescript
// Seed reddit posts
await context.supabase.from('reddit_posts').insert({
  post_id: 'test1',
  title: 'Test Post',
  body: 'Test content',
  subreddit: 'stocks',
  author: 'testuser',
  score: 100,
  detected_tickers: ['AAPL'],
  llm_tickers: ['AAPL'],
  is_future_upside_claim: true,
  stance: 'bullish',
  quality_score: 5,
  created_utc: new Date().toISOString(),
  processed_at: new Date().toISOString(),
  url: 'https://reddit.com/test',
});

// Seed price watches
await context.supabase.from('price_watches').insert({
  post_id: 'test1',
  ticker: 'AAPL',
  entry_price: 150.0,
  quality_score: 5,
  // ... other fields
});
```

### Verifying Results

Query the real database to verify:

```typescript
// Query results
const { data, error } = await context.supabase
  .from('reddit_posts')
  .select('*')
  .eq('post_id', 'test1')
  .single();

expect(error).toBeNull();
expect(data?.quality_score).toBe(5);
```

### Using Mock External APIs

#### Mock Tiingo

```typescript
const context = await createTestContext();

// Set custom price data
const prices = createPriceSeriesWithMove(
  'AAPL', 
  100.0,  // start price
  startTime, 
  endTime, 
  0.15,   // 15% move
  '5min'
);
context.getMockTiingo().setMockData('intraday', 'AAPL_5min', prices);
```

#### Mock Reddit

```typescript
const context = await createTestContext();

// Add mock posts
context.getMockReddit().addMockPost({
  id: 'post1',
  title: 'AAPL will moon',
  subreddit: 'stocks',
  score: 150,
});
```

## Test Helpers

Available helper functions in `test-helpers.ts`:

- `createTestContext()` - Creates complete test environment with real Supabase (async!)
- `createTestConfig()` - Generates test configuration pointing to local Supabase
- `createTestPost()` - Creates mock Reddit post data
- `createPriceSeriesWithMove()` - Generates realistic price bar data
- `daysAgo(n)` - Date n days ago
- `hoursAgo(n)` - Date n hours ago  
- `minutesAgo(n)` - Date n minutes ago

## Database Setup Utilities

In `tests/setup-test-db.ts`:

- `createTestSupabaseClient()` - Creates a Supabase client with service role key
- `clearTestDatabase()` - Removes all test data from tables
- `seedTestDatabase()` - Seeds initial test data
- `setupTestDatabase()` - Combined setup (clear + optional seed)
- `teardownTestDatabase()` - Cleanup after tests

## Troubleshooting

### Supabase not running

```bash
Error: Connection refused to localhost:54321
```

**Solution**: Start Supabase with `npx supabase start` or `./scripts/start-test-db.sh`

### Database schema issues

```bash
Error: relation "reddit_posts" does not exist
```

**Solution**: Reset the database to apply migrations:
```bash
npx supabase db reset
```

### Tests fail after schema changes

**Solution**: Stop and restart Supabase to apply new migrations:
```bash
npx supabase stop
npx supabase start
```

### Port conflicts

If ports 54321-54323 are in use:

```bash
# Stop Supabase
npx supabase stop

# Check what's using the ports
lsof -i :54321
lsof -i :54322  
lsof -i :54323

# Start Supabase again
npx supabase start
```

## Cleaning Up

When you're done with tests:

```bash
# Stop all Supabase services
npm run supabase:stop

# Or reset database (clear all data, reapply migrations)
npm run supabase:reset

# Using npx directly:
npx supabase stop
npx supabase db reset
```

## Helpful npm Scripts

For convenience, we've added these npm scripts:

```bash
npm run supabase:start   # Start local Supabase
npm run supabase:stop    # Stop local Supabase
npm run supabase:status  # Check if Supabase is running
npm run supabase:reset   # Reset database (clear data, reapply migrations)
```

## Benefits of This Approach

✅ **Real database behavior** - Catches SQL errors, constraint violations, RLS issues
✅ **No mock maintenance** - Database behavior tracked automatically  
✅ **Fast feedback** - Local database is very fast
✅ **Isolation** - Each test gets a clean database state
✅ **Confidence** - Tests reflect production database behavior

## Migration Path from Mocks

If you see tests with old mock patterns like:

```typescript
const db = (context.supabase as any).getDatabase();
db.reddit_posts.push({...});
```

Update them to use real database inserts:

```typescript
await context.supabase.from('reddit_posts').insert({...});
```

And update verifications from:

```typescript
expect(db.reddit_posts).toHaveLength(1);
```

To:

```typescript
const { data } = await context.supabase.from('reddit_posts').select('*');
expect(data).toHaveLength(1);
```

