# Spec: Reddit Stock Upside Watcher — **AWS CDK + Lambda + Supabase + LLM**

End goal: run a **stateless, scheduled job** on **AWS Lambda** (triggered by
**EventBridge**) that:

1. pulls fresh Reddit posts from selected subs,
2. prefilters for likely _bullish_ claims about specific **tickers**,
3. runs an **LLM** once to classify + summarize,
4. stores results in **Supabase Postgres**, and
5. emails a digest of high-confidence bullish posts. No agents. No long-running
   workers. Deterministic, cheap, and idempotent.

---

## 0) Tech Stack

- Runtime: **TypeScript / Node 18** (bundled via esbuild)
- Infra: **AWS CDK (v2)**
- Compute: **AWS Lambda** (ARM_64)
- Scheduler: **Amazon EventBridge** (rate cron)
- Config/Secrets: **AWS Systems Manager Parameter Store (SSM)**
- Logs/Metrics/Alerts: **CloudWatch Logs + Metric Filters + SNS**
- DB: **Supabase Postgres**
- Reddit API: **snoowrap** (script app credentials)
- LLM: **OpenAI gpt-4o-mini**, JSON-only
- Email: **Resend**

---

## 1) Configuration (SSM Parameters)

All runtime configuration is stored in AWS SSM under the prefix
`/reddit-stock-watcher/`. Use `./scripts/update-parameters-from-env.sh` to bulk
upload from a local `.env`.

Required:

- `/reddit-stock-watcher/REDDIT_CLIENT_ID`
- `/reddit-stock-watcher/REDDIT_CLIENT_SECRET`
- `/reddit-stock-watcher/REDDIT_USERNAME`
- `/reddit-stock-watcher/REDDIT_PASSWORD`
- `/reddit-stock-watcher/SUPABASE_URL`
- `/reddit-stock-watcher/SUPABASE_API_KEY` (service role)
- `/reddit-stock-watcher/OPENAI_API_KEY`
- `/reddit-stock-watcher/RESEND_API_KEY`
- `/reddit-stock-watcher/EMAIL_FROM`
- `/reddit-stock-watcher/EMAIL_TO`
- `/reddit-stock-watcher/TIINGO_API_KEY`

App knobs:

- `/reddit-stock-watcher/SUBREDDITS` (csv)
- `/reddit-stock-watcher/CRON_WINDOW_MINUTES` (default 5)
- `/reddit-stock-watcher/LLM_BATCH_SIZE` (default 10)
- `/reddit-stock-watcher/LLM_MAX_BODY_CHARS` (default 2000)
- `/reddit-stock-watcher/MIN_SCORE_FOR_LLM` (default 1)
- `/reddit-stock-watcher/QUALITY_THRESHOLD` (tuned nightly)
- `/reddit-stock-watcher/MAX_POSTS_PER_RUN` (default 120)

Backtest knobs:

- `/reddit-stock-watcher/TARGET_EMAILS_PER_DAY` (fallback when precision sample
  is thin)
- `/reddit-stock-watcher/ALPHA_VANTAGE_API_KEY`
- `/reddit-stock-watcher/BACKTEST_TP_PCT` (default 0.03)
- `/reddit-stock-watcher/BACKTEST_SL_PCT` (default 0.02)
- `/reddit-stock-watcher/BACKTEST_HOURS` (default 24)
- `/reddit-stock-watcher/BACKTEST_MAX_TICKERS_PER_RUN` (default 10)

Alerting:

- CDK parameter `AlertEmail` (set at deploy) subscribes to an SNS topic for
  alarms.

## 2) Scheduling (EventBridge)

- Poller: `rate(5 minutes)` → triggers `lambda/poll.ts`
- Backtest: `cron(5 2 * * ? *)` → runs nightly at 02:05 UTC to tune
  `QUALITY_THRESHOLD`
- Performance report: `cron(30 22 * * ? *)` → generates two-week P&L summary after
  U.S. market close (>=18:30 ET)
- (Optional) PriceFetcher: `cron(30 1 * * ? *)` → pre-warms Alpha Vantage prices
  cache

3. Supabase Schema (SQL) sql Copy code create table if not exists reddit_posts (
   post_id text primary key, -- e.g., 't3_abc123' title text not null, body
   text, subreddit text not null, author text, url text not null, --
   https://www.reddit.com/... created_utc timestamptz not null, score int
   default 0, detected_tickers text[] default '{}', -- from prefilter

-- LLM outputs is_future_upside_claim boolean, stance text check (stance in
('bullish','bearish','unclear')), reason text, quality_score int check
(quality_score between 0 and 5),

-- bookkeeping emailed_at timestamptz, processed_at timestamptz default now() );

create index if not exists idx_posts_created on reddit_posts (created_utc desc);
create index if not exists idx_posts_email on reddit_posts (emailed_at); create
index if not exists idx_posts_quality on reddit_posts (is_future_upside_claim,
stance, quality_score); create index if not exists idx_posts_tickers on
reddit_posts using gin (detected_tickers);

create table if not exists app_meta( key text primary key, value jsonb not null,
updated_at timestamptz default now() );

insert into app_meta(key, value) values ('last_cursor',
jsonb_build_object('created_utc', '1970-01-01T00:00:00Z')) on conflict (key) do
nothing; RLS: For simplicity, use the service role key from the serverless
function and keep RLS disabled for these two tables. If you need RLS later, add
narrow policies and switch to function-invoked RPCs.

4. Code Layout bash Copy code /api/poll.ts # serverless entrypoint (Node
   runtime, NOT Edge) /lib/config.ts # env parsing, constants /lib/reddit.ts #
   snoowrap client + fetchNew() /lib/prefilter.ts # ticker + upside lexicon +
   stop-list /lib/llm.ts # JSON-mode batch classify/summarize /lib/db.ts #
   Supabase client + upserts + cursor mgmt /lib/email.ts # Resend digest
   /assets/tickers.json # US ticker whitelist (uppercase) /assets/stoplist.json
   # words that look like tickers but aren't
5. Serverless Handler Contract: Run once; do everything (ingest → prefilter →
   LLM → persist → email) and exit within plan limits.

ts Copy code // /api/poll.ts import type { VercelRequest, VercelResponse } from
'@vercel/node'; import { parseEnv } from '@/lib/config'; import { fetchNew }
from '@/lib/reddit'; import { prefilter } from '@/lib/prefilter'; import {
classifyBatch } from '@/lib/llm'; import { getCursor, setCursor, upsertPosts,
selectForEmail, markEmailed } from '@/lib/db'; import { sendDigest } from
'@/lib/email';

export default async function handler(req: VercelRequest, res: VercelResponse) {
try { const cfg = parseEnv(); const sinceIso = await getCursor('last_cursor');
const posts = await fetchNew(cfg.subreddits, sinceIso, cfg.cronWindowMinutes,
cfg.maxPostsPerRun);

    // Cheap prefilter
    const candidates = posts
      .filter(p => p.score >= cfg.minScoreForLlm)
      .map(p => prefilter(p, cfg))
      .filter(x => x.tickers.length > 0 && x.upsideHits.length > 0);

    if (!candidates.length) {
      await setCursor('last_cursor', posts);
      return res.status(200).json({ ok: true, fetched: posts.length, candidates: 0, emailed: 0 });
    }

    // LLM classify in batches
    const items = candidates.map(c => ({
      post_id: c.post.id,
      title: c.post.title,
      body: (c.post.selftext ?? '').slice(0, cfg.llmMaxBodyChars),
      tickers: c.tickers
    }));

    const batched: typeof items[] = [];
    for (let i = 0; i < items.length; i += cfg.llmBatchSize) batched.push(items.slice(i, i+cfg.llmBatchSize));

    const results = [];
    for (const chunk of batched) {
      const r = await classifyBatch(chunk, cfg);
      results.push(...r);
    }

    await upsertPosts(candidates, results);

    // Build and send digest
    const winners = await selectForEmail({ minQuality: cfg.qualityThreshold });
    if (winners.length) {
      await sendDigest(winners, cfg);
      await markEmailed(winners.map(w => w.post_id));
    }

    await setCursor('last_cursor', posts);
    return res.status(200).json({
      ok: true,
      fetched: posts.length,
      candidates: candidates.length,
      llmClassified: results.length,
      emailed: winners.length
    });

} catch (err: any) { console.error('poll error', err); return
res.status(500).json({ ok: false, error: err?.message ?? 'unknown' }); } } 6)
Reddit Ingestion ts Copy code // /lib/reddit.ts import Snoowrap from 'snoowrap';

const r = new Snoowrap({ userAgent: process.env.REDDIT_USER_AGENT!, clientId:
process.env.REDDIT_CLIENT_ID!, clientSecret: process.env.REDDIT_CLIENT_SECRET!,
username: process.env.REDDIT_USERNAME!, password: process.env.REDDIT_PASSWORD!,
});

export type Post = { id: string; title: string; selftext?: string; subreddit:
string; author: string; url: string; createdUtc: string; // ISO score: number;
};

export async function fetchNew(subreddits: string[], sinceIso: string,
windowMinutes: number, maxPosts: number): Promise<Post[]> { const sinceMs =
sinceIso ? new Date(sinceIso).getTime() : 0; const windowMs = windowMinutes *
60 * 1000;

const out: Post[] = []; for (const sub of subreddits) { const items = await
r.getSubreddit(sub).getNew({ limit: 100 }); for (const s of items) { const
createdMs = (s.created_utc ?? 0) * 1000; // Keep overlap window to tolerate
retries/clock skew; ignore very old beyond window if (sinceMs && createdMs +
windowMs < sinceMs) continue; out.push({ id: s.id, title: s.title, selftext: (s
as any).selftext ?? '', subreddit: sub, author: (s as any).author?.name ??
'unknown', url: `https://www.reddit.com${s.permalink}`, createdUtc: new
Date(createdMs).toISOString(), score: s.score ?? 0, }); } } // Deduplicate and
cap const byId = new Map(out.map(p => [p.id, p])); const dedup =
[...byId.values()].sort((a,b) => +new Date(a.createdUtc) - +new
Date(b.createdUtc)); return dedup.slice(-maxPosts); } 7) Prefilter (Tickers +
Upside Language) ts Copy code // /lib/prefilter.ts import type { Post } from
'./reddit'; import stoplist from '@/assets/stoplist.json'; import tickers from
'@/assets/tickers.json';

const TICKERS = new Set<string>(tickers); // uppercase symbols const STOP = new
Set<string>(stoplist); // uppercase words to ignore const CASHTAG =
/\$[A-Z]{1,5}\b/g;

const UPSIDE_CLUES = [ 'will go
up','bullish','undervalued','catalyst','breakout','run-up','gap up',
'moon','pump','squeeze','price target','upside','rerate','re-rate', 'fda
approval','pdufa','earnings beat','raise guidance','beat and raise', 'new
highs','break resistance' ];

export type Prefiltered = { post: Post; tickers: string[]; upsideHits: string[];
};

export function prefilter(post: Post): Prefiltered { const text =
`${post.title}\n${post.selftext ?? ''}`; const U = text.toUpperCase();

// 1) Cashtags const cashtags = new Set((U.match(CASHTAG) ?? []).map(s =>
s.slice(1)).filter(t => TICKERS.has(t) && !STOP.has(t)));

// 2) Bare tickers (word boundaries) const words = U.match(/\b[A-Z]{2,5}\b/g) ??
[]; for (const w of words) { if (TICKERS.has(w) && !STOP.has(w))
cashtags.add(w); }

// 3) Upside clues const lower = text.toLowerCase(); const hits =
UPSIDE_CLUES.filter(c => lower.includes(c));

return { post, tickers: [...cashtags], upsideHits: hits }; } Ticker whitelist:
assets/tickers.json should be a full U.S. equities list (1–5 letters,
uppercase). Stop-list seed:
["ON","ALL","FOR","IT","OR","ANY","ONE","META","SHOP","RUN","EDIT","EV","AI"].
Expand as you encounter collisions.

8. LLM Classification & Summarization 8.1 JSON Schema (Validator-friendly) json
   Copy code { "$schema": "http://json-schema.org/draft-07/schema#", "title":
   "RedditPostLLMResult", "type": "object", "required":
   ["post_id","is_future_upside_claim","stance","reason","tickers","quality_score"],
   "properties": { "post_id": { "type": "string" }, "is_future_upside_claim": {
   "type": "boolean" }, "stance": { "type": "string", "enum":
   ["bullish","bearish","unclear"] }, "reason": { "type": "string", "maxLength":
   320 }, "tickers": { "type": "array", "items": { "type": "string", "pattern":
   "^[A-Z]{1,5}$" }, "uniqueItems": true }, "quality_score": { "type":
   "integer", "minimum": 0, "maximum": 5 } }, "additionalProperties": false }
   8.2 Prompt (System + User template) System

pgsql Copy code You are a precise financial-forum reader. Determine if the
author makes a forward-looking claim that a stock will go up. Summarize the
rationale in ≤2 sentences. Do not give financial advice. Return STRICT JSON that
conforms to the provided schema. User (template)

php Copy code POST: Title: {{title}} Body: {{body_truncated}}

Detected tickers (from parser): {{tickers_csv}}

Return JSON with keys:

- is_future_upside_claim: boolean
- stance: "bullish" | "bearish" | "unclear"
- reason: string (<= 2 sentences)
- tickers: array of uppercase tickers (subset of detected; exclude false
  positives)
- quality_score: integer 0..5 (evidence strength & clarity)

Rules:

- Phrases like "moon", "gap up", "send it", "breakout" count as bullish claims.
- Mere mention without a prediction => is_future_upside_claim = false.
- If heavily hedged ("maybe if") => stance = "unclear".
- Never invent tickers not in the detected list. 8.3 Few-Shot Examples Example A
  — Clear bullish

vbnet Copy code Title: TSLA going to moon after delivery numbers Body: Delivery
beat expectations and analyst PTs are up. Loading calls. Detected tickers: TSLA
json Copy code { "post_id":"<FILL_AT_RUNTIME>", "is_future_upside_claim": true,
"stance": "bullish", "reason": "Predicts a rise due to delivery beat and analyst
upgrades.", "tickers": ["TSLA"], "quality_score": 4 } Example B — Mention only

yaml Copy code Title: Just bought a few shares of AMZN Body: Diversifying my
portfolio a bit. Detected tickers: AMZN json Copy code {
"post_id":"<FILL_AT_RUNTIME>", "is_future_upside_claim": false, "stance":
"unclear", "reason": "Mentions a purchase without any forward-looking claim.",
"tickers": ["AMZN"], "quality_score": 2 } Example C — Catalyst bullish

vbnet Copy code Title: VRTX will explode after FDA decision Body: PDUFA date
this Friday. Approval looks very likely. Detected tickers: VRTX json Copy code {
"post_id":"<FILL_AT_RUNTIME>", "is_future_upside_claim": true, "stance":
"bullish", "reason": "Expects a post-approval move driven by an upcoming FDA
decision.", "tickers": ["VRTX"], "quality_score": 5 } Example D — Bearish call

yaml Copy code Title: NVDA overbought, expect pullback Body: RSI extreme and
possible distribution; waiting for a better entry. Detected tickers: NVDA json
Copy code { "post_id":"<FILL_AT_RUNTIME>", "is_future_upside_claim": false,
"stance": "bearish", "reason": "Predicts price decline due to overbought
conditions.", "tickers": ["NVDA"], "quality_score": 4 } Example E — Meme bullish

vbnet Copy code Title: GME YOLO 🚀🚀🚀 Body: Squeeze still alive, get in or stay
poor. Detected tickers: GME json Copy code { "post_id":"<FILL_AT_RUNTIME>",
"is_future_upside_claim": true, "stance": "bullish", "reason": "Meme language
implying a continued squeeze and upside.", "tickers": ["GME"], "quality_score":
3 } 8.4 LLM Client (provider-agnostic) ts Copy code // /lib/llm.ts import Ajv
from 'ajv'; import schema from '@/assets/llm_schema.json';

const ajv = new Ajv({ allErrors: true, strict: false }); const validate =
ajv.compile(schema as any);

type LlmItem = { post_id: string; title: string; body: string; tickers:
string[]; }; export type LlmResult = { post_id: string; is_future_upside_claim:
boolean; stance: 'bullish'|'bearish'|'unclear'; reason: string; tickers:
string[]; quality_score: number; };

export async function classifyBatch(batch: LlmItem[], cfg: any):
Promise<LlmResult[]> { const { LLM_PROVIDER } = process.env; const sys = /*
system prompt above */; const userBlocks = batch.map((b,i) => ({ role: 'user',
content: `POST: Title: ${b.title} Body: ${b.body}

Detected tickers (from parser): ${b.tickers.join(', ')}

Return JSON with keys:

- is_future_upside_claim: boolean
- stance: "bullish" | "bearish" | "unclear"
- reason: string (<= 2 sentences)
- tickers: array of uppercase tickers (subset of detected; exclude false
  positives)
- quality_score: integer 0..5

Rules:

- Phrases like "moon", "gap up", "send it", "breakout" count as bullish.
- Mere mention without prediction => false.
- Heavily hedged => "unclear".
- Never invent tickers not detected.` }));

  let raw: string;

  if (LLM_PROVIDER === 'openai') { // OpenAI JSON mode sketch const { OpenAI } =
  await import('openai'); const client = new OpenAI({ apiKey:
  process.env.OPENAI_API_KEY! }); const chat = await
  client.chat.completions.create({ model: 'gpt-4o-mini', temperature: 0.2,
  response_format: { type: 'json_object' }, messages: [{ role:'system', content:
  sys }, ...userBlocks] }); raw = chat.choices[0].message.content ?? '{}'; }
  else { // Anthropic sketch const { Anthropic } = await
  import('@anthropic-ai/sdk'); const client = new Anthropic({ apiKey:
  process.env.ANTHROPIC_API_KEY! }); const msg = await client.messages.create({
  model: 'claude-3-5-sonnet-20240620', temperature: 0.2, max_tokens: 800,
  system: sys, messages: [{ role:'user', content: userBlocks.map(b =>
  b.content).join('\n\n---\n\n') }], }); raw = (msg.content[0] as any)?.text ??
  '{}'; }

  // Expected shape: either a single object or a JSON list of objects. let
  parsed: any; try { parsed = JSON.parse(raw); } catch { // one retry with a
  strict reminder could be added here parsed = []; }

  const arr: any[] = Array.isArray(parsed) ? parsed : (parsed.items ??
  parsed.results ?? []); const results: LlmResult[] = []; for (const obj of arr)
  { if (validate(obj)) results.push(obj); } return results; } Implementation
  note: for OpenAI, you can also send one post per call to get a single JSON
  object back (simpler parsing) at the cost of more overhead. The above shows a
  “batch prompt in one message” pattern; adapt to actual provider JSON-mode
  behavior.

9. DB Accessors & Idempotency ts Copy code // /lib/db.ts import { createClient }
   from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!,
process.env.SUPABASE_SERVICE_ROLE!);

export async function getCursor(key: string): Promise<string> { const { data } =
await supabase.from('app_meta').select('value').eq('key', key).single(); return
data?.value?.created_utc ?? '1970-01-01T00:00:00Z'; }

export async function setCursor(key: string, posts: { createdUtc: string }[]) {
const latest = posts.reduce((m, p) => (+new Date(p.createdUtc) > +new Date(m) ?
p.createdUtc : m), '1970-01-01T00:00:00Z'); await
supabase.from('app_meta').upsert({ key, value: { created_utc: latest } }); }

export async function upsertPosts( candidates: { post: any; tickers: string[]
}[], results: any[] ) { const byId = new Map(results.map((r:any) => [r.post_id,
r])); const rows = candidates.map(c => { const r = byId.get(c.post.id); return {
post_id: c.post.id, title: c.post.title, body: c.post.selftext ?? '', subreddit:
c.post.subreddit, author: c.post.author, url: c.post.url, created_utc:
c.post.createdUtc, score: c.post.score, detected_tickers: c.tickers,
is_future_upside_claim: r?.is_future_upside_claim ?? null, stance: r?.stance ??
null, reason: r?.reason ?? null, quality_score: r?.quality_score ?? null }; });

// upsert by primary key await supabase.from('reddit_posts').upsert(rows, {
onConflict: 'post_id' }); }

export async function selectForEmail({ minQuality }: { minQuality: number }) {
const { data } = await supabase .from('reddit_posts') .select('*')
.is('emailed_at', null) .eq('is_future_upside_claim', true) .eq('stance',
'bullish') .gte('quality_score', minQuality) .order('created_utc', { ascending:
true }); return data ?? []; }

export async function markEmailed(ids: string[]) { if (!ids.length) return;
await supabase.from('reddit_posts') .update({ emailed_at: new
Date().toISOString() }) .in('post_id', ids); } 10) Email Digest ts Copy code //
/lib/email.ts import { Resend } from 'resend';

export async function sendDigest(rows: any[], cfg: any) { const r = new
Resend(process.env.RESEND_API_KEY!); const date = new
Date().toISOString().slice(0,10); const items = rows.map(row =>
`**${(row.detected_tickers ?? []).join(', ')}** — ${row.title}
Reason: ${row.reason}
[Open](${row.url})\n`).join('\n');

const md =
`# 🚀 Stock Watch — ${date}\n\n${items}\n\n*FYI only, not investment advice.*`;

await r.emails.send({ from: process.env.EMAIL_FROM!, to: process.env.EMAIL_TO!,
subject: `🚀 Stock Watch — ${date}`, text: md.replace(/\*\*/g, ''), // plain
fallback html: md.replace(/\n/g, '<br/>') }); } 11) Cost & Latency Controls
Prefilter reduces LLM volume drastically (tickers ∩ whitelist + upside words).

Truncate body to LLM_MAX_BODY_CHARS (default 2000).

Batch size LLM_BATCH_SIZE=10; increase/decrease to fit Vercel time limits.

Score gate MIN_SCORE_FOR_LLM=1 to drop dead posts.

Back-pressure: cap MAX_POSTS_PER_RUN.

Idempotency: UNIQUE(post_id) + emailed_at IS NULL.

Overlap safety: the CRON_WINDOW_MINUTES overlap window ensures late posts aren’t
missed and duplicates are safe due to upsert.

12. Safety, Compliance, & API Hygiene Add email disclaimer: “This is not
    investment advice. Do your own research.”

Respect Reddit Terms & rate limits; set a descriptive User-Agent.

Filter known pump-and-dump patterns if desired; apply min account-age/karma
thresholds later.

13. Testing Plan Unit

Regex parsing (tickers, stop-list collisions).

Upside lexicon matches (case/emoji/spacing).

JSON schema validation of LLM results (good/bad payloads).

Integration

Mock Reddit (fixtures) → prefilter → LLM (stubbed) → DB upsert.

DB upsert idempotency (run twice, no dupes).

Email rendering produces expected HTML/text.

Load/Timeout

Simulate spikes (e.g., 120 posts) with LLM disabled; ensure run < 60s.

Then enable LLM with small batches; verify still within limits or reduce
schedule to 5–10 min.

14. Extensibility (Later) Add comments ingestion (getNewComments) with same
    pipeline.

Add author quality features (account age, karma) to adjust quality_score.

Add per-ticker digest or Slack webhook.

Add a dashboard (Supabase + simple UI) to inspect results and tune thresholds.

Add nightly backfill mode: scan “top (day)” to seed the DB.

15. Deliverables Checklist vercel.json cron

SQL for Supabase tables

/api/poll.ts handler

/lib/* modules: config, reddit, prefilter, llm, db, email

assets/tickers.json (US symbols) + assets/stoplist.json

assets/llm_schema.json (JSON schema above)

README with setup steps and environment variables

16. README Quick Start cp .env.example .env (for local dev only; deploy vars in
    Vercel UI).

Load Supabase schema.

Add assets/tickers.json (uppercase list).

Deploy to Vercel → add env vars.

Enable Cron: */5 * * * *.

Watch logs for fetched / candidates / emailed counters.

17. Non-Goals / Explicitly Not Using Temporal or other workflow engines.

Agentic AI (no tool use, no external browsing).

Long-running VMs or background daemons.

Reddit scraping without OAuth (use API only).

```
```
