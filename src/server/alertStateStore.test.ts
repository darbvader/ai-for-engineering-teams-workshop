import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_THRESHOLDS, mergeThresholds } from './alertThresholds';
import {
  AUDIT_LOG_CAPACITY,
  SUPPRESSION_REASON,
  UnknownAlertKeyError,
  getAudit,
  getEntry,
  getFatigueMetrics,
  getState,
  parseAlertKey,
  recordAction,
  reconcile,
  reset,
  type AlertDetection,
} from './alertStateStore';

/** Wednesday 10:00 UTC — inside the delivery window when `timeZone` is UTC. */
const BASE_MS = Date.parse('2026-09-09T10:00:00Z');
const HOUR_MS = 3_600_000;

/** Every test pins UTC so the delivery-window gate is deterministic. */
const UTC = { timeZone: 'UTC' } as const;

function detection(overrides: Partial<AlertDetection> = {}): AlertDetection {
  return {
    key: '1:payment-risk',
    customerId: '1',
    ruleId: 'payment-risk',
    priority: 'high',
    ...overrides,
  };
}

describe('alertStateStore', () => {
  beforeEach(() => {
    reset();
  });

  describe('deduplication', () => {
    it('creates one entry on first detection', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);

      const entry = getEntry('1:payment-risk');
      expect(entry?.occurrenceCount).toBe(1);
      expect(entry?.firstDetectedAt).toBe(new Date(BASE_MS).toISOString());
      expect(getState().size).toBe(1);
    });

    it('increments the count and moves lastTriggeredAt without adding a row', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      reconcile([detection()], BASE_MS + HOUR_MS, DEFAULT_THRESHOLDS, UTC);

      const entry = getEntry('1:payment-risk');
      expect(getState().size).toBe(1);
      expect(entry?.occurrenceCount).toBe(2);
      expect(entry?.lastTriggeredAt).toBe(new Date(BASE_MS + HOUR_MS).toISOString());
    });

    it('never resets firstDetectedAt on a re-trigger', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      reconcile([detection()], BASE_MS + 5 * HOUR_MS, DEFAULT_THRESHOLDS, UTC);

      expect(getEntry('1:payment-risk')?.firstDetectedAt).toBe(new Date(BASE_MS).toISOString());
    });

    it('keys on customer and rule together, so two rules are two entries', () => {
      reconcile(
        [detection(), detection({ key: '1:support-ticket-spike', ruleId: 'support-ticket-spike', priority: 'medium' })],
        BASE_MS,
        DEFAULT_THRESHOLDS,
        UTC
      );

      expect(getState().size).toBe(2);
    });
  });

  describe('cooldown', () => {
    it('notifies on first detection inside the delivery window', () => {
      const result = reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);

      expect(result.get('1:payment-risk')?.notificationSuppressedUntil).toBeNull();
      expect(getAudit().some((line) => line.event === 'notified')).toBe(true);
    });

    it('keeps a cooled-down alert in the list while suppressing its notification', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      const result = reconcile([detection()], BASE_MS + HOUR_MS, DEFAULT_THRESHOLDS, UTC);

      // Still reconciled — detection is never suppressed, only notification.
      expect(result.has('1:payment-risk')).toBe(true);
      expect(result.get('1:payment-risk')?.notificationSuppressedUntil).not.toBeNull();
      expect(
        getAudit().filter(
          (line) =>
            line.event === 'notification_suppressed' && line.detail === SUPPRESSION_REASON.cooldown
        )
      ).toHaveLength(1);
    });

    it('uses 48 hours for high priority', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);

      const justInside = reconcile([detection()], BASE_MS + 47 * HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      expect(justInside.get('1:payment-risk')?.notificationSuppressedUntil).not.toBeNull();

      // 48h later lands on a Friday morning, still inside the delivery window.
      const afterCooldown = reconcile([detection()], BASE_MS + 48 * HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      expect(afterCooldown.get('1:payment-risk')?.notificationSuppressedUntil).toBeNull();
    });

    it('uses 168 hours for medium priority', () => {
      const medium = detection({
        key: '1:support-ticket-spike',
        ruleId: 'support-ticket-spike',
        priority: 'medium',
      });

      reconcile([medium], BASE_MS, DEFAULT_THRESHOLDS, UTC);

      const stillCooling = reconcile([medium], BASE_MS + 100 * HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      expect(stillCooling.get('1:support-ticket-spike')?.notificationSuppressedUntil).not.toBeNull();

      const afterCooldown = reconcile([medium], BASE_MS + 168 * HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      expect(afterCooldown.get('1:support-ticket-spike')?.notificationSuppressedUntil).toBeNull();
    });

    it('defers a notification raised outside the delivery window', () => {
      // Saturday 10:00 UTC.
      const saturday = Date.parse('2026-09-12T10:00:00Z');
      const result = reconcile([detection()], saturday, DEFAULT_THRESHOLDS, UTC);

      expect(result.get('1:payment-risk')?.notificationSuppressedUntil).toBe(
        '2026-09-14T09:00:00.000Z'
      );
      expect(
        getAudit().some(
          (line) =>
            line.event === 'notification_suppressed' &&
            line.detail === SUPPRESSION_REASON.outsideBusinessHours
        )
      ).toBe(true);
    });

    it('defers in the client-supplied zone, not the server zone', () => {
      // 10:00 UTC is 02:00 in Los Angeles: open in UTC, shut for the viewer.
      const inUtc = reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      expect(inUtc.get('1:payment-risk')?.notificationSuppressedUntil).toBeNull();

      reset();
      const inLosAngeles = reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, {
        timeZone: 'America/Los_Angeles',
      });
      expect(inLosAngeles.get('1:payment-risk')?.notificationSuppressedUntil).not.toBeNull();
    });
  });

  describe('dismissal', () => {
    it('records a dismissal and returns the updated entry', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      const entry = recordAction('1:payment-risk', 'dismiss', BASE_MS + HOUR_MS);

      expect(entry.status).toBe('dismissed');
      expect(entry.statusChangedAt).toBe(new Date(BASE_MS + HOUR_MS).toISOString());
    });

    it('throws for an alert the store has never seen', () => {
      expect(() => recordAction('99:payment-risk', 'dismiss', BASE_MS)).toThrow(
        UnknownAlertKeyError
      );
    });

    it('keeps the dismissal while the rule keeps firing inside the TTL', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      recordAction('1:payment-risk', 'dismiss', BASE_MS);

      reconcile([detection()], BASE_MS + 100 * HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      expect(getEntry('1:payment-risk')?.status).toBe('dismissed');
    });

    it('reactivates once the TTL elapses, preserving the occurrence count', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      reconcile([detection()], BASE_MS + HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      recordAction('1:payment-risk', 'dismiss', BASE_MS + HOUR_MS);

      const ttlHours = DEFAULT_THRESHOLDS.cooldown.dismissalTtlHours;
      // The rule is still firing — reactivation must not require it to stop.
      reconcile([detection()], BASE_MS + (1 + ttlHours) * HOUR_MS, DEFAULT_THRESHOLDS, UTC);

      const entry = getEntry('1:payment-risk');
      expect(entry?.status).toBe('active');
      expect(entry?.occurrenceCount).toBe(3);
      expect(entry?.firstDetectedAt).toBe(new Date(BASE_MS).toISOString());
      expect(getAudit().some((line) => line.event === 'reactivated')).toBe(true);
    });

    it('reactivates early when the rule stops firing', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      recordAction('1:payment-risk', 'dismiss', BASE_MS);

      reconcile([], BASE_MS + HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      expect(getEntry('1:payment-risk')?.status).toBe('active');
    });

    it('does not notify about a dismissed alert that is still detected', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      recordAction('1:payment-risk', 'dismiss', BASE_MS);

      const notifiedBefore = getAudit().filter((line) => line.event === 'notified').length;
      reconcile([detection()], BASE_MS + HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      expect(getAudit().filter((line) => line.event === 'notified')).toHaveLength(notifiedBefore);
    });
  });

  describe('audit log', () => {
    it('records every event class', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      reconcile([detection()], BASE_MS + HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      recordAction('1:payment-risk', 'dismiss', BASE_MS + 2 * HOUR_MS);
      reconcile([], BASE_MS + 3 * HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      reconcile([detection()], BASE_MS + 4 * HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      recordAction('1:payment-risk', 'action', BASE_MS + 5 * HOUR_MS);

      const events = new Set(getAudit().map((line) => line.event));
      expect(events).toContain('triggered');
      expect(events).toContain('notified');
      expect(events).toContain('notification_suppressed');
      expect(events).toContain('dismissed');
      expect(events).toContain('reactivated');
      expect(events).toContain('actioned');
    });

    it('caps at the ring-buffer size, dropping the oldest line', () => {
      for (let pass = 0; pass < AUDIT_LOG_CAPACITY; pass += 1) {
        reconcile([detection()], BASE_MS + pass * 60_000, DEFAULT_THRESHOLDS, UTC);
      }

      const audit = getAudit();
      expect(audit.length).toBe(AUDIT_LOG_CAPACITY);
      // The very first line has been evicted; the newest survives.
      expect(audit[audit.length - 1]?.at).toBe(
        new Date(BASE_MS + (AUDIT_LOG_CAPACITY - 1) * 60_000).toISOString()
      );
    });

    it('never puts customer data in the detail field', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      const details = getAudit().map((line) => line.detail ?? '');

      for (const detail of details) {
        expect(detail).not.toMatch(/@/);
        expect(detail).not.toMatch(/\$/);
      }
    });
  });

  describe('getFatigueMetrics', () => {
    it('counts cooldown suppressions', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      reconcile([detection()], BASE_MS + HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      reconcile([detection()], BASE_MS + 2 * HOUR_MS, DEFAULT_THRESHOLDS, UTC);

      expect(getFatigueMetrics(BASE_MS).notificationsSuppressedByCooldown).toBe(2);
    });

    it('computes a per-rule dismissal rate', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      reconcile([detection()], BASE_MS + HOUR_MS, DEFAULT_THRESHOLDS, UTC);
      recordAction('1:payment-risk', 'dismiss', BASE_MS + 2 * HOUR_MS);

      const rule = getFatigueMetrics(BASE_MS).dismissalRateByRule.find(
        (entry) => entry.ruleId === 'payment-risk'
      );
      expect(rule?.triggered).toBe(2);
      expect(rule?.dismissed).toBe(1);
      expect(rule?.rate).toBeCloseTo(0.5);
    });

    it('reports median hours to action, and null before any action', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      expect(getFatigueMetrics(BASE_MS).medianHoursToAction).toBeNull();

      recordAction('1:payment-risk', 'action', BASE_MS + 4 * HOUR_MS);
      expect(getFatigueMetrics(BASE_MS).medianHoursToAction).toBe(4);
    });

    it('counts reactivations after a dismissal expired', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      recordAction('1:payment-risk', 'dismiss', BASE_MS);
      const ttl = DEFAULT_THRESHOLDS.cooldown.dismissalTtlHours;
      reconcile([detection()], BASE_MS + ttl * HOUR_MS, DEFAULT_THRESHOLDS, UTC);

      expect(getFatigueMetrics(BASE_MS).reactivationsAfterDismissal).toBe(1);
    });

    it('recommends raising a threshold only above the rate and trigger floors', () => {
      const thresholds = mergeThresholds();

      // Five triggers, four dismissals: 80% over the 5-trigger floor.
      for (let pass = 0; pass < 5; pass += 1) {
        reconcile([detection()], BASE_MS + pass * HOUR_MS, thresholds, UTC);
        if (pass < 4) {
          recordAction('1:payment-risk', 'dismiss', BASE_MS + pass * HOUR_MS);
        }
      }

      const { recommendations } = getFatigueMetrics(BASE_MS);
      expect(recommendations).toHaveLength(1);
      expect(recommendations[0]).toContain('payment-risk');
      expect(recommendations[0]).toContain('Suggestion only');
    });

    it('makes no recommendation below the trigger floor', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      recordAction('1:payment-risk', 'dismiss', BASE_MS);

      expect(getFatigueMetrics(BASE_MS).recommendations).toHaveLength(0);
    });
  });

  describe('cross-session behaviour', () => {
    it('shows one store to every reader, so a dismissal is visible everywhere', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);
      recordAction('1:payment-risk', 'dismiss', BASE_MS);

      // Two independent readers, as two concurrent sessions would be.
      expect(getState().get('1:payment-risk')?.status).toBe('dismissed');
      expect(getEntry('1:payment-risk')?.status).toBe('dismissed');
    });

    it('hands out copies, so a caller cannot mutate stored state', () => {
      reconcile([detection()], BASE_MS, DEFAULT_THRESHOLDS, UTC);

      const leaked = getState().get('1:payment-risk');
      if (leaked !== undefined) {
        leaked.occurrenceCount = 999;
      }

      expect(getEntry('1:payment-risk')?.occurrenceCount).toBe(1);
    });
  });

  describe('parseAlertKey', () => {
    it('splits on the first colon', () => {
      expect(parseAlertKey('12:payment-risk')).toEqual({
        customerId: '12',
        ruleId: 'payment-risk',
      });
    });

    it('returns null for a key without a rule', () => {
      expect(parseAlertKey('12')).toBeNull();
      expect(parseAlertKey(':payment-risk')).toBeNull();
    });
  });
});
