# Migration Guide: From Mocked Supabase to Real Local Supabase

This guide explains how to update integration tests to use real local Supabase instead of mocks.

## Why This Change?

**Before**: Integration tests used an in-memory mock of Supabase, which didn't catch real database issues.

**After**: Integration tests use a real local Supabase instance, giving us:
- ✅ Real PostgreSQL behavior
- ✅ Actual constraint validation
- ✅ RLS policy testing
- ✅ Migration verification
- ✅ Query correctness validation

## Quick Migration Pattern

### 1. Update Test Context Creation

**Before:**
```typescript
let context: ReturnType<typeof createTestContext>;

beforeEach(() => {
  context = createTestContext();
  __resetSupabaseClient();
  __setSupabaseClient(context.supabase);
});
```

**After:**
```typescript
let context: Awaited<ReturnType<typeof createTestContext>>;

beforeEach(async () => {
  context = await createTestContext();
  __resetSupabaseClient();
  __setSupabaseClient(context.supabase);
});

afterEach(async () => {
  await context.cleanup();
});
```

### 2. Update Data Seeding

**Before:**
```typescript
const db = (context.supabase as any).getDatabase();
db.reddit_posts = [
  {
    post_id: 'test1',
    title: 'Test',
    // ...
  },
];
```

**After:**
```typescript
await context.supabase.from('reddit_posts').insert({
  post_id: 'test1',
  title: 'Test',
  // ...
});
```

### 3. Update Verification

**Before:**
```typescript
const db = (context.supabase as any).getDatabase();
expect(db.reddit_posts).toHaveLength(1);
expect(db.reddit_posts[0].quality_score).toBe(5);
```

**After:**
```typescript
const { data, error } = await context.supabase
  .from('reddit_posts')
  .select('*');

expect(error).toBeNull();
expect(data).toHaveLength(1);
expect(data![0].quality_score).toBe(5);
```

### 4. Update Single Record Queries

**Before:**
```typescript
const db = (context.supabase as any).getDatabase();
const post = db.reddit_posts.find(p => p.post_id === 'test1');
expect(post.quality_score).toBe(5);
```

**After:**
```typescript
const { data: post, error } = await context.supabase
  .from('reddit_posts')
  .select('*')
  .eq('post_id', 'test1')
  .single();

expect(error).toBeNull();
expect(post?.quality_score).toBe(5);
```

## Step-by-Step Example

Let's migrate a complete test:

### Before (Mock)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContext } from './test-helpers';

describe('My Tests', () => {
  let context: ReturnType<typeof createTestContext>;

  beforeEach(() => {
    context = createTestContext();
    __resetSupabaseClient();
    __setSupabaseClient(context.supabase);
  });

  it('should process posts', async () => {
    // Seed data
    const db = (context.supabase as any).getDatabase();
    db.reddit_posts = [
      {
        post_id: 'post1',
        title: 'Test',
        quality_score: 5,
        // ... other fields
      },
    ];

    // Run code
    const result = await myFunction(context.config);

    // Verify
    expect(db.reddit_posts).toHaveLength(1);
    expect(result.success).toBe(true);
  });
});
```

### After (Real Supabase)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext } from './test-helpers';

describe('My Tests', () => {
  let context: Awaited<ReturnType<typeof createTestContext>>;

  beforeEach(async () => {
    context = await createTestContext();
    __resetSupabaseClient();
    __setSupabaseClient(context.supabase);
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('should process posts', async () => {
    // Seed data with real database insert
    await context.supabase.from('reddit_posts').insert({
      post_id: 'post1',
      title: 'Test',
      quality_score: 5,
      // ... other fields (must match schema!)
      body: 'Test body',
      subreddit: 'stocks',
      author: 'testuser',
      url: 'https://reddit.com/test',
      score: 100,
      detected_tickers: [],
      llm_tickers: [],
      is_future_upside_claim: null,
      stance: null,
      reason: null,
      emailed_at: null,
      created_utc: new Date().toISOString(),
      processed_at: new Date().toISOString(),
    });

    // Run code
    const result = await myFunction(context.config);

    // Verify with real database query
    const { data: posts } = await context.supabase
      .from('reddit_posts')
      .select('*');

    expect(posts).toHaveLength(1);
    expect(result.success).toBe(true);
  });
});
```

## Common Pitfalls

### 1. Missing Required Fields

**Error:**
```
Error: null value in column "body" violates not-null constraint
```

**Solution:** Check the schema in `supabase/migrations/` and ensure all required fields are provided.

### 2. Forgetting Async/Await

**Error:**
```
TypeError: context.supabase.from(...).insert(...) is not iterable
```

**Solution:** Add `await` before all database operations.

### 3. Not Cleaning Up

**Problem:** Tests interfere with each other, data from previous tests persists.

**Solution:** Always add the `afterEach` cleanup:
```typescript
afterEach(async () => {
  await context.cleanup();
});
```

### 4. Accessing Mock Methods

**Error:**
```
TypeError: context.supabase.getDatabase is not a function
```

**Solution:** `getDatabase()` was a mock method. Use real Supabase queries instead.

## Testing Multiple Records

**Before:**
```typescript
db.reddit_posts = [
  { post_id: 'post1', /* ... */ },
  { post_id: 'post2', /* ... */ },
  { post_id: 'post3', /* ... */ },
];
```

**After:**
```typescript
await context.supabase.from('reddit_posts').insert([
  { post_id: 'post1', /* ... */ },
  { post_id: 'post2', /* ... */ },
  { post_id: 'post3', /* ... */ },
]);
```

## Testing Relationships

When testing foreign key relationships (like price_watches → reddit_posts):

```typescript
// Insert parent first
await context.supabase.from('reddit_posts').insert({
  post_id: 'post1',
  // ... required fields
});

// Then insert child
await context.supabase.from('price_watches').insert({
  post_id: 'post1',  // Foreign key reference
  ticker: 'AAPL',
  // ... other fields
});
```

## Next Steps

1. Run `supabase start` to get local Supabase running
2. Update one test file at a time
3. Run tests after each migration to verify
4. Commit changes incrementally

## Getting Help

- See `tests/integration/README.md` for full documentation
- Look at `tests/integration/db.integration.test.ts` for complete examples
- Check `tests/setup-test-db.ts` for database utilities

