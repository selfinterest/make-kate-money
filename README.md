# Reddit Stock Upside Watcher

A serverless application that monitors Reddit posts for bullish stock sentiment,
analyzes them with LLM, and sends email digests.

## Architecture

- **Runtime**: TypeScript/Node.js on Vercel serverless functions
- **Cron**: Vercel Cron (every 5 minutes)
- **Database**: Supabase Postgres
- **LLM**: OpenAI GPT-4o-mini (configurable)
- **Email**: Resend
- **Reddit API**: snoowrap

## Features

- 🔍 Monitors multiple subreddits for new posts
- 📈 Prefilters posts for stock tickers and upside language
- 🤖 LLM classification for sentiment analysis
- 💾 Stores results in Postgres with deduplication
- 📧 Sends quality-filtered email digests
- 📊 Structured logging for monitoring
- ⚡ Stateless and idempotent design

## Setup

### 1. Prerequisites

- Node.js 18+
- Supabase account
- Reddit API credentials (script app)
- OpenAI API key
- Resend account
- Vercel account

### 2. Reddit API Setup

1. Go to https://www.reddit.com/prefs/apps
2. Create a "script" application
3. Note down your client ID and secret

### 3. Database Setup

1. Create a new Supabase project
2. Run the SQL schema in `schema.sql` in your SQL editor
3. Note your project URL and API key from Settings → API

### 4. Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required variables:

- `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`,
  `REDDIT_PASSWORD`
- `SUPABASE_URL`, `SUPABASE_API_KEY`
- `OPENAI_API_KEY`
- `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`

### 5. Asset Files

You need to provide two asset files (as mentioned, these will be provided
separately):

- `assets/tickers.json` - Array of valid US stock tickers (uppercase)
- `assets/stoplist.json` - Array of words to ignore (uppercase)

Example format:

```json
// assets/tickers.json
["AAPL", "GOOGL", "MSFT", "TSLA", ...]

// assets/stoplist.json  
["ON", "ALL", "FOR", "IT", "OR", "ANY", "ONE", "META", ...]
```

### 6. Local Development

Install dependencies:

```bash
npm install
```

Run locally with Vercel dev server:

```bash
npm run dev
```

Test the endpoint:

```bash
curl http://localhost:3000/api/poll
```

### 7. Deployment

Deploy to Vercel:

```bash
npm run deploy
```

Or connect your GitHub repo to Vercel for automatic deployments.

**Important**: Add all environment variables in Vercel dashboard under Project
Settings → Environment Variables.

### 8. Monitoring

The application includes structured logging. Monitor your Vercel function logs
to track:

- Posts fetched from Reddit
- Candidates passing prefilter
- LLM classification results
- Email digest status
- Execution times

## Configuration

Key settings in environment variables:

- `SUBREDDITS`: Comma-separated list of subreddits to monitor
- `LLM_BATCH_SIZE`: Posts per LLM batch (default: 10)
- `MIN_SCORE_FOR_LLM`: Minimum Reddit score to process (default: 1)
- `QUALITY_THRESHOLD`: Minimum quality score for email (default: 3)
- `MAX_POSTS_PER_RUN`: Maximum posts to process per run (default: 120)

## How It Works

1. **Fetch**: Gets new posts from configured subreddits since last run
2. **Prefilter**: Scans for stock tickers and bullish language patterns
3. **Classify**: Sends promising posts to LLM for sentiment analysis
4. **Store**: Saves results to Postgres with upsert (idempotent)
5. **Email**: Sends digest of high-quality bullish posts
6. **Cursor**: Updates timestamp cursor for next run

## API Response

The `/api/poll` endpoint returns:

```json
{
  "ok": true,
  "fetched": 45,
  "candidates": 12,
  "llmClassified": 10,
  "emailed": 3,
  "executionTime": 15432
}
```

## Cost Optimization

- Prefilter reduces LLM API calls by ~90%
- Batch processing minimizes request overhead
- Body text truncated to 2000 chars max
- Configurable score thresholds filter low-quality posts
- Idempotent design prevents duplicate processing

## Troubleshooting

### No posts being processed

- Check subreddit names in `SUBREDDITS`
- Verify Reddit API credentials
- Lower `MIN_SCORE_FOR_LLM` threshold

### LLM classification failing

- Verify API keys for your chosen provider
- Check batch size isn't too large
- Monitor token usage

### Email not sending

- Verify Resend API key and domain setup
- Check `EMAIL_FROM` uses verified domain
- Look for email delivery logs in Resend dashboard

### Database errors

- Ensure Supabase service role key is used
- Verify schema was run correctly
- Check for connection limits

## Development

Type checking:

```bash
npm run type-check
```

Linting:

```bash
npm run lint
```

Build:

```bash
npm run build
```

## License

MIT
