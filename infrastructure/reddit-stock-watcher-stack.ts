import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
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
      'SUPABASE_ANON_KEY',
      'SUPABASE_ANON_KEY',
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
      'MAX_PRICE_MOVE_PCT_FOR_ALERT',
      'TARGET_EMAILS_PER_DAY',
      'ALPHA_VANTAGE_API_KEY',
      'BACKTEST_TP_PCT',
      'BACKTEST_SL_PCT',
      'BACKTEST_HOURS',
      'BACKTEST_MAX_TICKERS_PER_RUN',
      'TIINGO_API_KEY',
    ].map(name => `arn:aws:ssm:${this.region}:${this.account}:parameter/reddit-stock-watcher/${name}`);


    // Nightly Backtest Lambda to auto-tune QUALITY_THRESHOLD
    new BacktestConstruct(this, 'Backtest', {
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
      'MIN_VOTES_PER_MINUTE_FOR_LLM',
      'MAX_PRICE_MOVE_PCT_FOR_ALERT'
      , 'TARGET_EMAILS_PER_DAY'
      , 'ALPHA_VANTAGE_API_KEY'
      , 'BACKTEST_TP_PCT'
      , 'BACKTEST_SL_PCT'
      , 'BACKTEST_HOURS'
      , 'BACKTEST_MAX_TICKERS_PER_RUN'
      , 'TIINGO_API_KEY',
    ];

    // Create SSM parameters (will need to be populated manually)
    parameterNames.forEach(paramName => {
      new ssm.StringParameter(this, `${paramName}Parameter`, {
        parameterName: `/reddit-stock-watcher/${paramName}`,
        stringValue: 'REPLACE_ME', // Placeholder value
        description: `Configuration parameter for ${paramName}`,
      });
    });

    // Import existing hosted zone for katey.dev
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'KateyDevZone', {
      hostedZoneId: 'Z06224933H6U8S4RHR5DR',
      zoneName: 'katey.dev',
    });

    // Create SSL certificate for the custom domain
    // Must be in us-east-1 for CloudFront
    const certificate = new acm.Certificate(this, 'WebUiCertificate', {
      domainName: 'money.katey.dev',
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const webUiBucket = new s3.Bucket(this, 'WebUiBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    /*const webUiOriginIdentity = new cloudfront.OriginAccessIdentity(this, 'WebUiOriginIdentity', {
      comment: 'Access identity for portfolio UI distribution',
    });
    webUiBucket.grantRead(webUiOriginIdentity)*/;

    const webUiDistribution = new cloudfront.Distribution(this, 'WebUiDistribution', {
      defaultRootObject: 'index.html',
      domainNames: ['money.katey.dev'],
      certificate: certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webUiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(1),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(1),
        },
      ],
    });

    const webUiAssetPath = path.resolve(__dirname, '..', 'web', 'dist');
    if (!fs.existsSync(webUiAssetPath)) {
      throw new Error(`Web UI build assets not found at ${webUiAssetPath}. Run "npm --prefix web run build" before deploying.`);
    }

    new s3deploy.BucketDeployment(this, 'WebUiDeployment', {
      sources: [s3deploy.Source.asset(webUiAssetPath)],
      destinationBucket: webUiBucket,
      distribution: webUiDistribution,
      distributionPaths: ['/*'],
    });

    // Create Route53 A record pointing to CloudFront distribution
    new route53.ARecord(this, 'WebUiAliasRecord', {
      zone: hostedZone,
      recordName: 'money',
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(webUiDistribution)
      ),
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
      description: 'Name of the Lambda function',
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: poll.func.functionArn,
      description: 'ARN of the Lambda function',
    });

    new cdk.CfnOutput(this, 'BackfillFunctionName', {
      value: backfill.func.functionName,
      description: 'Manual backfill Lambda function for LLM tickers',
    });

    new cdk.CfnOutput(this, 'BackfillFunctionArn', {
      value: backfill.func.functionArn,
      description: 'ARN of the LLM ticker backfill Lambda',
    });

    new cdk.CfnOutput(this, 'ParameterPrefix', {
      value: '/reddit-stock-watcher/',
      description: 'Parameter Store prefix for configuration values',
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

    new cdk.CfnOutput(this, 'WebUiBucketName', {
      value: webUiBucket.bucketName,
      description: 'S3 bucket serving the portfolio web UI',
    });

    new cdk.CfnOutput(this, 'WebUiDistributionDomain', {
      value: webUiDistribution.distributionDomainName,
      description: 'CloudFront domain for the portfolio dashboard',
    });

    new cdk.CfnOutput(this, 'WebUiCustomDomain', {
      value: 'https://money.katey.dev',
      description: 'Custom domain URL for the portfolio dashboard',
    });
  }
}
