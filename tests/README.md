# Testing Guide

This directory contains unit tests and integration tests for the Reddit Stock Watcher application.

## Test Structure

```
tests/
├── __mocks__/           # Mock implementations for external services
│   ├── supabase-mock.ts # Mock Supabase client
│   ├── tiingo-mock.ts   # Mock Tiingo API client
│   └── reddit-mock.ts   # Mock Reddit client
├── integration/         # Integration tests
│   ├── db.integration.test.ts
│   ├── price-watch.integration.test.ts
│   ├── tiingo.integration.test.ts
│   └── test-helpers.ts  # Shared test utilities
├── price-watch.test.ts  # Unit tests for price watch logic
└── time.test.ts         # Unit tests for time utilities
```

## Running Tests

### Run All Tests
```bash
npm test              # Run in watch mode
npm run test:all      # Run all tests once
```

### Run Unit Tests Only
```bash
npm run test:unit
```

### Run Integration Tests Only
```bash
npm run test:integration
```

### Run Tests with Coverage
```bash
npm run test:coverage
```

### Run Tests in Watch Mode
```bash
npm run test:watch
```

## Writing Tests

### Unit Tests

Unit tests focus on testing individual functions and modules in isolation. They should:
- Be fast and independent
- Not make real network calls
- Not depend on external services
- Test edge cases and error handling

Example:
```typescript
import { describe, it, expect } from 'vitest';
import { myFunction } from '../lib/my-module';

describe('myFunction', () => {
  it('should return expected result', () => {
    const result = myFunction('input');
    expect(result).toBe('expected output');
  });
});
```

### Integration Tests

Integration tests verify that multiple components work together correctly. They use mock clients to simulate external services.

Example:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext } from './test-helpers';

describe('My Integration Test', () => {
  let context: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    context = createTestContext({
      // Optional: provide initial mock data
      supabaseData: {
        reddit_posts: [],
      },
    });
  });

  it('should perform integration test', async () => {
    // Use context.config, context.supabase, context.tiingo, etc.
    const result = await someFunction(context.config);
    expect(result).toBeDefined();
  });
});
```

## Mock Clients

### MockSupabaseClient

Provides a fully functional in-memory mock of the Supabase client with support for:
- `select()`, `insert()`, `upsert()`, `update()`, `delete()`
- Filters: `eq()`, `is()`, `gte()`, `lte()`, `in()`
- Modifiers: `order()`, `limit()`, `single()`

Access the underlying database state:
```typescript
const db = (context.supabase as any).getDatabase();
console.log(db.reddit_posts); // Access raw data
```

### MockTiingoClient

Simulates the Tiingo API with:
- Automatic generation of realistic price data
- Support for custom mock data via `setMockData()`
- Request counting for testing rate limits
- Configurable failure modes

Example:
```typescript
const tiingo = context.getMockTiingo();

// Set custom price data
tiingo.setMockData('intraday', 'AAPL_5min', [
  { timestamp: '2024-01-01T10:00:00Z', open: 100, high: 105, low: 99, close: 103, volume: 1000000 },
]);

// Simulate API failures
tiingo.setFailure(true, 'API rate limit exceeded');
```

### MockRedditClient

Simulates Reddit API responses:
```typescript
const reddit = context.getMockReddit();

// Add mock posts
reddit.addMockPost({
  id: 'abc123',
  title: 'Test Post',
  subreddit: 'stocks',
  score: 100,
});
```

## Test Helpers

The `test-helpers.ts` file provides utilities for creating test data:

```typescript
// Create a complete test context
const context = createTestContext();

// Create test configuration
const config = createTestConfig({ app: { maxPostsPerRun: 50 } });

// Time helpers
const oneHourAgo = hoursAgo(1);
const yesterday = daysAgo(1);
const fiveMinutesAgo = minutesAgo(5);

// Create test posts
const post = createTestPost({
  title: 'My test post',
  tickers: ['AAPL', 'MSFT'],
  score: 100,
});

// Create price series with specific movement
const prices = createPriceSeriesWithMove(
  'AAPL',
  100.0,      // start price
  start,      // start time
  end,        // end time
  0.15,       // 15% movement
  '5min'      // frequency
);
```

## Best Practices

1. **Isolation**: Each test should be independent and not rely on other tests
2. **Setup and Teardown**: Use `beforeEach()` to reset state between tests
3. **Descriptive Names**: Use clear, descriptive test names that explain what is being tested
4. **Arrange-Act-Assert**: Structure tests with clear setup, execution, and verification phases
5. **Mock External Services**: Never make real API calls in tests
6. **Test Edge Cases**: Include tests for error conditions, empty inputs, and boundary conditions

## Coverage

The test suite aims for high coverage of critical business logic:
- Database operations
- Price watch scheduling and processing
- Tiingo API interactions
- Reddit post processing
- LLM classification
- Email notification logic

To view coverage reports:
```bash
npm run test:coverage
# Open coverage/index.html in a browser
```

## Continuous Integration

Tests should be run as part of CI/CD pipeline before deployment:
```bash
npm run lint:check && npm run test:all
```

## Troubleshooting

### Tests timing out
Increase timeout in `vitest.config.ts`:
```typescript
testTimeout: 20000,  // 20 seconds
```

### Mock not working correctly
Ensure you're properly overriding the client getter:
```typescript
beforeEach(() => {
  const originalGetClient = getSupabaseClient;
  (getSupabaseClient as any) = () => context.supabase;
  
  return () => {
    (getSupabaseClient as any) = originalGetClient;
  };
});
```

### Database state persisting between tests
Make sure you're using `beforeEach()` to create a fresh context:
```typescript
beforeEach(() => {
  context = createTestContext();
});
```

