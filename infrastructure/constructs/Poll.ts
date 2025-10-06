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

export interface PollConstructProps {
    ssmParamArns: string[];
    tickersBucket?: s3.IBucket;
}

export class PollConstruct extends Construct {
  public readonly func: lambdaNode.NodejsFunction;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: PollConstructProps) {
    super(scope, id);

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    this.func = new lambdaNode.NodejsFunction(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '..', '..', 'lambda', 'poll.ts'),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        define: { 'process.env.NODE_ENV': '"production"' },
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        NODE_ENV: 'production',
        ...(props.tickersBucket && { TICKERS_BUCKET: props.tickersBucket.bucketName }),
      },
      logGroup: this.logGroup,
    });

    // Least-privilege SSM read
    this.func.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: props.ssmParamArns,
    }));

    // Grant S3 read access to tickers bucket if provided
    if (props.tickersBucket) {
      props.tickersBucket.grantRead(this.func);
    }

    // 5-minute schedule
    const rule = new events.Rule(this, 'Schedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Trigger Reddit stock watcher every 5 minutes',
    });
    rule.addTarget(new targets.LambdaFunction(this.func));
  }
}


