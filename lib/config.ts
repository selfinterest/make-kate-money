import { logger } from './logger';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

export interface Config {
  // Reddit
  reddit: {
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
    userAgent: string;
  };

  // Supabase
  supabase: {
    url: string;
    apiKey: string;
  };

  // LLM
  llm: {
    provider: 'openai';
    openaiApiKey: string;
  };

  // Email
  email: {
    resendApiKey: string;
    from: string;
    to: string;
  };

  // App settings
  app: {
    subreddits: string[];
    cronWindowMinutes: number;
    llmBatchSize: number;
    llmMaxBodyChars: number;
    minScoreForLlm: number;
    qualityThreshold: number;
    maxPostsPerRun: number;
  };
}

// Cache for parameter store values
let parameterCache: Record<string, string> | null = null;

async function loadParameters(): Promise<Record<string, string>> {
  if (parameterCache) {
    return parameterCache;
  }

  const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
  
  const parameterNames = [
    '/reddit-stock-watcher/REDDIT_CLIENT_ID',
    '/reddit-stock-watcher/REDDIT_CLIENT_SECRET',
    '/reddit-stock-watcher/REDDIT_USERNAME', 
    '/reddit-stock-watcher/REDDIT_PASSWORD',
    '/reddit-stock-watcher/SUPABASE_URL',
    '/reddit-stock-watcher/SUPABASE_API_KEY',
    '/reddit-stock-watcher/OPENAI_API_KEY',
    '/reddit-stock-watcher/RESEND_API_KEY',
    '/reddit-stock-watcher/EMAIL_FROM',
    '/reddit-stock-watcher/EMAIL_TO',
    '/reddit-stock-watcher/SUBREDDITS',
    '/reddit-stock-watcher/LLM_PROVIDER',
    '/reddit-stock-watcher/LLM_BATCH_SIZE',
    '/reddit-stock-watcher/MIN_SCORE_FOR_LLM',
    '/reddit-stock-watcher/QUALITY_THRESHOLD',
    '/reddit-stock-watcher/MAX_POSTS_PER_RUN',
    '/reddit-stock-watcher/CRON_WINDOW_MINUTES',
    '/reddit-stock-watcher/LLM_MAX_BODY_CHARS'
  ];

  try {
    const command = new GetParametersCommand({
      Names: parameterNames,
      WithDecryption: true
    });

    const response = await ssmClient.send(command);
    
    parameterCache = {};
    response.Parameters?.forEach(param => {
      if (param.Name && param.Value) {
        // Convert /reddit-stock-watcher/KEY to KEY
        const key = param.Name.split('/').pop();
        if (key) {
          parameterCache![key] = param.Value;
        }
      }
    });

    logger.info('Loaded parameters from Parameter Store', { 
      parameterCount: Object.keys(parameterCache).length 
    });

    return parameterCache;
  } catch (error) {
    logger.error('Failed to load parameters from Parameter Store', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw new Error(`Failed to load configuration from Parameter Store: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function getRequiredParam(params: Record<string, string>, key: string): string {
  const value = params[key];
  if (!value || value === 'REPLACE_ME') {
    const error = `Missing required parameter: ${key}`;
    logger.error('Config validation failed', { missingParam: key });
    throw new Error(error);
  }
  return value;
}

function getOptionalParam(params: Record<string, string>, key: string, defaultValue: string = ''): string {
  return params[key] && params[key] !== 'REPLACE_ME' ? params[key] : defaultValue;
}

function getIntParam(params: Record<string, string>, key: string, defaultValue: number): number {
  const value = params[key];
  if (!value || value === 'REPLACE_ME') return defaultValue;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    logger.warn('Invalid integer parameter', { key, value });
    return defaultValue;
  }
  return parsed;
}

export async function parseEnv(): Promise<Config> {
  logger.info('Parsing environment configuration');

  try {
    const params = await loadParameters();
    const llmProvider = 'openai' as const;

    const config: Config = {
      reddit: {
        clientId: getRequiredParam(params, 'REDDIT_CLIENT_ID'),
        clientSecret: getRequiredParam(params, 'REDDIT_CLIENT_SECRET'),
        username: getRequiredParam(params, 'REDDIT_USERNAME'),
        password: getRequiredParam(params, 'REDDIT_PASSWORD'),
        userAgent: 'Reddit Stock Watcher Bot v1.0',
      },

      supabase: {
        url: getRequiredParam(params, 'SUPABASE_URL'),
        apiKey: getRequiredParam(params, 'SUPABASE_API_KEY'),
      },

      llm: {
        provider: llmProvider,
        openaiApiKey: getRequiredParam(params, 'OPENAI_API_KEY'),
      },

      email: {
        resendApiKey: getRequiredParam(params, 'RESEND_API_KEY'),
        from: getRequiredParam(params, 'EMAIL_FROM'),
        to: getRequiredParam(params, 'EMAIL_TO'),
      },

      app: {
        subreddits: getOptionalParam(params, 'SUBREDDITS', 'stocks,investing,wallstreetbets,pennystocks').split(','),
        cronWindowMinutes: getIntParam(params, 'CRON_WINDOW_MINUTES', 5),
        llmBatchSize: getIntParam(params, 'LLM_BATCH_SIZE', 10),
        llmMaxBodyChars: getIntParam(params, 'LLM_MAX_BODY_CHARS', 2000),
        minScoreForLlm: getIntParam(params, 'MIN_SCORE_FOR_LLM', 1),
        qualityThreshold: getIntParam(params, 'QUALITY_THRESHOLD', 3),
        maxPostsPerRun: getIntParam(params, 'MAX_POSTS_PER_RUN', 120),
      },
    };

    // Validate configuration
    if (config.app.llmBatchSize <= 0) {
      throw new Error('LLM_BATCH_SIZE must be greater than 0');
    }

    if (config.app.qualityThreshold < 0 || config.app.qualityThreshold > 5) {
      throw new Error('QUALITY_THRESHOLD must be between 0 and 5');
    }

    if (config.app.subreddits.length === 0) {
      throw new Error('At least one subreddit must be specified in SUBREDDITS');
    }

    logger.info('Configuration parsed successfully', {
      subredditCount: config.app.subreddits.length,
      llmProvider: config.llm.provider,
      batchSize: config.app.llmBatchSize,
      qualityThreshold: config.app.qualityThreshold,
    });

    return config;

  } catch (error) {
    logger.error('Failed to parse configuration', { error: error instanceof Error ? error.message : 'Unknown error' });
    throw error;
  }
}