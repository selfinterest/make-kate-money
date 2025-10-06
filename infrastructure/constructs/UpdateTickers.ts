import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';

export interface UpdateTickersConstructProps {
  ssmParamArns: string[];
}

export class UpdateTickersConstruct extends Construct {
  public readonly func: lambdaNode.NodejsFunction;
  public readonly bucket: s3.Bucket;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: UpdateTickersConstructProps) {
    super(scope, id);

    // S3 bucket for storing ticker lists
    this.bucket = new s3.Bucket(this, 'TickersBucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: 'DeleteOldBackups',
          enabled: true,
          expiration: cdk.Duration.days(90), // Keep backups for 90 days
          prefix: 'tickers/backups/',
        },
      ],
    });

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    this.func = new lambdaNode.NodejsFunction(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '..', '..', 'lambda', 'update-tickers.ts'),
      handler: 'handler',
      logGroup: this.logGroup,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        define: { 'process.env.NODE_ENV': '"production"' },
      },
      environment: {
        NODE_ENV: 'production',
        TICKERS_BUCKET: this.bucket.bucketName,
      },
    });

    // Grant SSM parameter access
    this.func.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: props.ssmParamArns,
    }));

    // Grant S3 access
    this.bucket.grantReadWrite(this.func);

    // Weekly schedule - runs every Monday at 6 AM UTC (1 AM EST)
    new events.Rule(this, 'WeeklySchedule', {
      description: 'Update ticker list from GitHub repository weekly',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '6',
        weekDay: 'MON',
      }),
      targets: [new targets.LambdaFunction(this.func)],
    });

    // Optional: Daily schedule for testing (can be removed in production)
    // Uncomment the following if you want daily updates for testing
    /*
    new events.Rule(this, 'DailySchedule', {
      description: 'Update ticker list from Tiingo API daily (testing)',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '6'
      }),
      targets: [new targets.LambdaFunction(this.func)],
    });
    */
  }
}
