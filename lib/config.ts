import { logger } from './logger';

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
    serviceRoleKey: string;
  };
  
  // LLM
  llm: {
    provider: 'openai' | 'anthropic';
    openaiApiKey?: string;
    anthropicApiKey?: string;
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

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    const error = `Missing required environment variable: ${key}`;
    logger.error('Config validation failed', { missingVar: key });
    throw new Error(error);
  }
  return value;
}

function getOptionalEnv(key: string, defaultValue: string = ''): string {
  return process.env[key] ?? defaultValue;
}

function getIntEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    logger.warn('Invalid integer environment variable', { key, value });
    return defaultValue;
  }
  return parsed;
}

export function parseEnv(): Config {
  logger.info('Parsing environment configuration');
  
  try {
    const llmProvider = getOptionalEnv('LLM_PROVIDER', 'openai') as 'openai' | 'anthropic';
    
    // Validate LLM provider and required API key
    if (llmProvider === 'openai' && !process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
    }
    if (llmProvider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');
    }
    
    const config: Config = {
      reddit: {
        clientId: getRequiredEnv('REDDIT_CLIENT_ID'),
        clientSecret: getRequiredEnv('REDDIT_CLIENT_SECRET'),
        username: getRequiredEnv('REDDIT_USERNAME'),
        password: getRequiredEnv('REDDIT_PASSWORD'),
        userAgent: getRequiredEnv('REDDIT_USER_AGENT'),
      },
      
      supabase: {
        url: getRequiredEnv('SUPABASE_URL'),
        serviceRoleKey: getRequiredEnv('SUPABASE_SERVICE_ROLE'),
      },
      
      llm: {
        provider: llmProvider,
        openaiApiKey: getOptionalEnv('OPENAI_API_KEY'),
        anthropicApiKey: getOptionalEnv('ANTHROPIC_API_KEY'),
      },
      
      email: {
        resendApiKey: getRequiredEnv('RESEND_API_KEY'),
        from: getRequiredEnv('EMAIL_FROM'),
        to: getRequiredEnv('EMAIL_TO'),
      },
      
      app: {
        subreddits: getOptionalEnv('SUBREDDITS', 'stocks,investing,wallstreetbets,pennystocks').split(','),
        cronWindowMinutes: getIntEnv('CRON_WINDOW_MINUTES', 5),
        llmBatchSize: getIntEnv('LLM_BATCH_SIZE', 10),
        llmMaxBodyChars: getIntEnv('LLM_MAX_BODY_CHARS', 2000),
        minScoreForLlm: getIntEnv('MIN_SCORE_FOR_LLM', 1),
        qualityThreshold: getIntEnv('QUALITY_THRESHOLD', 3),
        maxPostsPerRun: getIntEnv('MAX_POSTS_PER_RUN', 120),
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