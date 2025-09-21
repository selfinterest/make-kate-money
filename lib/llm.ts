import Ajv from 'ajv';
import { logger } from './logger';
import type { Config } from './config';
import llmSchema from '../assets/llm_schema.json';

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(llmSchema as any);

export interface LlmItem {
  post_id: string;
  title: string;
  body: string;
  tickers: string[];
}

export interface LlmResult {
  post_id: string;
  is_future_upside_claim: boolean;
  stance: 'bullish' | 'bearish' | 'unclear';
  reason: string;
  tickers: string[];
  quality_score: number;
}

const SYSTEM_PROMPT = `You are a precise financial-forum reader.

Definition of a prediction: ONLY when the author asserts a future UPWARD direction for a specific ticker using explicit forward-looking language (e.g., "will go up", "going to rise", "expect X to increase"). Mere hype/slang ("moon", "send it") IS NOT a prediction unless paired with an explicit forward-looking verb near a ticker.

Rules:
- is_future_upside_claim = true ONLY if:
  (a) explicit forward-looking verb (will/going to/expect) AND
  (b) upward direction AND
  (c) linked to a specific mentioned ticker.
- Conditional/hedged language ("might", "could", "if X then") without a clear base-case assertion => is_future_upside_claim=false and stance="unclear".
- Slang (moon, gap up, send it) counts ONLY as supporting evidence when (a)+(b)+(c) are present.
- Require at least one concrete rationale phrase (event/catalyst/valuation). If none, set is_future_upside_claim=false.
- Never invent tickers; restrict to provided detected tickers.

Return STRICT JSON that conforms to the provided schema.`;

function createUserPrompt(item: LlmItem): string {
  return `POST:
Title: ${item.title}
Body: ${item.body}

Detected tickers (from parser): ${item.tickers.join(', ')}

Return JSON with keys:
- is_future_upside_claim: boolean
- stance: "bullish" | "bearish" | "unclear"  
- reason: string (<= 2 sentences)
- tickers: array of uppercase tickers (subset of detected; exclude false positives)
- quality_score: integer 0..5 (evidence strength & clarity)
- evidence_phrases: array of short quotes that justify the prediction
- confidence: integer 0..5 (model confidence)

Rules:
- Phrases like "moon", "gap up", "send it", "breakout" count as bullish claims.
- Mere mention without a prediction => is_future_upside_claim = false.
- If heavily hedged ("maybe if") => stance = "unclear".
- Never invent tickers not in the detected list.`;
}

export async function classifyBatch(
  batch: LlmItem[],
  config: Config
): Promise<LlmResult[]> {
  if (batch.length === 0) {
    logger.debug('Empty batch provided to LLM');
    return [];
  }

  logger.info('Starting LLM classification', {
    batchSize: batch.length,
    provider: config.llm.provider
  });

  try {
    let rawResponse: string;

    if (config.llm.provider === 'openai') {
      rawResponse = await callOpenAI(batch, config);
    } else {
      throw new Error(`Unsupported LLM provider: ${config.llm.provider}`);
    }

    const results = parseAndValidateResponse(rawResponse, batch);

    logger.info('LLM classification completed', {
      batchSize: batch.length,
      validResults: results.length,
      provider: config.llm.provider
    });

    return results;

  } catch (error) {
    logger.error('LLM classification failed', {
      batchSize: batch.length,
      provider: config.llm.provider,
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    // Return empty results rather than failing the entire pipeline
    return [];
  }
}

async function callOpenAI(batch: LlmItem[], config: Config): Promise<string> {
  const { OpenAI } = await import('openai');

  const client = new OpenAI({
    apiKey: config.llm.openaiApiKey!
  });

  logger.debug('Calling OpenAI API', { batchSize: batch.length });

  // For batch processing, we'll send all posts in one request
  // and ask for a JSON array response
  const userContent = batch.map(item =>
    `POST ID: ${item.post_id}\n${createUserPrompt(item)}`
  ).join('\n\n---\n\n');

  const finalPrompt = `${userContent}\n\nReturn a JSON array with one object per post, each containing the post_id and analysis.`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: finalPrompt }
    ]
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error('OpenAI returned empty response');
  }

  logger.debug('OpenAI response received', {
    responseLength: content.length,
    usage: response.usage
  });

  return content;
}

async function callAnthropic(batch: LlmItem[], config: Config): Promise<string> {
  throw new Error('Anthropic provider is not supported in this implementation');
}

function parseAndValidateResponse(rawResponse: string, batch: LlmItem[]): LlmResult[] {
  logger.debug('Parsing LLM response', { responseLength: rawResponse.length });

  let parsed: any;

  try {
    parsed = JSON.parse(rawResponse);
  } catch (parseError) {
    logger.error('Failed to parse LLM JSON response', {
      error: parseError instanceof Error ? parseError.message : 'Unknown error',
      responsePreview: rawResponse.slice(0, 200)
    });
    return [];
  }

  // Handle different response formats
  let items: any[] = [];

  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed.results && Array.isArray(parsed.results)) {
    items = parsed.results;
  } else if (parsed.items && Array.isArray(parsed.items)) {
    items = parsed.items;
  } else if (typeof parsed === 'object' && parsed.post_id) {
    // Single object response
    items = [parsed];
  }

  logger.debug('Extracted items from response', { itemCount: items.length });

  const validResults: LlmResult[] = [];
  const batchPostIds = new Set(batch.map(item => item.post_id));

  for (const item of items) {
    // Ensure post_id exists and matches our batch
    if (!item.post_id || !batchPostIds.has(item.post_id)) {
      logger.warn('LLM result missing or invalid post_id', {
        providedId: item.post_id,
        hasValidId: batchPostIds.has(item.post_id)
      });
      continue;
    }

    // Validate against schema
    if (validate(item)) {
      validResults.push(item as LlmResult);
    } else {
      logger.warn('LLM result failed schema validation', {
        postId: item.post_id,
        errors: validate.errors
      });
    }
  }

  logger.info('Response validation completed', {
    rawItems: items.length,
    validResults: validResults.length,
    batchSize: batch.length
  });

  return validResults;
}

// Single post classification (useful for testing or retries)
export async function classifySingle(
  item: LlmItem,
  config: Config
): Promise<LlmResult | null> {
  const results = await classifyBatch([item], config);
  return results.length > 0 ? results[0] : null;
}