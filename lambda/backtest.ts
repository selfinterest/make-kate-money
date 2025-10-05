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
        log.info('Calculating time window', { windowDays });
        const windowStartMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
        log.info('Window start calculation', { windowStartMs });
        const windowStartDate = new Date(windowStartMs);
        log.info('Window start date created', { windowStartDate: windowStartDate.toISOString() });
        const sinceIso = windowStartDate.toISOString();
        log.info('Time window calculated', { sinceIso, windowDays });

        // Consider thresholds 3,4,5 (aligned with schema)
        const thresholds = [3, 4, 5];
        const dailyCounts: Record<string, number> = {};

        // Pull recent emailed alerts with tickers
        log.info('Querying database for emailed alerts', { sinceIso });
        const { data: emailedRows, error: emailedErr } = await supabase
            .from('reddit_posts')
            .select('post_id, created_utc, detected_tickers, llm_tickers, quality_score')
            .not('emailed_at', 'is', null)
            .gte('created_utc', sinceIso)
            .order('created_utc', { ascending: true });
        if (emailedErr) {
            log.error('Database query failed', { error: emailedErr });
            throw emailedErr;
        }
        log.info('Database query successful', { rowCount: emailedRows?.length || 0 });

        log.info('Processing emailed alerts', { totalRows: emailedRows?.length || 0 });
        let alerts: any[] = [];
        try {
            alerts = (emailedRows || [])
                .map((r: any) => ({
                    post_id: r.post_id as string,
                    created_utc: r.created_utc as string,
                    tickers: (() => {
                        const llm = Array.isArray(r.llm_tickers) ? (r.llm_tickers as string[]) : [];
                        const detected = Array.isArray(r.detected_tickers) ? (r.detected_tickers as string[]) : [];
                        const chosen = llm.length > 0 ? llm : detected;
                        return chosen.map(t => String(t).toUpperCase());
                    })(),
                    quality_score: typeof r.quality_score === 'number' ? r.quality_score as number : null,
                }))
                .filter(a => a.tickers.length > 0)
                .filter(a => {
                    const created = coerceDate(a.created_utc);
                    if (!created) {
                        log.warn('Skipping alert with invalid created_utc', { postId: a.post_id, createdUtc: a.created_utc });
                        return false;
                    }
                    return true;
                });
            log.info('Alerts processing complete', { validAlertCount: alerts.length });
        } catch (error) {
            log.error('Error processing alerts', { error: error instanceof Error ? error.message : 'Unknown error' });
            throw error;
        }

        // Read backtest knobs from SSM
        log.info('Reading SSM parameters');
        const readParam = async (name: string): Promise<string | undefined> => {
            try {
                const s = new SSMClient({});
                const p = await s.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
                return p.Parameter?.Value ?? undefined;
            } catch { return undefined; }
        };

        log.info('Reading TP_PCT parameter');
        const tpPctRaw = await readParam('/reddit-stock-watcher/BACKTEST_TP_PCT');
        log.info('TP_PCT raw value', { raw: tpPctRaw, type: typeof tpPctRaw, isUndefined: tpPctRaw === undefined, isNull: tpPctRaw === null });
        const tpPctDefault = tpPctRaw ?? '0.03';
        log.info('TP_PCT after default', { defaultValue: tpPctDefault, type: typeof tpPctDefault });
        const tpPct = Number(tpPctDefault);
        log.info('TP_PCT parameter', { raw: tpPctRaw, defaultValue: tpPctDefault, parsed: tpPct, isValid: !isNaN(tpPct) });
        
        log.info('Reading SL_PCT parameter');
        const slPctRaw = await readParam('/reddit-stock-watcher/BACKTEST_SL_PCT');
        const slPct = Number(slPctRaw ?? '0.02');
        log.info('SL_PCT parameter', { raw: slPctRaw, parsed: slPct, isValid: !isNaN(slPct) });
        
        log.info('Reading BACKTEST_HOURS parameter');
        const horizonHoursRaw = await readParam('/reddit-stock-watcher/BACKTEST_HOURS');
        log.info('BACKTEST_HOURS raw value', { raw: horizonHoursRaw, type: typeof horizonHoursRaw, isUndefined: horizonHoursRaw === undefined, isNull: horizonHoursRaw === null });
        const horizonHoursDefault = horizonHoursRaw ?? '24';
        log.info('BACKTEST_HOURS after default', { defaultValue: horizonHoursDefault, type: typeof horizonHoursDefault });
        const horizonHours = Number(horizonHoursDefault);
        log.info('BACKTEST_HOURS parameter', { raw: horizonHoursRaw, defaultValue: horizonHoursDefault, parsed: horizonHours, isValid: !isNaN(horizonHours) });
        
        log.info('Reading MAX_TICKERS parameter');
        const maxTickersRaw = await readParam('/reddit-stock-watcher/BACKTEST_MAX_TICKERS_PER_RUN');
        const maxTickers = Number(maxTickersRaw ?? '10');
        log.info('MAX_TICKERS parameter', { raw: maxTickersRaw, parsed: maxTickers, isValid: !isNaN(maxTickers) });
        
        // Validate all parameters
        if (isNaN(tpPct) || tpPct <= 0 || tpPct >= 1) {
            log.error('Invalid TP_PCT parameter', { tpPct, raw: tpPctRaw });
            throw new Error(`Invalid TP_PCT parameter: ${tpPctRaw}`);
        }
        if (isNaN(slPct) || slPct <= 0 || slPct >= 1) {
            log.error('Invalid SL_PCT parameter', { slPct, raw: slPctRaw });
            throw new Error(`Invalid SL_PCT parameter: ${slPctRaw}`);
        }
        if (isNaN(horizonHours) || horizonHours <= 0) {
            log.error('Invalid horizonHours parameter', { horizonHours, raw: horizonHoursRaw });
            throw new Error(`Invalid horizonHours parameter: ${horizonHoursRaw}`);
        }
        if (isNaN(maxTickers) || maxTickers <= 0) {
            log.error('Invalid maxTickers parameter', { maxTickers, raw: maxTickersRaw });
            throw new Error(`Invalid maxTickers parameter: ${maxTickersRaw}`);
        }
        
        log.info('Getting Tiingo API key');
        const tiingoApiKey = config.marketData.tiingoApiKey;
        log.info('SSM parameters loaded and validated', { tpPct, slPct, horizonHours, maxTickers, hasTiingoKey: !!tiingoApiKey });

        // Build ticker set (cap to limit API hits)
        log.info('Building ticker set');
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
        log.info('Ticker set built', { tickerCount: tickerSet.size, tickers: Array.from(tickerSet) });

        // Ensure we have cached prices for these tickers (daily adjusted)
        if (tiingoApiKey && tickerSet.size > 0) {
            log.info('Checking cached prices for tickers');
            const toFetch: string[] = [];
            const cutoffMs = Date.now() - 2 * 24 * 60 * 60 * 1000; // refresh if last bar older than ~2 days
            log.info('Cutoff time calculated', { cutoffMs, cutoffDate: new Date(cutoffMs).toISOString() });
            
            for (const t of tickerSet) {
                log.info('Checking latest price for ticker', { ticker: t });
                try {
                    const latest = await getLatestPriceTs(t, supabase);
                    log.info('Latest price timestamp retrieved', { ticker: t, latest, needsFetch: !latest || latest < cutoffMs });
                    if (!latest || latest < cutoffMs) toFetch.push(t);
                } catch (error) {
                    log.error('Error getting latest price timestamp', { ticker: t, error: error instanceof Error ? error.message : 'Unknown error' });
                    toFetch.push(t); // Fetch if we can't determine the latest timestamp
                }
            }
            
            log.info('Tickers to fetch', { toFetchCount: toFetch.length, toFetch });
            if (toFetch.length > 0) {
                log.info('Fetching daily prices from Tiingo');
                const horizonDays = Math.max(1, Math.ceil(horizonHours / 24)) + 2;
                log.info('Calculated horizonDays', { horizonHours, horizonDays, calculation: `Math.max(1, Math.ceil(${horizonHours} / 24)) + 2` });
                
                if (isNaN(horizonDays) || horizonDays <= 0) {
                    log.error('Invalid horizonDays calculation', { horizonHours, horizonDays });
                    throw new Error(`Invalid horizonDays calculation: ${horizonDays} from horizonHours: ${horizonHours}`);
                }
                
                try {
                    await fetchAndCacheDailyPrices({
                        tickers: toFetch,
                        tiingoApiKey,
                        supabase,
                        horizonDays,
                    });
                    log.info('Daily prices fetch completed');
                } catch (error) {
                    log.error('Error in fetchAndCacheDailyPrices', { error: error instanceof Error ? error.message : 'Unknown error' });
                    throw error;
                }
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
            return (data || []).map((r: any) => {
                const tsDate = coerceDate(r.ts);
                if (!tsDate) {
                    log.warn('Skipping price row with invalid ts', { ticker, ts: r.ts });
                    return null;
                }
                return { ts: tsDate.getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) };
            }).filter((r): r is NonNullable<typeof r> => r !== null);
        };

        // Outcome labeling per alert
        log.info('Starting outcome labeling', { alertCount: alerts.length });
        interface Labeled { thrEligible: (thr: number) => boolean; win: boolean | null }
        const labeled: Array<Labeled> = [];
        for (let i = 0; i < alerts.length; i++) {
            const a = alerts[i];
            log.info('Processing alert for labeling', { index: i, postId: a.post_id, tickers: a.tickers, qualityScore: a.quality_score });
            const created = coerceDate(a.created_utc);
            if (!created) {
                log.warn('Skipping alert with invalid created_utc in labeling', { postId: a.post_id, createdUtc: a.created_utc });
                labeled.push({ thrEligible: (thr) => (a.quality_score ?? -1) >= thr, win: null });
                continue;
            }
            const createdMs = created.getTime();
            log.info('Created timestamp processed', { postId: a.post_id, createdMs, createdDate: created.toISOString() });
            
            // Approx entry = next calendar day open (best-effort on daily data)
            const nextDay = new Date(createdMs + 24 * 60 * 60 * 1000);
            nextDay.setUTCHours(0, 0, 0, 0);
            log.info('Next day calculated', { postId: a.post_id, nextDay: nextDay.toISOString() });

            // Use first ticker for labeling (heuristic)
            const t = a.tickers[0];
            log.info('Loading daily bars for ticker', { postId: a.post_id, ticker: t });
            const bars = await loadDaily(t);
            log.info('Daily bars loaded', { postId: a.post_id, ticker: t, barCount: bars.length });
            if (bars.length === 0) {
                labeled.push({ thrEligible: (thr) => (a.quality_score ?? -1) >= thr, win: null });
                continue;
            }

            // Find entry bar (the first bar on or after nextDay)
            const entryIdx = bars.findIndex(b => b.ts >= nextDay.getTime());
            log.info('Entry bar search', { postId: a.post_id, ticker: t, entryIdx, nextDayTime: nextDay.getTime() });
            if (entryIdx < 0) { 
                log.info('No entry bar found', { postId: a.post_id, ticker: t });
                labeled.push({ thrEligible: (thr) => (a.quality_score ?? -1) >= thr, win: null }); 
                continue; 
            }
            const entry = bars[entryIdx].open;
            const horizonDays = Math.max(1, Math.ceil(horizonHours / 24));
            const window = bars.slice(entryIdx, entryIdx + horizonDays);
            log.info('Window calculation', { postId: a.post_id, ticker: t, entry, horizonDays, windowLength: window.length });
            if (window.length === 0) { 
                log.info('Empty window', { postId: a.post_id, ticker: t });
                labeled.push({ thrEligible: (thr) => (a.quality_score ?? -1) >= thr, win: null }); 
                continue; 
            }
            const maxHigh = Math.max(...window.map(b => b.high));
            const minLow = Math.min(...window.map(b => b.low));
            const tpLevel = entry * (1 + tpPct);
            const slLevel = entry * (1 - slPct);
            const win = maxHigh >= tpLevel ? true : (minLow <= slLevel ? false : null);
            log.info('Outcome calculated', { postId: a.post_id, ticker: t, entry, maxHigh, minLow, tpLevel, slLevel, win });
            labeled.push({ thrEligible: (thr) => (a.quality_score ?? -1) >= thr, win });
        }
        log.info('Outcome labeling completed', { labeledCount: labeled.length });

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
                        const created = coerceDate(r.created_utc);
                        if (!created) {
                            log.warn('Skipping post in threshold sweep due to invalid created_utc', { postId: r.post_id, createdUtc: r.created_utc });
                            return;
                        }
                        const day = created.toISOString().slice(0, 10);
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
                const created = coerceDate(row.created_utc);
                if (!created) {
                    log.warn('Skipping post when computing daily counts due to invalid created_utc', { createdUtc: row.created_utc });
                    return;
                }
                const day = created.toISOString().slice(0, 10);
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


interface FetchAndCacheInputs {
    tickers: string[];
    tiingoApiKey: string;
    supabase: ReturnType<typeof getSupabaseClient>;
    horizonDays: number;
}

async function fetchAndCacheDailyPrices({ tickers, tiingoApiKey, supabase, horizonDays }: FetchAndCacheInputs) {
    logger.info('Starting fetchAndCacheDailyPrices', { tickerCount: tickers.length, horizonDays });
    
    const fetchFn = (globalThis as any).fetch as ((input: string, init?: any) => Promise<any>) | undefined;
    if (typeof fetchFn !== 'function') {
        throw new Error('global fetch is not available in this runtime');
    }

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    
    // Validate horizonDays
    if (typeof horizonDays !== 'number' || isNaN(horizonDays) || horizonDays <= 0) {
        logger.error('Invalid horizonDays value', { horizonDays, type: typeof horizonDays });
        throw new Error(`Invalid horizonDays: ${horizonDays}`);
    }
    
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    logger.info('Today calculated', { today: today.toISOString() });

    const daysBack = Math.max(30, horizonDays * 3);
    logger.info('Days back calculated', { horizonDays, daysBack });
    
    const earliestNeeded = new Date(today);
    const currentDate = earliestNeeded.getUTCDate();
    const newDate = currentDate - daysBack;
    logger.info('Date calculation', { currentDate, daysBack, newDate });
    
    earliestNeeded.setUTCDate(newDate);
    logger.info('Earliest needed calculated', { earliestNeeded: earliestNeeded.toISOString() });
    
    const startDate = earliestNeeded.toISOString().slice(0, 10);
    logger.info('Start date for Tiingo API', { startDate });

    for (let i = 0; i < tickers.length; i++) {
        const ticker = tickers[i];
        logger.info('Processing ticker', { index: i, ticker, totalTickers: tickers.length });
        
        const params = new URLSearchParams({
            token: tiingoApiKey,
            startDate,
            resampleFreq: 'daily',
        });
        const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices?${params.toString()}`;

        try {
            const res = await fetchFn(url);
            if (!res.ok) {
                const body = await res.text();
                logger.warn('Tiingo daily fetch failed', { ticker, status: res.status, statusText: res.statusText, body: body?.slice(0, 200) });
                await sleep(500);
                continue;
            }

            const json = await res.json();
            if (!Array.isArray(json)) {
                logger.warn('Unexpected Tiingo daily response shape', { ticker });
                await sleep(300);
                continue;
            }

            const rows: Array<{ ticker: string; ts: string; open: number; high: number; low: number; close: number }> = [];
            for (const item of json) {
                if (!item?.date) {
                    continue;
                }
                const ts = coerceDate(item.date);
                if (!ts) {
                    logger.warn('Skipping Tiingo row with invalid date', { ticker, date: item.date });
                    continue;
                }

                const open = typeof item.open === 'number' ? item.open : Number(item.open ?? NaN);
                const high = typeof item.high === 'number' ? item.high : Number(item.high ?? NaN);
                const low = typeof item.low === 'number' ? item.low : Number(item.low ?? NaN);
                const close = typeof item.close === 'number' ? item.close : Number(item.close ?? NaN);

                if (![open, high, low, close].every(Number.isFinite)) {
                    logger.warn('Skipping Tiingo row with invalid prices', { ticker, date: item.date });
                    continue;
                }

                rows.push({
                    ticker,
                    ts: ts.toISOString(),
                    open,
                    high,
                    low,
                    close,
                });
            }

            if (rows.length > 0) {
                const chunkSize = 500;
                for (let i = 0; i < rows.length; i += chunkSize) {
                    const chunk = rows.slice(i, i + chunkSize);
                    const { error } = await supabase.from('prices').upsert(chunk as any, { onConflict: 'ticker,ts' });
                    if (error) {
                        logger.warn('Failed to upsert Tiingo daily prices', { ticker, error: error.message });
                        break;
                    }
                }
            }
        } catch (error) {
            logger.warn('Tiingo daily fetch threw', { ticker, error: error instanceof Error ? error.message : 'unknown' });
        }

        await sleep(250); // stay well below Tiingo rate limits
    }
}

function coerceDate(value: unknown): Date | null {
    if (value instanceof Date) {
        if (!Number.isNaN(value.getTime())) {
            return value;
        }
        return null;
    }

    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === 'string' || typeof value === 'number') {
        try {
            const parsed = new Date(value as any);
            if (!Number.isNaN(parsed.getTime())) {
                return parsed;
            }
        } catch (error) {
            // If Date constructor throws, return null
            return null;
        }
    }

    return null;
}

async function getLatestPriceTs(ticker: string, supabase: ReturnType<typeof getSupabaseClient>): Promise<number | null> {
    const { data, error } = await supabase
        .from('prices')
        .select('ts')
        .eq('ticker', ticker)
        .order('ts', { ascending: false })
        .limit(1);
    if (error || !data || data.length === 0) return null;
    const tsDate = coerceDate((data[0] as any).ts);
    if (!tsDate) {
        logger.warn('Invalid ts in getLatestPriceTs', { ticker, ts: (data[0] as any).ts });
        return null;
    }
    return tsDate.getTime();
}
