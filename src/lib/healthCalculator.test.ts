import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CRITICAL_MAX,
  DEFAULT_BILLING_CYCLE_DAYS,
  FACTOR_WEIGHTS,
  FACTOR_WEIGHT_PERCENTAGES,
  HEALTH_SCORE_CONFIG,
  HEALTH_SCORE_MAXIMUM,
  HEALTH_SCORE_MINIMUM,
  HealthScoreValidationError,
  MIN_BANDING_CONFIDENCE,
  PROVISIONAL_TENURE_DAYS,
  TREND_DEAD_BAND,
  WARNING_MAX,
  calculateContractScore,
  calculateEngagementScore,
  calculateHealthScore,
  calculatePaymentScore,
  calculateSupportScore,
  clampScore,
  getRiskLevel,
  normalizeHealthScore,
  normalizeLinear,
  scoreContractMomentumCurve,
  scoreContractValueRatioCurve,
  scoreRenewalCurve,
  scoreSatisfactionCurve,
  scoreTicketVolumeCurve,
} from './healthCalculator';
import type { FactorScore, HealthScoreInput, RiskLevel } from './healthCalculator';
import {
  RATIO_DENOMINATOR,
  allNullSignalsInput,
  annualPayment,
  completeInput,
  contractValueForScore,
  emptyFactorObjectsInput,
  extremeMagnitudeInput,
  inputAtFactorScores,
  inputAtScore,
  invalidNumericCases,
  invalidShapeCases,
  mixedNullSignalsInput,
  newCustomerInput,
  paymentAndEngagementInput,
  paymentOnlyInput,
  supportOnlyWorstCaseInput,
} from './__fixtures__/health-score-fixtures';
import { mockHealthInputs } from '@/data/mock-health-inputs';
import { mockCustomers } from '@/data/mock-customers';

const paymentConfig = HEALTH_SCORE_CONFIG.payment;
const engagementConfig = HEALTH_SCORE_CONFIG.engagement;
const contractConfig = HEALTH_SCORE_CONFIG.contract;
const supportConfig = HEALTH_SCORE_CONFIG.support;

/** Casts a deliberately malformed fixture at the call boundary, without `any`. */
function asInput(value: unknown): HealthScoreInput {
  return value as HealthScoreInput;
}

/** Every score a curve can be asked for must land inside the display range. */
function expectInRange(value: number): void {
  expect(value).toBeGreaterThanOrEqual(HEALTH_SCORE_MINIMUM);
  expect(value).toBeLessThanOrEqual(HEALTH_SCORE_MAXIMUM);
}

describe('configuration', () => {
  it('declares the 40/30/20/10 weighting as exact integer percentages', () => {
    expect(FACTOR_WEIGHT_PERCENTAGES).toEqual({
      payment: 40,
      engagement: 30,
      contract: 20,
      support: 10,
    });
  });

  it('sums the percentages to exactly 100 — the exact-arithmetic surface', () => {
    const percentageTotal =
      FACTOR_WEIGHT_PERCENTAGES.payment +
      FACTOR_WEIGHT_PERCENTAGES.engagement +
      FACTOR_WEIGHT_PERCENTAGES.contract +
      FACTOR_WEIGHT_PERCENTAGES.support;

    expect(percentageTotal).toBe(100);
  });

  it('cannot sum the derived fractional weights to exactly 1 in IEEE-754', () => {
    // Documented, deliberate: 0.4 + 0.3 + 0.2 + 0.1 === 0.9999999999999999.
    // This is why FACTOR_WEIGHT_PERCENTAGES exists, and why the spec's
    // "FACTOR_WEIGHTS sum to exactly 1" criterion is unsatisfiable as literally
    // written. The drift is immaterial: the calculator divides by the sum of the
    // participating weights, so it cancels.
    const weightTotal =
      FACTOR_WEIGHTS.payment +
      FACTOR_WEIGHTS.engagement +
      FACTOR_WEIGHTS.contract +
      FACTOR_WEIGHTS.support;

    expect(weightTotal).not.toBe(1);
    expect(0.4 + 0.3 + 0.2 + 0.1).toBe(0.9999999999999999);
    expect(Math.abs(weightTotal - 1)).toBeLessThanOrEqual(Number.EPSILON);
  });

  it('derives each fractional weight from its percentage', () => {
    expect(FACTOR_WEIGHTS.payment).toBe(FACTOR_WEIGHT_PERCENTAGES.payment / 100);
    expect(FACTOR_WEIGHTS.engagement).toBe(FACTOR_WEIGHT_PERCENTAGES.engagement / 100);
    expect(FACTOR_WEIGHTS.contract).toBe(FACTOR_WEIGHT_PERCENTAGES.contract / 100);
    expect(FACTOR_WEIGHTS.support).toBe(FACTOR_WEIGHT_PERCENTAGES.support / 100);
  });

  it('freezes the tuning surface so calibration cannot drift at runtime', () => {
    expect(Object.isFrozen(FACTOR_WEIGHTS)).toBe(true);
    expect(Object.isFrozen(FACTOR_WEIGHT_PERCENTAGES)).toBe(true);
    expect(Object.isFrozen(HEALTH_SCORE_CONFIG)).toBe(true);
    expect(Object.isFrozen(HEALTH_SCORE_CONFIG.payment)).toBe(true);
  });

  it('normalizes every factor sub-weight block to 1', () => {
    for (const subWeights of [
      paymentConfig.subWeights,
      engagementConfig.subWeights,
      contractConfig.subWeights,
      supportConfig.subWeights,
    ]) {
      const total = Object.values(subWeights).reduce((sum, weight) => sum + weight, 0);
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it('pins the named thresholds the rest of the dashboard imports', () => {
    expect(CRITICAL_MAX).toBe(30);
    expect(WARNING_MAX).toBe(70);
    expect(MIN_BANDING_CONFIDENCE).toBe(0.5);
    expect(PROVISIONAL_TENURE_DAYS).toBe(30);
    expect(TREND_DEAD_BAND).toBe(3);
    expect(DEFAULT_BILLING_CYCLE_DAYS).toBe(30);
    expect(paymentConfig.overdueFallbackCeiling).toBe(10_000);
  });
});

describe('clampScore', () => {
  it.each([
    [-10, 0],
    [-0.1, 0],
    [0, 0],
    [50.5, 50.5],
    [100, 100],
    [100.1, 100],
    [150, 100],
    [1e9, 100],
    [-1e9, 0],
  ])('clamps %p to %p', (input, expected) => {
    expect(clampScore(input)).toBe(expected);
  });
});

describe('normalizeLinear', () => {
  it('ramps upward when bestAt is above worstAt', () => {
    expect(normalizeLinear(0, 20, 0)).toBe(0);
    expect(normalizeLinear(10, 20, 0)).toBe(50);
    expect(normalizeLinear(20, 20, 0)).toBe(100);
    expect(normalizeLinear(200, 20, 0)).toBe(100);
    expect(normalizeLinear(-5, 20, 0)).toBe(0);
  });

  it('ramps downward when bestAt is below worstAt', () => {
    expect(normalizeLinear(0, 0, 30)).toBe(100);
    expect(normalizeLinear(15, 0, 30)).toBe(50);
    expect(normalizeLinear(30, 0, 30)).toBe(0);
    expect(normalizeLinear(300, 0, 30)).toBe(0);
    expect(normalizeLinear(-5, 0, 30)).toBe(100);
  });

  it('treats equal endpoints as a step at that point', () => {
    expect(normalizeLinear(5, 10, 10)).toBe(100);
    expect(normalizeLinear(10, 10, 10)).toBe(100);
    expect(normalizeLinear(11, 10, 10)).toBe(0);
  });
});

describe('curve: support ticket volume (non-monotonic by design)', () => {
  it.each([
    [0, engagementConfig.ticketsSilenceScore],
    [1, 100],
    [3, 100],
    [15, 0],
    [40, 0],
  ])('scores %p tickets as %p', (tickets, expected) => {
    expect(scoreTicketVolumeCurve(tickets)).toBe(expected);
  });

  it('reads any count below one ticket as silence, not as light contact', () => {
    // Documented edge case: counts are integers in practice, but a fractional
    // average below 1 must land on the silence score rather than the 1-3 plateau.
    expect(scoreTicketVolumeCurve(0.4)).toBe(engagementConfig.ticketsSilenceScore);
    expect(scoreTicketVolumeCurve(0.999)).toBe(engagementConfig.ticketsSilenceScore);
    expect(scoreTicketVolumeCurve(1)).toBe(100);
  });

  it('is non-monotonic: silence scores below light contact', () => {
    expect(scoreTicketVolumeCurve(0)).toBeLessThan(scoreTicketVolumeCurve(2));
    expect(scoreTicketVolumeCurve(2)).toBeGreaterThan(scoreTicketVolumeCurve(9));
  });

  it('decays linearly through the midpoint of the distress segment', () => {
    expect(scoreTicketVolumeCurve(9)).toBe(50);
  });

  it('stays in range for every plausible count', () => {
    for (const tickets of [0, 0.5, 1, 3, 4, 9, 15, 40, 1e6]) {
      expectInRange(scoreTicketVolumeCurve(tickets));
    }
  });
});

describe('curve: renewal proximity (four segments)', () => {
  it.each([
    [-10, 0],
    [-1, 0],
    [0, contractConfig.renewalDayScore],
    [15, 45],
    [30, contractConfig.renewalNearHorizonScore],
    [75, 80],
    [120, 100],
    [400, 100],
  ])('scores %p days until renewal as %p', (days, expected) => {
    expect(scoreRenewalCurve(days)).toBeCloseTo(expected, 10);
  });

  it('treats a lapsed contract as the worst case without throwing', () => {
    expect(scoreRenewalCurve(-10)).toBe(HEALTH_SCORE_MINIMUM);
  });

  it('stays in range across the whole domain', () => {
    for (const days of [-1e6, -1, 0, 1, 29, 30, 31, 119, 120, 1e6]) {
      expectInRange(scoreRenewalCurve(days));
    }
  });
});

describe('curve: contract value ratio', () => {
  it.each([
    [0, 0],
    [0.25, 0],
    [contractConfig.contractRatioWorstAt, 0],
    [0.75, 40],
    [1, contractConfig.contractRatioFlatScore],
    [1.05, 90],
    [contractConfig.contractRatioBestAt, 100],
    [5, 100],
  ])('scores a ratio of %p as %p', (ratio, expected) => {
    expect(scoreContractValueRatioCurve(ratio)).toBeCloseTo(expected, 10);
  });

  it('stays in range across the whole domain', () => {
    for (const ratio of [-1, 0, 0.5, 0.9, 1, 1.1, 1e6]) {
      expectInRange(scoreContractValueRatioCurve(ratio));
    }
  });
});

describe('curve: contract momentum (step function)', () => {
  it.each([
    [0, 0, contractConfig.momentumBaseScore],
    [1, 0, contractConfig.momentumUpgradeScore],
    [5, 0, contractConfig.momentumUpgradeScore],
    [0, 1, contractConfig.momentumBaseScore - contractConfig.momentumDowngradePenalty],
    [0, 2, 0],
    [0, 10, 0],
    [2, 1, contractConfig.momentumUpgradeScore - contractConfig.momentumDowngradePenalty],
    [1, 3, 0],
  ])('scores %p upgrades and %p downgrades as %p', (upgrades, downgrades, expected) => {
    expect(scoreContractMomentumCurve(upgrades, downgrades)).toBe(expected);
  });

  it('clamps rather than going negative on many downgrades', () => {
    expectInRange(scoreContractMomentumCurve(0, 1e6));
  });
});

describe('curve: CSAT rescale', () => {
  it.each([
    [1, 0],
    [2, 25],
    [3, 50],
    [4, 75],
    [5, 100],
  ])('rescales CSAT %p to %p', (csat, expected) => {
    expect(scoreSatisfactionCurve(csat)).toBeCloseTo(expected, 10);
  });

  it('clamps values outside the scale, which validation rejects before this point', () => {
    expect(scoreSatisfactionCurve(0)).toBe(0);
    expect(scoreSatisfactionCurve(10)).toBe(100);
  });
});

describe('normalizeHealthScore', () => {
  it.each([
    [null, null],
    [undefined, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [Number.NEGATIVE_INFINITY, null],
    [-10, 0],
    [0, 0],
    [30.4, 30],
    [30.5, 31],
    [70.4, 70],
    [70.5, 71],
    [100, 100],
    [150, 100],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeHealthScore(input)).toBe(expected);
  });
});

describe('getRiskLevel', () => {
  it.each<[number | null | undefined, RiskLevel]>([
    [0, 'critical'],
    [CRITICAL_MAX, 'critical'],
    [30.4, 'critical'],
    [30.5, 'warning'],
    [31, 'warning'],
    [70, 'warning'],
    [70.4, 'warning'],
    [70.5, 'healthy'],
    [71, 'healthy'],
    [100, 'healthy'],
    [-5, 'critical'],
    [-10, 'critical'],
    [150, 'healthy'],
    [Number.NaN, 'unknown'],
    [Number.POSITIVE_INFINITY, 'unknown'],
    [Number.NEGATIVE_INFINITY, 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ])('bands %p as %s', (input, expected) => {
    expect(getRiskLevel(input)).toBe(expected);
  });

  it('is total: no input in the fixture list returns undefined', () => {
    const inputs: Array<number | null | undefined> = [
      0, 30, 30.4, 30.5, 31, 70, 70.4, 70.5, 71, 100, -5, 150, Number.NaN,
      Number.POSITIVE_INFINITY, null, undefined,
    ];

    for (const input of inputs) {
      expect(getRiskLevel(input)).toBeDefined();
      expect(['healthy', 'warning', 'critical', 'unknown']).toContain(getRiskLevel(input));
    }
  });

  it('leaves no fractional gap between the critical and warning bands', () => {
    for (let score = 0; score <= 100; score += 0.1) {
      expect(getRiskLevel(score)).not.toBe('unknown');
    }
  });
});

describe('calculatePaymentScore', () => {
  it('scores a perfect payer 100', () => {
    const factor = calculatePaymentScore({
      averagePaymentDelayDays: paymentConfig.delayBestAtDays,
      daysSinceLastPayment: 0,
      overdueAmount: 0,
    });

    expect(factor.score).toBe(100);
    expect(factor.weight).toBe(FACTOR_WEIGHTS.payment);
    expect(factor.signalsUsed).toHaveLength(3);
    expect(factor.signalsMissing).toEqual([]);
  });

  it('scores the worst payer 0', () => {
    const factor = calculatePaymentScore({
      averagePaymentDelayDays: paymentConfig.delayWorstAtDays,
      daysSinceLastPayment: paymentConfig.recencyWorstAtCycles * DEFAULT_BILLING_CYCLE_DAYS,
      overdueAmount: paymentConfig.overdueFallbackCeiling,
    });

    expect(factor.score).toBe(0);
  });

  it('scores the midpoint of every payment curve at 50', () => {
    const factor = calculatePaymentScore({
      averagePaymentDelayDays: 15,
      daysSinceLastPayment: 75,
      overdueAmount: paymentConfig.overdueFallbackCeiling / 2,
    });

    expect(factor.score).toBe(50);
  });

  it('clamps beyond both ends rather than leaving the range', () => {
    const beyondWorst = calculatePaymentScore({
      averagePaymentDelayDays: 1e6,
      daysSinceLastPayment: 1e6,
      overdueAmount: 1e9,
    });
    expect(beyondWorst.score).toBe(0);

    const beyondBest = calculatePaymentScore({
      averagePaymentDelayDays: 0,
      daysSinceLastPayment: 0,
      overdueAmount: 0,
    });
    expect(beyondBest.score).toBe(100);
  });

  it('re-normalizes sub-weights over the present signals only', () => {
    // delay (0.4) at 100 and overdue (0.3) at 0 → (100*0.4)/(0.7) = 57.142...
    const factor = calculatePaymentScore({
      averagePaymentDelayDays: 0,
      overdueAmount: paymentConfig.overdueFallbackCeiling,
    });

    expect(factor.score).toBe(57.1);
    expect(factor.signalsUsed).toEqual(['averagePaymentDelayDays', 'overdueAmount']);
    expect(factor.signalsMissing).toEqual(['daysSinceLastPayment']);
  });

  it('returns a null score with zero effective weight when the factor is absent', () => {
    for (const factor of [calculatePaymentScore(undefined), calculatePaymentScore({})]) {
      expect(factor.score).toBeNull();
      expect(factor.effectiveWeight).toBe(0);
      expect(factor.signalsUsed).toEqual([]);
      expect(factor.signalsMissing).toHaveLength(3);
    }
  });

  it('falls back to the flat overdue ceiling without a context', () => {
    const factor = calculatePaymentScore({
      overdueAmount: paymentConfig.overdueFallbackCeiling / 2,
    });
    expect(factor.score).toBe(50);
  });

  it('scales overdue severity to contract value when a context supplies one', () => {
    // 25% of a 40,000 contract is 10,000; half of that is the midpoint.
    const factor = calculatePaymentScore({ overdueAmount: 5_000 }, { contractValue: 40_000 });
    expect(factor.score).toBe(50);
  });

  it('scales the recency curve by the billing cycle', () => {
    const monthly = calculatePaymentScore(annualPayment, { billingCycleDays: 30 });
    const annual = calculatePaymentScore(annualPayment, { billingCycleDays: 365 });

    expect(monthly.score).toBeLessThan(annual.score ?? 0);
    expect(annual.score).toBe(100);
  });
});

describe('calculateEngagementScore', () => {
  it('scores a fully engaged customer 100', () => {
    expect(
      calculateEngagementScore({
        loginsLast30Days: engagementConfig.loginsBestAt,
        featureUsageCount: engagementConfig.featureUsageBestAt,
        supportTicketsLast30Days: 2,
      }).score
    ).toBe(100);
  });

  it('scores a disengaged, distressed customer 0', () => {
    expect(
      calculateEngagementScore({
        loginsLast30Days: 0,
        featureUsageCount: 0,
        supportTicketsLast30Days: engagementConfig.ticketsWorstAt,
      }).score
    ).toBe(0);
  });

  it('scores the midpoint of every engagement curve at 50', () => {
    expect(
      calculateEngagementScore({
        loginsLast30Days: engagementConfig.loginsBestAt / 2,
        featureUsageCount: engagementConfig.featureUsageBestAt / 2,
        supportTicketsLast30Days: 9,
      }).score
    ).toBe(50);
  });

  it('clamps past the best end', () => {
    expect(
      calculateEngagementScore({ loginsLast30Days: 100_000, featureUsageCount: 100_000 }).score
    ).toBe(100);
  });

  it('treats zero across every signal as a legitimate score, not missing data', () => {
    const factor = calculateEngagementScore({
      loginsLast30Days: 0,
      featureUsageCount: 0,
      supportTicketsLast30Days: 0,
    });

    expect(factor.score).not.toBeNull();
    expect(factor.signalsMissing).toEqual([]);
    // Silence still scores 70 on the ticket curve: 0.2 * 70 = 14.
    expect(factor.score).toBe(14);
  });
});

describe('calculateContractScore', () => {
  it('scores the best contract posture 100', () => {
    expect(
      calculateContractScore({
        daysUntilRenewal: contractConfig.renewalFarHorizonDays,
        contractValue: RATIO_DENOMINATOR * contractConfig.contractRatioBestAt,
        previousContractValue: RATIO_DENOMINATOR,
        recentUpgradeCount: 1,
        recentDowngradeCount: 0,
      }).score
    ).toBe(100);
  });

  it('scores the worst contract posture 0', () => {
    expect(
      calculateContractScore({
        daysUntilRenewal: -10,
        contractValue: RATIO_DENOMINATOR * contractConfig.contractRatioWorstAt,
        previousContractValue: RATIO_DENOMINATOR,
        recentUpgradeCount: 0,
        recentDowngradeCount: 2,
      }).score
    ).toBe(0);
  });

  it('scores a midpoint contract 50 on renewal and trajectory', () => {
    expect(
      calculateContractScore({
        daysUntilRenewal: 20,
        contractValue: contractValueForScore(50),
        previousContractValue: RATIO_DENOMINATOR,
      }).score
    ).toBe(50);
  });

  it('treats contractMomentum as present when either count is present', () => {
    const upgradesOnly = calculateContractScore({ recentUpgradeCount: 2 });
    const downgradesOnly = calculateContractScore({ recentDowngradeCount: 1 });
    const both = calculateContractScore({ recentUpgradeCount: 1, recentDowngradeCount: 1 });

    expect(upgradesOnly.signalsUsed).toContain('contractMomentum');
    expect(downgradesOnly.signalsUsed).toContain('contractMomentum');
    expect(both.signalsUsed).toContain('contractMomentum');

    expect(upgradesOnly.score).toBe(contractConfig.momentumUpgradeScore);
    expect(downgradesOnly.score).toBe(
      contractConfig.momentumBaseScore - contractConfig.momentumDowngradePenalty
    );
    expect(both.score).toBe(
      contractConfig.momentumUpgradeScore - contractConfig.momentumDowngradePenalty
    );
  });

  it('treats contractMomentum as missing only when both counts are absent', () => {
    const neither = calculateContractScore({ daysUntilRenewal: 90 });
    expect(neither.signalsMissing).toContain('contractMomentum');
    expect(neither.signalsUsed).toEqual(['daysUntilRenewal']);
  });

  it('drops contractValueRatio when previousContractValue is missing', () => {
    const factor = calculateContractScore({ daysUntilRenewal: 90, contractValue: 50_000 });
    expect(factor.signalsMissing).toContain('contractValueRatio');
  });

  it('treats a previousContractValue of 0 as a missing signal, not a division by zero', () => {
    // Documented edge case: a zero denominator would yield Infinity, so the
    // ratio signal is dropped and the sub-weights re-normalize instead.
    const factor = calculateContractScore({
      daysUntilRenewal: 90,
      contractValue: 50_000,
      previousContractValue: 0,
    });

    expect(factor.signalsMissing).toContain('contractValueRatio');
    expect(factor.score).toBe(Math.round(scoreRenewalCurve(90) * 10) / 10);
    expect(Number.isFinite(factor.score ?? Number.NaN)).toBe(true);
  });

  it('scores a lapsed contract without throwing', () => {
    const factor = calculateContractScore({ daysUntilRenewal: -10 });
    expect(factor.score).toBe(0);
  });
});

describe('calculateSupportScore', () => {
  it('scores the best support experience 100', () => {
    expect(
      calculateSupportScore({
        satisfactionScore: supportConfig.satisfactionMaximum,
        averageResolutionTimeHours: supportConfig.resolutionBestAtHours,
        escalationCount: supportConfig.escalationBestAt,
      }).score
    ).toBe(100);
  });

  it('scores the worst support experience 0', () => {
    expect(
      calculateSupportScore({
        satisfactionScore: supportConfig.satisfactionMinimum,
        averageResolutionTimeHours: supportConfig.resolutionWorstAtHours,
        escalationCount: supportConfig.escalationWorstAt,
      }).score
    ).toBe(0);
  });

  it('scores the midpoint of every support curve at 50', () => {
    expect(
      calculateSupportScore({
        satisfactionScore: 3,
        averageResolutionTimeHours: 38,
        escalationCount: 2.5,
      }).score
    ).toBe(50);
  });

  it('clamps past the worst end', () => {
    expect(
      calculateSupportScore({
        averageResolutionTimeHours: 1e6,
        escalationCount: 1e6,
      }).score
    ).toBe(0);
  });
});

describe('calculateHealthScore: the atScore property', () => {
  it.each([0, 30, 31, 70, 71, 100])(
    'totals exactly %p when every factor scores %p',
    (score) => {
      const result = calculateHealthScore(inputAtScore(score));

      expect(result.score).toBe(score);
      expect(result.confidence).toBe(1);
      for (const factor of Object.values(result.breakdown)) {
        expect(factor.score).toBeCloseTo(score, 1);
      }
    }
  );

  it.each<[number, RiskLevel]>([
    [0, 'critical'],
    [30, 'critical'],
    [31, 'warning'],
    [70, 'warning'],
    [71, 'healthy'],
    [100, 'healthy'],
  ])('bands a total of %p as %s', (score, expected) => {
    expect(calculateHealthScore(inputAtScore(score)).riskLevel).toBe(expected);
  });

  it('rounds a 30.4 total down to 30 and bands it Critical', () => {
    const result = calculateHealthScore(inputAtScore(30.4));
    expect(result.score).toBe(30);
    expect(result.riskLevel).toBe('critical');
    expect(getRiskLevel(result.score)).toBe(result.riskLevel);
  });

  it('rounds a 70.5 total up to 71 and bands it Healthy', () => {
    const result = calculateHealthScore(inputAtScore(70.5));
    expect(result.score).toBe(71);
    expect(result.riskLevel).toBe('healthy');
    expect(getRiskLevel(result.score)).toBe(result.riskLevel);
  });

  it('always returns an integer score in range', () => {
    for (const score of [0, 7.3, 30.4, 49.9, 70.5, 99.6, 100]) {
      const result = calculateHealthScore(inputAtScore(score));
      expect(Number.isInteger(result.score)).toBe(true);
      expectInRange(result.score ?? Number.NaN);
    }
  });
});

describe('calculateHealthScore: weighting', () => {
  it('applies 40/30/20/10 to a hand-computed total', () => {
    // 0.4*100 + 0.3*80 + 0.2*60 + 0.1*40 = 40 + 24 + 12 + 4 = 80
    const result = calculateHealthScore(
      inputAtFactorScores({ payment: 100, engagement: 80, contract: 60, support: 40 })
    );

    expect(result.score).toBe(80);
    expect(result.confidence).toBe(1);
  });

  it('gives payment four times the marginal pull of support', () => {
    const baseline = calculateHealthScore(
      inputAtFactorScores({ payment: 0, engagement: 50, contract: 50, support: 0 })
    );
    const paymentHigh = calculateHealthScore(
      inputAtFactorScores({ payment: 100, engagement: 50, contract: 50, support: 0 })
    );
    const supportHigh = calculateHealthScore(
      inputAtFactorScores({ payment: 0, engagement: 50, contract: 50, support: 100 })
    );

    const paymentGain = (paymentHigh.score ?? 0) - (baseline.score ?? 0);
    const supportGain = (supportHigh.score ?? 0) - (baseline.score ?? 0);

    expect(paymentGain).toBe(40);
    expect(supportGain).toBe(10);
    expect(paymentGain).toBe(supportGain * 4);
  });

  it('sums effective weights to 1 whenever at least one factor is present', () => {
    const inputs: HealthScoreInput[] = [
      completeInput,
      paymentOnlyInput,
      paymentAndEngagementInput,
      supportOnlyWorstCaseInput,
      mixedNullSignalsInput,
      newCustomerInput,
    ];

    for (const input of inputs) {
      const result = calculateHealthScore(input);
      const total = Object.values(result.breakdown).reduce(
        (sum: number, factor: FactorScore) => sum + factor.effectiveWeight,
        0
      );
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it('re-normalizes the remaining factor weights when one factor is missing', () => {
    // Support absent: (0.4*100 + 0.3*80 + 0.2*60) / 0.9 = 76/0.9 = 84.44 → 84
    const withSupport = inputAtFactorScores({
      payment: 100,
      engagement: 80,
      contract: 60,
      support: 40,
    });
    const withoutSupport: HealthScoreInput = { ...withSupport, support: undefined };

    const result = calculateHealthScore(withoutSupport);

    expect(result.score).toBe(84);
    expect(result.confidence).toBe(0.9);
    expect(result.breakdown.support.score).toBeNull();
    expect(result.breakdown.support.effectiveWeight).toBe(0);
    expect(result.breakdown.payment.effectiveWeight).toBeCloseTo(0.4 / 0.9, 10);
    expect(result.breakdown.engagement.effectiveWeight).toBeCloseTo(0.3 / 0.9, 10);
    expect(result.breakdown.contract.effectiveWeight).toBeCloseTo(0.2 / 0.9, 10);
  });

  it('keeps nominal weights untouched while re-normalizing effective ones', () => {
    const result = calculateHealthScore(paymentAndEngagementInput);

    expect(result.breakdown.payment.weight).toBe(FACTOR_WEIGHTS.payment);
    expect(result.breakdown.support.weight).toBe(FACTOR_WEIGHTS.support);
    expect(result.breakdown.payment.effectiveWeight).toBeCloseTo(0.4 / 0.7, 10);
    expect(result.breakdown.engagement.effectiveWeight).toBeCloseTo(0.3 / 0.7, 10);
  });

  it('rounds every factor score to at most one decimal place', () => {
    for (const input of [completeInput, mixedNullSignalsInput, paymentAndEngagementInput]) {
      for (const factor of Object.values(calculateHealthScore(input).breakdown)) {
        if (factor.score !== null) {
          expect(factor.score).toBe(Math.round(factor.score * 10) / 10);
        }
      }
    }
  });
});

describe('calculateHealthScore: missing data and confidence', () => {
  it('reports confidence 0.4 for payment-only data', () => {
    expect(calculateHealthScore(paymentOnlyInput).confidence).toBe(0.4);
  });

  it('reports confidence 1 for complete data', () => {
    expect(calculateHealthScore(completeInput).confidence).toBe(1);
  });

  it.each<[string, HealthScoreInput, number]>([
    ['payment only', { payment: { averagePaymentDelayDays: 1 } }, 0.4],
    ['engagement only', { engagement: { loginsLast30Days: 10 } }, 0.3],
    ['contract only', { contract: { daysUntilRenewal: 90 } }, 0.2],
    ['support only', { support: { satisfactionScore: 4 } }, 0.1],
  ])('reports confidence %s → %p', (_label, input, expected) => {
    expect(calculateHealthScore(input).confidence).toBe(expected);
  });

  it.each<[string, HealthScoreInput]>([
    ['no factors at all', {}],
    ['empty factor objects', emptyFactorObjectsInput],
    ['every signal null', allNullSignalsInput],
  ])('returns a null score rather than 0 with %s', (_label, input) => {
    const result = calculateHealthScore(input);

    expect(result.score).toBeNull();
    expect(result.score).not.toBe(0);
    expect(result.riskLevel).toBe('unknown');
    expect(result.confidence).toBe(0);
    for (const factor of Object.values(result.breakdown)) {
      expect(factor.score).toBeNull();
      expect(factor.effectiveWeight).toBe(0);
    }
  });

  it('treats a null signal exactly like an absent one', () => {
    const withNulls = calculateHealthScore({
      payment: { averagePaymentDelayDays: 3, daysSinceLastPayment: null, overdueAmount: null },
    });
    const withAbsent = calculateHealthScore({ payment: { averagePaymentDelayDays: 3 } });

    expect(withNulls).toEqual(withAbsent);
  });

  it('never throws for missing or null signals', () => {
    expect(() => calculateHealthScore(mixedNullSignalsInput)).not.toThrow();
    expect(() => calculateHealthScore(allNullSignalsInput)).not.toThrow();
    expect(() => calculateHealthScore({})).not.toThrow();
  });

  it('withholds the band below the confidence floor but still returns the score', () => {
    const result = calculateHealthScore(supportOnlyWorstCaseInput);

    expect(result.score).toBe(0);
    expect(result.riskLevel).toBe('unknown');
    expect(result.riskLevel).not.toBe('critical');
    expect(result.provisional).toBe(true);
    expect(result.confidence).toBe(0.1);
  });

  it('bands normally at or above the confidence floor', () => {
    const result = calculateHealthScore(paymentAndEngagementInput);

    expect(result.confidence).toBe(0.7);
    expect(result.confidence).toBeGreaterThanOrEqual(MIN_BANDING_CONFIDENCE);
    expect(result.riskLevel).not.toBe('unknown');
    expect(result.riskLevel).toBe(getRiskLevel(result.score));
    expect(result.provisional).toBe(false);
  });

  it('does not band payment-only data, which sits below the floor', () => {
    const result = calculateHealthScore(paymentOnlyInput);

    expect(result.score).not.toBeNull();
    expect(result.riskLevel).toBe('unknown');
    expect(result.provisional).toBe(true);
  });

  it('ignores unknown extra properties rather than rejecting them', () => {
    const withExtras = asInput({
      ...completeInput,
      futureSignal: 'whatever',
      payment: { ...completeInput.payment, unknownField: 1 },
    });

    expect(() => calculateHealthScore(withExtras)).not.toThrow();
    expect(calculateHealthScore(withExtras).score).toBe(calculateHealthScore(completeInput).score);
  });

  it('handles extreme magnitudes by clamping, not by throwing', () => {
    const result = calculateHealthScore(extremeMagnitudeInput);

    expect(() => calculateHealthScore(extremeMagnitudeInput)).not.toThrow();
    expectInRange(result.score ?? Number.NaN);
  });
});

describe('calculateHealthScore: provisional tenure', () => {
  it('marks a customer under PROVISIONAL_TENURE_DAYS as provisional', () => {
    const result = calculateHealthScore(newCustomerInput);
    expect(result.provisional).toBe(true);
  });

  it('does not adjust the score for short tenure', () => {
    const withoutTenure: HealthScoreInput = { ...newCustomerInput, tenureDays: undefined };
    const withTenure: HealthScoreInput = { ...newCustomerInput, tenureDays: 5 };

    expect(calculateHealthScore(withTenure).score).toBe(calculateHealthScore(withoutTenure).score);
    expect(calculateHealthScore(withoutTenure).provisional).toBe(false);
  });

  it.each([
    [0, true],
    [5, true],
    [PROVISIONAL_TENURE_DAYS - 1, true],
    [PROVISIONAL_TENURE_DAYS, false],
    [PROVISIONAL_TENURE_DAYS + 1, false],
  ])('treats tenureDays %p as provisional=%p', (tenureDays, expected) => {
    const result = calculateHealthScore({ ...completeInput, tenureDays });
    expect(result.provisional).toBe(expected);
  });

  it('still bands a provisional new customer with enough data', () => {
    const result = calculateHealthScore({ ...completeInput, tenureDays: 5 });

    expect(result.provisional).toBe(true);
    expect(result.riskLevel).not.toBe('unknown');
  });

  it('never lets short tenure plus unknown payment recency produce Critical', () => {
    const result = calculateHealthScore({
      tenureDays: 5,
      payment: { daysSinceLastPayment: undefined },
      support: { satisfactionScore: 4 },
    });

    expect(result.riskLevel).not.toBe('critical');
    expect(result.riskLevel).toBe('unknown');
    expect(result.provisional).toBe(true);
  });
});

describe('calculateHealthScore: trend', () => {
  const baseInput = inputAtScore(50);

  it('omits trend when previous is absent', () => {
    expect(calculateHealthScore(baseInput).trend).toBeUndefined();
    expect('trend' in calculateHealthScore(baseInput)).toBe(false);
  });

  it('omits trend when the score is null', () => {
    const result = calculateHealthScore({ previous: { score: 60 } });

    expect(result.score).toBeNull();
    expect(result.trend).toBeUndefined();
  });

  it.each<[number, string]>([
    [48, 'stable'],
    [47, 'stable'],
    [46, 'improving'],
    [53, 'stable'],
    [54, 'declining'],
    [50, 'stable'],
  ])('reports previous %p as %s', (previousScore, expected) => {
    const result = calculateHealthScore({ ...baseInput, previous: { score: previousScore } });

    expect(result.score).toBe(50);
    expect(result.trend).toBe(expected);
  });

  it('treats a delta of exactly ±TREND_DEAD_BAND as stable', () => {
    const up = calculateHealthScore({ ...baseInput, previous: { score: 50 - TREND_DEAD_BAND } });
    const down = calculateHealthScore({ ...baseInput, previous: { score: 50 + TREND_DEAD_BAND } });

    expect(up.trend).toBe('stable');
    expect(down.trend).toBe('stable');
  });

  it('does not let the trend feed back into the score', () => {
    const withoutPrevious = calculateHealthScore(baseInput);
    const withPrevious = calculateHealthScore({ ...baseInput, previous: { score: 10 } });

    expect(withPrevious.score).toBe(withoutPrevious.score);
    expect(withPrevious.confidence).toBe(withoutPrevious.confidence);
  });
});

describe('calculateHealthScore: billing cycle and payment context', () => {
  it('does not penalise an annually billed customer for payment recency', () => {
    const monthly = calculateHealthScore({ payment: annualPayment, billingCycleDays: 30 });
    const annual = calculateHealthScore({ payment: annualPayment, billingCycleDays: 365 });

    expect(monthly.breakdown.payment.score).toBeLessThan(annual.breakdown.payment.score ?? 0);
    expect(annual.breakdown.payment.score).toBe(100);
    expect(monthly.breakdown.payment.score).toBe(70);
  });

  it('defaults an absent billing cycle to the monthly cadence', () => {
    const explicit = calculateHealthScore({
      payment: annualPayment,
      billingCycleDays: DEFAULT_BILLING_CYCLE_DAYS,
    });
    const implicit = calculateHealthScore({ payment: annualPayment });

    expect(implicit.breakdown.payment.score).toBe(explicit.breakdown.payment.score);
  });

  it('agrees with calculatePaymentScore when the same context is supplied', () => {
    const payment = { daysSinceLastPayment: 20, averagePaymentDelayDays: 4, overdueAmount: 3_000 };
    const contract = { contractValue: 40_000 };

    const orchestrated = calculateHealthScore({ payment, contract, billingCycleDays: 30 });
    const standalone = calculatePaymentScore(payment, {
      contractValue: contract.contractValue,
      billingCycleDays: 30,
    });

    expect(standalone.score).toBe(orchestrated.breakdown.payment.score);
  });

  it('documents that a contextless standalone call may differ from the orchestrated one', () => {
    const payment = { overdueAmount: 5_000 };
    const contract = { contractValue: 40_000 };

    const contextless = calculatePaymentScore(payment);
    const orchestrated = calculateHealthScore({ payment, contract });

    // Contextless ceiling is the flat 10,000 fallback → 50.
    // Orchestrated ceiling is 25% of 40,000 = 10,000 → also 50 here, so use a
    // contract value where the two genuinely diverge.
    expect(contextless.score).toBe(50);
    expect(orchestrated.breakdown.payment.score).toBe(50);

    const largeContract = calculateHealthScore({ payment, contract: { contractValue: 200_000 } });
    expect(largeContract.breakdown.payment.score).toBe(90);
    expect(largeContract.breakdown.payment.score).not.toBe(contextless.score);
  });

  it('falls back to the flat overdue ceiling when contractValue is 0', () => {
    // Documented edge case: 0 is not a usable denominator, so the fallback
    // ceiling of 10,000 applies exactly as if contractValue were absent.
    const withZero = calculateHealthScore({
      payment: { overdueAmount: 5_000 },
      contract: { contractValue: 0 },
    });
    const withAbsent = calculateHealthScore({ payment: { overdueAmount: 5_000 } });

    expect(withZero.breakdown.payment.score).toBe(50);
    expect(withZero.breakdown.payment.score).toBe(withAbsent.breakdown.payment.score);
  });
});

describe('calculateHealthScore: validation', () => {
  it.each(invalidShapeCases)('rejects $label with field $field', ({ input, field }) => {
    expect(() => calculateHealthScore(asInput(input))).toThrow(HealthScoreValidationError);

    try {
      calculateHealthScore(asInput(input));
      expect.unreachable('expected a HealthScoreValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(HealthScoreValidationError);
      expect((error as HealthScoreValidationError).name).toBe('HealthScoreValidationError');
      expect((error as HealthScoreValidationError).field).toBe(field);
      expect((error as HealthScoreValidationError).message).toContain(field);
    }
  });

  it.each(invalidNumericCases)('rejects $label with field $field', ({ input, field }) => {
    try {
      calculateHealthScore(asInput(input));
      expect.unreachable('expected a HealthScoreValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(HealthScoreValidationError);
      expect((error as HealthScoreValidationError).field).toBe(field);
      expect((error as HealthScoreValidationError).message).toContain(field);
    }
  });

  it('never echoes a monetary amount in the error message', () => {
    const monetaryInputs: unknown[] = [
      { payment: { overdueAmount: -123_456 } },
      { contract: { contractValue: -987_654 } },
      { contract: { previousContractValue: -42_424 } },
    ];

    for (const input of monetaryInputs) {
      try {
        calculateHealthScore(asInput(input));
        expect.unreachable('expected a HealthScoreValidationError');
      } catch (error) {
        const message = (error as HealthScoreValidationError).message;
        expect(message).not.toMatch(/123456|123,456|987654|987,654|42424|42,424/);
        expect(message).not.toMatch(/\d{4,}/);
      }
    }
  });

  it('accepts a negative daysUntilRenewal as a legitimate lapsed contract', () => {
    expect(() => calculateHealthScore({ contract: { daysUntilRenewal: -10 } })).not.toThrow();
    expect(calculateHealthScore({ contract: { daysUntilRenewal: -10 } }).breakdown.contract.score).toBe(0);
  });

  it('accepts the CSAT scale boundaries', () => {
    expect(() => calculateHealthScore({ support: { satisfactionScore: 1 } })).not.toThrow();
    expect(() => calculateHealthScore({ support: { satisfactionScore: 5 } })).not.toThrow();
  });

  it('accepts a fractional but in-range CSAT', () => {
    expect(calculateHealthScore({ support: { satisfactionScore: 4.5 } }).breakdown.support.score).toBe(87.5);
  });

  it('accepts previous.score at both ends of the range', () => {
    expect(() =>
      calculateHealthScore({ ...completeInput, previous: { score: 0 } })
    ).not.toThrow();
    expect(() =>
      calculateHealthScore({ ...completeInput, previous: { score: 100 } })
    ).not.toThrow();
  });

  it('treats a null factor object as absent rather than invalid', () => {
    expect(() => calculateHealthScore(asInput({ payment: null }))).not.toThrow();
  });

  it('is an Error subclass carrying the field path', () => {
    const error = new HealthScoreValidationError('payment.overdueAmount', 'must not be negative');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HealthScoreValidationError');
    expect(error.field).toBe('payment.overdueAmount');
  });

  it('fails fast on the first invalid field', () => {
    try {
      calculateHealthScore(
        asInput({ tenureDays: -1, payment: { overdueAmount: -1 }, support: { satisfactionScore: 9 } })
      );
      expect.unreachable('expected a HealthScoreValidationError');
    } catch (error) {
      expect((error as HealthScoreValidationError).field).toBe('tenureDays');
    }
  });
});

describe('calculateHealthScore: purity and determinism', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns deep-equal results for two calls on the same object', () => {
    const first = calculateHealthScore(completeInput);
    const second = calculateHealthScore(completeInput);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('does not mutate the input', () => {
    const input = structuredClone(completeInput);
    const before = structuredClone(input);

    calculateHealthScore(input);

    expect(input).toEqual(before);
  });

  it('does not mutate a factor object passed to a factor function', () => {
    const payment = { daysSinceLastPayment: 8, averagePaymentDelayDays: 1, overdueAmount: 0 };
    const before = structuredClone(payment);

    calculatePaymentScore(payment, { contractValue: 40_000, billingCycleDays: 30 });

    expect(payment).toEqual(before);
  });

  it('reads no clock and no randomness', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const randomSpy = vi.spyOn(Math, 'random');

    calculateHealthScore(completeInput);
    calculateHealthScore(inputAtScore(42));
    calculateHealthScore(supportOnlyWorstCaseInput);

    expect(nowSpy).not.toHaveBeenCalled();
    expect(randomSpy).not.toHaveBeenCalled();
  });

  it('is stable across many repeated calls', () => {
    const expected = JSON.stringify(calculateHealthScore(completeInput));

    for (let iteration = 0; iteration < 50; iteration += 1) {
      expect(JSON.stringify(calculateHealthScore(completeInput))).toBe(expected);
    }
  });

  it('returns a fresh breakdown per call, so callers cannot corrupt each other', () => {
    const first = calculateHealthScore(completeInput);
    first.breakdown.payment.effectiveWeight = 99;

    expect(calculateHealthScore(completeInput).breakdown.payment.effectiveWeight).not.toBe(99);
  });
});

describe('module hygiene', () => {
  it('imports nothing from React, Next.js, or src/components', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./healthCalculator.ts', import.meta.url)),
      'utf8'
    );
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*(import|export)\s.*\sfrom\s/.test(line));

    expect(importLines).toEqual([]);
    expect(source).not.toMatch(/from\s+['"](react|next|@\/components)/);
  });

  it('has no default export', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./healthCalculator.ts', import.meta.url)),
      'utf8'
    );

    expect(source).not.toMatch(/^export default/m);
  });
});

describe('mock health inputs', () => {
  it('has an entry for every mock customer id', () => {
    for (const customer of mockCustomers) {
      expect(mockHealthInputs[customer.id]).toBeDefined();
    }
  });

  it('produces a result for every entry without throwing', () => {
    for (const [customerId, input] of Object.entries(mockHealthInputs)) {
      const result = calculateHealthScore(input);

      expect(result, `customer ${customerId}`).toBeDefined();
      if (result.score !== null) {
        expectInRange(result.score);
      }
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('resolves an unknown customer id to no input at all, not a crash', () => {
    const missing = mockHealthInputs['does-not-exist'];

    expect(missing).toBeUndefined();
    expect(calculateHealthScore(missing ?? {}).score).toBeNull();
  });
});
