import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';

export interface AlertsConstructProps {
    pollLogGroup: logs.ILogGroup;
    alertEmailParam?: cdk.CfnParameter;
}

export class AlertsConstruct extends Construct {
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlertsConstructProps) {
    super(scope, id);

    const namespace = 'RedditStockWatcher';

    // SNS Topic
    this.topic = new sns.Topic(this, 'Topic', { displayName: 'Reddit Stock Watcher Alerts' });

    if (props.alertEmailParam) {
      this.topic.addSubscription(new snsSubs.EmailSubscription(props.alertEmailParam.valueAsString));
    }

    // Metrics from logs
    new logs.MetricFilter(this, 'EmailsSentMetric', {
      logGroup: props.pollLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.emailedCount = * }'),
      metricNamespace: namespace,
      metricName: 'EmailedCount',
      metricValue: '$.emailedCount',
      defaultValue: 0,
    });

    new logs.MetricFilter(this, 'LlmItemCountMetric', {
      logGroup: props.pollLogGroup,
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
    noEmailsAlarm.addAlarmAction({ bind: () => ({ alarmActionArn: this.topic.topicArn }) });
  }
}


