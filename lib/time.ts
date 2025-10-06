import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import businessTime from 'dayjs-business-time';

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

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(businessTime);

dayjs.tz.setDefault(EASTERN_TIMEZONE);

const MARKET_OPEN = { hour: 9, minute: 30 };
const MARKET_CLOSE = { hour: 16, minute: 0 };

const MARKET_BUSINESS_HOURS: dayjs.BusinessHoursMap = {
  sunday: null,
  monday: [{ start: '09:30', end: '16:00' }],
  tuesday: [{ start: '09:30', end: '16:00' }],
  wednesday: [{ start: '09:30', end: '16:00' }],
  thursday: [{ start: '09:30', end: '16:00' }],
  friday: [{ start: '09:30', end: '16:00' }],
  saturday: null,
};

const NYSE_HOLIDAYS = [
  // 2023
  '2023-01-02', // New Year's Day (observed)
  '2023-01-16', // Martin Luther King, Jr. Day
  '2023-02-20', // Presidents' Day
  '2023-04-07', // Good Friday
  '2023-05-29', // Memorial Day
  '2023-06-19', // Juneteenth
  '2023-07-04', // Independence Day
  '2023-09-04', // Labor Day
  '2023-11-23', // Thanksgiving Day
  '2023-12-25', // Christmas Day
  // 2024
  '2024-01-01',
  '2024-01-15',
  '2024-02-19',
  '2024-03-29',
  '2024-05-27',
  '2024-06-19',
  '2024-07-04',
  '2024-09-02',
  '2024-11-28',
  '2024-12-25',
  // 2025
  '2025-01-01',
  '2025-01-20',
  '2025-02-17',
  '2025-04-18',
  '2025-05-26',
  '2025-06-19',
  '2025-07-04',
  '2025-09-01',
  '2025-11-27',
  '2025-12-25',
  '2025-11-27',
  '2025-12-25',
  // 2026
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
];

dayjs.setBusinessTime(MARKET_BUSINESS_HOURS);
dayjs.setHolidays(NYSE_HOLIDAYS);

function toEasternDayjs(date: Date): dayjs.Dayjs {
  return dayjs(date).tz(EASTERN_TIMEZONE);
}

function toEasternString(year: number, month: number, day: number, hour: number, minute: number): string {
  const pad = (value: number, length = 2) => value.toString().padStart(length, '0');
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`;
}

export function getEasternComponents(date: Date): EasternComponents {
  const zoned = toEasternDayjs(date);
  return {
    year: zoned.year(),
    month: zoned.month() + 1,
    day: zoned.date(),
    hour: zoned.hour(),
    minute: zoned.minute(),
    second: zoned.second(),
    offsetMinutes: zoned.utcOffset(),
    weekday: zoned.day(),
  };
}

export function startOfEasternDay(date: Date): Date {
  return toEasternDayjs(date).startOf('day').toDate();
}

export function easternDateTime(year: number, month: number, day: number, hour: number, minute: number): Date {
  return dayjs.tz(
    toEasternString(year, month, day, hour, minute),
    EASTERN_TIMEZONE,
  ).toDate();
}

export function isEasternWeekend(date: Date): boolean {
  const day = toEasternDayjs(date).day();
  return day === 0 || day === 6;
}

export function addDays(date: Date, days: number): Date {
  return dayjs.utc(date).add(days, 'day').toDate();
}

export function nextEasternBusinessDay(date: Date): Date {
  return toEasternDayjs(date).nextBusinessDay().toDate();
}

function easternMarketBoundary(zoned: dayjs.Dayjs, boundary: 'open' | 'close'): dayjs.Dayjs {
  const { hour, minute } = boundary === 'open' ? MARKET_OPEN : MARKET_CLOSE;
  return dayjs.tz(
    toEasternString(zoned.year(), zoned.month() + 1, zoned.date(), hour, minute),
    EASTERN_TIMEZONE,
  );
}

export function easternMarketOpen(date: Date): Date {
  const zoned = toEasternDayjs(date);
  return easternMarketBoundary(zoned, 'open').toDate();
}

export function easternMarketClose(date: Date): Date {
  const zoned = toEasternDayjs(date);
  return easternMarketBoundary(zoned, 'close').toDate();
}

export function isDuringEasternMarketHours(date: Date): boolean {
  const zoned = toEasternDayjs(date);
  if (zoned.isHoliday() || zoned.day() === 0 || zoned.day() === 6) {
    return false;
  }

  const open = easternMarketBoundary(zoned, 'open');
  const close = easternMarketBoundary(zoned, 'close');

  return (zoned.isAfter(open) || zoned.isSame(open)) && (zoned.isBefore(close) || zoned.isSame(close));
}
