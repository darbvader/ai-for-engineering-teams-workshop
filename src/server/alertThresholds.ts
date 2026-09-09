/**
 * Configurable thresholds for the Predictive Intelligence feature.
 *
 * ## Why this lives here and not in `src/lib/alertThresholds.ts`
 *
 * The shipped rules engine (`src/lib/alerts.ts`) already owns the thresholds for
 * its five rules, as `AlertRuleConfig` / `DEFAULT_ALERT_RULE_CONFIG`, and that
 * module is not this feature's to edit. Rather than fork a second, competing set
 * of numbers for the same rules, `PredictiveThresholds` **wraps** the engine's
 * config and adds only what this feature introduces: the two extra rules, the
 * notification cooldowns, the dismissal TTL, and the fatigue caps.
 *
 * There is exactly one source of truth per number.
 */

import {
  DEFAULT_ALERT_RULE_CONFIG,
  validateAlertRuleConfig,
  type AlertRuleConfig,
} from '@/lib/alerts';

/** Thresholds for the whole feature. Every rule number is reachable from here. */
export interface PredictiveThresholds {
  /** Passed straight to `alertEngine`; owns the shipped five rules' numbers. */
  core: AlertRuleConfig;
  /** `engagement-decline-trend`, which the shipped engine does not carry. */
  engagementTrend: {
    /** Days per bucket; three consecutive buckets are compared. */
    bucketDays: number;
    /** Minimum `(oldest - newest) / oldest` drop across the three buckets. */
    minTotalDropRatio: number;
    /** Absolute low-volume guard on the oldest bucket. */
    minBaselineLogins: number;
  };
  /** `market-sentiment-risk`, which the shipped engine does not carry. */
  market: {
    /** Sentiment confidence at or above which the rule may fire. */
    minConfidence: number;
    /** Health score below which negative sentiment is treated as risk. */
    healthCeiling: number;
  };
  /**
   * Notification hold-off. Suppresses *notification* only — a cooled-down alert
   * still appears in the list, because hiding live risk is the opposite of the
   * feature's purpose.
   */
  cooldown: {
    highHours: number;
    mediumHours: number;
    /** How long a dismissal holds before the alert returns as `active`. */
    dismissalTtlHours: number;
  };
  /**
   * Fatigue controls, **not** security controls: they bound how much one screen
   * asks a human to read, and are trivially exceeded by adding customers.
   */
  caps: {
    maxPerCustomer: number;
    maxAlerts: number;
  };
}

/** The calibrated defaults. */
export const DEFAULT_THRESHOLDS: PredictiveThresholds = Object.freeze({
  core: DEFAULT_ALERT_RULE_CONFIG,
  engagementTrend: Object.freeze({ bucketDays: 10, minTotalDropRatio: 0.3, minBaselineLogins: 4 }),
  market: Object.freeze({ minConfidence: 0.6, healthCeiling: 70 }),
  cooldown: Object.freeze({ highHours: 48, mediumHours: 168, dismissalTtlHours: 168 }),
  caps: Object.freeze({ maxPerCustomer: 3, maxAlerts: 25 }),
}) as PredictiveThresholds;

/** A caller-supplied override. Every level is optional and deep-merged. */
export interface PredictiveThresholdsOverride {
  core?: Partial<AlertRuleConfig>;
  engagementTrend?: Partial<PredictiveThresholds['engagementTrend']>;
  market?: Partial<PredictiveThresholds['market']>;
  cooldown?: Partial<PredictiveThresholds['cooldown']>;
  caps?: Partial<PredictiveThresholds['caps']>;
}

/** Raised when a threshold override is unusable. */
export class ThresholdValidationError extends Error {
  readonly field: string;

  constructor(field: string, problem: string) {
    super(`Invalid threshold at "${field}": ${problem}`);
    this.name = 'ThresholdValidationError';
    this.field = field;
    Object.setPrototypeOf(this, ThresholdValidationError.prototype);
  }
}

function assertPositiveInteger(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new ThresholdValidationError(field, 'must be a positive integer');
  }
}

/** Ratios are in `(0, 1]`: a zero ratio would make the rule fire on everything. */
function assertRatio(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ThresholdValidationError(field, 'must be a finite ratio in (0, 1]');
  }
}

function assertHealthValue(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new ThresholdValidationError(field, 'must be a finite number in 0..100');
  }
}

function assertUnitInterval(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ThresholdValidationError(field, 'must be a finite number in 0..1');
  }
}

function isPlainObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

/**
 * Deep-merges a partial override over `DEFAULT_THRESHOLDS`.
 *
 * The merge is two levels deep, which is exactly the depth of the shape. It does
 * not validate — call {@link validateThresholds} on the result, so a combination
 * that is only invalid *together* cannot slip through field-by-field checking.
 *
 * @param override - Partial override; `undefined` yields the defaults.
 * @returns A fresh, fully-populated threshold object.
 */
export function mergeThresholds(override: PredictiveThresholdsOverride = {}): PredictiveThresholds {
  return {
    core: { ...DEFAULT_THRESHOLDS.core, ...override.core, cooldownHours: {
      ...DEFAULT_THRESHOLDS.core.cooldownHours,
      ...override.core?.cooldownHours,
    } },
    engagementTrend: { ...DEFAULT_THRESHOLDS.engagementTrend, ...override.engagementTrend },
    market: { ...DEFAULT_THRESHOLDS.market, ...override.market },
    cooldown: { ...DEFAULT_THRESHOLDS.cooldown, ...override.cooldown },
    caps: { ...DEFAULT_THRESHOLDS.caps, ...override.caps },
  };
}

/**
 * Validates a complete threshold object.
 *
 * Whole-object validation on purpose: a combination such as a zero drop ratio
 * beside a sane bucket length is only detectable when the object is checked as a
 * unit.
 *
 * @param input - Candidate threshold object, from an untrusted source.
 * @returns The same object, narrowed.
 * @throws {ThresholdValidationError} on any unusable value.
 */
export function validateThresholds(input: unknown): PredictiveThresholds {
  if (!isPlainObject(input)) {
    throw new ThresholdValidationError('thresholds', 'must be an object');
  }

  const { core, engagementTrend, market, cooldown, caps } = input as Record<string, unknown>;

  if (!isPlainObject(core)) {
    throw new ThresholdValidationError('core', 'must be an object');
  }
  // The engine owns its own numbers, so it owns their validation too.
  validateAlertRuleConfig(core as unknown as AlertRuleConfig);

  if (!isPlainObject(engagementTrend)) {
    throw new ThresholdValidationError('engagementTrend', 'must be an object');
  }
  assertPositiveInteger(engagementTrend.bucketDays, 'engagementTrend.bucketDays');
  assertRatio(engagementTrend.minTotalDropRatio, 'engagementTrend.minTotalDropRatio');
  assertPositiveInteger(engagementTrend.minBaselineLogins, 'engagementTrend.minBaselineLogins');

  if (!isPlainObject(market)) {
    throw new ThresholdValidationError('market', 'must be an object');
  }
  assertUnitInterval(market.minConfidence, 'market.minConfidence');
  assertHealthValue(market.healthCeiling, 'market.healthCeiling');

  if (!isPlainObject(cooldown)) {
    throw new ThresholdValidationError('cooldown', 'must be an object');
  }
  assertPositiveInteger(cooldown.highHours, 'cooldown.highHours');
  assertPositiveInteger(cooldown.mediumHours, 'cooldown.mediumHours');
  assertPositiveInteger(cooldown.dismissalTtlHours, 'cooldown.dismissalTtlHours');

  if (!isPlainObject(caps)) {
    throw new ThresholdValidationError('caps', 'must be an object');
  }
  assertPositiveInteger(caps.maxPerCustomer, 'caps.maxPerCustomer');
  assertPositiveInteger(caps.maxAlerts, 'caps.maxAlerts');

  return input as unknown as PredictiveThresholds;
}

/**
 * Merges an override over the defaults and validates the result as a whole.
 *
 * @param override - Partial override.
 * @returns Validated, fully-populated thresholds.
 * @throws {ThresholdValidationError} when the merged object is unusable.
 */
export function resolveThresholds(
  override: PredictiveThresholdsOverride = {}
): PredictiveThresholds {
  return validateThresholds(mergeThresholds(override));
}
