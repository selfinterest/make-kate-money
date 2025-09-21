#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RedditStockWatcherStack } from './reddit-stock-watcher-stack';

const app = new cdk.App();

new RedditStockWatcherStack(app, 'RedditStockWatcherStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});