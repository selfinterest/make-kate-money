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

export interface PerformanceReportProps {
  ssmParamArns: string[];
}

export class PerformanceReportConstruct extends Construct {
  public readonly func: lambdaNode.NodejsFunction;
  public readonly bucket: s3.Bucket;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: PerformanceReportProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'ReportsBucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    this.func = new lambdaNode.NodejsFunction(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '..', '..', 'lambda', 'performance-report.ts'),
      handler: 'handler',
      logGroup: this.logGroup,
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        define: { 'process.env.NODE_ENV': '"production"' },
      },
      environment: {
        NODE_ENV: 'production',
        PERFORMANCE_REPORT_BUCKET: this.bucket.bucketName,
      },
    });

    this.func.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: props.ssmParamArns,
    }));

    this.bucket.grantReadWrite(this.func);

    new events.Rule(this, 'DailySchedule', {
      description: 'Generate the two-week performance report after market close',
      schedule: events.Schedule.cron({ minute: '30', hour: '22' }),
      targets: [new targets.LambdaFunction(this.func)],
    });
  }
}
