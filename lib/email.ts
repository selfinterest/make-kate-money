import { Resend } from 'resend';
import { logger } from './logger';
import type { Config } from './config';
import type { EmailCandidate } from './db';
import type { PriceWatchAlertInfo } from './price-watch';
import type { PerformanceEmailPayload } from './performance-types';
import {
  escapeHtml,
  formatEtTimestamp,
  formatPct,
  formatUsd,
  getTimeAgo,
} from './email-utils';

let resendClient: Resend | null = null;

interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

function getResendClient(config: Config): Resend {
  if (!resendClient) {
    resendClient = new Resend(config.email.resendApiKey);
  }
  return resendClient;
}

async function sendEmail(
  content: EmailContent,
  config: Config,
  metadata: Record<string, unknown>,
): Promise<string | null> {
  const resend = getResendClient(config);

  logger.debug('Sending email via Resend', {
    ...metadata,
    from: config.email.from,
    to: config.email.to,
    subject: content.subject,
  });

  const result = await resend.emails.send({
    from: config.email.from,
    to: config.email.to,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });

  if (result.error) {
    throw new Error(`Resend API error: ${result.error.message}`);
  }

  return result.data?.id ?? null;
}

function formatPriceInsightsText(candidate: EmailCandidate): string[] {
  const lines: string[] = [];
  const insights = candidate.priceInsights ?? [];
  if (insights.length === 0) {
    if (candidate.priceAlert?.dataUnavailableCount) {
      lines.push('Price: data unavailable');
    }
    return lines;
  }

  const thresholdPct = candidate.priceAlert?.thresholdPct ?? 0;
  const thresholdLabel = thresholdPct > 0 ? `(threshold ±${(thresholdPct * 100).toFixed(2)}%)` : '';
  const headerSuffix = candidate.priceAlert?.anyExceeded ? ' ⚠️' : '';
  lines.push(`Price${headerSuffix}: ${thresholdLabel}`.trim());

  insights.forEach(insight => {
    if (insight.dataUnavailable) {
      lines.push(`  ${insight.ticker}: data unavailable`);
      return;
    }
    const latest = formatUsd(insight.latestPrice);
    const entry = formatUsd(insight.entryPrice);
    const move = formatPct(insight.movePct);
    const flag = insight.exceedsThreshold ? ' ⚠️' : '';
    lines.push(`  ${insight.ticker}: ${latest} (Δ ${move} from ${entry})${flag}`);
  });

  return lines;
}

function formatPriceInsightsHtml(candidate: EmailCandidate): string {
  const insights = candidate.priceInsights ?? [];
  if (insights.length === 0) {
    if (candidate.priceAlert?.dataUnavailableCount) {
      return '<p style="margin:4px 0;font-size:0.9em;">Price: data unavailable</p>';
    }
    return '';
  }

  const thresholdPct = candidate.priceAlert?.thresholdPct ?? 0;
  const thresholdLabel = thresholdPct > 0 ? ` (threshold ±${(thresholdPct * 100).toFixed(2)}%)` : '';
  const headerSuffix = candidate.priceAlert?.anyExceeded ? ' ⚠️' : '';

  const items = insights.map(insight => {
    if (insight.dataUnavailable) {
      return `<li style="margin-left:16px;">${escapeHtml(insight.ticker)}: data unavailable</li>`;
    }
    const latest = formatUsd(insight.latestPrice);
    const entry = formatUsd(insight.entryPrice);
    const move = formatPct(insight.movePct);
    const flag = insight.exceedsThreshold ? ' ⚠️' : '';
    return `<li style="margin-left:16px;">${escapeHtml(insight.ticker)}: ${escapeHtml(latest)} (Δ ${escapeHtml(move)} from ${escapeHtml(entry)})${flag}</li>`;
  }).join('');

  return `
    <div style="margin:6px 0;">
      <p style="margin:4px 0;font-size:0.9em;"><strong>Price${headerSuffix}:</strong>${escapeHtml(thresholdLabel)}</p>
      <ul style="margin:0 0 0 12px;padding:0;font-size:0.9em;list-style:disc;">
        ${items}
      </ul>
    </div>
  `;
}

export async function sendDigest(
  candidates: EmailCandidate[],
  config: Config,
): Promise<void> {
  if (candidates.length === 0) {
    logger.debug('No candidates to email');
    return;
  }

  const sortedCandidates = sortCandidates(candidates);

  try {
    logger.info('Preparing email digest', { candidateCount: sortedCandidates.length });

    const content = buildDigestEmail(sortedCandidates);
    const emailId = await sendEmail(content, config, {
      candidateCount: sortedCandidates.length,
      emailType: 'daily-digest',
    });

    logger.info('Email digest sent successfully', {
      emailId,
      candidateCount: sortedCandidates.length,
      to: config.email.to,
    });
  } catch (error) {
    logger.error('Failed to send email digest', {
      candidateCount: candidates.length,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error(`Email send failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function sendPriceWatchAlerts(
  alerts: PriceWatchAlertInfo[],
  config: Config,
): Promise<void> {
  if (alerts.length === 0) {
    logger.debug('No price watch alerts to email');
    return;
  }

  try {
    const content = buildPriceWatchEmail(alerts);
    const emailId = await sendEmail(content, config, {
      alertCount: alerts.length,
      emailType: 'price-watch',
    });

    logger.info('Price watch alerts sent', {
      emailId,
      alertCount: alerts.length,
      to: config.email.to,
    });
  } catch (error) {
    logger.error('Failed to send price watch alerts', {
      alertCount: alerts.length,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw new Error(`Price watch email failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function sendPerformanceReportEmail(
  payload: PerformanceEmailPayload,
  config: Config,
): Promise<void> {
  try {
    const content = buildPerformanceReportEmail(payload);
    const emailId = await sendEmail(content, config, {
      completed: payload.completed.length,
      errorCount: payload.errors.length,
      emailType: 'performance-report',
    });

    logger.info('Performance report email sent', {
      emailId,
      completed: payload.completed.length,
      errors: payload.errors.length,
    });
  } catch (error) {
    logger.error('Failed to send performance report email', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error instanceof Error ? error : new Error('Unknown error');
  }
}

function sortCandidates(candidates: EmailCandidate[]): EmailCandidate[] {
  return [...candidates].sort((a, b) => {
    if (b.quality_score !== a.quality_score) {
      return b.quality_score - a.quality_score;
    }
    return new Date(a.created_utc).getTime() - new Date(b.created_utc).getTime();
  });
}

function buildDigestEmail(
  candidates: EmailCandidate[],
  referenceDate: Date = new Date(),
): EmailContent {
  const dateLabel = referenceDate.toISOString().slice(0, 10);
  const subject = `🚀 Stock Watch — ${dateLabel} (${candidates.length} alerts)`;
  const { text, html } = composeDigestContent(candidates, dateLabel, referenceDate);
  return {
    subject,
    text,
    html,
  };
}

function composeDigestContent(
  candidates: EmailCandidate[],
  dateLabel: string,
  referenceDate: Date,
): { text: string; html: string } {
  const header = `🚀 Stock Watch — ${dateLabel}`;
  const disclaimer = '*This is for informational purposes only and is not investment advice. Do your own research.*';

  const byQuality = candidates.reduce((acc, candidate) => {
    const score = candidate.quality_score;
    if (!acc[score]) acc[score] = [];
    acc[score].push(candidate);
    return acc;
  }, {} as Record<number, EmailCandidate[]>);

  const qualityScores = Object.keys(byQuality)
    .map(Number)
    .sort((a, b) => b - a);

  const textParts: string[] = [header, ''];

  qualityScores.forEach(score => {
    const sectionTitle = score >= 4
      ? `🔥 HIGH QUALITY (${score}/5):`
      : `📈 Quality ${score}/5:`;

    textParts.push(sectionTitle, '');

    byQuality[score].forEach(candidate => {
      const tickers = candidate.tickers.join(', ');
      const timeAgo = getTimeAgo(candidate.created_utc, referenceDate);

      textParts.push(`**${tickers}** — ${candidate.title}`);
      textParts.push(`Reason: ${candidate.reason}`);
      formatPriceInsightsText(candidate).forEach(line => textParts.push(line));
      textParts.push(`Posted: ${timeAgo}`);
      textParts.push(`Link: ${candidate.url}`);
      textParts.push('');
    });
  });

  textParts.push('', disclaimer);
  const text = textParts.join('\n');

  const htmlParts: string[] = [`<h1>${escapeHtml(header)}</h1>`];

  qualityScores.forEach(score => {
    const sectionTitle = score >= 4
      ? `🔥 HIGH QUALITY (${score}/5)`
      : `📈 Quality ${score}/5`;

    htmlParts.push(`<h2>${escapeHtml(sectionTitle)}</h2>`);

    byQuality[score].forEach(candidate => {
      const tickers = escapeHtml(candidate.tickers.join(', '));
      const timeAgo = escapeHtml(getTimeAgo(candidate.created_utc, referenceDate));

      htmlParts.push(`
        <div style="margin-bottom: 20px; padding: 15px; border-left: 3px solid #0070f3; background-color: #f8f9fa;">
          <h3 style="margin: 0 0 8px 0;"><strong>${tickers}</strong> — ${escapeHtml(candidate.title)}</h3>
          <p style="margin: 5px 0; color: #666;"><strong>Reason:</strong> ${escapeHtml(candidate.reason)}</p>
          ${formatPriceInsightsHtml(candidate)}
          <p style="margin: 5px 0; font-size: 0.9em; color: #888;">Posted: ${timeAgo}</p>
          <p style="margin: 10px 0 0 0;"><a href="${escapeHtml(candidate.url)}" style="color: #0070f3; text-decoration: none;">View Post →</a></p>
        </div>
      `);
    });
  });

  htmlParts.push(`<hr><p style="font-size: 0.9em; color: #666;"><em>${escapeHtml(disclaimer)}</em></p>`);
  const html = htmlParts.join('\n');

  return { text, html };
}

function buildPriceWatchEmail(alerts: PriceWatchAlertInfo[]): EmailContent {
  const subjectTickers = alerts.map(a => a.ticker).join(', ');
  const subject = `⏱️ Price Watch — ${subjectTickers}`;
  const text = buildPriceWatchText(alerts, subject);
  const html = buildPriceWatchHtml(alerts);
  return { subject, text, html };
}

function buildPriceWatchText(alerts: PriceWatchAlertInfo[], subject: string): string {
  const lines: string[] = [];
  lines.push(subject, '');
  lines.push('These tickers are still within 5% of their recommendation price (or below):', '');

  alerts.forEach(alert => {
    const entry = formatUsd(alert.entryPrice);
    const current = formatUsd(alert.currentPrice);
    const move = formatPct(alert.movePct);
    const recommendedAt = formatEtTimestamp(alert.emailedAtIso);
    const triggeredAt = formatEtTimestamp(alert.triggeredAtIso);
    lines.push(`${alert.ticker} — ${alert.title}`);
    lines.push(`  Current: ${current} (Δ ${move} from ${entry})`);
    lines.push(`  Recommended: ${recommendedAt} | Alerted: ${triggeredAt}`);
    if (alert.url) {
      lines.push(`  Link: ${alert.url}`);
    }
    lines.push('');
  });

  lines.push('We will stop monitoring once the stock gains more than 15% or after today’s market close.');
  return lines.join('\n');
}

function buildPriceWatchHtml(alerts: PriceWatchAlertInfo[]): string {
  const rows = alerts.map(alert => {
    const entry = formatUsd(alert.entryPrice);
    const current = formatUsd(alert.currentPrice);
    const move = formatPct(alert.movePct);
    const recommendedAt = formatEtTimestamp(alert.emailedAtIso);
    const triggeredAt = formatEtTimestamp(alert.triggeredAtIso);
    const title = escapeHtml(alert.title);
    const link = alert.url
      ? `<a href="${escapeHtml(alert.url)}">${title}</a>`
      : title;

    return `
      <li style="margin-bottom:12px;">
        <div style="font-weight:600;">${escapeHtml(alert.ticker)} — ${link}</div>
        <div style="font-size:0.95em;">Current: <strong>${escapeHtml(current)}</strong> (Δ ${escapeHtml(move)} from ${escapeHtml(entry)})</div>
        <div style="font-size:0.85em;color:#666;">Recommended: ${escapeHtml(recommendedAt)} · Alerted: ${escapeHtml(triggeredAt)}</div>
      </li>
    `;
  }).join('');

  return [
    '<div style="font-family:system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;">',
    '<h1 style="margin-bottom:8px;">⏱️ Price Watch</h1>',
    '<p style="margin:4px 0 12px 0;">These tickers are still within 5% of their recommendation price (or below):</p>',
    `<ul style="margin:0;padding-left:16px;">${rows}</ul>`,
    '<p style="font-size:0.85em;color:#666;margin-top:12px;">Monitoring stops after a 15% gain or once today’s market closes.</p>',
    '</div>',
  ].join('\n');
}

function buildPerformanceReportEmail(payload: PerformanceEmailPayload): EmailContent {
  const summary = payload.report;
  const subject = `📊 Performance — ${summary.lookbackDateEt} ➜ ${summary.runDateEt}`;
  const text = buildPerformanceText(payload, subject);
  const html = buildPerformanceHtml(payload);
  return { subject, text, html };
}

function buildPerformanceText(payload: PerformanceEmailPayload, subject: string): string {
  const { report: summary } = payload;
  const topWinners = [...payload.completed]
    .sort((a, b) => b.returnPct - a.returnPct)
    .slice(0, 5);
  const topLosers = [...payload.completed]
    .sort((a, b) => a.returnPct - b.returnPct)
    .slice(0, 5);

  const lines: string[] = [];
  lines.push(subject, '');
  lines.push(`Run date (ET): ${summary.runDateEt}`);
  lines.push(`Lookback date (ET): ${summary.lookbackDateEt}`);
  lines.push(`Positions: ${summary.completedPositions}/${summary.totalPositions} completed`);
  const avgReturnStr = summary.averageReturnPct !== null ? `${summary.averageReturnPct.toFixed(2)}%` : 'n/a';
  const winRateStr = summary.winRatePct !== null ? `${summary.winRatePct.toFixed(2)}%` : 'n/a';
  lines.push(`Net P&L: $${summary.netProfitUsd.toFixed(2)} (${avgReturnStr} avg return)`);
  lines.push(`Win rate: ${winRateStr}`);
  lines.push(`Download: ${payload.downloadUrl}`);

  lines.push('', 'Top Winners:');
  if (!topWinners.length) {
    lines.push('  (none)');
  } else {
    for (const item of topWinners) {
      lines.push(`  ${item.ticker}: ${item.returnPct.toFixed(2)}% ($${item.profitUsd.toFixed(2)}) — ${item.title}`);
      lines.push(`    Link: ${item.url}`);
    }
  }

  lines.push('', 'Top Losers:');
  if (!topLosers.length) {
    lines.push('  (none)');
  } else {
    for (const item of topLosers) {
      lines.push(`  ${item.ticker}: ${item.returnPct.toFixed(2)}% ($${item.profitUsd.toFixed(2)}) — ${item.title}`);
      lines.push(`    Link: ${item.url}`);
    }
  }

  if (payload.errors.length) {
    lines.push('', 'Tickers with missing data:');
    for (const err of payload.errors) {
      lines.push(`  ${err.ticker}: ${err.error} — ${err.title}`);
      lines.push(`    Link: ${err.url}`);
    }
  }

  lines.push('', 'This simulation allocates $1,000 per ticker at the entry price noted. This is not investment advice.');

  return lines.join('\n');
}

function buildPerformanceHtml(payload: PerformanceEmailPayload): string {
  const { report: summary } = payload;
  const avgReturnStr = summary.averageReturnPct !== null
    ? `${summary.averageReturnPct.toFixed(2)}%`
    : 'n/a';
  const winRateStr = summary.winRatePct !== null
    ? `${summary.winRatePct.toFixed(2)}%`
    : 'n/a';

  const renderCompletedTable = (title: string, rows: typeof payload.completed) => {
    if (!rows.length) {
      return `<h2>${escapeHtml(title)}</h2><p>(none)</p>`;
    }
    const cellStyle = 'style="padding:6px 8px;border:1px solid #ddd;text-align:left;"';
    const header = `<tr>
        <th ${cellStyle}>Ticker</th>
        <th ${cellStyle}>Return %</th>
        <th ${cellStyle}>P&L</th>
        <th ${cellStyle}>Entry</th>
        <th ${cellStyle}>Exit</th>
        <th ${cellStyle}>Post</th>
      </tr>`;
    const body = rows.map(item => `
        <tr>
          <td ${cellStyle}>${escapeHtml(item.ticker)}</td>
          <td ${cellStyle}>${item.returnPct.toFixed(2)}%</td>
          <td ${cellStyle}>$${item.profitUsd.toFixed(2)}</td>
          <td ${cellStyle}>${item.entryPrice ? `$${item.entryPrice.toFixed(2)}` : '—'}</td>
          <td ${cellStyle}>${item.exitPrice ? `$${item.exitPrice.toFixed(2)}` : '—'}</td>
          <td ${cellStyle}><a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a></td>
        </tr>
      `).join('');
    return `<h2>${escapeHtml(title)}</h2><table style="width:100%; border-collapse:collapse;">${header}${body}</table>`;
  };

  const sections: string[] = [];
  sections.push(`<h1>📊 Performance Report — ${escapeHtml(summary.lookbackDateEt)} ➜ ${escapeHtml(summary.runDateEt)}</h1>`);
  sections.push('<ul>');
  sections.push(`<li><strong>Run date (ET):</strong> ${escapeHtml(summary.runDateEt)}</li>`);
  sections.push(`<li><strong>Lookback (ET):</strong> ${escapeHtml(summary.lookbackDateEt)}</li>`);
  sections.push(`<li><strong>Positions:</strong> ${summary.completedPositions}/${summary.totalPositions} completed</li>`);
  sections.push(`<li><strong>Net P&amp;L:</strong> $${summary.netProfitUsd.toFixed(2)} (<strong>${escapeHtml(avgReturnStr)}</strong> avg return)</li>`);
  sections.push(`<li><strong>Win rate:</strong> ${escapeHtml(winRateStr)}</li>`);
  sections.push(`<li><strong>Download:</strong> <a href="${escapeHtml(payload.downloadUrl)}">JSON report</a></li>`);
  sections.push('</ul>');

  const topWinners = [...payload.completed]
    .sort((a, b) => b.returnPct - a.returnPct)
    .slice(0, 5);
  const topLosers = [...payload.completed]
    .sort((a, b) => a.returnPct - b.returnPct)
    .slice(0, 5);

  sections.push(renderCompletedTable('Top Winners', topWinners));
  sections.push(renderCompletedTable('Top Losers', topLosers));

  if (payload.errors.length) {
    const cellStyle = 'style="padding:6px 8px;border:1px solid #ddd;text-align:left;"';
    const rows = payload.errors.map(err => `
        <tr>
          <td ${cellStyle}>${escapeHtml(err.ticker)}</td>
          <td ${cellStyle}>${escapeHtml(err.error)}</td>
          <td ${cellStyle}><a href="${escapeHtml(err.url)}">${escapeHtml(err.title)}</a></td>
        </tr>
      `).join('');
    const header = `<tr>
        <th ${cellStyle}>Ticker</th>
        <th ${cellStyle}>Error</th>
        <th ${cellStyle}>Post</th>
      </tr>`;
    sections.push('<h2>Tickers With Missing Data</h2>');
    sections.push(`<table style="width:100%; border-collapse:collapse;">${header}${rows}</table>`);
  }

  sections.push('<hr><p style="font-size: 0.9em; color: #666;"><em>This simulation allocates $1,000 per ticker at the entry price noted. This is not investment advice.</em></p>');

  return sections.join('\n');
}

// Test function to preview email content without sending
export function previewDigest(candidates: EmailCandidate[]): { textContent: string; htmlContent: string } {
  const sorted = sortCandidates(candidates);
  const content = buildDigestEmail(sorted);
  return { textContent: content.text, htmlContent: content.html };
}
