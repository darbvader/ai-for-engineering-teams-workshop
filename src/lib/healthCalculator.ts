/**
 * Health score banding.
 *
 * This module is the **single source of truth** for the 0-100 health score bands.
 * The thresholds live here and nowhere else, so `CustomerCard`,
 * `CustomerHealthDisplay`, and any future widget can never show two different
 * colours for the same score.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS
 * ---------------------------------------------------------------------------
 * A pure, synchronous, side-effect-free multi-factor health scoring engine.
 * It never touches React, fetches nothing, logs nothing, and reads no clock.
 * All "days since / days until" values are supplied by the caller, already
 * computed, because reading the clock would break purity and make tests
 * time-dependent.
 *
 * The full contract for this file is `specs/health-score-calculator-spec.md`.
 * The banding surface (`getRiskLevel` / `normalizeHealthScore` / `CRITICAL_MAX`
 * / `WARNING_MAX`) is shared with `specs/health-indicator-spec.md`;
 * `src/components/HealthIndicator.tsx` owns the colours, this file owns the
 * thresholds, and neither duplicates the other.
 *
 * ---------------------------------------------------------------------------
 * ASSUMPTIONS (business judgements, not derived facts — overrulable)
 * ---------------------------------------------------------------------------
 * 1. **Absolute contract value does not indicate health.** A large unhappy
 *    account is not healthy. The contract factor scores *trajectory*
 *    (`contractValue / previousContractValue`) and renewal proximity; absolute
 *    value is used only as the denominator for overdue-amount severity.
 * 2. **Support tickets are counted once.** Ticket *volume* is an engagement
 *    signal only; the support factor scores *experience quality* (satisfaction,
 *    resolution time, escalations). Scoring volume in both would
 *    double-penalise a customer for a single behaviour.
 * 3. **Some support contact is healthier than none**, hence the deliberately
 *    non-monotonic ticket curve: silence often means disengagement, not
 *    satisfaction.
 * 4. **Near-term renewal is a risk signal, not a defect.** Renewal proximity
 *    depresses the contract score to surface accounts needing attention; it
 *    never alone drives a customer to Critical, since the factor caps at 20%.
 * 5. **Payment behaviour is the strongest churn predictor**, justifying its 40%
 *    weight. An assumption, not a measured result — see Calibration.
 * 6. Curve endpoints (30-day delay, 20 logins, 8 features, 72-hour resolution)
 *    are plausible placeholders, not empirically fitted values.
 * 7. **Payment recency is meaningless without a billing cycle.** A fixed
 *    "0 at 120 days" curve treats every annually-billed customer as
 *    delinquent. The curve is expressed in multiples of `billingCycleDays`
 *    (100 at <= 1 cycle, 0 at >= 4 cycles), which reproduces the original
 *    30/120-day numbers at the default cycle of 30.
 * 8. **A categorical risk label needs majority evidence.** Below
 *    `MIN_BANDING_CONFIDENCE` the score is reported but not banded.
 *
 * Not every curve is monotonic: the support-ticket curve is non-monotonic by
 * design, and the renewal, momentum and CSAT curves are piecewise or step
 * functions. Every curve does, however, return through {@link clampScore}.
 *
 * ---------------------------------------------------------------------------
 * ## Calibration
 * ---------------------------------------------------------------------------
 * The factor weights, every curve endpoint, the trend dead band and the
 * banding-confidence floor are **unvalidated placeholders**. They encode
 * plausible business intuition, not fitted parameters, and should be re-fitted
 * against observed churn outcomes once outcome data exists.
 *
 * {@link HEALTH_SCORE_CONFIG} and {@link FACTOR_WEIGHTS} are the intended
 * tuning surface: recalibration is a single-file change and needs no consumer
 * to be touched. Because `calculateHealthScore` is pure, any A/B or
 * shadow-scoring comparison should run the alternative weights over the **same**
 * inputs and diff the results — no replay infrastructure is required.
 *
 * No live monitoring, telemetry, or experiment framework is built in this
 * iteration.
 */

/** Lowest score the dashboard will display; anything below is clamped up to it. */
export const HEALTH_SCORE_MINIMUM = 0;

/** Highest score the dashboard will display; anything above is clamped down to it. */
export const HEALTH_SCORE_MAXIMUM = 100;

/** Inclusive upper bound of the critical (red) band. */
export const CRITICAL_MAX = 30;

/** Inclusive upper bound of the warning (yellow) band. */
export const WARNING_MAX = 70;

/**
 * Risk classification of a health score.
 *
 * `'unknown'` covers both an absent or non-finite score and a score the
 * calculator declined to classify because it had too little data behind it.
 */
export type RiskLevel = 'healthy' | 'warning' | 'critical' | 'unknown';

/**
 * Reduces a raw score to the canonical value used for **both** display and
 * banding, so the number shown and the colour shown can never disagree.
 *
 * 1. `null`, `undefined`, or non-finite (`NaN`, `±Infinity`) → `null`
 * 2. Otherwise clamp into `[HEALTH_SCORE_MINIMUM, HEALTH_SCORE_MAXIMUM]`, then
 *    round to the nearest integer (`Math.round`, half-up)
 *
 * @param score An unvalidated score, typically straight off a customer record.
 * @returns The canonical integer score, or `null` when there is no usable score.
 */
export function normalizeHealthScore(score: number | null | undefined): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return null;
  }

  const clampedScore = Math.min(Math.max(score, HEALTH_SCORE_MINIMUM), HEALTH_SCORE_MAXIMUM);
  return Math.round(clampedScore);
}

/**
 * Bands a score. **Total** — returns a `RiskLevel` for every possible input,
 * including fractional, out-of-range, and non-finite values, because callers
 * pass raw record values straight in.
 *
 * Banding runs on the canonical value from {@link normalizeHealthScore} and uses
 * open-ended comparisons, so a fractional input can never fall into a gap. A
 * closed `CRITICAL_MAX < score && score <= WARNING_MAX` form must not be used:
 * `getRiskLevel(30.5)` would then match no band.
 *
 * @param score An unvalidated score on the 0-100 scale.
 * @returns The band, or `'unknown'` when there is no usable score.
 */
export function getRiskLevel(score: number | null | undefined): RiskLevel {
  const normalizedScore = normalizeHealthScore(score);

  if (normalizedScore === null) {
    return 'unknown';
  }

  if (normalizedScore <= CRITICAL_MAX) {
    return 'critical';
  }

  if (normalizedScore <= WARNING_MAX) {
    return 'warning';
  }

  return 'healthy';
}

/* ==========================================================================
 * Configuration — the single tuning surface
 * ========================================================================== */

/**
 * Nominal factor weights. Payment 40%, Engagement 30%, Contract 20%,
 * Support 10%, mirroring Assumption 5 (payment behaviour is the strongest
 * churn predictor) and Assumption 2 (support scores experience quality only,
 * so it carries the smallest share).
 *
 * Declared once and frozen; `calculateHealthScore` re-normalizes over whichever
 * of these factors actually has data.
 *
 * The integer percentages in {@link FACTOR_WEIGHT_PERCENTAGES} are the exact
 * arithmetic surface: `0.4 + 0.3 + 0.2 + 0.1` is `0.9999999999999999` in
 * IEEE-754 double arithmetic, so an exact "sums to 1" invariant can only be
 * asserted on the integers. The fractional drift is immaterial to the score,
 * which divides by the sum of the participating weights.
 */
export const FACTOR_WEIGHT_PERCENTAGES = Object.freeze({
  payment: 40,
  engagement: 30,
  contract: 20,
  support: 10
});

/** {@link FACTOR_WEIGHT_PERCENTAGES} expressed as fractions of 1. */
export const FACTOR_WEIGHTS = Object.freeze({
  payment: FACTOR_WEIGHT_PERCENTAGES.payment / 100,
  engagement: FACTOR_WEIGHT_PERCENTAGES.engagement / 100,
  contract: FACTOR_WEIGHT_PERCENTAGES.contract / 100,
  support: FACTOR_WEIGHT_PERCENTAGES.support / 100
});

/**
 * Minimum share of the total weight that must be backed by real data before a
 * score is given a categorical band. Below it the score is still returned — the
 * breakdown remains explainable — but the *claim* that the customer is Critical
 * or Healthy is withheld (Assumption 8).
 */
export const MIN_BANDING_CONFIDENCE = 0.5;

/** Tenure below which a score is reported as provisional rather than settled. */
export const PROVISIONAL_TENURE_DAYS = 30;

/** Points of movement treated as noise, so a flat customer reads as `'stable'`. */
export const TREND_DEAD_BAND = 3;

/** Billing cycle assumed when the caller supplies none (monthly). */
export const DEFAULT_BILLING_CYCLE_DAYS = 30;

/**
 * Every curve endpoint, in one frozen block so recalibration is a single-file
 * change. Each entry names the business meaning of the number; the rationale
 * for the value lives on the curve function that consumes it.
 */
export const HEALTH_SCORE_CONFIG = Object.freeze({
  payment: Object.freeze({
    /** Sub-weights within the payment factor; re-normalized over present signals. */
    subWeights: Object.freeze({
      averagePaymentDelayDays: 0.4,
      daysSinceLastPayment: 0.3,
      overdueAmount: 0.3
    }),
    /** A habitually punctual payer scores 100; a month late scores 0. */
    delayBestAtDays: 0,
    delayWorstAtDays: 30,
    /** Recency in multiples of the billing cycle (Assumption 7). */
    recencyBestAtCycles: 1,
    recencyWorstAtCycles: 4,
    /** Overdue severity is relative: a quarter of contract value outstanding is the floor. */
    overdueWorstAtContractValueFraction: 0.25,
    /** Absolute overdue ceiling used when contract value is unknown or non-positive. */
    overdueFallbackCeiling: 10000
  }),
  engagement: Object.freeze({
    subWeights: Object.freeze({
      loginsLast30Days: 0.4,
      featureUsageCount: 0.4,
      supportTicketsLast30Days: 0.2
    }),
    /** Roughly daily-on-weekdays use is full marks; never logging in is 0. */
    loginsBestAt: 20,
    loginsWorstAt: 0,
    /** Breadth of adoption: eight distinct features is a fully embedded customer. */
    featureUsageBestAt: 8,
    featureUsageWorstAt: 0,
    /** Silence scores below light contact (Assumption 3), not at zero. */
    ticketsSilenceScore: 70,
    /** Upper end of "healthy contact" — one to three tickets a month. */
    ticketsHealthyMaximum: 3,
    /** Fifteen tickets a month is a customer in trouble. */
    ticketsWorstAt: 15
  }),
  contract: Object.freeze({
    subWeights: Object.freeze({
      daysUntilRenewal: 0.5,
      contractValueRatio: 0.25,
      contractMomentum: 0.25
    }),
    /** A lapsed contract scores 0; renewal day itself is the low point of the live curve. */
    renewalDayScore: 30,
    /** Inside a month of renewal the account needs attention (Assumption 4). */
    renewalNearHorizonDays: 30,
    renewalNearHorizonScore: 60,
    /** Beyond four months out, renewal risk is not a present concern. */
    renewalFarHorizonDays: 120,
    /** Halving spend is a total loss of trajectory. */
    contractRatioWorstAt: 0.5,
    /** Flat renewal is good but not perfect — it is not growth. */
    contractRatioFlatScore: 80,
    /** Ten percent expansion is a fully healthy trajectory. */
    contractRatioBestAt: 1.1,
    /** No recent upgrade is neutral-positive, not a fault. */
    momentumBaseScore: 70,
    /** Any recent upgrade is an unambiguous positive. */
    momentumUpgradeScore: 100,
    /** Each downgrade is a material contraction signal. */
    momentumDowngradePenalty: 35
  }),
  support: Object.freeze({
    subWeights: Object.freeze({
      satisfactionScore: 0.5,
      averageResolutionTimeHours: 0.3,
      escalationCount: 0.2
    }),
    /** CSAT is captured on a 1-5 scale; confirm before reuse elsewhere. */
    satisfactionMinimum: 1,
    satisfactionMaximum: 5,
    /** Same-working-day resolution is full marks; three days is a failure. */
    resolutionBestAtHours: 4,
    resolutionWorstAtHours: 72,
    /** Escalations are rare by definition, so five in 90 days is the floor. */
    escalationBestAt: 0,
    escalationWorstAt: 5
  })
});

/* ==========================================================================
 * Interfaces
 * ========================================================================== */

/**
 * Payment behaviour. Every field is optional and `null` is treated exactly like
 * `undefined`: absent is **not** zero. Treating a missing `overdueAmount` as `0`
 * would flatter a customer; treating it as worst-case would defame one.
 */
export interface PaymentHistory {
  /** Days since the most recent payment landed, computed by the caller. */
  daysSinceLastPayment?: number | null;
  /** Mean lateness across recent invoices, in days. */
  averagePaymentDelayDays?: number | null;
  /** Currency amount currently past due. Never echoed in errors or logs. */
  overdueAmount?: number | null;
}

/** Product engagement over the trailing 30 days. */
export interface EngagementMetrics {
  loginsLast30Days?: number | null;
  /** Count of *distinct* features touched in the last 30 days. */
  featureUsageCount?: number | null;
  /** Ticket volume. Scored here only — never again in the support factor. */
  supportTicketsLast30Days?: number | null;
}

/** Contract posture. Absolute value is not a health signal (Assumption 1). */
export interface ContractInformation {
  /** Negative means the contract has lapsed, which is legitimate and scores 0. */
  daysUntilRenewal?: number | null;
  /** Used only as the denominator for overdue severity. */
  contractValue?: number | null;
  /** Required for the trajectory ratio; without it that signal is missing. */
  previousContractValue?: number | null;
  recentUpgradeCount?: number | null;
  recentDowngradeCount?: number | null;
}

/** Support *experience quality* — deliberately excluding ticket volume. */
export interface SupportData {
  /** CSAT on a 1-5 scale. Out-of-range values throw rather than score. */
  satisfactionScore?: number | null;
  averageResolutionTimeHours?: number | null;
  /** Escalations in the trailing 90 days. */
  escalationCount?: number | null;
}

/**
 * Data a payment curve needs that does not live in {@link PaymentHistory}.
 *
 * Without it, `calculatePaymentScore(payment)` and the payment slice of
 * `calculateHealthScore({ payment, contract })` would disagree for the same
 * customer and the breakdown would not reconcile with the total.
 */
export interface FactorContext {
  /** Denominator for overdue-amount severity. */
  contractValue?: number;
  /** Scales the payment-recency curve. */
  billingCycleDays?: number;
}

/** One factor's contribution, carried so every number is explainable. */
export interface FactorScore {
  /** `[0, 100]` rounded to one decimal, or `null` when the factor has no data. */
  score: number | null;
  /** Nominal weight, e.g. `0.4`. */
  weight: number;
  /** Weight after cross-factor re-normalization; `0` when excluded. */
  effectiveWeight: number;
  signalsUsed: string[];
  signalsMissing: string[];
}

/** Everything the calculator knows about one customer at one point in time. */
export interface HealthScoreInput {
  payment?: PaymentHistory;
  engagement?: EngagementMetrics;
  contract?: ContractInformation;
  support?: SupportData;
  /** Days since the relationship began. Under 30 marks the score provisional. */
  tenureDays?: number | null;
  /** Real billing cadence. Annual customers **must** supply this. */
  billingCycleDays?: number | null;
  /** A prior score, supplied by the caller, purely for the trend flag. */
  previous?: { score: number };
}

/** Movement against the caller-supplied previous score. Advisory metadata only. */
export type HealthTrend = 'improving' | 'declining' | 'stable';

/** The explainable result: headline score, band, per-factor breakdown, confidence. */
export interface HealthScoreResult {
  /** Integer `[0, 100]`; `null` only when no factor had any data at all. */
  score: number | null;
  /** `'unknown'` does **not** imply `score === null` — see the confidence floor. */
  riskLevel: RiskLevel;
  breakdown: {
    payment: FactorScore;
    engagement: FactorScore;
    contract: FactorScore;
    support: FactorScore;
  };
  /** Fraction of the original 100% weight backed by data, to two decimals. */
  confidence: number;
  /** Set by short tenure *or* by low confidence; the wording differs. */
  provisional: boolean;
  /** Omitted when `previous` is absent or `score` is `null`. */
  trend?: HealthTrend;
}

/* ==========================================================================
 * Validation
 * ========================================================================== */

/**
 * Thrown for *invalid* data only. Missing data never throws — it re-weights.
 *
 * The message names the field path and the class of problem and **never** echoes
 * a monetary amount, so validation failures are safe to log. That costs some
 * debuggability on negative-amount errors; the field path plus the problem class
 * is judged sufficient.
 */
export class HealthScoreValidationError extends Error {
  /** Dotted path from the input root, e.g. `'payment.overdueAmount'`. */
  public readonly field: string;

  constructor(field: string, problem: string) {
    super(`Invalid health score input at "${field}": ${problem}`);
    this.name = 'HealthScoreValidationError';
    this.field = field;
  }
}

/** Numeric fields that describe counts, amounts or durations and cannot be negative. */
const NON_NEGATIVE_FIELD_PATHS: readonly string[] = [
  'tenureDays',
  'billingCycleDays',
  'payment.daysSinceLastPayment',
  'payment.averagePaymentDelayDays',
  'payment.overdueAmount',
  'engagement.loginsLast30Days',
  'engagement.featureUsageCount',
  'engagement.supportTicketsLast30Days',
  'contract.contractValue',
  'contract.previousContractValue',
  'contract.recentUpgradeCount',
  'contract.recentDowngradeCount',
  'support.averageResolutionTimeHours',
  'support.escalationCount'
];

/** `true` for a non-null, non-array object — the shape every factor must have. */
function isPlainObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

/** `true` when a signal is absent. `null` is treated exactly like `undefined`. */
function isMissing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Validates one optional numeric signal. Missing values pass untouched; present
 * ones must be finite numbers, and non-negative where the field demands it.
 *
 * @throws HealthScoreValidationError on the first problem found.
 */
function validateOptionalNumber(value: unknown, fieldPath: string): void {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value !== 'number') {
    throw new HealthScoreValidationError(fieldPath, `expected a number, received ${typeof value}`);
  }

  if (!Number.isFinite(value)) {
    throw new HealthScoreValidationError(fieldPath, 'expected a finite number');
  }

  if (NON_NEGATIVE_FIELD_PATHS.includes(fieldPath) && value < 0) {
    throw new HealthScoreValidationError(fieldPath, 'must not be negative');
  }
}

/** Asserts an optional factor object is a plain object when present and not `null`. */
function validateOptionalObject(value: unknown, fieldPath: string): void {
  if (value === null || value === undefined) {
    return;
  }

  if (!isPlainObject(value)) {
    throw new HealthScoreValidationError(
      fieldPath,
      'expected an object of signals, received ' + (Array.isArray(value) ? 'an array' : typeof value)
    );
  }
}

/**
 * Full input validation: shape first, then numerics, failing fast on the first
 * offending field. Unknown extra properties are ignored rather than rejected —
 * forward compatibility is worth more here than strictness.
 *
 * @throws HealthScoreValidationError naming the dotted field path.
 */
function validateInput(input: HealthScoreInput): void {
  // Narrowed through a separate `unknown` binding so the rest of the function
  // keeps its declared types rather than collapsing to `Record<string, unknown>`.
  const candidateInput: unknown = input;
  if (!isPlainObject(candidateInput)) {
    throw new HealthScoreValidationError(
      'input',
      'expected a non-null object, received ' +
        (Array.isArray(candidateInput) ? 'an array' : candidateInput === null ? 'null' : typeof candidateInput)
    );
  }

  validateOptionalObject(input.payment, 'payment');
  validateOptionalObject(input.engagement, 'engagement');
  validateOptionalObject(input.contract, 'contract');
  validateOptionalObject(input.support, 'support');
  validateOptionalObject(input.previous, 'previous');

  validateOptionalNumber(input.tenureDays, 'tenureDays');
  validateOptionalNumber(input.billingCycleDays, 'billingCycleDays');
  if (input.billingCycleDays === 0) {
    throw new HealthScoreValidationError(
      'billingCycleDays',
      'must not be zero because it divides the payment-recency curve'
    );
  }

  const payment: PaymentHistory = input.payment ?? {};
  validateOptionalNumber(payment.daysSinceLastPayment, 'payment.daysSinceLastPayment');
  validateOptionalNumber(payment.averagePaymentDelayDays, 'payment.averagePaymentDelayDays');
  validateOptionalNumber(payment.overdueAmount, 'payment.overdueAmount');

  const engagement: EngagementMetrics = input.engagement ?? {};
  validateOptionalNumber(engagement.loginsLast30Days, 'engagement.loginsLast30Days');
  validateOptionalNumber(engagement.featureUsageCount, 'engagement.featureUsageCount');
  validateOptionalNumber(engagement.supportTicketsLast30Days, 'engagement.supportTicketsLast30Days');

  const contract: ContractInformation = input.contract ?? {};
  // `daysUntilRenewal` is deliberately absent from the non-negative list: a
  // negative value means the contract has lapsed and is scored, not rejected.
  validateOptionalNumber(contract.daysUntilRenewal, 'contract.daysUntilRenewal');
  validateOptionalNumber(contract.contractValue, 'contract.contractValue');
  validateOptionalNumber(contract.previousContractValue, 'contract.previousContractValue');
  validateOptionalNumber(contract.recentUpgradeCount, 'contract.recentUpgradeCount');
  validateOptionalNumber(contract.recentDowngradeCount, 'contract.recentDowngradeCount');

  const support: SupportData = input.support ?? {};
  validateOptionalNumber(support.satisfactionScore, 'support.satisfactionScore');
  validateOptionalNumber(support.averageResolutionTimeHours, 'support.averageResolutionTimeHours');
  validateOptionalNumber(support.escalationCount, 'support.escalationCount');

  const { satisfactionMinimum, satisfactionMaximum } = HEALTH_SCORE_CONFIG.support;
  if (
    !isMissing(support.satisfactionScore) &&
    (support.satisfactionScore < satisfactionMinimum || support.satisfactionScore > satisfactionMaximum)
  ) {
    throw new HealthScoreValidationError(
      'support.satisfactionScore',
      `must be within the CSAT scale ${satisfactionMinimum}-${satisfactionMaximum}`
    );
  }

  const previous = input.previous;
  if (previous !== undefined && previous !== null) {
    const previousScore: unknown = previous.score;
    if (typeof previousScore !== 'number') {
      throw new HealthScoreValidationError(
        'previous.score',
        `expected a number, received ${typeof previousScore}`
      );
    }
    if (!Number.isFinite(previousScore)) {
      throw new HealthScoreValidationError('previous.score', 'expected a finite number');
    }
    if (previousScore < HEALTH_SCORE_MINIMUM || previousScore > HEALTH_SCORE_MAXIMUM) {
      throw new HealthScoreValidationError(
        'previous.score',
        `must be within ${HEALTH_SCORE_MINIMUM}-${HEALTH_SCORE_MAXIMUM}`
      );
    }
  }
}

/* ==========================================================================
 * Normalization helpers — the clamping rule lives in exactly one place
 * ========================================================================== */

/**
 * Clamps any curve output into `[0, 100]`. **Every** curve in this module
 * returns through here, including the piecewise and step curves, so no factor
 * can ever contribute an out-of-range value to the weighted mean.
 */
export function clampScore(value: number): number {
  return Math.min(Math.max(value, HEALTH_SCORE_MINIMUM), HEALTH_SCORE_MAXIMUM);
}

/**
 * A single linear ramp from `worstAt` (score 0) to `bestAt` (score 100),
 * clamped at both ends.
 *
 * `bestAt` may be greater or less than `worstAt`, so one helper serves both
 * "lower is better" signals (payment delay) and "higher is better" ones
 * (logins). Degenerate equal endpoints are treated as a step at that point.
 */
export function normalizeLinear(value: number, bestAt: number, worstAt: number): number {
  if (bestAt === worstAt) {
    return clampScore(value <= bestAt ? HEALTH_SCORE_MAXIMUM : HEALTH_SCORE_MINIMUM);
  }

  const positionOnRamp = (value - worstAt) / (bestAt - worstAt);
  return clampScore(positionOnRamp * HEALTH_SCORE_MAXIMUM);
}

/**
 * Support-ticket volume, **non-monotonic by design** (Assumption 3): total
 * silence usually means disengagement rather than delight, so it scores below
 * light contact. One to three tickets a month is a healthy, engaged customer;
 * beyond that, volume becomes a distress signal decaying linearly to 0 at 15.
 *
 * Ticket counts are integers in practice; a value below 1 is read as silence.
 */
export function scoreTicketVolumeCurve(ticketCount: number): number {
  const { ticketsSilenceScore, ticketsHealthyMaximum, ticketsWorstAt } =
    HEALTH_SCORE_CONFIG.engagement;

  if (ticketCount < 1) {
    return clampScore(ticketsSilenceScore);
  }

  if (ticketCount <= ticketsHealthyMaximum) {
    return clampScore(HEALTH_SCORE_MAXIMUM);
  }

  return normalizeLinear(ticketCount, ticketsHealthyMaximum, ticketsWorstAt);
}

/**
 * Renewal proximity as a four-segment curve. A lapsed contract scores 0. Renewal
 * day is the low point of the live curve (30) and the score recovers as the
 * horizon lengthens: 30→60 across the first month, 60→100 out to four months,
 * flat 100 beyond. Proximity is a *risk* flag, not a defect (Assumption 4),
 * which is why the near horizon still scores 30-60 rather than 0.
 */
export function scoreRenewalCurve(daysUntilRenewal: number): number {
  const {
    renewalDayScore,
    renewalNearHorizonDays,
    renewalNearHorizonScore,
    renewalFarHorizonDays
  } = HEALTH_SCORE_CONFIG.contract;

  if (daysUntilRenewal < 0) {
    return clampScore(HEALTH_SCORE_MINIMUM);
  }

  if (daysUntilRenewal === 0) {
    return clampScore(renewalDayScore);
  }

  if (daysUntilRenewal <= renewalNearHorizonDays) {
    const progress = daysUntilRenewal / renewalNearHorizonDays;
    return clampScore(renewalDayScore + progress * (renewalNearHorizonScore - renewalDayScore));
  }

  if (daysUntilRenewal < renewalFarHorizonDays) {
    const progress =
      (daysUntilRenewal - renewalNearHorizonDays) / (renewalFarHorizonDays - renewalNearHorizonDays);
    return clampScore(
      renewalNearHorizonScore + progress * (HEALTH_SCORE_MAXIMUM - renewalNearHorizonScore)
    );
  }

  return clampScore(HEALTH_SCORE_MAXIMUM);
}

/**
 * Spend trajectory, `contractValue / previousContractValue`, as two ramps:
 * halved spend or worse is a total loss of trajectory (0), flat renewal is good
 * but not growth (80), and 10% expansion or more is fully healthy (100).
 * Absolute value is never a health signal on its own (Assumption 1).
 */
export function scoreContractValueRatioCurve(contractValueRatio: number): number {
  const { contractRatioWorstAt, contractRatioFlatScore, contractRatioBestAt } =
    HEALTH_SCORE_CONFIG.contract;
  const flatRatio = 1;

  if (contractValueRatio <= contractRatioWorstAt) {
    return clampScore(HEALTH_SCORE_MINIMUM);
  }

  if (contractValueRatio <= flatRatio) {
    const progress = (contractValueRatio - contractRatioWorstAt) / (flatRatio - contractRatioWorstAt);
    return clampScore(progress * contractRatioFlatScore);
  }

  if (contractValueRatio < contractRatioBestAt) {
    const progress = (contractValueRatio - flatRatio) / (contractRatioBestAt - flatRatio);
    return clampScore(
      contractRatioFlatScore + progress * (HEALTH_SCORE_MAXIMUM - contractRatioFlatScore)
    );
  }

  return clampScore(HEALTH_SCORE_MAXIMUM);
}

/**
 * Contract momentum as a step function over two fields that are **one signal**:
 * no recent upgrade is neutral-positive (70) rather than a fault, any upgrade is
 * an unambiguous positive (100), and each downgrade removes 35 points.
 *
 * A downgrade count with no upgrade counterpart would otherwise have no defined
 * behaviour under the re-weighting rules, so the absent field is read as `0`
 * whenever the other is present.
 */
export function scoreContractMomentumCurve(
  recentUpgradeCount: number,
  recentDowngradeCount: number
): number {
  const { momentumBaseScore, momentumUpgradeScore, momentumDowngradePenalty } =
    HEALTH_SCORE_CONFIG.contract;

  const baseScore = recentUpgradeCount >= 1 ? momentumUpgradeScore : momentumBaseScore;
  return clampScore(baseScore - recentDowngradeCount * momentumDowngradePenalty);
}

/**
 * Rescales CSAT from its native 1-5 scale onto `[0, 100]`: `(value - 1) / 4 * 100`.
 * The 1-5 scale is an assumption — a source system using 1-10, a percentage, or
 * `0` for "no response" will throw in validation rather than mis-score.
 */
export function scoreSatisfactionCurve(satisfactionScore: number): number {
  const { satisfactionMinimum, satisfactionMaximum } = HEALTH_SCORE_CONFIG.support;
  const scaleWidth = satisfactionMaximum - satisfactionMinimum;
  return clampScore(((satisfactionScore - satisfactionMinimum) / scaleWidth) * HEALTH_SCORE_MAXIMUM);
}

/* ==========================================================================
 * Factor combination — the missing-data re-weighting rules
 * ========================================================================== */

/** One scored signal inside a factor. `score === null` means the signal is absent. */
interface SignalContribution {
  name: string;
  subWeight: number;
  score: number | null;
}

/** A factor's public breakdown plus the unrounded score the total is built from. */
interface FactorComputation {
  factorScore: FactorScore;
  /** Unrounded, so the total never inherits per-factor display rounding. */
  rawScore: number | null;
}

/** Rounds a factor score to one decimal place for display. */
function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Rounds a confidence value to two decimal places. */
function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Combines a factor's signals, re-normalizing the sub-weights of the **present**
 * signals to sum to 1. A payment record carrying only `averagePaymentDelayDays`
 * is therefore scored purely on that signal rather than penalised for silence.
 *
 * A factor with no present signals scores `null` with `effectiveWeight: 0`; the
 * orchestrator then redistributes its factor weight.
 */
function combineSignals(signals: SignalContribution[], nominalWeight: number): FactorComputation {
  const presentSignals = signals.filter((signal) => signal.score !== null);
  const signalsUsed = presentSignals.map((signal) => signal.name);
  const signalsMissing = signals
    .filter((signal) => signal.score === null)
    .map((signal) => signal.name);

  if (presentSignals.length === 0) {
    return {
      rawScore: null,
      factorScore: {
        score: null,
        weight: nominalWeight,
        effectiveWeight: 0,
        signalsUsed,
        signalsMissing
      }
    };
  }

  const presentSubWeightTotal = presentSignals.reduce((total, signal) => total + signal.subWeight, 0);
  const weightedTotal = presentSignals.reduce(
    (total, signal) => total + (signal.score ?? 0) * signal.subWeight,
    0
  );
  const rawScore = clampScore(weightedTotal / presentSubWeightTotal);

  return {
    rawScore,
    factorScore: {
      score: roundToOneDecimal(rawScore),
      weight: nominalWeight,
      effectiveWeight: nominalWeight,
      signalsUsed,
      signalsMissing
    }
  };
}

/**
 * Scores payment behaviour, the heaviest factor at 40% (Assumption 5).
 *
 * Sub-weights: average delay 40%, recency 30%, overdue amount 30%. Recency is
 * measured in multiples of `context.billingCycleDays` so an annually-billed
 * customer is not read as delinquent (Assumption 7), and overdue severity is
 * relative to `context.contractValue`.
 *
 * **A standalone call may differ from the orchestrated one.** Without a context,
 * the billing cycle falls back to {@link DEFAULT_BILLING_CYCLE_DAYS} and the
 * overdue ceiling to a flat `overdueFallbackCeiling`, whereas
 * `calculateHealthScore` supplies the customer's real cycle and contract value.
 * Pass the same context to reproduce the orchestrated number exactly.
 */
export function calculatePaymentScore(
  payment: PaymentHistory | undefined,
  context?: FactorContext
): FactorScore {
  return computePaymentFactor(payment, context).factorScore;
}

/** Shared implementation, so the orchestrator can use the unrounded score. */
function computePaymentFactor(
  payment: PaymentHistory | undefined,
  context?: FactorContext
): FactorComputation {
  const config = HEALTH_SCORE_CONFIG.payment;
  const record = payment ?? {};

  const billingCycleDays =
    context?.billingCycleDays !== undefined && context.billingCycleDays > 0
      ? context.billingCycleDays
      : DEFAULT_BILLING_CYCLE_DAYS;

  const overdueCeiling =
    context?.contractValue !== undefined && context.contractValue > 0
      ? context.contractValue * config.overdueWorstAtContractValueFraction
      : config.overdueFallbackCeiling;

  const delayScore = isMissing(record.averagePaymentDelayDays)
    ? null
    : normalizeLinear(record.averagePaymentDelayDays, config.delayBestAtDays, config.delayWorstAtDays);

  const recencyScore = isMissing(record.daysSinceLastPayment)
    ? null
    : normalizeLinear(
        record.daysSinceLastPayment,
        config.recencyBestAtCycles * billingCycleDays,
        config.recencyWorstAtCycles * billingCycleDays
      );

  const overdueScore = isMissing(record.overdueAmount)
    ? null
    : normalizeLinear(record.overdueAmount, 0, overdueCeiling);

  return combineSignals(
    [
      {
        name: 'averagePaymentDelayDays',
        subWeight: config.subWeights.averagePaymentDelayDays,
        score: delayScore
      },
      {
        name: 'daysSinceLastPayment',
        subWeight: config.subWeights.daysSinceLastPayment,
        score: recencyScore
      },
      { name: 'overdueAmount', subWeight: config.subWeights.overdueAmount, score: overdueScore }
    ],
    FACTOR_WEIGHTS.payment
  );
}

/**
 * Scores product engagement at 30%: logins 40%, breadth of feature adoption 40%,
 * ticket volume 20%. Ticket volume is scored here and **only** here
 * (Assumption 2), on a non-monotonic curve (Assumption 3).
 *
 * Zero across all three is a legitimate engagement score, not missing data.
 */
export function calculateEngagementScore(engagement?: EngagementMetrics): FactorScore {
  return computeEngagementFactor(engagement).factorScore;
}

/** Shared implementation, so the orchestrator can use the unrounded score. */
function computeEngagementFactor(engagement?: EngagementMetrics): FactorComputation {
  const config = HEALTH_SCORE_CONFIG.engagement;
  const record = engagement ?? {};

  const loginScore = isMissing(record.loginsLast30Days)
    ? null
    : normalizeLinear(record.loginsLast30Days, config.loginsBestAt, config.loginsWorstAt);

  const featureScore = isMissing(record.featureUsageCount)
    ? null
    : normalizeLinear(record.featureUsageCount, config.featureUsageBestAt, config.featureUsageWorstAt);

  const ticketScore = isMissing(record.supportTicketsLast30Days)
    ? null
    : scoreTicketVolumeCurve(record.supportTicketsLast30Days);

  return combineSignals(
    [
      { name: 'loginsLast30Days', subWeight: config.subWeights.loginsLast30Days, score: loginScore },
      {
        name: 'featureUsageCount',
        subWeight: config.subWeights.featureUsageCount,
        score: featureScore
      },
      {
        name: 'supportTicketsLast30Days',
        subWeight: config.subWeights.supportTicketsLast30Days,
        score: ticketScore
      }
    ],
    FACTOR_WEIGHTS.engagement
  );
}

/**
 * Scores contract posture at 20%: renewal proximity 50%, spend trajectory 25%,
 * momentum 25%.
 *
 * `contractValueRatio` needs `previousContractValue` and a positive denominator;
 * without either the signal is **missing**, not defaulted, because absolute
 * contract value is not a health signal (Assumption 1). `contractMomentum` is
 * present whenever *either* count is present, with the absent one read as `0`.
 */
export function calculateContractScore(contract?: ContractInformation): FactorScore {
  return computeContractFactor(contract).factorScore;
}

/** Shared implementation, so the orchestrator can use the unrounded score. */
function computeContractFactor(contract?: ContractInformation): FactorComputation {
  const config = HEALTH_SCORE_CONFIG.contract;
  const record = contract ?? {};

  const renewalScore = isMissing(record.daysUntilRenewal)
    ? null
    : scoreRenewalCurve(record.daysUntilRenewal);

  const hasComparableContractValues =
    !isMissing(record.contractValue) &&
    !isMissing(record.previousContractValue) &&
    record.previousContractValue > 0;

  const ratioScore =
    hasComparableContractValues && !isMissing(record.contractValue) && !isMissing(record.previousContractValue)
      ? scoreContractValueRatioCurve(record.contractValue / record.previousContractValue)
      : null;

  const hasMomentumSignal = !isMissing(record.recentUpgradeCount) || !isMissing(record.recentDowngradeCount);
  const momentumScore = hasMomentumSignal
    ? scoreContractMomentumCurve(record.recentUpgradeCount ?? 0, record.recentDowngradeCount ?? 0)
    : null;

  return combineSignals(
    [
      { name: 'daysUntilRenewal', subWeight: config.subWeights.daysUntilRenewal, score: renewalScore },
      {
        name: 'contractValueRatio',
        subWeight: config.subWeights.contractValueRatio,
        score: ratioScore
      },
      { name: 'contractMomentum', subWeight: config.subWeights.contractMomentum, score: momentumScore }
    ],
    FACTOR_WEIGHTS.contract
  );
}

/**
 * Scores support *experience quality* at 10%: satisfaction 50%, resolution time
 * 30%, escalations 20%. Ticket volume is deliberately excluded — it is an
 * engagement signal and scoring it twice would double-penalise one behaviour
 * (Assumption 2).
 */
export function calculateSupportScore(support?: SupportData): FactorScore {
  return computeSupportFactor(support).factorScore;
}

/** Shared implementation, so the orchestrator can use the unrounded score. */
function computeSupportFactor(support?: SupportData): FactorComputation {
  const config = HEALTH_SCORE_CONFIG.support;
  const record = support ?? {};

  const satisfaction = isMissing(record.satisfactionScore)
    ? null
    : scoreSatisfactionCurve(record.satisfactionScore);

  const resolution = isMissing(record.averageResolutionTimeHours)
    ? null
    : normalizeLinear(
        record.averageResolutionTimeHours,
        config.resolutionBestAtHours,
        config.resolutionWorstAtHours
      );

  const escalation = isMissing(record.escalationCount)
    ? null
    : normalizeLinear(record.escalationCount, config.escalationBestAt, config.escalationWorstAt);

  return combineSignals(
    [
      { name: 'satisfactionScore', subWeight: config.subWeights.satisfactionScore, score: satisfaction },
      {
        name: 'averageResolutionTimeHours',
        subWeight: config.subWeights.averageResolutionTimeHours,
        score: resolution
      },
      { name: 'escalationCount', subWeight: config.subWeights.escalationCount, score: escalation }
    ],
    FACTOR_WEIGHTS.support
  );
}

/**
 * Classifies movement against a caller-supplied previous score, with a dead band
 * of {@link TREND_DEAD_BAND} points so ordinary noise does not read as a trend.
 * A delta of exactly `±3` is stable.
 *
 * Advisory metadata only: the trend never feeds back into the score, since
 * folding a delta into the total would double-count signals already scored and
 * make the result irreproducible from a single snapshot.
 */
function determineTrend(currentScore: number, previousScore: number): HealthTrend {
  const delta = currentScore - previousScore;

  if (delta > TREND_DEAD_BAND) {
    return 'improving';
  }

  if (delta < -TREND_DEAD_BAND) {
    return 'declining';
  }

  return 'stable';
}

/**
 * Computes a customer's health score from a caller-supplied snapshot.
 *
 * Pure and synchronous: same input, same output, always. No clock, no
 * randomness, no I/O, no mutation of the argument, no module-level state. If
 * memoization is wanted, wrap this function at the call site rather than
 * caching inside it.
 *
 * The algorithm:
 * 1. Validate. Missing data never throws; invalid data throws
 *    {@link HealthScoreValidationError} naming the dotted field path.
 * 2. Score each factor over its **present** signals, re-normalizing sub-weights.
 * 3. Drop factors with no data and re-normalize the remaining factor weights to
 *    sum to 1, so a partially-known customer is scored on what is known rather
 *    than punished for what is not.
 * 4. `confidence` is the share of the original 100% weight backed by at least
 *    one signal, before re-normalization: payment-only data gives `0.4`.
 * 5. No data at all returns `score: null` and `'unknown'` — never `0`, which
 *    would read as Critical and libel the customer.
 * 6. Below {@link MIN_BANDING_CONFIDENCE} the score is returned but not banded:
 *    `riskLevel: 'unknown'`, `provisional: true`. Support-only data with
 *    `satisfactionScore: 1` totals `0` on 10% of the evidence, and that is not a
 *    claim worth making.
 *
 * **Breakdown precision caveat.** `FactorScore.score` is rounded to one decimal
 * for display, but the total is computed from the **unrounded** factor scores, so
 * re-multiplying the displayed parts may differ from the displayed total by up to
 * about half a point. The breakdown is an explanation, not an audit trail.
 *
 * @throws HealthScoreValidationError for invalid — never merely missing — data.
 */
export function calculateHealthScore(input: HealthScoreInput): HealthScoreResult {
  validateInput(input);

  const billingCycleDays =
    isMissing(input.billingCycleDays) || input.billingCycleDays <= 0
      ? DEFAULT_BILLING_CYCLE_DAYS
      : input.billingCycleDays;

  // Derived so the payment slice of the breakdown reconciles with the total:
  // a standalone `calculatePaymentScore` call without this context can differ.
  const paymentContext: FactorContext = {
    contractValue: isMissing(input.contract?.contractValue) ? undefined : input.contract.contractValue,
    billingCycleDays
  };

  const payment = computePaymentFactor(input.payment, paymentContext);
  const engagement = computeEngagementFactor(input.engagement);
  const contract = computeContractFactor(input.contract);
  const support = computeSupportFactor(input.support);

  const factors = [payment, engagement, contract, support];
  const presentFactors = factors.filter((factor) => factor.rawScore !== null);

  const backedWeightTotal = presentFactors.reduce(
    (total, factor) => total + factor.factorScore.weight,
    0
  );
  const confidence = roundToTwoDecimals(backedWeightTotal);

  const tenureIsShort = !isMissing(input.tenureDays) && input.tenureDays < PROVISIONAL_TENURE_DAYS;

  const breakdown = {
    payment: payment.factorScore,
    engagement: engagement.factorScore,
    contract: contract.factorScore,
    support: support.factorScore
  };

  if (presentFactors.length === 0) {
    // Rule 4: no evidence at all is reported as no score, never as zero.
    return {
      score: null,
      riskLevel: 'unknown',
      breakdown,
      confidence: 0,
      provisional: tenureIsShort
    };
  }

  // Cross-factor re-normalization: each surviving factor's share of the weight
  // that data actually backs.
  for (const factor of presentFactors) {
    factor.factorScore.effectiveWeight = factor.factorScore.weight / backedWeightTotal;
  }

  const weightedTotal = presentFactors.reduce(
    (total, factor) => total + (factor.rawScore ?? 0) * factor.factorScore.weight,
    0
  );
  const score = Math.round(clampScore(weightedTotal / backedWeightTotal));

  const isBandable = confidence >= MIN_BANDING_CONFIDENCE;
  const result: HealthScoreResult = {
    score,
    riskLevel: isBandable ? getRiskLevel(score) : 'unknown',
    breakdown,
    confidence,
    provisional: tenureIsShort || !isBandable
  };

  if (input.previous !== undefined && input.previous !== null) {
    return { ...result, trend: determineTrend(score, input.previous.score) };
  }

  return result;
}
