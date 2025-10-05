import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PollConstruct } from './constructs/Poll';
import { BacktestConstruct } from './constructs/Backtest';
import { AlertsConstruct } from './constructs/Alerts';
import { PerformanceReportConstruct } from './constructs/PerformanceReport';
import { BackfillLlmTickersConstruct } from './constructs/BackfillLlmTickers';
import { UpdateTickersConstruct } from './constructs/UpdateTickers';

export class RedditStockWatcherStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Poll construct (Lambda + schedule + SSM read)

    // Alerts and metrics are moved into Alerts construct below

    // IAM policy for Parameter Store access (least privilege)
    const ssmParamArns = [
      'REDDIT_CLIENT_ID',
      'REDDIT_CLIENT_SECRET',
      'REDDIT_USERNAME',
      'REDDIT_PASSWORD',
      'SUPABASE_URL',
      'SUPABASE_API_KEY',
      'OPENAI_API_KEY',
      'RESEND_API_KEY',
      'EMAIL_FROM',
      'EMAIL_TO',
      'SUBREDDITS',
      'LLM_PROVIDER',
      'LLM_BATCH_SIZE',
      'MIN_SCORE_FOR_LLM',
      'QUALITY_THRESHOLD',
      'MAX_POSTS_PER_RUN',
      'CRON_WINDOW_MINUTES',
      'LLM_MAX_BODY_CHARS',
      'MIN_VOTES_PER_MINUTE_FOR_LLM',
      'TARGET_EMAILS_PER_DAY',
      'ALPHA_VANTAGE_API_KEY',
      'BACKTEST_TP_PCT',
      'BACKTEST_SL_PCT',
      'BACKTEST_HOURS',
      'BACKTEST_MAX_TICKERS_PER_RUN',
      'TIINGO_API_KEY',
    ].map(name => `arn:aws:ssm:${this.region}:${this.account}:parameter/reddit-stock-watcher/${name}`);


    // Nightly Backtest Lambda to auto-tune QUALITY_THRESHOLD
    const backtest = new BacktestConstruct(this, 'Backtest', {
      ssmParamArns,
      qualityThresholdArn: `arn:aws:ssm:${this.region}:${this.account}:parameter/reddit-stock-watcher/QUALITY_THRESHOLD`,
    });

    const backfill = new BackfillLlmTickersConstruct(this, 'BackfillLlmTickers', {
      ssmParamArns,
    });

    const performance = new PerformanceReportConstruct(this, 'PerformanceReport', {
      ssmParamArns,
    });

    const updateTickers = new UpdateTickersConstruct(this, 'UpdateTickers', {
      ssmParamArns,
    });

    // Update Poll construct to use tickers bucket
    const poll = new PollConstruct(this, 'Poll', { 
      ssmParamArns,
      tickersBucket: updateTickers.bucket,
    });

    // Parameter Store parameters for configuration
    const parameterNames = [
      'REDDIT_CLIENT_ID',
      'REDDIT_CLIENT_SECRET',
      'REDDIT_USERNAME',
      'REDDIT_PASSWORD',
      'SUPABASE_URL',
      'SUPABASE_API_KEY',
      'OPENAI_API_KEY',
      'RESEND_API_KEY',
      'EMAIL_FROM',
      'EMAIL_TO',
      'SUBREDDITS',
      'LLM_PROVIDER',
      'LLM_BATCH_SIZE',
      'MIN_SCORE_FOR_LLM',
      'QUALITY_THRESHOLD',
      'MAX_POSTS_PER_RUN',
      'CRON_WINDOW_MINUTES',
      'LLM_MAX_BODY_CHARS',
      'MIN_VOTES_PER_MINUTE_FOR_LLM'
      , 'TARGET_EMAILS_PER_DAY'
      , 'ALPHA_VANTAGE_API_KEY'
      , 'BACKTEST_TP_PCT'
      , 'BACKTEST_SL_PCT'
      , 'BACKTEST_HOURS'
      , 'BACKTEST_MAX_TICKERS_PER_RUN'
      , 'TIINGO_API_KEY'
    ];

    // Create SSM parameters (will need to be populated manually)
    parameterNames.forEach(paramName => {
      new ssm.StringParameter(this, `${paramName}Parameter`, {
        parameterName: `/reddit-stock-watcher/${paramName}`,
        stringValue: 'REPLACE_ME', // Placeholder value
        description: `Configuration parameter for ${paramName}`,
      });
    });

    // Alerts construct (metrics + SNS)
    const alertEmailParam = new cdk.CfnParameter(this, 'AlertEmail', {
      type: 'String',
      description: 'Email address to receive operational alerts',
    });
    new AlertsConstruct(this, 'Alerts', { pollLogGroup: poll.logGroup, alertEmailParam });

    // Outputs
    new cdk.CfnOutput(this, 'FunctionName', {
      value: poll.func.functionName,
      description: 'Name of the Lambda function'
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: poll.func.functionArn,
      description: 'ARN of the Lambda function'
    });

    new cdk.CfnOutput(this, 'BackfillFunctionName', {
      value: backfill.func.functionName,
      description: 'Manual backfill Lambda function for LLM tickers'
    });

    new cdk.CfnOutput(this, 'BackfillFunctionArn', {
      value: backfill.func.functionArn,
      description: 'ARN of the LLM ticker backfill Lambda'
    });

    new cdk.CfnOutput(this, 'ParameterPrefix', {
      value: '/reddit-stock-watcher/',
      description: 'Parameter Store prefix for configuration values'
    });

    new cdk.CfnOutput(this, 'PerformanceReportBucket', {
      value: performance.bucket.bucketName,
      description: 'S3 bucket storing performance reports',
    });

    new cdk.CfnOutput(this, 'TickersBucket', {
      value: updateTickers.bucket.bucketName,
      description: 'S3 bucket storing ticker lists',
    });

    new cdk.CfnOutput(this, 'UpdateTickersFunctionName', {
      value: updateTickers.func.functionName,
      description: 'Name of the ticker update Lambda function',
    });
  }
}
