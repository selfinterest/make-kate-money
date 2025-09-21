import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';

export class RedditStockWatcherStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lambda function for polling Reddit
    const pollLogGroup = new logs.LogGroup(this, 'PollFunctionLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const pollFunction = new lambdaNode.NodejsFunction(this, 'PollFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '..', 'lambda', 'poll.ts'),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node18',
        define: { 'process.env.NODE_ENV': '"production"' },
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        NODE_ENV: 'production',
      },
      logGroup: pollLogGroup,
    });

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
    ].map(name => `arn:aws:ssm:${this.region}:${this.account}:parameter/reddit-stock-watcher/${name}`);

    pollFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: ssmParamArns,
    }));

    // EventBridge rule for 5-minute schedule
    const pollRule = new events.Rule(this, 'PollRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Trigger Reddit stock watcher every 5 minutes'
    });

    // Add Lambda function as target
    pollRule.addTarget(new targets.LambdaFunction(pollFunction));

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
      'LLM_MAX_BODY_CHARS'
    ];

    // Create SSM parameters (will need to be populated manually)
    parameterNames.forEach(paramName => {
      new ssm.StringParameter(this, `${paramName}Parameter`, {
        parameterName: `/reddit-stock-watcher/${paramName}`,
        stringValue: 'REPLACE_ME', // Placeholder value
        description: `Configuration parameter for ${paramName}`,
      });
    });

    // Outputs
    new cdk.CfnOutput(this, 'FunctionName', {
      value: pollFunction.functionName,
      description: 'Name of the Lambda function'
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: pollFunction.functionArn,
      description: 'ARN of the Lambda function'
    });

    new cdk.CfnOutput(this, 'ParameterPrefix', {
      value: '/reddit-stock-watcher/',
      description: 'Parameter Store prefix for configuration values'
    });
  }
}