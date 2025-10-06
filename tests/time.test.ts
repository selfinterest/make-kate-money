import { describe, expect, it } from 'vitest';
import {
  addDays,
  easternDateTime,
  getEasternComponents,
  isEasternWeekend,
  startOfEasternDay,
  nextEasternBusinessDay,
  easternMarketOpen,
  easternMarketClose,
  isDuringEasternMarketHours,
} from '../lib/time';

describe('getEasternComponents', () => {
  it('parses standard time offsets', () => {
    const date = new Date('2023-12-15T17:30:00Z');
    const components = getEasternComponents(date);

    expect(components).toEqual({
      year: 2023,
      month: 12,
      day: 15,
      hour: 12,
      minute: 30,
      second: 0,
      offsetMinutes: -300,
      weekday: 5,
    });
  });

  it('parses daylight savings offsets', () => {
    const date = new Date('2023-07-04T16:00:00Z');
    const components = getEasternComponents(date);

    expect(components).toEqual({
      year: 2023,
      month: 7,
      day: 4,
      hour: 12,
      minute: 0,
      second: 0,
      offsetMinutes: -240,
      weekday: 2,
    });
  });
});

describe('startOfEasternDay', () => {
  it('returns midnight eastern time for given date', () => {
    const date = new Date('2023-07-04T18:30:00Z');
    const start = startOfEasternDay(date);

    expect(start.toISOString()).toBe('2023-07-04T04:00:00.000Z');
  });
});

describe('easternDateTime', () => {
  it('creates a date at the requested eastern time', () => {
    const date = easternDateTime(2023, 7, 4, 9, 15);

    expect(date.toISOString()).toBe('2023-07-04T13:15:00.000Z');
  });
});

describe('isEasternWeekend', () => {
  it('identifies weekdays correctly', () => {
    expect(isEasternWeekend(new Date('2023-12-15T17:30:00Z'))).toBe(false);
    expect(isEasternWeekend(new Date('2023-12-16T17:30:00Z'))).toBe(true);
    expect(isEasternWeekend(new Date('2023-12-17T17:30:00Z'))).toBe(true);
  });
});

describe('addDays', () => {
  it('adds the requested number of days using UTC to avoid DST issues', () => {
    const initial = new Date('2023-03-10T05:00:00Z');
    const result = addDays(initial, 5);

    expect(result.toISOString()).toBe('2023-03-15T05:00:00.000Z');
  });
});

describe('nextEasternBusinessDay', () => {
  it('moves to Monday when given a Friday', () => {
    const friday = new Date('2023-12-15T17:30:00Z');
    const next = nextEasternBusinessDay(friday);
    expect(next.toISOString().slice(0, 10)).toBe('2023-12-18');
  });

  it('returns following Monday when input date is Saturday', () => {
    const saturday = new Date('2023-12-16T12:00:00Z');
    const next = nextEasternBusinessDay(saturday);
    expect(next.toISOString().slice(0, 10)).toBe('2023-12-18');
  });

  it('returns following Monday when input date is Sunday', () => {
    const sunday = new Date('2023-12-17T12:00:00Z');
    const next = nextEasternBusinessDay(sunday);
    expect(next.toISOString().slice(0, 10)).toBe('2023-12-18');
  });
});

describe('easternMarketOpen/Close', () => {
  it('returns 9:30 ET open and 16:00 ET close in standard time', () => {
    const date = new Date('2023-12-15T17:30:00Z');
    const open = easternMarketOpen(date);
    const close = easternMarketClose(date);
    expect(open.toISOString()).toBe('2023-12-15T14:30:00.000Z'); // 9:30 ET = 14:30Z in EST (UTC-5)
    expect(close.toISOString()).toBe('2023-12-15T21:00:00.000Z'); // 16:00 ET = 21:00Z in EST
  });

  it('returns 9:30 ET open and 16:00 ET close in daylight time', () => {
    const date = new Date('2023-07-05T16:00:00Z');
    const open = easternMarketOpen(date);
    const close = easternMarketClose(date);
    expect(open.toISOString()).toBe('2023-07-05T13:30:00.000Z'); // 9:30 ET = 13:30Z in EDT (UTC-4)
    expect(close.toISOString()).toBe('2023-07-05T20:00:00.000Z'); // 16:00 ET = 20:00Z in EDT
  });
});

describe('isDuringEasternMarketHours', () => {
  it('is false on weekends', () => {
    expect(isDuringEasternMarketHours(new Date('2023-12-16T15:00:00Z'))).toBe(false); // Saturday
    expect(isDuringEasternMarketHours(new Date('2023-12-17T15:00:00Z'))).toBe(false); // Sunday
  });

  it('is false before open and after close on a weekday (EST)', () => {
    // 2023-12-15 is Friday
    expect(isDuringEasternMarketHours(new Date('2023-12-15T14:29:59Z'))).toBe(false); // 9:29:59 ET
    expect(isDuringEasternMarketHours(new Date('2023-12-15T21:00:01Z'))).toBe(false); // 16:00:01 ET
  });

  it('is true at boundaries inclusive (EST)', () => {
    expect(isDuringEasternMarketHours(new Date('2023-12-15T14:30:00Z'))).toBe(true); // open
    expect(isDuringEasternMarketHours(new Date('2023-12-15T21:00:00Z'))).toBe(true); // close
  });

  it('works during DST (EDT)', () => {
    // 2023-07-05 is Wednesday
    expect(isDuringEasternMarketHours(new Date('2023-07-05T13:29:59Z'))).toBe(false); // 9:29:59 ET
    expect(isDuringEasternMarketHours(new Date('2023-07-05T13:30:00Z'))).toBe(true);  // open
    expect(isDuringEasternMarketHours(new Date('2023-07-05T20:00:00Z'))).toBe(true);  // close
    expect(isDuringEasternMarketHours(new Date('2023-07-05T20:00:01Z'))).toBe(false); // after close
  });
});
