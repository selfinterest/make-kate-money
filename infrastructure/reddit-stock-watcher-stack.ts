import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
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

    // CloudWatch metrics from structured JSON logs
    const namespace = 'RedditStockWatcher';

    // emailedCount metric
    new logs.MetricFilter(this, 'EmailsSentMetric', {
      logGroup: pollLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.emailedCount = * }'),
      metricNamespace: namespace,
      metricName: 'EmailedCount',
      metricValue: '$.emailedCount',
      defaultValue: 0,
    });

    // LLM itemCount metric (items sent to LLM per run)
    new logs.MetricFilter(this, 'LlmItemCountMetric', {
      logGroup: pollLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.itemCount = * }'),
      metricNamespace: namespace,
      metricName: 'LlmItemCount',
      metricValue: '$.itemCount',
      defaultValue: 0,
    });

    // No emails in 24h alarm
    const emailsMetric = new cloudwatch.Metric({
      namespace,
      metricName: 'EmailedCount',
      period: cdk.Duration.hours(1),
      statistic: 'sum',
    });

    const noEmailsAlarm = new cloudwatch.Alarm(this, 'NoEmails24h', {
      metric: emailsMetric,
      evaluationPeriods: 24,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'No emails sent in the last 24 hours',
    });

    // SNS topic and email subscription for alerts
    const alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      displayName: 'Reddit Stock Watcher Alerts',
    });

    // Use a deploy-time parameter for alert email (CloudFormation-friendly)
    const alertEmailParam = new cdk.CfnParameter(this, 'AlertEmail', {
      type: 'String',
      description: 'Email address to receive operational alerts',
    });
    alertsTopic.addSubscription(new snsSubs.EmailSubscription(alertEmailParam.valueAsString));

    // Alarm: Lambda function errors > 0 in last 5 minutes
    const errorsMetric = pollFunction.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'sum' });
    const errorsAlarm = new cloudwatch.Alarm(this, 'LambdaErrors', {
      metric: errorsMetric,
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Lambda reported errors in the last 5 minutes',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Wire alarms to SNS
    errorsAlarm.addAlarmAction({ bind: () => ({ alarmActionArn: alertsTopic.topicArn }) });
    noEmailsAlarm.addAlarmAction({ bind: () => ({ alarmActionArn: alertsTopic.topicArn }) });

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