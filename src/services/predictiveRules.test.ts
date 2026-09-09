import { describe, expect, it } from 'vitest';

import type { CustomerSignals, DailySignals } from '@/lib/alerts';
import { DEFAULT_THRESHOLDS, mergeThresholds } from '@/server/alertThresholds';
import type { MarketSignal } from '@/types/predictive-intelligence';

import {
  MAX_PRIORITY_SCORE,
  MIN_PRIORITY_SCORE,
  applyCaps,
  compareRankedAlerts,
  computePredictivePriorityScore,
  evaluateEngagementDeclineTrend,
  evaluateMarketSentimentRisk,
  type PredictiveRuleInput,
} from './predictiveRules';

const AS_OF = '2026-09-09';
const NOW_MS = Date.parse('2026-09-09T10:00:00Z');

/** `YYYY-MM-DD` for a day `ageInDays` before `AS_OF`. */
function dateBefore(ageInDays: number): string {
  const date = new Date(`${AS_OF}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ageInDays);
  return date.toISOString().slice(0, 10);
}

/**
 * Builds a daily history where each of the three ten-day buckets carries a fixed
 * number of logins per day.
 */
function buildHistory(loginsPerDayByBucket: [number, number, number], days = 30): DailySignals[] {
  const history: DailySignals[] = [];

  for (let age = days - 1; age >= 0; age -= 1) {
    const bucket = Math.min(2, Math.floor(age / 10));
    history.push({
      date: dateBefore(age),
      logins: loginsPerDayByBucket[bucket] ?? 0,
      featuresUsed: [],
      supportTicketsOpened: 0,
      supportTicketsEscalated: 0,
      csatResponses: [],
      resolutionHours: [],
    });
  }

  return history;
}

function buildSignals(history: DailySignals[]): CustomerSignals {
  return {
    customerId: '1',
    payment: {
      lastPaymentDate: dateBefore(10),
      averagePaymentDelayDays: 0,
      overdueAmount: 0,
      overdueSince: null,
    },
    contract: {
      renewalDate: '2027-01-01',
      annualRecurringRevenue: 50_000,
      lastUpgradeDate: null,
    },
    history,
  };
}

function buildInput(overrides: Partial<PredictiveRuleInput> = {}): PredictiveRuleInput {
  return {
    customerId: '1',
    healthScore: 45,
    // buckets are oldest -> newest, so index 2 is the oldest ten days.
    signals: buildSignals(buildHistory([1, 2, 3])),
    market: null,
    thresholds: DEFAULT_THRESHOLDS,
    asOf: AS_OF,
    ...overrides,
  };
}

function marketSignal(overrides: Partial<MarketSignal> = {}): MarketSignal {
  return {
    score: -0.8,
    label: 'negative',
    confidence: 0.7,
    articleCount: 6,
    lastUpdated: '2026-09-09T09:00:00Z',
    ...overrides,
  };
}

describe('evaluateEngagementDeclineTrend', () => {
  it('fires on three strictly decreasing buckets past the drop floor', () => {
    // 3/day oldest, 2/day middle, 1/day newest => 30, 20, 10 logins: a 66% drop.
    const outcome = evaluateEngagementDeclineTrend(
      buildInput({ signals: buildSignals(buildHistory([1, 2, 3])) })
    );

    expect(outcome.fired?.ruleId).toBe('engagement-decline-trend');
    expect(outcome.fired?.priority).toBe('medium');
    expect(outcome.fired?.triggeredClause).toBe('loginTrend');
  });

  it('does not fire when the buckets are flat', () => {
    const outcome = evaluateEngagementDeclineTrend(
      buildInput({ signals: buildSignals(buildHistory([3, 3, 3])) })
    );

    expect(outcome.fired).toBeNull();
    expect(outcome.skipped).toHaveLength(0);
  });

  it('does not fire when the decline is not strictly monotonic', () => {
    // 30 oldest, 10 middle, 20 newest: a net drop, but not a steady slide.
    const outcome = evaluateEngagementDeclineTrend(
      buildInput({ signals: buildSignals(buildHistory([2, 1, 3])) })
    );

    expect(outcome.fired).toBeNull();
  });

  it('does not fire when the total drop is below the ratio floor', () => {
    // 30 -> 29 -> 28 is decreasing but only a 7% decline.
    const history = buildHistory([0, 0, 0]);
    history.forEach((day, index) => {
      const age = history.length - 1 - index;
      const bucket = Math.min(2, Math.floor(age / 10));
      day.logins = [28, 29, 30][bucket] ?? 0;
    });

    expect(evaluateEngagementDeclineTrend(buildInput({ signals: buildSignals(history) })).fired).toBeNull();
  });

  it('skips rather than fires when the baseline bucket is below the low-volume floor', () => {
    // 3 logins in the oldest bucket: below the absolute floor of 4, whatever the
    // percentage drop looks like.
    const history = buildHistory([0, 0, 0]);
    history[0]!.logins = 3;
    history[10]!.logins = 2;
    history[20]!.logins = 0;

    const outcome = evaluateEngagementDeclineTrend(buildInput({ signals: buildSignals(history) }));
    expect(outcome.fired).toBeNull();
    expect(outcome.skipped[0]?.clause).toBe('buckets');
  });

  it('fires at exactly the low-volume floor of 4 baseline logins', () => {
    const history = buildHistory([0, 0, 0]);
    history[0]!.logins = 4; // oldest bucket
    history[10]!.logins = 2;
    history[20]!.logins = 1; // newest bucket

    const outcome = evaluateEngagementDeclineTrend(buildInput({ signals: buildSignals(history) }));
    expect(outcome.fired).not.toBeNull();
  });

  it('skips when there is not enough history to fill three buckets', () => {
    const outcome = evaluateEngagementDeclineTrend(
      buildInput({ signals: buildSignals(buildHistory([1, 2, 3], 12)) })
    );

    expect(outcome.fired).toBeNull();
    expect(outcome.skipped[0]?.reason).toContain('needs 30 days');
  });

  it('honours a threshold override', () => {
    const relaxed = mergeThresholds({ engagementTrend: { minTotalDropRatio: 0.9 } });
    const outcome = evaluateEngagementDeclineTrend(
      buildInput({ signals: buildSignals(buildHistory([1, 2, 3])), thresholds: relaxed })
    );

    expect(outcome.fired).toBeNull();
  });
});

describe('evaluateMarketSentimentRisk', () => {
  it('fires on negative sentiment above the confidence floor with health below the ceiling', () => {
    const outcome = evaluateMarketSentimentRisk(
      buildInput({ market: marketSignal(), healthScore: 45 })
    );

    expect(outcome.fired?.ruleId).toBe('market-sentiment-risk');
    expect(outcome.fired?.priority).toBe('medium');
    expect(outcome.fired?.severity).toBeCloseTo(0.56);
  });

  it('does not fire below the confidence floor', () => {
    expect(
      evaluateMarketSentimentRisk(buildInput({ market: marketSignal({ confidence: 0.59 }) })).fired
    ).toBeNull();
  });

  it('fires exactly at the confidence floor', () => {
    expect(
      evaluateMarketSentimentRisk(buildInput({ market: marketSignal({ confidence: 0.6 }) })).fired
    ).not.toBeNull();
  });

  it('does not fire for positive or neutral sentiment', () => {
    expect(
      evaluateMarketSentimentRisk(buildInput({ market: marketSignal({ label: 'positive' }) })).fired
    ).toBeNull();
    expect(
      evaluateMarketSentimentRisk(buildInput({ market: marketSignal({ label: 'neutral' }) })).fired
    ).toBeNull();
  });

  it('does not fire at or above the health ceiling', () => {
    expect(
      evaluateMarketSentimentRisk(buildInput({ market: marketSignal(), healthScore: 70 })).fired
    ).toBeNull();
    expect(
      evaluateMarketSentimentRisk(buildInput({ market: marketSignal(), healthScore: 69 })).fired
    ).not.toBeNull();
  });

  it('skips, rather than clearing, when market data is unavailable', () => {
    const outcome = evaluateMarketSentimentRisk(buildInput({ market: null }));

    expect(outcome.fired).toBeNull();
    expect(outcome.skipped[0]).toMatchObject({ clause: 'market' });
  });

  it('never puts an email address or an exact amount in its text', () => {
    const fired = evaluateMarketSentimentRisk(buildInput({ market: marketSignal() })).fired;
    const text = `${fired?.title} ${fired?.message} ${JSON.stringify(fired?.evidence)}`;

    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\$/);
  });
});

describe('computePredictivePriorityScore', () => {
  it('floors at 20 for a medium alert with nothing going for it', () => {
    const score = computePredictivePriorityScore({
      priority: 'medium',
      annualRecurringRevenue: 0,
      severity: 0,
      firstDetectedAt: new Date(NOW_MS - 8 * 24 * 3_600_000).toISOString(),
      now: NOW_MS,
    });

    expect(score).toBe(MIN_PRIORITY_SCORE);
  });

  it('tops out at 100 for a fresh, severe, high-value, high-priority alert', () => {
    const score = computePredictivePriorityScore({
      priority: 'high',
      annualRecurringRevenue: 500_000,
      severity: 1,
      firstDetectedAt: new Date(NOW_MS).toISOString(),
      now: NOW_MS,
    });

    expect(score).toBe(MAX_PRIORITY_SCORE);
  });

  it('always returns an integer inside the stated range', () => {
    const score = computePredictivePriorityScore({
      priority: 'medium',
      annualRecurringRevenue: 33_333,
      severity: 0.37,
      firstDetectedAt: new Date(NOW_MS - 50 * 3_600_000).toISOString(),
      now: NOW_MS,
    });

    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(MIN_PRIORITY_SCORE);
    expect(score).toBeLessThanOrEqual(MAX_PRIORITY_SCORE);
  });

  it('decays with age, so an unchanged alert is not frozen at the top', () => {
    const fresh = computePredictivePriorityScore({
      priority: 'high',
      annualRecurringRevenue: 50_000,
      severity: 0.5,
      firstDetectedAt: new Date(NOW_MS).toISOString(),
      now: NOW_MS,
    });
    const threeDaysOld = computePredictivePriorityScore({
      priority: 'high',
      annualRecurringRevenue: 50_000,
      severity: 0.5,
      firstDetectedAt: new Date(NOW_MS - 72 * 3_600_000).toISOString(),
      now: NOW_MS,
    });

    expect(threeDaysOld).toBeLessThan(fresh);
  });
});

describe('compareRankedAlerts', () => {
  it('orders by score descending', () => {
    const ranked = [
      { customerId: '1', ruleId: 'payment-risk' as const, priorityScore: 40 },
      { customerId: '2', ruleId: 'payment-risk' as const, priorityScore: 90 },
    ].sort(compareRankedAlerts);

    expect(ranked[0]?.customerId).toBe('2');
  });

  it('breaks ties on rule id, then customer id, not on sort stability', () => {
    const alerts = [
      { customerId: '2', ruleId: 'payment-risk' as const, priorityScore: 50 },
      { customerId: '1', ruleId: 'payment-risk' as const, priorityScore: 50 },
      { customerId: '1', ruleId: 'engagement-cliff' as const, priorityScore: 50 },
    ];

    const forward = [...alerts].sort(compareRankedAlerts);
    const reversed = [...alerts].reverse().sort(compareRankedAlerts);

    expect(forward.map((alert) => `${alert.customerId}:${alert.ruleId}`)).toEqual([
      '1:engagement-cliff',
      '1:payment-risk',
      '2:payment-risk',
    ]);
    // Byte-identical ordering whatever the input order.
    expect(reversed).toEqual(forward);
  });
});

describe('applyCaps', () => {
  it('keeps the top three per customer and counts the rest', () => {
    const ranked = Array.from({ length: 5 }, (_, index) => ({
      customerId: '1',
      ruleId: 'payment-risk' as const,
      priorityScore: 90 - index,
    }));

    const { kept, suppressedByCap } = applyCaps(ranked, DEFAULT_THRESHOLDS.caps);
    expect(kept).toHaveLength(3);
    expect(kept.map((alert) => alert.priorityScore)).toEqual([90, 89, 88]);
    expect(suppressedByCap).toBe(2);
  });

  it('applies the global cap across a synthetic 200-customer set', () => {
    // Eight fixtures cannot reach the global cap (8 x 3 = 24 < 25), so it is
    // exercised against a set large enough to bind.
    const ranked = Array.from({ length: 200 }, (_, index) => ({
      customerId: String(index),
      ruleId: 'payment-risk' as const,
      priorityScore: 100 - (index % 50),
    }));

    const { kept, suppressedByCap } = applyCaps(ranked, DEFAULT_THRESHOLDS.caps);
    expect(kept).toHaveLength(DEFAULT_THRESHOLDS.caps.maxAlerts);
    expect(suppressedByCap).toBe(200 - DEFAULT_THRESHOLDS.caps.maxAlerts);
  });
});
