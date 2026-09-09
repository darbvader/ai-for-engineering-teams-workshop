/**
 * Fixtures for the health score calculator suite.
 *
 * These are *inputs only*: every expected number is derived in the test from the
 * exported curve functions and constants, never hard-coded here, so recalibrating
 * `HEALTH_SCORE_CONFIG` cannot leave a stale expectation hiding in a fixture.
 *
 * The centrepiece is {@link inputAtScore}: an input engineered so that **all four
 * factors score exactly `s`**, which (because a weighted mean of equal values is
 * that value) makes the total exactly `s` too. Band boundaries, fractional totals
 * and the weighting arithmetic are all expressed through it.
 */

import type { HealthScoreInput, PaymentHistory } from '@/lib/healthCalculator';
import { HEALTH_SCORE_CONFIG } from '@/lib/healthCalculator';

const paymentConfig = HEALTH_SCORE_CONFIG.payment;
const engagementConfig = HEALTH_SCORE_CONFIG.engagement;
const contractConfig = HEALTH_SCORE_CONFIG.contract;
const supportConfig = HEALTH_SCORE_CONFIG.support;

/** Denominator for the contract-value ratio; large so the ratio divides cleanly. */
export const RATIO_DENOMINATOR = 100_000;

/**
 * `averagePaymentDelayDays` that makes the payment factor score exactly `score`.
 * The delay curve is the only payment signal used, so the factor is that signal.
 */
export function paymentDelayForScore(score: number): number {
  const { delayBestAtDays, delayWorstAtDays } = paymentConfig;
  return delayWorstAtDays - (score / 100) * (delayWorstAtDays - delayBestAtDays);
}

/** `loginsLast30Days` that makes the engagement factor score exactly `score`. */
export function loginsForScore(score: number): number {
  const { loginsBestAt, loginsWorstAt } = engagementConfig;
  return loginsWorstAt + (score / 100) * (loginsBestAt - loginsWorstAt);
}

/**
 * `contractValue` (against {@link RATIO_DENOMINATOR}) that makes the contract
 * factor score exactly `score`. The ratio curve is the only contract signal used
 * because it is the only one that covers the whole `[0, 100]` range continuously
 * — the renewal curve has a floor of 30 for any live contract.
 */
export function contractValueForScore(score: number): number {
  const { contractRatioWorstAt, contractRatioFlatScore, contractRatioBestAt } = contractConfig;
  const flatRatio = 1;
  const ratio =
    score <= contractRatioFlatScore
      ? contractRatioWorstAt + (score / contractRatioFlatScore) * (flatRatio - contractRatioWorstAt)
      : flatRatio +
        ((score - contractRatioFlatScore) / (100 - contractRatioFlatScore)) *
          (contractRatioBestAt - flatRatio);
  return ratio * RATIO_DENOMINATOR;
}

/** `satisfactionScore` that makes the support factor score exactly `score`. */
export function satisfactionForScore(score: number): number {
  const { satisfactionMinimum, satisfactionMaximum } = supportConfig;
  return satisfactionMinimum + (score / 100) * (satisfactionMaximum - satisfactionMinimum);
}

/**
 * An input whose four factors each score `score`, so the weighted total is
 * `score` regardless of the weights. Every factor carries exactly one signal, so
 * confidence is `1` and no factor is excluded.
 */
export function inputAtScore(score: number): HealthScoreInput {
  return {
    payment: { averagePaymentDelayDays: paymentDelayForScore(score) },
    engagement: { loginsLast30Days: loginsForScore(score) },
    contract: {
      contractValue: contractValueForScore(score),
      previousContractValue: RATIO_DENOMINATOR
    },
    support: { satisfactionScore: satisfactionForScore(score) }
  };
}

/**
 * An input whose four factors score four *different* known values, for the
 * hand-computed 40/30/20/10 weighting assertion.
 */
export function inputAtFactorScores(scores: {
  payment: number;
  engagement: number;
  contract: number;
  support: number;
}): HealthScoreInput {
  return {
    payment: { averagePaymentDelayDays: paymentDelayForScore(scores.payment) },
    engagement: { loginsLast30Days: loginsForScore(scores.engagement) },
    contract: {
      contractValue: contractValueForScore(scores.contract),
      previousContractValue: RATIO_DENOMINATOR
    },
    support: { satisfactionScore: satisfactionForScore(scores.support) }
  };
}

/** A complete, plausible, healthy customer — confidence `1`, every signal present. */
export const completeInput: HealthScoreInput = {
  payment: { daysSinceLastPayment: 8, averagePaymentDelayDays: 1, overdueAmount: 0 },
  engagement: { loginsLast30Days: 18, featureUsageCount: 7, supportTicketsLast30Days: 2 },
  contract: {
    daysUntilRenewal: 140,
    contractValue: 48_000,
    previousContractValue: 42_000,
    recentUpgradeCount: 1,
    recentDowngradeCount: 0
  },
  support: { satisfactionScore: 5, averageResolutionTimeHours: 6, escalationCount: 0 },
  tenureDays: 620,
  billingCycleDays: 30
};

/** Payment signals only — confidence `0.4`, below the banding floor. */
export const paymentOnlyInput: HealthScoreInput = {
  payment: { daysSinceLastPayment: 10, averagePaymentDelayDays: 2, overdueAmount: 0 }
};

/** Payment + engagement — confidence `0.7`, so this one *is* banded. */
export const paymentAndEngagementInput: HealthScoreInput = {
  payment: { daysSinceLastPayment: 10, averagePaymentDelayDays: 2, overdueAmount: 0 },
  engagement: { loginsLast30Days: 12, featureUsageCount: 5, supportTicketsLast30Days: 2 }
};

/** The libel case: support-only, worst CSAT — totals `0` on 10% of the evidence. */
export const supportOnlyWorstCaseInput: HealthScoreInput = {
  support: { satisfactionScore: 1 }
};

/** Every factor object present but empty — indistinguishable from no data at all. */
export const emptyFactorObjectsInput: HealthScoreInput = {
  payment: {},
  engagement: {},
  contract: {},
  support: {}
};

/** Every signal explicitly `null`, which must be treated exactly like absent. */
export const allNullSignalsInput: HealthScoreInput = {
  payment: { daysSinceLastPayment: null, averagePaymentDelayDays: null, overdueAmount: null },
  engagement: { loginsLast30Days: null, featureUsageCount: null, supportTicketsLast30Days: null },
  contract: {
    daysUntilRenewal: null,
    contractValue: null,
    previousContractValue: null,
    recentUpgradeCount: null,
    recentDowngradeCount: null
  },
  support: { satisfactionScore: null, averageResolutionTimeHours: null, escalationCount: null },
  tenureDays: null,
  billingCycleDays: null
};

/** `null` signals interspersed with present ones inside the same factor. */
export const mixedNullSignalsInput: HealthScoreInput = {
  payment: { daysSinceLastPayment: null, averagePaymentDelayDays: 3, overdueAmount: null },
  engagement: { loginsLast30Days: 10, featureUsageCount: null, supportTicketsLast30Days: 2 },
  contract: { daysUntilRenewal: 90, previousContractValue: null },
  support: { satisfactionScore: 4, averageResolutionTimeHours: null, escalationCount: 0 }
};

/** Twelve days old with thin data — provisional by tenure, not by confidence. */
export const newCustomerInput: HealthScoreInput = {
  payment: { averagePaymentDelayDays: 0 },
  engagement: { loginsLast30Days: 11, featureUsageCount: 5 },
  contract: { daysUntilRenewal: 353, recentUpgradeCount: 0 },
  support: { satisfactionScore: 4 },
  tenureDays: 5
};

/** The same payment behaviour, scored monthly and annually. */
export const annualPayment: PaymentHistory = {
  daysSinceLastPayment: 210,
  averagePaymentDelayDays: 0,
  overdueAmount: 0
};

/** Extreme magnitudes, all legitimate, all expected to clamp rather than throw. */
export const extremeMagnitudeInput: HealthScoreInput = {
  payment: { overdueAmount: 1e9, averagePaymentDelayDays: 1e6, daysSinceLastPayment: 1e6 },
  engagement: { loginsLast30Days: 100_000, featureUsageCount: 100_000, supportTicketsLast30Days: 1e6 },
  contract: {
    daysUntilRenewal: 1e6,
    contractValue: 1e9,
    previousContractValue: 1,
    recentUpgradeCount: 1e6,
    recentDowngradeCount: 1e6
  },
  support: { satisfactionScore: 5, averageResolutionTimeHours: 1e6, escalationCount: 1e6 }
};

/**
 * Structurally invalid inputs. Typed as `unknown` because the whole point is
 * that they violate `HealthScoreInput`; the test casts at the call site.
 */
export const invalidShapeCases: ReadonlyArray<{
  label: string;
  input: unknown;
  field: string;
}> = [
  { label: 'null input', input: null, field: 'input' },
  { label: 'undefined input', input: undefined, field: 'input' },
  { label: 'array input', input: [], field: 'input' },
  { label: 'number input', input: 42, field: 'input' },
  { label: 'string input', input: 'hello', field: 'input' },
  { label: 'payment as a number', input: { payment: 42 }, field: 'payment' },
  { label: 'payment as a string', input: { payment: 'hello' }, field: 'payment' },
  { label: 'payment as an array', input: { payment: [] }, field: 'payment' },
  { label: 'engagement as an array', input: { engagement: [] }, field: 'engagement' },
  { label: 'contract as a string', input: { contract: 'nope' }, field: 'contract' },
  { label: 'support as a number', input: { support: 1 }, field: 'support' },
  { label: 'previous as a number', input: { previous: 5 }, field: 'previous' }
];

/** Invalid numeric values, each naming the dotted path the error must report. */
export const invalidNumericCases: ReadonlyArray<{
  label: string;
  input: unknown;
  field: string;
}> = [
  { label: 'NaN tenure', input: { tenureDays: Number.NaN }, field: 'tenureDays' },
  { label: 'Infinite tenure', input: { tenureDays: Number.POSITIVE_INFINITY }, field: 'tenureDays' },
  { label: 'negative tenure', input: { tenureDays: -1 }, field: 'tenureDays' },
  { label: 'zero billing cycle', input: { billingCycleDays: 0 }, field: 'billingCycleDays' },
  { label: 'negative billing cycle', input: { billingCycleDays: -30 }, field: 'billingCycleDays' },
  {
    label: 'string billing cycle',
    input: { billingCycleDays: '30' },
    field: 'billingCycleDays'
  },
  {
    label: 'negative overdue amount',
    input: { payment: { overdueAmount: -1 } },
    field: 'payment.overdueAmount'
  },
  {
    label: 'NaN overdue amount',
    input: { payment: { overdueAmount: Number.NaN } },
    field: 'payment.overdueAmount'
  },
  {
    label: 'string overdue amount',
    input: { payment: { overdueAmount: '500' } },
    field: 'payment.overdueAmount'
  },
  {
    label: 'negative days since last payment',
    input: { payment: { daysSinceLastPayment: -3 } },
    field: 'payment.daysSinceLastPayment'
  },
  {
    label: '-Infinity average payment delay',
    input: { payment: { averagePaymentDelayDays: Number.NEGATIVE_INFINITY } },
    field: 'payment.averagePaymentDelayDays'
  },
  {
    label: 'negative logins',
    input: { engagement: { loginsLast30Days: -1 } },
    field: 'engagement.loginsLast30Days'
  },
  {
    label: 'NaN feature usage',
    input: { engagement: { featureUsageCount: Number.NaN } },
    field: 'engagement.featureUsageCount'
  },
  {
    label: 'boolean ticket count',
    input: { engagement: { supportTicketsLast30Days: true } },
    field: 'engagement.supportTicketsLast30Days'
  },
  {
    label: 'NaN days until renewal',
    input: { contract: { daysUntilRenewal: Number.NaN } },
    field: 'contract.daysUntilRenewal'
  },
  {
    label: 'negative contract value',
    input: { contract: { contractValue: -1 } },
    field: 'contract.contractValue'
  },
  {
    label: 'negative previous contract value',
    input: { contract: { previousContractValue: -1 } },
    field: 'contract.previousContractValue'
  },
  {
    label: 'negative upgrade count',
    input: { contract: { recentUpgradeCount: -1 } },
    field: 'contract.recentUpgradeCount'
  },
  {
    label: 'negative downgrade count',
    input: { contract: { recentDowngradeCount: -1 } },
    field: 'contract.recentDowngradeCount'
  },
  {
    label: 'satisfaction below the scale',
    input: { support: { satisfactionScore: 0 } },
    field: 'support.satisfactionScore'
  },
  {
    label: 'satisfaction above the scale',
    input: { support: { satisfactionScore: 6 } },
    field: 'support.satisfactionScore'
  },
  {
    label: 'string satisfaction',
    input: { support: { satisfactionScore: '5' } },
    field: 'support.satisfactionScore'
  },
  {
    label: 'negative resolution time',
    input: { support: { averageResolutionTimeHours: -1 } },
    field: 'support.averageResolutionTimeHours'
  },
  {
    label: 'Infinite escalation count',
    input: { support: { escalationCount: Number.POSITIVE_INFINITY } },
    field: 'support.escalationCount'
  },
  { label: 'NaN previous score', input: { previous: { score: Number.NaN } }, field: 'previous.score' },
  { label: 'previous score above 100', input: { previous: { score: 200 } }, field: 'previous.score' },
  { label: 'previous score below 0', input: { previous: { score: -1 } }, field: 'previous.score' },
  {
    label: 'string previous score',
    input: { previous: { score: '80' } },
    field: 'previous.score'
  }
];
