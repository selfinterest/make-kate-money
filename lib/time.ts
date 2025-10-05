export const EASTERN_TIMEZONE = 'America/New_York';

interface EasternComponents {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetMinutes: number;
  weekday: number; // 0=Sunday ... 6=Saturday
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function parseOffset(offsetLabel: string | undefined): number {
  if (!offsetLabel) return 0;
  // Supports formats like "GMT-4", "GMT-04", "GMT-04:00"
  const match = offsetLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = parseInt(match[2], 10);
  const minutes = match[3] ? parseInt(match[3], 10) : 0;
  if (!Number.isFinite(hours) || hours < 0 || hours > 14) return 0;
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 60) return 0;
  return sign * (hours * 60 + minutes);
}

export function getEasternComponents(date: Date): EasternComponents {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  });

  const parts = formatter.formatToParts(date);
  const data: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      data[part.type] = part.value;
    }
  }

  const year = Number(data.year);
  const month = Number(data.month);
  const day = Number(data.day);
  const hour = Number(data.hour);
  const minute = Number(data.minute);
  const second = Number(data.second);
  const offsetMinutes = parseOffset(data.timeZoneName);

  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIMEZONE,
    weekday: 'short',
  });
  const weekdayLabel = weekdayFormatter.format(date);
  const weekday = WEEKDAY_MAP[weekdayLabel] ?? 0;

  return { year, month, day, hour, minute, second, offsetMinutes, weekday };
}

export function startOfEasternDay(date: Date): Date {
  const { year, month, day } = getEasternComponents(date);
  return easternDateTime(year, month, day, 0, 0);
}

export function easternDateTime(year: number, month: number, day: number, hour: number, minute: number): Date {
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const { offsetMinutes } = getEasternComponents(probe);
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60 * 1000;
  return new Date(utcMillis);
}

export function isEasternWeekend(date: Date): boolean {
  const { weekday } = getEasternComponents(date);
  return weekday === 0 || weekday === 6;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
