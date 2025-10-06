import { describe, expect, it } from 'vitest';
import {
  addDays,
  easternDateTime,
  getEasternComponents,
  isEasternWeekend,
  startOfEasternDay,
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
