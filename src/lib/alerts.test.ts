import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALERT_RULE_IDS,
  AlertEvaluationError,
  DEFAULT_ALERT_RULE_CONFIG,
  MIN_HISTORY_DAYS_FOR_RULE,
  PRIORITY_WEIGHTS,
  RULE_PRIORITY,
  alertEngine,
  alertKey,
  alertTimestampFor,
  clampUnitInterval,
  computeRecencyWeight,
  computeUrgencyWeight,
  computeValueWeight,
  createMonitoringState,
  daysBetween,
  isWithinBusinessHours,
  validateAlertRuleConfig,
  validateCustomerSignals,
  validateMonitoringState,
  type Alert,
  type AlertRuleConfig,
  type AlertRuleId,
  type CustomerEvaluationInput,
  type CustomerSignals,
  type MonitoringState
} from './alerts';
import {
  FIXTURE_REFERENCE_DATE,
  adoptionStallBroadeningArm,
  adoptionStallFires,
  adoptionStallMinimumHistory,
  adoptionStallNotGrowing,
  adoptionStallOffByOne,
  adoptionStallShortHistory,
  alertFixtures,
  buildFixtureSignals,
  contractExpirationRunwayOffByOne,
  contractExpirationScoreOffByOne,
  contractExpirationUnscored,
  contractExpirationExpired,
  contractExpirationFires,
  engagementCliffFires,
  engagementCliffLowBaselineGuard,
  engagementCliffMinimumHistory,
  engagementCliffOffByOne,
  engagementCliffShortHistory,
  fixtureDate,
  fixtureHealth,
  paymentRiskFires,
  paymentRiskMissingScoreHistory,
  paymentRiskOffByOne,
  paymentRiskScoreDropFires,
  scoredHealthResult,
  supportSpikeEscalationArm,
  supportSpikeFires,
  supportSpikeOffByOne,
  type AlertFixture
} from '@/data/alerts-fixtures';

/* ==========================================================================
 * Harness
 *
 * Every evaluation is driven by an explicit `asOf`: the engine contains no
 * `Date.now()`, so the suite must never introduce one either. No test sleeps,
 * and no assertion depends on the wall clock or on the host timezone.
 * ========================================================================== */

/** The engine input one fixture stands for. */
function inputFor(fixture: AlertFixture, asOf: string = FIXTURE_REFERENCE_DATE): CustomerEvaluationInput {
  return {
    customer: { id: fixture.signals.customerId },
    signals: fixture.signals,
    health: fixtureHealth(fixture, asOf)
  };
}

/** A fresh state seeded with whatever score history the fixture pins. */
function stateFor(fixtures: readonly AlertFixture[]): MonitoringState {
  const scoreHistory: Record<string, Array<{ date: string; score: number }>> = {};

  for (const fixture of fixtures) {
    if (fixture.scoreHistory !== undefined) {
      scoreHistory[fixture.signals.customerId] = fixture.scoreHistory.map((snapshot) => ({ ...snapshot }));
    }
  }

  return createMonitoringState(scoreHistory);
}

/** Runs the engine over one fixture at `asOf`, from a state seeded for it. */
function evaluateFixture(
  fixture: AlertFixture,
  options: { asOf?: string; config?: AlertRuleConfig } = {}
): ReturnType<typeof alertEngine> {
  const asOf = options.asOf ?? FIXTURE_REFERENCE_DATE;
  return alertEngine([inputFor(fixture, asOf)], stateFor([fixture]), asOf, options.config);
}

function firedRuleIds(alerts: readonly Alert[]): AlertRuleId[] {
  return alerts.map((alert) => alert.ruleId).sort();
}

function skippedRuleIds(skipped: ReadonlyArray<{ ruleId: AlertRuleId }>): AlertRuleId[] {
  return skipped.map((entry) => entry.ruleId).sort();
}

function alertFor(result: ReturnType<typeof alertEngine>, ruleId: AlertRuleId): Alert {
  const alert = result.alerts.find((candidate) => candidate.ruleId === ruleId);

  if (alert === undefined) {
    throw new Error(`expected an open ${ruleId} alert, found ${firedRuleIds(result.alerts).join(', ') || 'none'}`);
  }

  return alert;
}

/* ==========================================================================
 * The whole fixture set, walked
 * ========================================================================== */

describe('alertEngine against the committed fixtures', () => {
  it.each(alertFixtures.map((fixture) => [fixture.name, fixture] as const))(
    'fires exactly the expected rules — %s',
    (_name, fixture) => {
      const result = evaluateFixture(fixture);

      expect(firedRuleIds(result.alerts)).toEqual([...fixture.expectedRules].sort());
    }
  );

  it.each(alertFixtures.map((fixture) => [fixture.name, fixture] as const))(
    'skips exactly the expected rules — %s',
    (_name, fixture) => {
      const result = evaluateFixture(fixture);

      expect(skippedRuleIds(result.skipped)).toEqual([...fixture.expectedSkipped].sort());
    }
  );

  it('never puts an email address, a dollar amount, or a customer name in alert text', () => {
    const inputs = alertFixtures.map((fixture) => inputFor(fixture));
    const result = alertEngine(inputs, stateFor(alertFixtures), FIXTURE_REFERENCE_DATE);

    expect(result.alerts.length).toBeGreaterThan(0);

    for (const alert of result.alerts) {
      const text = `${alert.title} ${alert.detail} ${alert.recommendedAction} ${(alert.notes ?? []).join(' ')}`;

      expect(text).not.toMatch(/@/);
      expect(text).not.toMatch(/\$/);
      // The overdue balance is $4,000 on the payment fixture; the amount must
      // not surface in any form.
      expect(text).not.toMatch(/4000|4,000/);
    }
  });

  it('reports how much history a skipped rule needed and how much it had', () => {
    const result = evaluateFixture(engagementCliffShortHistory);
    const skipped = result.skipped.find((entry) => entry.ruleId === 'engagement-cliff');

    expect(skipped).toMatchObject({
      customerId: 'fixture-cliff-36-days',
      requiredHistoryDays: MIN_HISTORY_DAYS_FOR_RULE['engagement-cliff'],
      availableHistoryDays: 36
    });
    expect(skipped?.reason).toContain('needs 37 days');
  });
});

/* ==========================================================================
 * Rule boundaries, one threshold at a time
 * ========================================================================== */

describe('payment-risk', () => {
  it('fires on a balance outstanding 31 days', () => {
    const alert = alertFor(evaluateFixture(paymentRiskFires), 'payment-risk');

    expect(alert.priority).toBe('high');
    expect(alert.title).toContain('31 days');
  });

  it('does not fire at exactly the 30-day threshold', () => {
    expect(evaluateFixture(paymentRiskOffByOne).alerts).toHaveLength(0);
  });

  it('fires on a 21-point drop against a seeded 7-day-prior snapshot, with no arrears at all', () => {
    const alert = alertFor(evaluateFixture(paymentRiskScoreDropFires), 'payment-risk');

    expect(alert.title).toContain('21 points');
    expect(alert.detail).toContain('71');
    expect(alert.notes).toBeUndefined();
  });

  it('does not fire on a drop of exactly 20 points', () => {
    const result = alertEngine(
      [inputFor(paymentRiskScoreDropFires)],
      createMonitoringState({ 'fixture-score-drop': [{ date: fixtureDate(7), score: 70 }] }),
      FIXTURE_REFERENCE_DATE
    );

    expect(result.alerts).toHaveLength(0);
  });

  it('skips the drop arm and records a note when no snapshot sits in the 5-9 day window', () => {
    // The arrears arm carries the alert, so the note is observable. A 45-point
    // gap exists 20 days away and must not be read as either a drop or an
    // all-clear.
    const fixture: AlertFixture = {
      ...paymentRiskFires,
      scoreHistory: paymentRiskMissingScoreHistory.scoreHistory
    };
    const alert = alertFor(evaluateFixture(fixture), 'payment-risk');

    expect(alert.notes).toEqual([
      expect.stringContaining('7-day score comparison unavailable') as unknown as string
    ]);
    expect(alert.title).not.toContain('points');
  });

  it('treats a 45-point gap 20 days away as unavailable rather than as a drop', () => {
    expect(evaluateFixture(paymentRiskMissingScoreHistory).alerts).toHaveLength(0);
  });
});

describe('engagement-cliff', () => {
  it('fires when the trailing week collapses against the preceding 30 days', () => {
    const alert = alertFor(evaluateFixture(engagementCliffFires), 'engagement-cliff');

    expect(alert.priority).toBe('high');
    expect(alert.detail).toContain('logins/day');
  });

  it('does not fire at exactly 50% of the baseline', () => {
    const result = evaluateFixture(engagementCliffOffByOne);

    expect(result.alerts).toHaveLength(0);
  });

  it('does not fire on a 0.1 logins/day baseline, under the 0.15 floor', () => {
    expect(evaluateFixture(engagementCliffLowBaselineGuard).alerts).toHaveLength(0);
    expect(skippedRuleIds(evaluateFixture(engagementCliffLowBaselineGuard).skipped)).not.toContain('engagement-cliff');
  });

  it('is skipped at 36 days of history and evaluated at 37', () => {
    const short = evaluateFixture(engagementCliffShortHistory);
    const minimum = evaluateFixture(engagementCliffMinimumHistory);

    expect(skippedRuleIds(short.skipped)).toContain('engagement-cliff');
    expect(firedRuleIds(short.alerts)).not.toContain('engagement-cliff');

    expect(skippedRuleIds(minimum.skipped)).not.toContain('engagement-cliff');
    expect(firedRuleIds(minimum.alerts)).toContain('engagement-cliff');
  });
});

describe('contract-expiration-risk', () => {
  it('fires at 89 days of runway and a score of 49', () => {
    const alert = alertFor(evaluateFixture(contractExpirationFires), 'contract-expiration-risk');

    expect(alert.detail).toContain('89 days');
  });

  it('does not fire at 90 days of runway, nor at a score of exactly 50', () => {
    expect(evaluateFixture(contractExpirationRunwayOffByOne).alerts).toHaveLength(0);
    expect(evaluateFixture(contractExpirationScoreOffByOne).alerts).toHaveLength(0);
  });

  it('fires on an expired contract with urgencyWeight clamped to exactly 1.0', () => {
    const alert = alertFor(evaluateFixture(contractExpirationExpired), 'contract-expiration-risk');
    const urgencyWeight = computeUrgencyWeight(
      'contract-expiration-risk',
      contractExpirationExpired.signals,
      FIXTURE_REFERENCE_DATE,
      DEFAULT_ALERT_RULE_CONFIG
    );

    expect(daysBetween(FIXTURE_REFERENCE_DATE, contractExpirationExpired.signals.contract.renewalDate)).toBe(-30);
    expect(urgencyWeight).toBe(1);
    expect(alert.title).toContain('expired 30 days ago');
  });

  it('does not fire for an unscored customer, which cannot satisfy "score below 50"', () => {
    expect(evaluateFixture(contractExpirationUnscored).alerts).toHaveLength(0);
  });
});

describe('support-ticket-spike', () => {
  it('fires on 4 tickets in 7 days and not on exactly 3', () => {
    const alert = alertFor(evaluateFixture(supportSpikeFires), 'support-ticket-spike');

    expect(alert.priority).toBe('medium');
    expect(alert.title).toContain('4 tickets');
    expect(evaluateFixture(supportSpikeOffByOne).alerts).toHaveLength(0);
  });

  it('fires on a single escalation even with only one ticket', () => {
    const alert = alertFor(evaluateFixture(supportSpikeEscalationArm), 'support-ticket-spike');

    expect(alert.title).toContain('escalated');
  });
});

describe('feature-adoption-stall', () => {
  it('fires on a recently upgraded account with no new feature in 30 days', () => {
    const alert = alertFor(evaluateFixture(adoptionStallFires), 'feature-adoption-stall');

    expect(alert.priority).toBe('medium');
    expect(alert.detail).toContain('recent upgrade');
  });

  it('does not fire when exactly one new feature appears in the trailing 30 days', () => {
    expect(evaluateFixture(adoptionStallOffByOne).alerts).toHaveLength(0);
  });

  it('does not fire on an upgrade 181 days ago with flat adoption', () => {
    expect(evaluateFixture(adoptionStallNotGrowing).alerts).toHaveLength(0);
  });

  it('fires on broadening adoption with no upgrade on record', () => {
    const alert = alertFor(evaluateFixture(adoptionStallBroadeningArm), 'feature-adoption-stall');

    expect(alert.detail).toContain('broadening adoption');
  });

  it('is skipped at 89 days of history and evaluated at 90', () => {
    const short = evaluateFixture(adoptionStallShortHistory);
    const minimum = evaluateFixture(adoptionStallMinimumHistory);

    expect(skippedRuleIds(short.skipped)).toContain('feature-adoption-stall');
    expect(firedRuleIds(short.alerts)).not.toContain('feature-adoption-stall');

    expect(skippedRuleIds(minimum.skipped)).not.toContain('feature-adoption-stall');
    expect(firedRuleIds(minimum.alerts)).toContain('feature-adoption-stall');
  });
});

/* ==========================================================================
 * Priority scoring
 * ========================================================================== */

describe('priority weights', () => {
  it('sums the four component weights to exactly 100', () => {
    const total =
      PRIORITY_WEIGHTS.severity + PRIORITY_WEIGHTS.value + PRIORITY_WEIGHTS.urgency + PRIORITY_WEIGHTS.recency;

    expect(total).toBe(100);
  });

  it('clamps the value weight to 0..1 across the ARR range', () => {
    expect(computeValueWeight(500)).toBe(0);
    expect(computeValueWeight(1000)).toBe(0);
    expect(computeValueWeight(500000)).toBe(1);
    expect(computeValueWeight(1000000)).toBe(1);
    expect(computeValueWeight(22360)).toBeGreaterThan(0);
    expect(computeValueWeight(22360)).toBeLessThan(1);
  });

  it('rejects an ARR of 0 or -1 rather than taking log10 of it', () => {
    expect(() => computeValueWeight(0)).toThrow(AlertEvaluationError);
    expect(() => computeValueWeight(-1)).toThrow(AlertEvaluationError);
    expect(() => computeValueWeight(Number.NaN)).toThrow(AlertEvaluationError);
  });

  it('clamps every unit-interval weight and rejects a non-finite one', () => {
    expect(clampUnitInterval(-5)).toBe(0);
    expect(clampUnitInterval(5)).toBe(1);
    expect(clampUnitInterval(0.25)).toBe(0.25);
    expect(() => clampUnitInterval(Number.POSITIVE_INFINITY)).toThrow(AlertEvaluationError);
  });

  it('decays recency from 1 on the opening day to 0 after 14 days', () => {
    expect(computeRecencyWeight(alertTimestampFor(FIXTURE_REFERENCE_DATE), FIXTURE_REFERENCE_DATE)).toBe(1);
    expect(computeRecencyWeight(alertTimestampFor(fixtureDate(7)), FIXTURE_REFERENCE_DATE)).toBeCloseTo(0.5, 10);
    expect(computeRecencyWeight(alertTimestampFor(fixtureDate(14)), FIXTURE_REFERENCE_DATE)).toBe(0);
    expect(computeRecencyWeight(alertTimestampFor(fixtureDate(40)), FIXTURE_REFERENCE_DATE)).toBe(0);
  });

  it('keeps urgency inside 0..1 for every rule', () => {
    for (const ruleId of ALERT_RULE_IDS) {
      const weight = computeUrgencyWeight(
        ruleId,
        contractExpirationExpired.signals,
        FIXTURE_REFERENCE_DATE,
        DEFAULT_ALERT_RULE_CONFIG
      );

      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
  });

  it('never exceeds 100 or drops below 0 on any fixture alert', () => {
    const inputs = alertFixtures.map((fixture) => inputFor(fixture));
    const result = alertEngine(inputs, stateFor(alertFixtures), FIXTURE_REFERENCE_DATE);

    for (const alert of result.alerts) {
      expect(alert.priorityScore).toBeGreaterThanOrEqual(0);
      expect(alert.priorityScore).toBeLessThanOrEqual(100);
      expect(Number.isInteger(alert.priorityScore)).toBe(true);
    }
  });

  it('ranks every high alert above every medium alert regardless of ARR', () => {
    // A high alert on the smallest account in the portfolio against a medium
    // alert on an account 500 times its size.
    const smallHighRisk = buildFixtureSignals({
      customerId: 'small-account-high-alert',
      historyDays: 120,
      eras: [{ fromAgeDays: 0, toAgeDays: 120, loginsPerDay: 1, features: ['dashboard'] }],
      payment: { overdueAmount: 500, overdueSince: fixtureDate(60) },
      contract: { annualRecurringRevenue: 1000 }
    });
    const largeMediumRisk = buildFixtureSignals({
      customerId: 'large-account-medium-alert',
      historyDays: 120,
      eras: [
        {
          fromAgeDays: 0,
          toAgeDays: 7,
          loginsPerDay: 1,
          features: ['dashboard'],
          ticketsPerDay: 2,
          resolutionHours: 4
        },
        { fromAgeDays: 7, toAgeDays: 120, loginsPerDay: 1, features: ['dashboard'] }
      ],
      contract: { annualRecurringRevenue: 500000 }
    });

    const result = alertEngine(
      [
        { customer: { id: smallHighRisk.customerId }, signals: smallHighRisk, health: scoredHealthResult(60) },
        { customer: { id: largeMediumRisk.customerId }, signals: largeMediumRisk, health: scoredHealthResult(60) }
      ],
      createMonitoringState(),
      FIXTURE_REFERENCE_DATE
    );

    expect(result.alerts.map((alert) => alert.priority)).toEqual(['high', 'medium']);
    expect(result.alerts[0].customerId).toBe('small-account-high-alert');
    // The tie is the point. The $1k account's high alert and the $500k
    // account's medium alert both score 70, so `priorityScore` alone would not
    // separate them — the tier comparison in `sortAlerts` is what keeps the
    // critical small-account alert out from under the enterprise noise.
    expect(result.alerts[0].priorityScore).toBe(result.alerts[1].priorityScore);
    expect(result.alerts[0].priorityScore).toBeGreaterThanOrEqual(result.alerts[1].priorityScore);
  });

  it('assigns each rule the priority tier the spec names', () => {
    expect(RULE_PRIORITY).toEqual({
      'payment-risk': 'high',
      'engagement-cliff': 'high',
      'contract-expiration-risk': 'high',
      'support-ticket-spike': 'medium',
      'feature-adoption-stall': 'medium'
    });
  });
});

/* ==========================================================================
 * Business hours — a parameter, never the host's locale
 * ========================================================================== */

describe('isWithinBusinessHours', () => {
  // 2026-09-09 is a Wednesday; 2026-09-12 a Saturday; 2026-09-13 a Sunday.
  const cases: Array<[string, string, boolean]> = [
    ['2026-09-09T09:00:00.000Z', 'UTC', true],
    ['2026-09-09T08:59:00.000Z', 'UTC', false],
    ['2026-09-09T16:59:00.000Z', 'UTC', true],
    ['2026-09-09T17:00:00.000Z', 'UTC', false],
    ['2026-09-12T12:00:00.000Z', 'UTC', false],
    ['2026-09-13T12:00:00.000Z', 'UTC', false],
    ['2026-09-09T12:00:00.000Z', 'Asia/Tokyo', false],
    ['2026-09-09T01:00:00.000Z', 'Asia/Tokyo', true],
    ['2026-09-09T20:00:00.000Z', 'America/Los_Angeles', true],
    ['2026-09-09T12:00:00.000Z', 'America/Los_Angeles', false]
  ];

  it.each(cases)('evaluates %s in %s', (iso, timeZone, expected) => {
    expect(isWithinBusinessHours(iso, timeZone)).toBe(expected);
  });

  it('defaults to UTC rather than reading the host locale', () => {
    expect(isWithinBusinessHours('2026-09-09T12:00:00.000Z')).toBe(
      isWithinBusinessHours('2026-09-09T12:00:00.000Z', 'UTC')
    );
  });

  it('returns identical results under TZ=UTC, America/Los_Angeles and Asia/Tokyo', () => {
    const originalTimeZone = process.env.TZ;

    try {
      const resultsByHostZone = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'].map((hostZone) => {
        process.env.TZ = hostZone;
        return cases.map(([iso, timeZone]) => isWithinBusinessHours(iso, timeZone));
      });

      expect(resultsByHostZone[1]).toEqual(resultsByHostZone[0]);
      expect(resultsByHostZone[2]).toEqual(resultsByHostZone[0]);
      expect(resultsByHostZone[0]).toEqual(cases.map(([, , expected]) => expected));
    } finally {
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
    }
  });

  it('rejects an unparseable instant', () => {
    expect(() => isWithinBusinessHours('not-a-timestamp')).toThrow(AlertEvaluationError);
  });

  it('never suppresses an alert — it is metadata only', () => {
    // 2026-09-12 is a Saturday, so the flag is false while the alert still opens.
    const asOf = '2026-09-12';
    const signals = buildFixtureSignals({
      customerId: 'weekend-evaluation',
      historyDays: 120,
      eras: [{ fromAgeDays: 0, toAgeDays: 120, loginsPerDay: 1, features: ['dashboard'] }],
      payment: { overdueAmount: 4000, overdueSince: fixtureDate(60) }
    });
    const result = alertEngine(
      [{ customer: { id: signals.customerId }, signals, health: scoredHealthResult(60) }],
      createMonitoringState(),
      asOf
    );

    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].withinBusinessHours).toBe(false);
  });
});

/* ==========================================================================
 * Date arithmetic
 * ========================================================================== */

describe('daysBetween', () => {
  it('counts whole days across a month and a leap day', () => {
    expect(daysBetween('2026-09-09', '2026-09-09')).toBe(0);
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-09-10', '2026-09-09')).toBe(-1);
  });

  it('rejects a date that does not exist on the calendar', () => {
    expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow(AlertEvaluationError);
    expect(() => daysBetween('2026-13-01', '2026-03-01')).toThrow(AlertEvaluationError);
    expect(() => daysBetween('2026-00-01', '2026-03-01')).toThrow(AlertEvaluationError);
    expect(() => daysBetween('2026-09-00', '2026-03-01')).toThrow(AlertEvaluationError);
    expect(() => daysBetween('2026-9-9', '2026-03-01')).toThrow(AlertEvaluationError);
    expect(() => daysBetween('2023-02-29', '2026-03-01')).toThrow(AlertEvaluationError);
    expect(() => daysBetween('1900-02-29', '2026-03-01')).toThrow(AlertEvaluationError);
    expect(daysBetween('2000-02-29', '2000-03-01')).toBe(1);
  });
});

/* ==========================================================================
 * Validation — every invalid input names its field and leaks nothing
 * ========================================================================== */

describe('validation', () => {
  const validSignals = (): CustomerSignals =>
    buildFixtureSignals({
      customerId: 'validation-subject',
      historyDays: 10,
      eras: [{ fromAgeDays: 0, toAgeDays: 10, loginsPerDay: 1, features: ['dashboard'], csatEveryDays: 3 }]
    });

  /** Mutates a deep copy, so no case can affect another. */
  function withSignals(mutate: (signals: CustomerSignals) => void): CustomerSignals {
    const copy = JSON.parse(JSON.stringify(validSignals())) as CustomerSignals;
    mutate(copy);
    return copy;
  }

  it('accepts a well-formed fixture', () => {
    expect(() => validateCustomerSignals(validSignals())).not.toThrow();
  });

  const invalidSignalCases: Array<[string, () => CustomerSignals, string]> = [
    ['an empty customerId', () => withSignals((signals) => ((signals as { customerId: string }).customerId = '')), 'customerId'],
    [
      'NaN logins',
      () => withSignals((signals) => (signals.history[0].logins = Number.NaN)),
      'history[].logins'
    ],
    [
      'Infinite logins',
      () => withSignals((signals) => (signals.history[0].logins = Number.POSITIVE_INFINITY)),
      'history[].logins'
    ],
    [
      'a negative ticket count',
      () => withSignals((signals) => (signals.history[0].supportTicketsOpened = -1)),
      'history[].supportTicketsOpened'
    ],
    [
      'more escalations than tickets',
      () =>
        withSignals((signals) => {
          signals.history[0].supportTicketsOpened = 1;
          signals.history[0].supportTicketsEscalated = 2;
        }),
      'history[].supportTicketsEscalated'
    ],
    ['a CSAT of 0', () => withSignals((signals) => (signals.history[0].csatResponses = [0])), 'history[].csatResponses'],
    ['a CSAT of 6', () => withSignals((signals) => (signals.history[0].csatResponses = [6])), 'history[].csatResponses'],
    [
      'a negative resolution time',
      () => withSignals((signals) => (signals.history[0].resolutionHours = [-1])),
      'history[].resolutionHours'
    ],
    [
      'an ARR of 0',
      () => withSignals((signals) => (signals.contract.annualRecurringRevenue = 0)),
      'contract.annualRecurringRevenue'
    ],
    [
      'an ARR of -1',
      () => withSignals((signals) => (signals.contract.annualRecurringRevenue = -1)),
      'contract.annualRecurringRevenue'
    ],
    [
      'an outstanding balance with no overdueSince',
      () =>
        withSignals((signals) => {
          signals.payment.overdueAmount = 4000;
          signals.payment.overdueSince = null;
        }),
      'payment.overdueSince'
    ],
    [
      'an overdueSince with no balance',
      () => withSignals((signals) => (signals.payment.overdueSince = fixtureDate(5))),
      'payment.overdueSince'
    ],
    [
      'an unsorted history',
      () => withSignals((signals) => signals.history.reverse()),
      'history[].date'
    ],
    [
      'a duplicate history date',
      () => withSignals((signals) => (signals.history[1].date = signals.history[0].date)),
      'history[].date'
    ],
    [
      'a malformed history date',
      () => withSignals((signals) => (signals.history[0].date = '09/09/2026')),
      'history[].date'
    ],
    [
      'a non-finite payment delay',
      () => withSignals((signals) => (signals.payment.averagePaymentDelayDays = Number.NaN)),
      'payment.averagePaymentDelayDays'
    ],
    [
      'a negative overdue amount',
      () =>
        withSignals((signals) => {
          signals.payment.overdueAmount = -1;
          signals.payment.overdueSince = null;
        }),
      'payment.overdueAmount'
    ],
    [
      'a malformed renewal date',
      () => withSignals((signals) => (signals.contract.renewalDate = '2026-09')),
      'contract.renewalDate'
    ],
    [
      'a malformed lastUpgradeDate',
      () => withSignals((signals) => (signals.contract.lastUpgradeDate = 'yesterday')),
      'contract.lastUpgradeDate'
    ],
    [
      'featuresUsed that is not an array',
      () =>
        withSignals((signals) => {
          (signals.history[0] as { featuresUsed: unknown }).featuresUsed = 'dashboard';
        }),
      'history[].featuresUsed'
    ],
    [
      'a history that is not an array',
      () => withSignals((signals) => ((signals as { history: unknown }).history = {})),
      'history'
    ]
  ];

  it.each(invalidSignalCases)('throws AlertEvaluationError naming the field for %s', (_name, build, field) => {
    let thrown: unknown;

    try {
      validateCustomerSignals(build());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AlertEvaluationError);
    expect((thrown as AlertEvaluationError).field).toBe(field);
    expect((thrown as AlertEvaluationError).message).toContain(field);
  });

  it('leaks no name, email address, or dollar amount in any validation message', () => {
    for (const [, build] of invalidSignalCases) {
      let message = '';

      try {
        validateCustomerSignals(build());
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/@/);
      expect(message).not.toMatch(/\$/);
      expect(message).not.toMatch(/4000|4,000/);
      expect(message).not.toMatch(/validation-subject/);
    }
  });

  it('describes a rejected free-text string by its length rather than its content', () => {
    let message = '';

    try {
      validateCustomerSignals(
        withSignals((signals) => (signals.contract.lastUpgradeDate = 'secret@example.com'))
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('18-character string');
    expect(message).not.toContain('secret');
  });

  const invalidConfigCases: Array<[string, Partial<AlertRuleConfig>, string]> = [
    ['a non-finite threshold', { paymentOverdueDays: Number.NaN }, 'config.paymentOverdueDays'],
    ['a negative window', { ticketSpikeWindowDays: -1 }, 'config.ticketSpikeWindowDays'],
    ['an infinite drop threshold', { scoreDropPoints: Number.POSITIVE_INFINITY }, 'config.scoreDropPoints'],
    ['a ratio above 1', { engagementCliffRatio: 1.5 }, 'config.engagementCliffRatio'],
    ['a negative ratio', { minBaselineLoginsPerDay: -0.1 }, 'config.minBaselineLoginsPerDay'],
    ['a negative suppression window', { dismissalSuppressHours: -1 }, 'config.dismissalSuppressHours'],
    ['a negative high cooldown', { cooldownHours: { high: -1, medium: 168 } }, 'config.cooldownHours.high'],
    ['a NaN medium cooldown', { cooldownHours: { high: 72, medium: Number.NaN } }, 'config.cooldownHours.medium'],
    ['a negative expiry window', { contractExpiryDays: -90 }, 'config.contractExpiryDays'],
    ['a negative adoption window', { adoptionStallWindowDays: -30 }, 'config.adoptionStallWindowDays']
  ];

  it.each(invalidConfigCases)('rejects a config with %s', (_name, overrides, field) => {
    const config: AlertRuleConfig = { ...DEFAULT_ALERT_RULE_CONFIG, ...overrides };

    expect(() => validateAlertRuleConfig(config)).toThrowError(
      expect.objectContaining({ name: 'AlertEvaluationError', field }) as unknown as Error
    );
  });

  it('accepts the shipped defaults', () => {
    expect(() => validateAlertRuleConfig(DEFAULT_ALERT_RULE_CONFIG)).not.toThrow();
  });

  it('rejects a malformed MonitoringState', () => {
    const cases: Array<[MonitoringState, string]> = [
      [{ ...createMonitoringState(), open: null as unknown as Record<string, Alert> }, 'state.open'],
      [
        { ...createMonitoringState(), history: {} as unknown as MonitoringState['history'] },
        'state.history'
      ],
      [
        {
          ...createMonitoringState(),
          scoreHistory: { customer: {} as unknown as Array<{ date: string; score: number }> }
        },
        'state.scoreHistory'
      ],
      [
        {
          ...createMonitoringState({
            customer: [
              { date: fixtureDate(1), score: 50 },
              { date: fixtureDate(1), score: 60 }
            ]
          })
        },
        'state.scoreHistory[].date'
      ],
      [
        { ...createMonitoringState({ customer: [{ date: fixtureDate(1), score: Number.NaN }] }) },
        'state.scoreHistory[].score'
      ],
      [
        { ...createMonitoringState({ customer: [{ date: 'not-a-date', score: 50 }] }) },
        'state.scoreHistory[].date'
      ]
    ];

    for (const [state, field] of cases) {
      expect(() => validateMonitoringState(state)).toThrowError(
        expect.objectContaining({ name: 'AlertEvaluationError', field }) as unknown as Error
      );
    }
  });

  it('rejects an open entry whose key disagrees with its alert', () => {
    const alert: Alert = {
      id: 'customer-a:payment-risk:2026-09-09T12:00:00.000Z',
      ruleId: 'payment-risk',
      customerId: 'customer-a',
      priority: 'high',
      priorityScore: 80,
      title: 'Balance outstanding 47 days',
      detail: 'detail',
      recommendedAction: 'action',
      firstTriggeredAt: '2026-09-09T12:00:00.000Z',
      triggeredAt: '2026-09-09T12:00:00.000Z',
      withinBusinessHours: true
    };
    const state = createMonitoringState();
    state.open['customer-b:payment-risk'] = alert;

    expect(() => validateMonitoringState(state)).toThrowError(
      expect.objectContaining({ name: 'AlertEvaluationError', field: 'state.open' }) as unknown as Error
    );

    const consistent = createMonitoringState();
    consistent.open[alertKey(alert.customerId, alert.ruleId)] = alert;

    expect(() => validateMonitoringState(consistent)).not.toThrow();
  });

  it('rejects a malformed asOf from the engine itself', () => {
    expect(() => alertEngine([], createMonitoringState(), '2026-9-9')).toThrowError(
      expect.objectContaining({ name: 'AlertEvaluationError', field: 'asOf' }) as unknown as Error
    );
  });

  it('never throws the calculator’s error class from the alerts engine', () => {
    let thrown: unknown;

    try {
      alertEngine(
        [
          {
            customer: { id: 'validation-subject' },
            signals: withSignals((signals) => (signals.history[0].logins = Number.NaN)),
            health: scoredHealthResult(60)
          }
        ],
        createMonitoringState(),
        FIXTURE_REFERENCE_DATE
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AlertEvaluationError);
    expect((thrown as Error).name).toBe('AlertEvaluationError');
  });
});

/* ==========================================================================
 * Source-level guarantees
 *
 * Determinism and framework-freedom are properties of the *source*, not of any
 * one call, so they are asserted by reading the file. A behavioural test cannot
 * distinguish "no clock" from "a clock that happened not to matter this run".
 *
 * Scoped to the two monitoring modules. `src/lib/customer-search.ts` predates
 * this feature and takes a type-only import from `@/data/mock-customers`; it is
 * not in this spec's scope and is not policed here.
 * ========================================================================== */

describe('src/lib source hygiene', () => {
  const MONITORING_MODULES = ['alerts.ts', 'healthCalculator.ts'] as const;

  /** Source with comments stripped, so prose about `Date.now()` is not a hit. */
  function readExecutableSource(fileName: string): string {
    const path = fileURLToPath(new URL(fileName, import.meta.url));

    return readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  it.each(MONITORING_MODULES)('reads no ambient clock or randomness — %s', (fileName) => {
    const source = readExecutableSource(fileName);

    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/Math\.random/);
    // `new Date(instant)` is fine; `new Date()` reads the wall clock.
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });

  it.each(MONITORING_MODULES)('imports nothing from react, next, or src/data — %s', (fileName) => {
    const source = readExecutableSource(fileName);

    expect(source).not.toMatch(/from\s+['"]react['"]/);
    expect(source).not.toMatch(/from\s+['"]react-dom/);
    expect(source).not.toMatch(/from\s+['"]next\//);
    expect(source).not.toMatch(/from\s+['"]@\/data\//);
    expect(source).not.toMatch(/from\s+['"]\.\.\/data\//);
  });

  it.each(MONITORING_MODULES)('logs nothing, so no customer data can reach a console — %s', (fileName) => {
    expect(readExecutableSource(fileName)).not.toMatch(/console\./);
  });
});
