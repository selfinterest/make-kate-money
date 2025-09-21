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

        // Count how many posts per day would qualify for email at each threshold
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

        // Target volume per day (heuristic). Allow override via event or SSM.
        let targetPerDay = typeof event?.targetPerDay === 'number' ? event.targetPerDay : undefined;
        if (targetPerDay === undefined) {
            // Try SSM parameter
            try {
                const ssm = new SSMClient({});
                const p = await ssm.send(new GetParameterCommand({
                    Name: '/reddit-stock-watcher/TARGET_EMAILS_PER_DAY',
                    WithDecryption: false,
                }));
                const v = Number(p.Parameter?.Value ?? 'NaN');
                if (!Number.isNaN(v) && v > 0) targetPerDay = v;
            } catch { }
        }
        if (targetPerDay === undefined) targetPerDay = 2;

        // Pick threshold with avg closest to target, biasing higher threshold on ties
        let bestThr = thresholds[0];
        let bestDiff = Infinity;
        for (const thr of thresholds) {
            const diff = Math.abs(dailyCounts[String(thr)] - targetPerDay);
            if (diff < bestDiff || (diff === bestDiff && thr > bestThr)) {
                bestDiff = diff;
                bestThr = thr;
            }
        }

        // Write back to SSM if different from current (idempotent write)
        const ssm = new SSMClient({});
        await ssm.send(new PutParameterCommand({
            Name: '/reddit-stock-watcher/QUALITY_THRESHOLD',
            Value: String(bestThr),
            Overwrite: true,
            Type: 'String',
        }));

        log.info('Backtest completed', { windowDays, dailyCounts, selectedThreshold: bestThr, targetPerDay });
        return { ok: true, selectedThreshold: bestThr, dailyCounts, windowDays };

    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logger.error('Backtest failed', { error: msg });
        return { ok: false, error: msg };
    } finally {
        logger.info('Backtest finished', { ms: Date.now() - start });
    }
}


