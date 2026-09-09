import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THRESHOLDS,
  ThresholdValidationError,
  mergeThresholds,
  resolveThresholds,
  validateThresholds,
} from './alertThresholds';

describe('alertThresholds', () => {
  describe('mergeThresholds', () => {
    it('returns the defaults when nothing is overridden', () => {
      expect(mergeThresholds()).toEqual(DEFAULT_THRESHOLDS);
    });

    it('deep-merges a partial override without dropping sibling fields', () => {
      const merged = mergeThresholds({ caps: { maxPerCustomer: 1 } });

      expect(merged.caps.maxPerCustomer).toBe(1);
      expect(merged.caps.maxAlerts).toBe(DEFAULT_THRESHOLDS.caps.maxAlerts);
      expect(merged.market).toEqual(DEFAULT_THRESHOLDS.market);
    });

    it('merges nested engine cooldowns rather than replacing the object', () => {
      const merged = mergeThresholds({ core: { cooldownHours: { high: 12, medium: 24 } } });

      expect(merged.core.cooldownHours.high).toBe(12);
      expect(merged.core.paymentOverdueDays).toBe(DEFAULT_THRESHOLDS.core.paymentOverdueDays);
    });

    it('does not mutate the defaults', () => {
      mergeThresholds({ caps: { maxAlerts: 2 } });
      expect(DEFAULT_THRESHOLDS.caps.maxAlerts).toBe(25);
    });
  });

  describe('validateThresholds', () => {
    it('accepts the defaults', () => {
      expect(() => validateThresholds(DEFAULT_THRESHOLDS)).not.toThrow();
    });

    it('rejects a non-object', () => {
      expect(() => validateThresholds(null)).toThrow(ThresholdValidationError);
    });

    it('rejects a non-finite number', () => {
      expect(() =>
        resolveThresholds({ market: { minConfidence: Number.NaN } })
      ).toThrow(ThresholdValidationError);
    });

    it('rejects a non-integer day count', () => {
      expect(() => resolveThresholds({ cooldown: { highHours: 4.5 } })).toThrow(
        ThresholdValidationError
      );
    });

    it('rejects a ratio of zero, which would make the rule fire on everything', () => {
      expect(() => resolveThresholds({ engagementTrend: { minTotalDropRatio: 0 } })).toThrow(
        ThresholdValidationError
      );
    });

    it('rejects a ratio above one', () => {
      expect(() => resolveThresholds({ engagementTrend: { minTotalDropRatio: 1.2 } })).toThrow(
        ThresholdValidationError
      );
    });

    it('rejects an out-of-range health ceiling', () => {
      expect(() => resolveThresholds({ market: { healthCeiling: 140 } })).toThrow(
        ThresholdValidationError
      );
    });

    it('rejects a cap below one', () => {
      expect(() => resolveThresholds({ caps: { maxPerCustomer: 0 } })).toThrow(
        ThresholdValidationError
      );
    });

    it('validates the merged whole, so a bad value inside a valid-looking override is caught', () => {
      expect(() =>
        resolveThresholds({ caps: { maxAlerts: 5 }, market: { minConfidence: 2 } })
      ).toThrow(ThresholdValidationError);
    });

    it('names the offending field', () => {
      expect(() => resolveThresholds({ caps: { maxAlerts: -1 } })).toThrow(/caps.maxAlerts/);
    });
  });
});
