import type { Context } from 'aws-lambda';
import { logger } from '../lib/logger';
import { parseEnv } from '../lib/config';
import { getSupabaseClient } from '../lib/db';
import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

interface BacktestResult {
    ok: boolean;
    selectedThreshold?: number;
    dailyCounts?: Record<string, number>;
    windowDays?: number;
    error?: string;
}

export async function handler(event: any, context: Context): Promise<BacktestResult> {
    const start = Date.now();
    const log = logger.withContext({ requestId: context.awsRequestId, fn: 'backtest' });
    try {
        // Load config/creds
        const config = await parseEnv();
        const supabase = getSupabaseClient(config);

        // Window to evaluate
        const windowDays = 7;
        const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

        // Consider thresholds 3,4,5 (aligned with schema)
        const thresholds = [3, 4, 5];
        const dailyCounts: Record<string, number> = {};

        // Pull recent emailed alerts with tickers
        const { data: emailedRows, error: emailedErr } = await supabase
            .from('reddit_posts')
            .select('post_id, created_utc, detected_tickers, quality_score')
            .not('emailed_at', 'is', null)
            .gte('created_utc', sinceIso)
            .order('created_utc', { ascending: true });
        if (emailedErr) throw emailedErr;

        const alerts = (emailedRows || [])
            .map((r: any) => ({
                post_id: r.post_id as string,
                created_utc: r.created_utc as string,
                tickers: Array.isArray(r.detected_tickers) ? (r.detected_tickers as string[]).map(t => String(t).toUpperCase()) : [],
                quality_score: typeof r.quality_score === 'number' ? r.quality_score as number : null,
            }))
            .filter(a => a.tickers.length > 0);

        // Read backtest knobs from SSM
        const readParam = async (name: string): Promise<string | undefined> => {
            try {
                const s = new SSMClient({});
                const p = await s.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
                return p.Parameter?.Value ?? undefined;
            } catch { return undefined; }
        };

        const tpPct = Number((await readParam('/reddit-stock-watcher/BACKTEST_TP_PCT')) ?? '0.03');
        const slPct = Number((await readParam('/reddit-stock-watcher/BACKTEST_SL_PCT')) ?? '0.02');
        const horizonHours = Number((await readParam('/reddit-stock-watcher/BACKTEST_HOURS')) ?? '24');
        const maxTickers = Number((await readParam('/reddit-stock-watcher/BACKTEST_MAX_TICKERS_PER_RUN')) ?? '10');
        const apiKey = await readParam('/reddit-stock-watcher/ALPHA_VANTAGE_API_KEY');

        // Build ticker set (cap to limit API hits)
        const tickerSet = new Set<string>();
        for (const a of alerts) {
            for (const t of a.tickers) {
                if (!tickerSet.has(t)) {
                    tickerSet.add(t);
                    if (tickerSet.size >= maxTickers) break;
                }
            }
            if (tickerSet.size >= maxTickers) break;
        }

        // Ensure we have cached prices for these tickers (daily adjusted)
        if (apiKey && tickerSet.size > 0) {
            const toFetch: string[] = [];
            const cutoffMs = Date.now() - 2 * 24 * 60 * 60 * 1000; // refresh if last bar older than ~2 days
            for (const t of tickerSet) {
                const latest = await getLatestPriceTs(t, supabase);
                if (!latest || latest < cutoffMs) toFetch.push(t);
            }
            if (toFetch.length > 0) {
                await fetchAndCacheDailyPrices(toFetch, apiKey, supabase);
            }
        }

        // Helper to get daily bars from cache
        const loadDaily = async (ticker: string): Promise<Array<{ ts: number; open: number; high: number; low: number; close: number }>> => {
            const { data, error } = await supabase
                .from('prices')
                .select('ts, open, high, low, close')
                .eq('ticker', ticker)
                .order('ts', { ascending: true });
            if (error) return [];
            return (data || []).map((r: any) => ({ ts: new Date(r.ts).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
        };

        // Outcome labeling per alert
        interface Labeled { thrEligible: (thr: number) => boolean; win: boolean | null }
        const labeled: Array<Labeled> = [];
        for (const a of alerts) {
            const createdMs = new Date(a.created_utc).getTime();
            // Approx entry = next calendar day open (best-effort on daily data)
            const nextDay = new Date(createdMs + 24 * 60 * 60 * 1000);
            nextDay.setUTCHours(0, 0, 0, 0);

            // Use first ticker for labeling (heuristic)
            const t = a.tickers[0];
            const bars = await loadDaily(t);
            if (bars.length === 0) {
                labeled.push({ thrEligible: (thr) => (a.quality_score ?? -1) >= thr, win: null });
                continue;
            }

            // Find entry bar (the first bar on or after nextDay)
            const entryIdx = bars.findIndex(b => b.ts >= nextDay.getTime());
            if (entryIdx < 0) { labeled.push({ thrEligible: (thr) => (a.quality_score ?? -1) >= thr, win: null }); continue; }
            const entry = bars[entryIdx].open;
            const horizonDays = Math.max(1, Math.ceil(horizonHours / 24));
            const window = bars.slice(entryIdx, entryIdx + horizonDays);
            if (window.length === 0) { labeled.push({ thrEligible: (thr) => (a.quality_score ?? -1) >= thr, win: null }); continue; }
            const maxHigh = Math.max(...window.map(b => b.high));
            const minLow = Math.min(...window.map(b => b.low));
            const tpLevel = entry * (1 + tpPct);
            const slLevel = entry * (1 - slPct);
            const win = maxHigh >= tpLevel ? true : (minLow <= slLevel ? false : null);
            labeled.push({ thrEligible: (thr) => (a.quality_score ?? -1) >= thr, win });
        }

        // Compute precision per threshold using labeled outcomes (ignore nulls)
        const precisionByThr: Record<number, number> = {} as any;
        for (const thr of thresholds) {
            const sample = labeled.filter(l => l.thrEligible(thr) && l.win !== null);
            const wins = sample.filter(l => l.win === true).length;
            precisionByThr[thr] = sample.length > 0 ? wins / sample.length : 0;
        }

        // If we have any labeled samples, prefer precision tuning; else fallback to volume targeting
        let bestThr = thresholds[0];
        if (Object.values(precisionByThr).some(v => v > 0)) {
            let best = -1;
            for (const thr of thresholds) {
                const v = precisionByThr[thr];
                if (v > best || (v === best && thr > bestThr)) { best = v; bestThr = thr; }
            }
        } else {
            // Count how many posts per day would qualify for email at each threshold
            const dailyCounts: Record<string, number> = {};
            for (const thr of thresholds) {
                const byDay = new Map<string, number>();
                (alerts || []).forEach((r: any) => {
                    if ((r.quality_score ?? -1) >= thr) {
                        const day = new Date(r.created_utc).toISOString().slice(0, 10);
                        byDay.set(day, (byDay.get(day) || 0) + 1);
                    }
                });
                let sum = 0;
                for (let i = 0; i < windowDays; i++) {
                    const d = new Date(Date.now() - (windowDays - 1 - i) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
                    sum += byDay.get(d) || 0;
                }
                const avgPerDay = sum / windowDays;
                dailyCounts[String(thr)] = Number(avgPerDay.toFixed(3));
            }
            let targetPerDay = typeof event?.targetPerDay === 'number' ? event.targetPerDay : undefined;
            if (targetPerDay === undefined) {
                try {
                    const s = new SSMClient({});
                    const p = await s.send(new GetParameterCommand({ Name: '/reddit-stock-watcher/TARGET_EMAILS_PER_DAY', WithDecryption: false }));
                    const v = Number(p.Parameter?.Value ?? 'NaN');
                    if (!Number.isNaN(v) && v > 0) targetPerDay = v;
                } catch { }
            }
            if (targetPerDay === undefined) targetPerDay = 2;
            let bestDiff = Infinity;
            for (const thr of thresholds) {
                const diff = Math.abs(dailyCounts[String(thr)] - targetPerDay);
                if (diff < bestDiff || (diff === bestDiff && thr > bestThr)) { bestDiff = diff; bestThr = thr; }
            }
        }
        for (const thr of thresholds) {
            const { data, error } = await supabase
                .from('reddit_posts')
                .select('created_utc, quality_score')
                .eq('is_future_upside_claim', true)
                .eq('stance', 'bullish')
                .gte('quality_score', thr)
                .gte('created_utc', sinceIso)
                .order('created_utc', { ascending: true });
            if (error) throw error;

            const byDay = new Map<string, number>();
            (data || []).forEach((row: any) => {
                const day = new Date(row.created_utc).toISOString().slice(0, 10);
                byDay.set(day, (byDay.get(day) || 0) + 1);
            });
            // Average per day over the window (fill missing days with 0)
            let sum = 0;
            for (let i = 0; i < windowDays; i++) {
                const d = new Date(Date.now() - (windowDays - 1 - i) * 24 * 60 * 60 * 1000)
                    .toISOString()
                    .slice(0, 10);
                sum += byDay.get(d) || 0;
            }
            const avgPerDay = sum / windowDays;
            dailyCounts[String(thr)] = Number(avgPerDay.toFixed(3));
        }

        // Remove duplicated fallback block from earlier; bestThr is already chosen above

        // Write back to SSM if different from current (idempotent write)
        const ssm = new SSMClient({});
        await ssm.send(new PutParameterCommand({
            Name: '/reddit-stock-watcher/QUALITY_THRESHOLD',
            Value: String(bestThr),
            Overwrite: true,
            Type: 'String',
        }));

        log.info('Backtest completed', { windowDays, selectedThreshold: bestThr, precisionByThr });
        return { ok: true, selectedThreshold: bestThr, dailyCounts: Object.fromEntries(Object.entries(precisionByThr).map(([k, v]) => [k, Number(v.toFixed(3))])), windowDays };

    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logger.error('Backtest failed', { error: msg });
        return { ok: false, error: msg };
    } finally {
        logger.info('Backtest finished', { ms: Date.now() - start });
    }
}


async function fetchAndCacheDailyPrices(tickers: string[], apiKey: string, supabase: ReturnType<typeof getSupabaseClient>) {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    let count = 0;
    for (const ticker of tickers) {
        try {
            const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&outputsize=compact&apikey=${encodeURIComponent(apiKey)}`;
            // Use global fetch (Node 18)
            const res = await (globalThis as any).fetch(url);
            if (!res || !res.ok) { await sleep(1500); continue; }
            const json = await res.json();
            const series = json['Time Series (Daily)'] || {};
            const rows: any[] = [];
            for (const dateStr of Object.keys(series)) {
                const rec = series[dateStr];
                rows.push({
                    ticker,
                    ts: new Date(dateStr).toISOString(),
                    open: Number(rec['1. open']),
                    high: Number(rec['2. high']),
                    low: Number(rec['3. low']),
                    close: Number(rec['4. close']),
                });
            }
            if (rows.length > 0) {
                // Upsert in chunks to stay under row limits
                const chunkSize = 500;
                for (let i = 0; i < rows.length; i += chunkSize) {
                    const chunk = rows.slice(i, i + chunkSize);
                    const { error } = await supabase.from('prices').upsert(chunk as any, { onConflict: 'ticker,ts' });
                    if (error) break;
                }
            }
        } catch {
            // ignore and continue
        }
        // Alpha Vantage free limit ~5 req/min; be kind
        count++;
        if (count % 5 === 0) await sleep(60_000);
        else await sleep(1500);
    }
}

async function getLatestPriceTs(ticker: string, supabase: ReturnType<typeof getSupabaseClient>): Promise<number | null> {
    const { data, error } = await supabase
        .from('prices')
        .select('ts')
        .eq('ticker', ticker)
        .order('ts', { ascending: false })
        .limit(1);
    if (error || !data || data.length === 0) return null;
    return new Date((data[0] as any).ts).getTime();
}


