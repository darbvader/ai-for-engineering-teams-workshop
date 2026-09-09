import { describe, expect, it } from 'vitest';

import {
  getLocalParts,
  isSupportedTimeZone,
  isWithinBusinessHours,
  nextBusinessWindowOpen,
} from './businessHours';

/** Wednesday 10:00 UTC — inside the window in UTC. */
const WEDNESDAY_MORNING_UTC = Date.parse('2026-09-09T10:00:00Z');

describe('businessHours', () => {
  describe('isSupportedTimeZone', () => {
    it('accepts a real IANA zone', () => {
      expect(isSupportedTimeZone('America/New_York')).toBe(true);
    });

    it('rejects an invented zone rather than falling back silently', () => {
      expect(isSupportedTimeZone('Mars/Olympus_Mons')).toBe(false);
    });

    it('rejects non-strings and empty strings', () => {
      expect(isSupportedTimeZone(42)).toBe(false);
      expect(isSupportedTimeZone('')).toBe(false);
    });
  });

  describe('isWithinBusinessHours', () => {
    it('is inside the window on a weekday morning', () => {
      expect(isWithinBusinessHours(WEDNESDAY_MORNING_UTC, 'UTC')).toBe(true);
    });

    it('is outside the window before 09:00', () => {
      expect(isWithinBusinessHours(Date.parse('2026-09-09T08:59:00Z'), 'UTC')).toBe(false);
    });

    it('treats 17:00 as closed, since the end hour is exclusive', () => {
      expect(isWithinBusinessHours(Date.parse('2026-09-09T17:00:00Z'), 'UTC')).toBe(false);
      expect(isWithinBusinessHours(Date.parse('2026-09-09T16:59:00Z'), 'UTC')).toBe(true);
    });

    it('is closed at the weekend', () => {
      // 2026-09-12 is a Saturday.
      expect(isWithinBusinessHours(Date.parse('2026-09-12T10:00:00Z'), 'UTC')).toBe(false);
    });

    it('answers in the supplied zone, not the server zone', () => {
      // 10:00 UTC is 02:00 in Los Angeles: open in one zone, shut in the other.
      expect(isWithinBusinessHours(WEDNESDAY_MORNING_UTC, 'UTC')).toBe(true);
      expect(isWithinBusinessHours(WEDNESDAY_MORNING_UTC, 'America/Los_Angeles')).toBe(false);
    });
  });

  describe('DST transitions', () => {
    it('reads local wall-clock time correctly on a US spring-forward day', () => {
      // 2026-03-08 is the US DST transition. 07:00 UTC is 02:00 EST, which does
      // not exist locally; 14:00 UTC is 10:00 EDT, which is inside the window.
      const springForwardMorning = Date.parse('2026-03-08T14:00:00Z');
      const parts = getLocalParts(springForwardMorning, 'America/New_York');
      expect(parts.hour).toBe(10);
    });

    it('keeps the window in local time across a transition, not a fixed offset', () => {
      // The Monday after the transition: 14:00 UTC is 10:00 EDT (open), whereas
      // before the transition the same UTC instant would have been 09:00 EST.
      const beforeTransition = Date.parse('2026-03-06T13:00:00Z'); // Fri, 08:00 EST
      const afterTransition = Date.parse('2026-03-09T13:00:00Z'); // Mon, 09:00 EDT

      expect(isWithinBusinessHours(beforeTransition, 'America/New_York')).toBe(false);
      expect(isWithinBusinessHours(afterTransition, 'America/New_York')).toBe(true);
    });
  });

  describe('nextBusinessWindowOpen', () => {
    it('returns the same instant when already inside the window', () => {
      expect(nextBusinessWindowOpen(WEDNESDAY_MORNING_UTC, 'UTC')).toBe(WEDNESDAY_MORNING_UTC);
    });

    it('defers an out-of-hours instant to 09:00 the same day', () => {
      const earlyMorning = Date.parse('2026-09-09T05:00:00Z');
      expect(new Date(nextBusinessWindowOpen(earlyMorning, 'UTC')).toISOString()).toBe(
        '2026-09-09T09:00:00.000Z'
      );
    });

    it('defers a Saturday to Monday morning', () => {
      const saturday = Date.parse('2026-09-12T10:00:00Z');
      expect(new Date(nextBusinessWindowOpen(saturday, 'UTC')).toISOString()).toBe(
        '2026-09-14T09:00:00.000Z'
      );
    });

    it('resolves the window in the supplied zone', () => {
      // 02:00 in Los Angeles on a Wednesday defers to 09:00 Los Angeles time,
      // which is 16:00 UTC.
      const result = nextBusinessWindowOpen(WEDNESDAY_MORNING_UTC, 'America/Los_Angeles');
      expect(getLocalParts(result, 'America/Los_Angeles').hour).toBe(9);
    });
  });
});
