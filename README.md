# Reddit Stock Upside Watcher

A serverless application that monitors Reddit posts for bullish stock sentiment,
analyzes them with LLM, and sends email digests.

## Architecture

- **Runtime**: TypeScript/Node.js on AWS Lambda
- **Scheduler**: EventBridge Rules (every 5 minutes)
- **Infrastructure**: AWS CDK
- **Database**: Supabase Postgres
- **Configuration**: AWS Systems Manager Parameter Store
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
- AWS CLI configured with appropriate permissions
- AWS CDK CLI installed (`npm install -g aws-cdk`)
- Supabase account
- Reddit API credentials (script app)
- OpenAI API key
- Resend account

### 2. Reddit API Setup

1. Go to https://www.reddit.com/prefs/apps
2. Create a "script" application
3. Note down your client ID and secret

### 3. Database Setup

1. Create a new Supabase project
2. Run the SQL schema in `schema.sql` in your SQL editor
3. Note your project URL and API key from Settings → API

### 4. AWS Setup

#### Install CDK dependencies:

```bash
npm install
```

#### Bootstrap CDK (first time only):

```bash
cdk bootstrap
```

#### Deploy the stack:

```bash
npm run deploy

## AWS_PROFILE=AdministratorAccess cdk deploy --require-approval never --parameters AlertEmail="$(AWS_PROFILE=AdministratorAccess aws ssm get-parameter --with-decryption --name /reddit-stock-watcher/EMAIL_TO --query Parameter.Value --output text)"
```

This will create:

- Lambda function
- EventBridge rule (5-minute schedule)
- Parameter Store parameters (with placeholder values)
- IAM roles and policies
- CloudWatch log groups

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

### 6. Configure Parameters

After deployment, you need to update the Parameter Store values with your actual
configuration:

```bash
aws ssm put-parameter --name "/reddit-stock-watcher/REDDIT_CLIENT_ID" --value "YOUR_CLIENT_ID" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/REDDIT_CLIENT_SECRET" --value "YOUR_CLIENT_SECRET" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/REDDIT_USERNAME" --value "YOUR_USERNAME" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/REDDIT_PASSWORD" --value "YOUR_PASSWORD" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/SUPABASE_URL" --value "YOUR_SUPABASE_URL" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/SUPABASE_API_KEY" --value "YOUR_SUPABASE_KEY" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/OPENAI_API_KEY" --value "YOUR_OPENAI_KEY" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/RESEND_API_KEY" --value "YOUR_RESEND_KEY" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/EMAIL_FROM" --value "your-email@domain.com" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/EMAIL_TO" --value "target@domain.com" --overwrite
```

Optional parameters (with defaults):

```bash
aws ssm put-parameter --name "/reddit-stock-watcher/SUBREDDITS" --value "stocks,investing,wallstreetbets,pennystocks" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/LLM_BATCH_SIZE" --value "10" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/MIN_SCORE_FOR_LLM" --value "1" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/QUALITY_THRESHOLD" --value "3" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/MAX_POSTS_PER_RUN" --value "120" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/CRON_WINDOW_MINUTES" --value "5" --overwrite
aws ssm put-parameter --name "/reddit-stock-watcher/LLM_MAX_BODY_CHARS" --value "2000" --overwrite
```

### 7. Testing

Test the Lambda function directly:

```bash
aws lambda invoke --function-name RedditStockWatcherStack-PollFunction* --payload '{}' response.json
cat response.json
```

### 8. Monitoring

The application includes structured logging. Monitor your Lambda function logs
in CloudWatch:

```bash
aws logs tail --follow /aws/lambda/RedditStockWatcherStack-PollFunction*
```

Track:

- Posts fetched from Reddit
- Candidates passing prefilter
- LLM classification results
- Email digest status
- Execution times

### 9. Management

View EventBridge rules:

```bash
aws events list-rules --name-prefix RedditStockWatcherStack
```

Update deployment:

```bash
npm run deploy
```

Clean up resources:

```bash
npm run cdk:destroy
```

## Configuration

Key settings in Parameter Store:

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

## Lambda Response

The Lambda function returns:

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
