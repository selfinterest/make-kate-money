# Integration Testing Setup

This document provides an overview of the integration testing infrastructure added to the Reddit Stock Watcher application.

## Overview

The integration testing suite provides comprehensive test coverage for the application's core workflows using mock implementations of external services (Supabase, Tiingo, Reddit). This allows for fast, reliable testing without requiring actual API keys or network calls.

## What Was Added

### Mock Clients (`tests/__mocks__/`)

1. **MockSupabaseClient** (`supabase-mock.ts`)
   - Full-featured in-memory database mock
   - Supports all major Supabase operations: `select`, `insert`, `upsert`, `update`, `delete`
   - Implements filters: `eq`, `is`, `gte`, `lte`, `in`
   - Supports modifiers: `order`, `limit`, `single`
   - Maintains state across test operations

2. **MockTiingoClient** (`tiingo-mock.ts`)
   - Simulates Tiingo API responses
   - Generates realistic price data automatically
   - Supports custom mock data via `setMockData()`
   - Tracks API request counts for rate limit testing
   - Configurable failure modes for error testing

3. **MockRedditClient** (`reddit-mock.ts`)
   - Simulates Reddit API responses
   - Helper functions for creating mock posts
   - Support for multiple subreddits
   - Configurable failure modes

### Integration Tests (`tests/integration/`)

1. **Database Integration Tests** (`db.integration.test.ts`)
   - Cursor management (get/set)
   - Post upsertion with LLM results
   - Email candidate selection with reputation scoring
   - Post marking as emailed
   - Covers ~150 lines of test code

2. **Price Watch Integration Tests** (`price-watch.integration.test.ts`)
   - Price watch scheduling from seeds
   - Price watch queue processing
   - Alert triggering on 15% gains
   - Watch rescheduling and expiration
   - Multi-ticker scenarios
   - Data unavailability handling
   - Covers ~400 lines of test code

3. **Tiingo Integration Tests** (`tiingo.integration.test.ts`)
   - Intraday data fetching
   - Daily data fetching
   - News article fetching
   - Request counting and caching
   - Error handling
   - Covers ~290 lines of test code

4. **Comprehensive Workflow Tests** (`workflow.integration.test.ts`)
   - **End-to-End Flow**: Reddit → Prefilter → LLM → Database → Email → Price Watch
   - **Performance Tracking**: Historical post performance calculation
   - **Reputation System**: Author/subreddit reputation-based ranking
   - **Price Alerts**: Price movement annotation and threshold alerts
   - **Multi-Ticker Posts**: Handling posts with multiple tickers
   - Covers ~600 lines of test code

### Test Utilities (`tests/integration/test-helpers.ts`)

Provides helper functions for test setup:
- `createTestContext()`: Creates complete test environment with all mocks
- `createTestConfig()`: Generates test configuration
- `createTestPost()`: Creates realistic mock Reddit posts
- `createPriceSeriesWithMove()`: Generates price data with specific movements
- Time helpers: `daysAgo()`, `hoursAgo()`, `minutesAgo()`

### Configuration Updates

1. **vitest.config.ts**
   - Added coverage configuration with v8 provider
   - Set test timeouts (10s)
   - Configured coverage exclusions

2. **package.json**
   - Added `@vitest/coverage-v8` dependency
   - Added test scripts:
     - `test:unit`: Run only unit tests
     - `test:integration`: Run only integration tests
     - `test:watch`: Run tests in watch mode
     - `test:coverage`: Run tests with coverage report
     - `test:all`: Run all tests once

## Running the Tests

```bash
# Run all tests
npm test

# Run only integration tests
npm run test:integration

# Run only unit tests
npm run test:unit

# Run with coverage
npm run test:coverage

# Run in watch mode
npm run test:watch
```

## Test Coverage

The integration tests cover the following workflows:

### 1. Reddit Post Ingestion
- Fetching posts from multiple subreddits
- Handling rate limits and retries
- Post deduplication
- Cursor management for incremental fetching

### 2. Post Processing
- Ticker detection and normalization
- Upside language detection (prefiltering)
- LLM classification (mocked)
- Database storage with conflict resolution

### 3. Email Candidate Selection
- Quality threshold filtering
- Bullish stance filtering
- Already-emailed post exclusion
- Author/subreddit reputation scoring
- Ticker performance-based ranking

### 4. Price Monitoring
- Price watch scheduling from emailed posts
- Periodic price checking
- 15% gain alert triggering
- Watch expiration and cleanup
- Data unavailability handling

### 5. Performance Tracking
- Post performance calculation
- Ticker-level aggregate statistics
- Win rate tracking
- Historical performance lookback

## Mock Data Examples

### Creating a Test Post with Tickers
```typescript
const post = createTestPost({
  title: 'AAPL will surge',
  tickers: ['AAPL'],
  score: 150,
  createdUtc: minutesAgo(30),
});
```

### Setting Up Price Data
```typescript
const prices = createPriceSeriesWithMove(
  'AAPL',
  100.0,      // start price
  startTime,
  endTime,
  0.15,       // 15% movement
  '5min'
);

context.getMockTiingo().setMockData('intraday', 'AAPL_5min', prices);
```

### Accessing Database State
```typescript
const db = (context.supabase as any).getDatabase();
expect(db.reddit_posts).toHaveLength(3);
expect(db.price_watches[0].ticker).toBe('AAPL');
```

## Benefits

1. **Fast Execution**: No network calls, all tests run in-memory
2. **Reliable**: No dependency on external API availability
3. **Deterministic**: Consistent results across runs
4. **Comprehensive**: Covers complete workflows end-to-end
5. **Maintainable**: Clear structure and helper functions
6. **Developer Friendly**: Easy to add new tests using existing patterns

## Architecture

```
┌─────────────────────────────────────────────┐
│         Integration Test                    │
│  (e.g., workflow.integration.test.ts)      │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│          Test Context                       │
│  - Mock Supabase Client                     │
│  - Mock Tiingo Client                       │
│  - Mock Reddit Client                       │
│  - Test Configuration                       │
└─────────────────┬───────────────────────────┘
                  │
        ┌─────────┴─────────┬─────────────┐
        ▼                   ▼             ▼
┌───────────────┐  ┌──────────────┐  ┌──────────────┐
│ Application   │  │ Application  │  │ Application  │
│ Database      │  │ Market Data  │  │ Reddit       │
│ Functions     │  │ Functions    │  │ Functions    │
└───────────────┘  └──────────────┘  └──────────────┘
```

## Adding New Tests

To add a new integration test:

1. Create a new test file in `tests/integration/`
2. Import test helpers: `import { createTestContext } from './test-helpers';`
3. Set up test context in `beforeEach()`
4. Mock any external clients as needed
5. Write test cases following existing patterns
6. Use descriptive test names that explain the scenario

Example:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext } from './test-helpers';

describe('My New Feature Tests', () => {
  let context: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    context = createTestContext();
  });

  it('should do something specific', async () => {
    // Arrange
    const db = (context.supabase as any).getDatabase();
    db.reddit_posts = [/* test data */];

    // Act
    const result = await myFunction(context.config);

    // Assert
    expect(result).toBeDefined();
  });
});
```

## Future Enhancements

Potential areas for expansion:

1. **LLM Integration Tests**: Add tests that mock OpenAI responses
2. **Email Integration Tests**: Mock Resend API for email sending tests
3. **Lambda Handler Tests**: Full handler testing with EventBridge mocks
4. **Performance Tests**: Add timing and performance benchmarks
5. **Concurrency Tests**: Test concurrent price watch processing
6. **Error Recovery Tests**: Simulate various failure scenarios

## Troubleshooting

### Tests are failing with "client not found"
Ensure you're properly mocking the client getter in `beforeEach()`:
```typescript
const originalGetClient = getSupabaseClient;
(getSupabaseClient as any) = () => context.supabase;

return () => {
  (getSupabaseClient as any) = originalGetClient;
};
```

### Database state persists between tests
Make sure you're creating a fresh context in `beforeEach()`:
```typescript
beforeEach(() => {
  context = createTestContext(); // Fresh context each time
});
```

### Type errors with mock clients
The mocks are cast to the real client types for type safety. Use `any` when accessing mock-specific methods:
```typescript
const db = (context.supabase as any).getDatabase(); // Mock-specific method
```

## Summary

This integration testing infrastructure provides a solid foundation for ensuring the reliability and correctness of the Reddit Stock Watcher application. The tests are fast, comprehensive, and maintainable, making it easy to catch bugs early and ensure new features work correctly with existing code.

