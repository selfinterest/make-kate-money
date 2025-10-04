import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export interface BacktestConstructProps {
    ssmParamArns: string[];
    qualityThresholdArn: string;
}

export class BacktestConstruct extends Construct {
    public readonly func: lambdaNode.NodejsFunction;
    public readonly logGroup: logs.LogGroup;

    constructor(scope: Construct, id: string, props: BacktestConstructProps) {
        super(scope, id);

        this.logGroup = new logs.LogGroup(this, 'Logs', {
            retention: logs.RetentionDays.ONE_MONTH,
        });

        this.func = new lambdaNode.NodejsFunction(this, 'Function', {
            runtime: lambda.Runtime.NODEJS_20_X,
            architecture: lambda.Architecture.ARM_64,
            entry: path.join(__dirname, '..', '..', 'lambda', 'backtest.ts'),
            handler: 'handler',
            bundling: {
                minify: true,
                sourceMap: false,
                target: 'node18',
                define: { 'process.env.NODE_ENV': '"production"' },
            },
            timeout: cdk.Duration.minutes(2),
            memorySize: 256,
            environment: {
                NODE_ENV: 'production',
            },
            logGroup: this.logGroup,
        });

        this.func.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter', 'ssm:GetParameters'],
            resources: props.ssmParamArns,
        }));
        this.func.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:PutParameter'],
            resources: [props.qualityThresholdArn],
        }));

        new events.Rule(this, 'Nightly', {
            schedule: events.Schedule.cron({ minute: '5', hour: '2' }),
            description: 'Run nightly backtest to auto-tune QUALITY_THRESHOLD',
            targets: [new targets.LambdaFunction(this.func)],
        });
    }
}


