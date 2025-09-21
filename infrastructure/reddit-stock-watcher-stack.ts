import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
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
    const pollFunction = new lambda.Function(this, 'PollFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'lambda/poll.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..'), {
        exclude: [
          'node_modules',
          'cdk.out',
          'infrastructure',
          '.git',
          '*.md',
          'tsconfig.json',
          'cdk.json',
          'package*.json'
        ]
      }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        // Environment variables will be set via Parameter Store references
        NODE_ENV: 'production',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // IAM policy for Parameter Store access
    pollFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath'
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/reddit-stock-watcher/*`
      ]
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