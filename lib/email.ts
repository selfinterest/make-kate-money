import { Resend } from 'resend';
import { logger } from './logger';
import type { Config } from './config';
import type { EmailCandidate } from './db';

let resendClient: Resend | null = null;

function getResendClient(config: Config): Resend {
  if (!resendClient) {
    resendClient = new Resend(config.email.resendApiKey);
  }
  return resendClient;
}

export async function sendDigest(
  candidates: EmailCandidate[], 
  config: Config
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
      candidateCount: sortedCandidates.length
    });
    
    const result = await resend.emails.send({
      from: config.email.from,
      to: config.email.to,
      subject,
      text: textContent,
      html: htmlContent
    });
    
    if (result.error) {
      throw new Error(`Resend API error: ${result.error.message}`);
    }
    
    logger.info('Email digest sent successfully', {
      emailId: result.data?.id,
      candidateCount: sortedCandidates.length,
      to: config.email.to
    });
    
  } catch (error) {
    logger.error('Failed to send email digest', {
      candidateCount: candidates.length,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw new Error(`Email send failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  let textParts = [header, ''];
  
  qualityScores.forEach(score => {
    if (score >= 4) {
      textParts.push(`🔥 HIGH QUALITY (${score}/5):`);
    } else {
      textParts.push(`📈 Quality ${score}/5:`);
    }
    textParts.push('');
    
    byQuality[score].forEach(candidate => {
      const tickers = (candidate.llm_tickers.length > 0 ? candidate.llm_tickers : candidate.detected_tickers).join(', ');
      const timeAgo = getTimeAgo(candidate.created_utc);

      textParts.push(`**${tickers}** — ${candidate.title}`);
      textParts.push(`Reason: ${candidate.reason}`);
      textParts.push(`Posted: ${timeAgo}`);
      textParts.push(`Link: ${candidate.url}`);
      textParts.push('');
    });
  });
  
  textParts.push('', disclaimer);
  const textContent = textParts.join('\n');
  
  // Generate HTML content
  let htmlParts = [`<h1>${header}</h1>`];
  
  qualityScores.forEach(score => {
    const sectionTitle = score >= 4 
      ? `🔥 HIGH QUALITY (${score}/5)` 
      : `📈 Quality ${score}/5`;
    
    htmlParts.push(`<h2>${sectionTitle}</h2>`);
    
    byQuality[score].forEach(candidate => {
      const tickers = (candidate.llm_tickers.length > 0 ? candidate.llm_tickers : candidate.detected_tickers).join(', ');
      const timeAgo = getTimeAgo(candidate.created_utc);

      htmlParts.push(`
        <div style="margin-bottom: 20px; padding: 15px; border-left: 3px solid #0070f3; background-color: #f8f9fa;">
          <h3 style="margin: 0 0 8px 0;"><strong>${tickers}</strong> — ${escapeHtml(candidate.title)}</h3>
          <p style="margin: 5px 0; color: #666;"><strong>Reason:</strong> ${escapeHtml(candidate.reason)}</p>
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
