import { Resend } from 'resend';
import { logger } from './logger';
import type { Config } from './config';
import type { EmailCandidate } from './db';
import type { PriceWatchAlertInfo } from './price-watch';
import { EASTERN_TIMEZONE } from './time';
import type { PerformanceEmailPayload } from './performance-types';

let resendClient: Resend | null = null;

function getResendClient(config: Config): Resend {
  if (!resendClient) {
    resendClient = new Resend(config.email.resendApiKey);
  }
  return resendClient;
}

function formatUsd(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }
  return `$${value.toFixed(2)}`;
}

function formatPct(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}%`;
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

  const resend = getResendClient(config);

  try {
    logger.info('Preparing email digest', { candidateCount: candidates.length });

    const date = new Date().toISOString().slice(0, 10);
    const subject = `🚀 Stock Watch — ${date} (${candidates.length} alerts)`;

    // Sort by quality score (highest first), then by creation time
    const sortedCandidates = [...candidates].sort((a, b) => {
      if (b.quality_score !== a.quality_score) {
        return b.quality_score - a.quality_score;
      }
      return new Date(a.created_utc).getTime() - new Date(b.created_utc).getTime();
    });

    // Generate email content
    const { textContent, htmlContent } = generateEmailContent(sortedCandidates, date);

    logger.debug('Sending email via Resend', {
      from: config.email.from,
      to: config.email.to,
      subject,
      candidateCount: sortedCandidates.length,
    });

    const result = await resend.emails.send({
      from: config.email.from,
      to: config.email.to,
      subject,
      text: textContent,
      html: htmlContent,
    });

    if (result.error) {
      throw new Error(`Resend API error: ${result.error.message}`);
    }

    logger.info('Email digest sent successfully', {
      emailId: result.data?.id,
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

  const resend = getResendClient(config);
  const subjectTickers = alerts.map(a => a.ticker).join(', ');
  const subject = `⏱️ Price Watch — ${subjectTickers}`;

  const textLines: string[] = [];
  textLines.push(subject, '');
  textLines.push('These tickers are still within 5% of their recommendation price (or below):', '');

  alerts.forEach(alert => {
    const entry = formatUsd(alert.entryPrice);
    const current = formatUsd(alert.currentPrice);
    const move = formatPct(alert.movePct);
    const recommendedAt = formatEtTimestamp(alert.emailedAtIso);
    const triggeredAt = formatEtTimestamp(alert.triggeredAtIso);
    textLines.push(`${alert.ticker} — ${alert.title}`);
    textLines.push(`  Current: ${current} (Δ ${move} from ${entry})`);
    textLines.push(`  Recommended: ${recommendedAt} | Alerted: ${triggeredAt}`);
    if (alert.url) {
      textLines.push(`  Link: ${alert.url}`);
    }
    textLines.push('');
  });

  textLines.push('We will stop monitoring once the stock gains more than 15% or after today’s market close.');

  const htmlRows = alerts.map(alert => {
    const entry = formatUsd(alert.entryPrice);
    const current = formatUsd(alert.currentPrice);
    const move = formatPct(alert.movePct);
    const recommendedAt = formatEtTimestamp(alert.emailedAtIso);
    const triggeredAt = formatEtTimestamp(alert.triggeredAtIso);
    const title = escapeHtml(alert.title);
    const escapedUrl = alert.url ? escapeHtml(alert.url) : '';
    // eslint-disable-next-line prefer-template
    const link = alert.url ? '<a href="' + escapedUrl + '">' + title + '</a>' : title;
    // eslint-disable-next-line prefer-template
    return '<li style="margin-bottom:12px;">'
      + '<div style="font-weight:600;">' + escapeHtml(alert.ticker) + ' — ' + link + '</div>'
      + '<div style="font-size:0.95em;">Current: <strong>' + escapeHtml(current) + '</strong> (Δ ' + escapeHtml(move)
      + ' from ' + escapeHtml(entry) + ')</div>'
      + '<div style="font-size:0.85em;color:#666;">Recommended: ' + escapeHtml(recommendedAt)
      + ' · Alerted: ' + escapeHtml(triggeredAt) + '</div>'
      + '</li>';
  }).join('');

  const htmlParts: string[] = [];
  htmlParts.push('<div style="font-family:system-ui, -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, sans-serif;">');
  htmlParts.push('<h1 style="margin-bottom:8px;">⏱️ Price Watch</h1>');
  htmlParts.push('<p style="margin:4px 0 12px 0;">These tickers are still within 5% of their recommendation price (or below):</p>');
  // eslint-disable-next-line prefer-template
  htmlParts.push('<ul style="margin:0;padding-left:16px;">' + htmlRows + '</ul>');
  htmlParts.push('<p style="font-size:0.85em;color:#666;margin-top:12px;">Monitoring stops after a 15% gain or once today’s market closes.</p>');
  htmlParts.push('</div>');

  try {
    const result = await resend.emails.send({
      from: config.email.from,
      to: config.email.to,
      subject,
      text: textLines.join('\n'),
      html: htmlParts.join('\n'),
    });

    if (result.error) {
      throw new Error(`Resend API error: ${result.error.message}`);
    }

    logger.info('Price watch alerts sent', {
      emailId: result.data?.id,
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
  const resend = getResendClient(config);

  try {
    const summary = payload.report;
    const subject = `📊 Performance — ${summary.lookbackDateEt} ➜ ${summary.runDateEt}`;

    const topWinners = [...payload.completed]
      .sort((a, b) => b.returnPct - a.returnPct)
      .slice(0, 5);

    const topLosers = [...payload.completed]
      .sort((a, b) => a.returnPct - b.returnPct)
      .slice(0, 5);

    const textLines: string[] = [];
    textLines.push(subject, '');
    textLines.push(`Run date (ET): ${summary.runDateEt}`);
    textLines.push(`Lookback date (ET): ${summary.lookbackDateEt}`);
    textLines.push(`Positions: ${summary.completedPositions}/${summary.totalPositions} completed`);
    const avgReturnStr = summary.averageReturnPct !== null ? `${summary.averageReturnPct.toFixed(2)}%` : 'n/a';
    const winRateStr = summary.winRatePct !== null ? `${summary.winRatePct.toFixed(2)}%` : 'n/a';
    textLines.push(`Net P&L: $${summary.netProfitUsd.toFixed(2)} (${avgReturnStr} avg return)`);
    textLines.push(`Win rate: ${winRateStr}`);
    textLines.push(`Download: ${payload.downloadUrl}`);
    textLines.push('', 'Top Winners:');
    if (!topWinners.length) {
      textLines.push('  (none)');
    } else {
      for (const item of topWinners) {
        textLines.push(`  ${item.ticker}: ${item.returnPct.toFixed(2)}% ($${item.profitUsd.toFixed(2)}) — ${item.title}`);
        textLines.push(`    Link: ${item.url}`);
      }
    }
    textLines.push('', 'Top Losers:');
    if (!topLosers.length) {
      textLines.push('  (none)');
    } else {
      for (const item of topLosers) {
        textLines.push(`  ${item.ticker}: ${item.returnPct.toFixed(2)}% ($${item.profitUsd.toFixed(2)}) — ${item.title}`);
        textLines.push(`    Link: ${item.url}`);
      }
    }
    if (payload.errors.length) {
      textLines.push('', 'Tickers with missing data:');
      for (const err of payload.errors) {
        textLines.push(`  ${err.ticker}: ${err.error} — ${err.title}`);
        textLines.push(`    Link: ${err.url}`);
      }
    }
    const text = textLines.join('\n');

    const htmlSections: string[] = [];
    htmlSections.push(`<h1>📊 Performance Report — ${escapeHtml(summary.lookbackDateEt)} ➜ ${escapeHtml(summary.runDateEt)}</h1>`);
    htmlSections.push('<ul>');
    htmlSections.push(`<li><strong>Run date (ET):</strong> ${escapeHtml(summary.runDateEt)}</li>`);
    htmlSections.push(`<li><strong>Lookback (ET):</strong> ${escapeHtml(summary.lookbackDateEt)}</li>`);
    htmlSections.push(`<li><strong>Positions:</strong> ${summary.completedPositions}/${summary.totalPositions} completed</li>`);
    htmlSections.push(`<li><strong>Net P&amp;L:</strong> $${summary.netProfitUsd.toFixed(2)} (<strong>${escapeHtml(avgReturnStr)}</strong> avg return)</li>`);
    htmlSections.push(`<li><strong>Win rate:</strong> ${escapeHtml(winRateStr)}</li>`);
    htmlSections.push(`<li><strong>Download:</strong> <a href="${payload.downloadUrl}">JSON report</a></li>`);
    htmlSections.push('</ul>');

    const renderTable = (title: string, rows: typeof payload.completed) => {
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
          <td ${cellStyle}><a href="${item.url}">${escapeHtml(item.title)}</a></td>
        </tr>
      `).join('');
      return `<h2>${escapeHtml(title)}</h2><table style="width:100%; border-collapse:collapse;">${header}${body}</table>`;
    };

    htmlSections.push(renderTable('Top Winners', topWinners));
    htmlSections.push(renderTable('Top Losers', topLosers));

    if (payload.errors.length) {
      const cellStyle = 'style="padding:6px 8px;border:1px solid #ddd;text-align:left;"';
      const rows = payload.errors.map(err => `
        <tr>
          <td ${cellStyle}>${escapeHtml(err.ticker)}</td>
          <td ${cellStyle}>${escapeHtml(err.error)}</td>
          <td ${cellStyle}><a href="${err.url}">${escapeHtml(err.title)}</a></td>
        </tr>
      `).join('');
      const header = `<tr>
          <th ${cellStyle}>Ticker</th>
          <th ${cellStyle}>Error</th>
          <th ${cellStyle}>Post</th>
        </tr>`;
      htmlSections.push('<h2>Tickers With Missing Data</h2>');
      htmlSections.push(`<table style="width:100%; border-collapse:collapse;">${header}${rows}</table>`);
    }

    htmlSections.push('<hr><p style="font-size: 0.9em; color: #666;"><em>This simulation allocates $1,000 per ticker at the entry price noted. This is not investment advice.</em></p>');
    const html = htmlSections.join('\n');

    const result = await resend.emails.send({
      from: config.email.from,
      to: config.email.to,
      subject,
      text,
      html,
    });

    if (result.error) {
      throw new Error(`Resend API error: ${result.error.message}`);
    }

    logger.info('Performance report email sent', {
      emailId: result.data?.id,
      completed: payload.completed.length,
      errors: payload.errors.length,
    });
  } catch (error) {
    logger.error('Failed to send performance report email', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

function generateEmailContent(candidates: EmailCandidate[], date: string): { textContent: string; htmlContent: string } {
  const header = `🚀 Stock Watch — ${date}`;
  const disclaimer = '*This is for informational purposes only and is not investment advice. Do your own research.*';

  // Group by quality score for better organization
  const byQuality = candidates.reduce((acc, candidate) => {
    const score = candidate.quality_score;
    if (!acc[score]) acc[score] = [];
    acc[score].push(candidate);
    return acc;
  }, {} as Record<number, EmailCandidate[]>);

  const qualityScores = Object.keys(byQuality)
    .map(Number)
    .sort((a, b) => b - a); // Highest quality first

  // Generate text content
  const textParts = [header, ''];

  qualityScores.forEach(score => {
    if (score >= 4) {
      textParts.push(`🔥 HIGH QUALITY (${score}/5):`);
    } else {
      textParts.push(`📈 Quality ${score}/5:`);
    }
    textParts.push('');

    byQuality[score].forEach(candidate => {
      const tickers = candidate.tickers.join(', ');
      const timeAgo = getTimeAgo(candidate.created_utc);

      textParts.push(`**${tickers}** — ${candidate.title}`);
      textParts.push(`Reason: ${candidate.reason}`);
      formatPriceInsightsText(candidate).forEach(line => textParts.push(line));
      textParts.push(`Posted: ${timeAgo}`);
      textParts.push(`Link: ${candidate.url}`);
      textParts.push('');
    });
  });

  textParts.push('', disclaimer);
  const textContent = textParts.join('\n');

  // Generate HTML content
  const htmlParts = [`<h1>${header}</h1>`];

  qualityScores.forEach(score => {
    const sectionTitle = score >= 4
      ? `🔥 HIGH QUALITY (${score}/5)`
      : `📈 Quality ${score}/5`;

    htmlParts.push(`<h2>${sectionTitle}</h2>`);

    byQuality[score].forEach(candidate => {
      const tickers = candidate.tickers.join(', ');
      const timeAgo = getTimeAgo(candidate.created_utc);

      htmlParts.push(`
        <div style="margin-bottom: 20px; padding: 15px; border-left: 3px solid #0070f3; background-color: #f8f9fa;">
          <h3 style="margin: 0 0 8px 0;"><strong>${tickers}</strong> — ${escapeHtml(candidate.title)}</h3>
          <p style="margin: 5px 0; color: #666;"><strong>Reason:</strong> ${escapeHtml(candidate.reason)}</p>
          ${formatPriceInsightsHtml(candidate)}
          <p style="margin: 5px 0; font-size: 0.9em; color: #888;">Posted: ${timeAgo}</p>
          <p style="margin: 10px 0 0 0;"><a href="${candidate.url}" style="color: #0070f3; text-decoration: none;">View Post →</a></p>
        </div>
      `);
    });
  });

  htmlParts.push(`<hr><p style="font-size: 0.9em; color: #666;"><em>${disclaimer}</em></p>`);
  const htmlContent = htmlParts.join('\n');

  return { textContent, htmlContent };
}

function getTimeAgo(isoString: string): string {
  const now = new Date();
  const postTime = new Date(isoString);
  const diffMs = now.getTime() - postTime.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor(diffMs / (1000 * 60));

  if (diffHours > 24) {
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  } else if (diffHours > 0) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  } else {
    return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  }
}

function formatEtTimestamp(isoString: string): string {
  if (!isoString) {
    return 'n/a';
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return 'n/a';
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIMEZONE,
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function escapeHtml(text: string): string {
  const div = { innerHTML: '' } as any;
  div.textContent = text;
  return div.innerHTML || text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Test function to preview email content without sending
export function previewDigest(candidates: EmailCandidate[]): { textContent: string; htmlContent: string } {
  const date = new Date().toISOString().slice(0, 10);
  return generateEmailContent(candidates, date);
}
