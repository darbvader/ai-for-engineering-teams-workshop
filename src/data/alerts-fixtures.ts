/**
 * Verification fixtures for the alerts engine.
 *
 * `mockCustomers` plus `mockCustomerSignals` are for the demo; these are for
 * *verification*. Each fixture states the rules it expects to fire and the rules
 * it expects to be skipped, so an implementation change that silently moves a
 * threshold is visible rather than merely plausible.
 *
 * They deliberately reuse the exported interfaces from `@/lib/alerts` rather than
 * restating the shapes, so a fixture cannot drift from the type it stands in for.
 *
 * Every rule gets three fixtures — one that fires it, one that misses each of its
 * thresholds by a single unit, and one that would fire but is held back by
 * cooldown or dismissal — plus the guard, short-history, and lifecycle cases the
 * rules' edges depend on.
 *
 * **This repository has no committed test runner for these fixtures to drive**
 * (see `SPEC_DEVIATIONS` at the foot of the file). They are consumable by a
 * plain Node script today and by a suite the day one is added.
 */

import {
  DEFAULT_ALERT_RULE_CONFIG,
  scoreCustomerAt,
  type AlertRuleId,
  type ContractSignals,
  type CustomerSignals,
  type DailySignals,
  type PaymentSignals
} from '@/lib/alerts';
import type { HealthScoreResult } from '@/lib/healthCalculator';

/** All fixture dates are counted back from here, matching the demo data. */
export const FIXTURE_REFERENCE_DATE = '2026-09-09';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The `YYYY-MM-DD` date `ageInDays` before `FIXTURE_REFERENCE_DATE`. */
export function fixtureDate(ageInDays: number): string {
  const reference = Date.parse(`${FIXTURE_REFERENCE_DATE}T00:00:00.000Z`);
  return new Date(reference - ageInDays * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

/** Per-day behaviour for a slice of a fixture's history. */
interface FixtureEra {
  /** Inclusive lower age bound in days. */
  fromAgeDays: number;
  /** Exclusive upper age bound in days. */
  toAgeDays: number;
  loginsPerDay?: number;
  features?: readonly string[];
  ticketsPerDay?: number;
  escalationsPerDay?: number;
  resolutionHours?: number | null;
  csatEveryDays?: number;
  csatValue?: number;
}

interface FixtureSignalOptions {
  customerId: string;
  historyDays: number;
  eras: readonly FixtureEra[];
  payment?: Partial<PaymentSignals>;
  contract?: Partial<ContractSignals>;
}

/** Whole events for day `index` at `ratePerDay`, spread without randomness. */
function eventsOnDay(index: number, ratePerDay: number): number {
  return Math.floor((index + 1) * ratePerDay) - Math.floor(index * ratePerDay);
}

/**
 * Builds a synthetic `CustomerSignals` from era descriptions.
 *
 * Fixtures are hand-computable on purpose: rates are uniform inside an era, so
 * "12 tickets in the trailing 7 days" is a property of the fixture rather than
 * something to be discovered by running the code under test.
 */
export function buildFixtureSignals(options: FixtureSignalOptions): CustomerSignals {
  const history: DailySignals[] = [];

  for (let ageInDays = options.historyDays - 1; ageInDays >= 0; ageInDays -= 1) {
    const era =
      options.eras.find((candidate) => ageInDays >= candidate.fromAgeDays && ageInDays < candidate.toAgeDays) ??
      options.eras[options.eras.length - 1];
    const indexInEra = era.toAgeDays - 1 - ageInDays;
    const ticketsOpened = eventsOnDay(indexInEra, era.ticketsPerDay ?? 0);
    const resolutionHours = era.resolutionHours ?? null;
    const csatEveryDays = era.csatEveryDays ?? 0;

    history.push({
      date: fixtureDate(ageInDays),
      logins: eventsOnDay(indexInEra, era.loginsPerDay ?? 0),
      featuresUsed: [...(era.features ?? [])],
      supportTicketsOpened: ticketsOpened,
      supportTicketsEscalated: Math.min(ticketsOpened, eventsOnDay(indexInEra, era.escalationsPerDay ?? 0)),
      csatResponses: csatEveryDays > 0 && indexInEra % csatEveryDays === 0 ? [era.csatValue ?? 4] : [],
      resolutionHours: resolutionHours === null ? [] : Array.from({ length: ticketsOpened }, () => resolutionHours)
    });
  }

  return {
    customerId: options.customerId,
    payment: {
      lastPaymentDate: fixtureDate(10),
      averagePaymentDelayDays: 0,
      overdueAmount: 0,
      overdueSince: null,
      ...options.payment
    },
    contract: {
      renewalDate: fixtureDate(-200),
      annualRecurringRevenue: 24000,
      lastUpgradeDate: null,
      ...options.contract
    },
    history
  };
}

/**
 * A minimal `HealthScoreResult` standing in for a scored customer.
 *
 * Used where a rule's behaviour depends on the *score* rather than on the
 * signals — `contract-expiration-risk` needs one below 50 — so the fixture pins
 * the score instead of reverse-engineering signals that happen to produce it.
 */
export function scoredHealthResult(score: number): HealthScoreResult {
  const absentFactor = { score: null, weight: 0, effectiveWeight: 0, signalsUsed: [], signalsMissing: [] };

  return {
    score,
    riskLevel: score <= 30 ? 'critical' : score <= 70 ? 'warning' : 'healthy',
    breakdown: {
      payment: { ...absentFactor, score, weight: 0.4, effectiveWeight: 1 },
      engagement: absentFactor,
      contract: absentFactor,
      support: absentFactor
    },
    confidence: 1,
    provisional: false
  };
}

/** A health result the engine must refuse to compare against a threshold. */
export const UNSCORED_HEALTH_RESULT: HealthScoreResult = {
  score: null,
  riskLevel: 'unknown',
  breakdown: {
    payment: { score: null, weight: 0.4, effectiveWeight: 0, signalsUsed: [], signalsMissing: ['all'] },
    engagement: { score: null, weight: 0.3, effectiveWeight: 0, signalsUsed: [], signalsMissing: ['all'] },
    contract: { score: null, weight: 0.2, effectiveWeight: 0, signalsUsed: [], signalsMissing: ['all'] },
    support: { score: null, weight: 0.1, effectiveWeight: 0, signalsUsed: [], signalsMissing: ['all'] }
  },
  confidence: 0,
  provisional: true
};

/** One verification case: signals, optional score, and the expected verdict. */
export interface AlertFixture {
  /** What the fixture pins down, in one line. */
  name: string;
  signals: CustomerSignals;
  /** Supplied when the expected verdict depends on the score. */
  health?: HealthScoreResult;
  /** Seeded score history, for the score-drop arm of `payment-risk`. */
  scoreHistory?: Array<{ date: string; score: number }>;
  /** Rules expected to fire, in no particular order. */
  expectedRules: AlertRuleId[];
  /** Rules expected to be reported in `skipped`. */
  expectedSkipped: AlertRuleId[];
  /** Why the expectation is what it is, where that is not self-evident. */
  note?: string;
}

const FULL_HISTORY_DAYS = 120;
const STEADY_FEATURES = ['dashboard', 'reports', 'api'];

/* ==========================================================================
 * payment-risk
 * ========================================================================== */

/** Balance 31 days old against a 30-day threshold: fires on the arrears arm. */
export const paymentRiskFires: AlertFixture = {
  name: 'payment-risk fires: balance outstanding 31 days',
  signals: buildFixtureSignals({
    customerId: 'fixture-payment-fires',
    historyDays: FULL_HISTORY_DAYS,
    eras: [{ fromAgeDays: 0, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }],
    payment: { overdueAmount: 4000, overdueSince: fixtureDate(31) }
  }),
  health: scoredHealthResult(60),
  expectedRules: ['payment-risk'],
  expectedSkipped: [],
  note: `31 days exceeds paymentOverdueDays (${DEFAULT_ALERT_RULE_CONFIG.paymentOverdueDays})`
};

/** Balance exactly 30 days old: the threshold is strict, so this must not fire. */
export const paymentRiskOffByOne: AlertFixture = {
  name: 'payment-risk misses by one day: balance outstanding 30 days',
  signals: buildFixtureSignals({
    customerId: 'fixture-payment-off-by-one',
    historyDays: FULL_HISTORY_DAYS,
    eras: [{ fromAgeDays: 0, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }],
    payment: { overdueAmount: 4000, overdueSince: fixtureDate(30) }
  }),
  health: scoredHealthResult(60),
  expectedRules: [],
  expectedSkipped: []
};

/** A 21-point drop against a seeded 7-day-prior snapshot: fires on the drop arm. */
export const paymentRiskScoreDropFires: AlertFixture = {
  name: 'payment-risk fires: score down 21 points in 7 days, no arrears at all',
  signals: buildFixtureSignals({
    customerId: 'fixture-score-drop',
    historyDays: FULL_HISTORY_DAYS,
    eras: [{ fromAgeDays: 0, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }]
  }),
  health: scoredHealthResult(50),
  scoreHistory: [{ date: fixtureDate(7), score: 71 }],
  expectedRules: ['payment-risk'],
  expectedSkipped: [],
  note: 'A 20-point drop exactly must not fire; 21 must'
};

/** Exactly 20 points: the threshold is strict. */
export const paymentRiskScoreDropOffByOne: AlertFixture = {
  name: 'payment-risk misses by one point: score down exactly 20 in 7 days',
  signals: paymentRiskScoreDropFires.signals,
  health: scoredHealthResult(50),
  scoreHistory: [{ date: fixtureDate(7), score: 70 }],
  expectedRules: [],
  expectedSkipped: []
};

/**
 * No snapshot inside the 5-9 day window.
 *
 * The drop arm must be **skipped and noted**, not read as "no drop": inferring
 * an all-clear from absent history is how a monitoring system goes blind.
 */
export const paymentRiskMissingScoreHistory: AlertFixture = {
  name: 'payment-risk records a note: no score snapshot in the 5-9 day window',
  signals: paymentRiskScoreDropFires.signals,
  health: scoredHealthResult(50),
  scoreHistory: [{ date: fixtureDate(20), score: 95 }],
  expectedRules: [],
  expectedSkipped: [],
  note: 'A 45-point gap exists but 20 days away; the arm is unavailable, not false'
};

/* ==========================================================================
 * engagement-cliff
 * ========================================================================== */

/** 0.14 logins/day against a 1.0/day baseline: an 86% collapse. */
export const engagementCliffFires: AlertFixture = {
  name: 'engagement-cliff fires: trailing week collapses against the preceding 30 days',
  signals: buildFixtureSignals({
    customerId: 'fixture-cliff-fires',
    historyDays: FULL_HISTORY_DAYS,
    eras: [
      { fromAgeDays: 0, toAgeDays: 7, loginsPerDay: 1 / 7, features: STEADY_FEATURES },
      { fromAgeDays: 7, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }
    ]
  }),
  health: scoredHealthResult(60),
  expectedRules: ['engagement-cliff'],
  expectedSkipped: []
};

/** Recent rate at exactly 50% of the baseline: the comparison is strict, so no fire. */
export const engagementCliffOffByOne: AlertFixture = {
  name: 'engagement-cliff misses: trailing week at exactly 50% of the baseline',
  signals: buildFixtureSignals({
    customerId: 'fixture-cliff-off-by-one',
    historyDays: FULL_HISTORY_DAYS,
    eras: [
      // 1.0 against 2.0 logins/day: whole logins only, so the exact-50% case
      // needs an even baseline. At 0.5 against 1.0 the day quota rounds to 3
      // logins in 7 days, which is 43% and genuinely below the threshold.
      { fromAgeDays: 0, toAgeDays: 7, loginsPerDay: 1, features: STEADY_FEATURES },
      { fromAgeDays: 7, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 2, features: STEADY_FEATURES }
    ]
  }),
  health: scoredHealthResult(60),
  expectedRules: [],
  expectedSkipped: [],
  note: 'engagementCliffRatio is a strict comparison, so exactly 50% must not fire'
};

/**
 * The low-baseline guard: 3 logins per 30 days (0.1/day, under the 0.15 floor)
 * halving to nothing.
 *
 * Without the floor this fires, and an account that logged in twice a month and
 * now logs in once is the single largest false-positive source in the rule.
 */
export const engagementCliffLowBaselineGuard: AlertFixture = {
  name: 'engagement-cliff does not fire: baseline of 0.1 logins/day is under the floor',
  signals: buildFixtureSignals({
    customerId: 'fixture-cliff-low-baseline',
    historyDays: FULL_HISTORY_DAYS,
    eras: [
      { fromAgeDays: 0, toAgeDays: 7, loginsPerDay: 0, features: STEADY_FEATURES },
      { fromAgeDays: 7, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 0.1, features: STEADY_FEATURES }
    ]
  }),
  health: scoredHealthResult(60),
  expectedRules: [],
  expectedSkipped: [],
  note: `minBaselineLoginsPerDay is ${DEFAULT_ALERT_RULE_CONFIG.minBaselineLoginsPerDay}`
};

/** 36 days of history: one short of what the cliff needs. */
export const engagementCliffShortHistory: AlertFixture = {
  name: 'engagement-cliff skipped: 36 days of history, one short of 37',
  signals: buildFixtureSignals({
    customerId: 'fixture-cliff-36-days',
    historyDays: 36,
    eras: [
      { fromAgeDays: 0, toAgeDays: 7, loginsPerDay: 0, features: STEADY_FEATURES },
      { fromAgeDays: 7, toAgeDays: 36, loginsPerDay: 1, features: STEADY_FEATURES }
    ]
  }),
  health: scoredHealthResult(60),
  expectedRules: [],
  expectedSkipped: ['engagement-cliff', 'feature-adoption-stall']
};

/** 37 days: the minimum at which the cliff is evaluated, and it fires. */
export const engagementCliffMinimumHistory: AlertFixture = {
  name: 'engagement-cliff evaluated at exactly 37 days of history',
  signals: buildFixtureSignals({
    customerId: 'fixture-cliff-37-days',
    historyDays: 37,
    eras: [
      { fromAgeDays: 0, toAgeDays: 7, loginsPerDay: 0, features: STEADY_FEATURES },
      { fromAgeDays: 7, toAgeDays: 37, loginsPerDay: 1, features: STEADY_FEATURES }
    ]
  }),
  health: scoredHealthResult(60),
  expectedRules: ['engagement-cliff'],
  expectedSkipped: ['feature-adoption-stall']
};

/* ==========================================================================
 * contract-expiration-risk
 * ========================================================================== */

/** 89 days of runway at a score of 49: both conditions met by one unit. */
export const contractExpirationFires: AlertFixture = {
  name: 'contract-expiration-risk fires: 89 days of runway at score 49',
  signals: buildFixtureSignals({
    customerId: 'fixture-contract-fires',
    historyDays: FULL_HISTORY_DAYS,
    eras: [{ fromAgeDays: 0, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }],
    contract: { renewalDate: fixtureDate(-89) }
  }),
  health: scoredHealthResult(49),
  expectedRules: ['contract-expiration-risk'],
  expectedSkipped: []
};

/** 90 days of runway: outside the window by one day. */
export const contractExpirationRunwayOffByOne: AlertFixture = {
  name: 'contract-expiration-risk misses by one day: 90 days of runway',
  signals: buildFixtureSignals({
    customerId: 'fixture-contract-runway-off-by-one',
    historyDays: FULL_HISTORY_DAYS,
    eras: [{ fromAgeDays: 0, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }],
    contract: { renewalDate: fixtureDate(-90) }
  }),
  health: scoredHealthResult(49),
  expectedRules: [],
  expectedSkipped: []
};

/** A score of exactly 50: the ceiling is strict. */
export const contractExpirationScoreOffByOne: AlertFixture = {
  name: 'contract-expiration-risk misses by one point: score exactly 50',
  signals: contractExpirationFires.signals,
  health: scoredHealthResult(50),
  expectedRules: [],
  expectedSkipped: []
};

/**
 * An expired contract, 30 days lapsed, at a score below 50.
 *
 * Included rather than excluded: literal fidelity to "expires in <90 days", and
 * excluding it left the worst-off account in the portfolio generating no alerts
 * at all. `urgencyWeight` must clamp to exactly 1.0 rather than exceeding it.
 */
export const contractExpirationExpired: AlertFixture = {
  name: 'contract-expiration-risk fires on an expired contract with urgencyWeight exactly 1.0',
  signals: buildFixtureSignals({
    customerId: 'fixture-contract-expired',
    historyDays: FULL_HISTORY_DAYS,
    eras: [{ fromAgeDays: 0, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }],
    contract: { renewalDate: fixtureDate(30) }
  }),
  health: scoredHealthResult(20),
  expectedRules: ['contract-expiration-risk'],
  expectedSkipped: []
};

/** An unscored customer cannot satisfy "score below 50" and must not be treated as if it does. */
export const contractExpirationUnscored: AlertFixture = {
  name: 'contract-expiration-risk does not fire for an unscored customer',
  signals: contractExpirationFires.signals,
  health: UNSCORED_HEALTH_RESULT,
  expectedRules: [],
  expectedSkipped: []
};

/* ==========================================================================
 * support-ticket-spike
 * ========================================================================== */

/** Four tickets in the trailing week against a threshold of "more than three". */
export const supportSpikeFires: AlertFixture = {
  name: 'support-ticket-spike fires: 4 tickets in 7 days',
  signals: buildFixtureSignals({
    customerId: 'fixture-spike-fires',
    historyDays: FULL_HISTORY_DAYS,
    eras: [
      { fromAgeDays: 0, toAgeDays: 7, loginsPerDay: 1, features: STEADY_FEATURES, ticketsPerDay: 4 / 7, resolutionHours: 10 },
      { fromAgeDays: 7, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }
    ]
  }),
  health: scoredHealthResult(60),
  expectedRules: ['support-ticket-spike'],
  expectedSkipped: []
};

/** Exactly three tickets and no escalation: both arms miss by one. */
export const supportSpikeOffByOne: AlertFixture = {
  name: 'support-ticket-spike misses by one ticket: exactly 3 in 7 days, none escalated',
  signals: buildFixtureSignals({
    customerId: 'fixture-spike-off-by-one',
    historyDays: FULL_HISTORY_DAYS,
    eras: [
      { fromAgeDays: 0, toAgeDays: 7, loginsPerDay: 1, features: STEADY_FEATURES, ticketsPerDay: 3 / 7, resolutionHours: 10 },
      { fromAgeDays: 7, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }
    ]
  }),
  health: scoredHealthResult(60),
  expectedRules: [],
  expectedSkipped: []
};

/** One escalated ticket is sufficient on its own — noisy by the requirement's design. */
export const supportSpikeEscalationArm: AlertFixture = {
  name: 'support-ticket-spike fires on a single escalation with only one ticket',
  signals: buildFixtureSignals({
    customerId: 'fixture-spike-escalation',
    historyDays: FULL_HISTORY_DAYS,
    eras: [
      {
        fromAgeDays: 0,
        toAgeDays: 7,
        loginsPerDay: 1,
        features: STEADY_FEATURES,
        ticketsPerDay: 1 / 7,
        escalationsPerDay: 1 / 7,
        resolutionHours: 10
      },
      { fromAgeDays: 7, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }
    ]
  }),
  health: scoredHealthResult(60),
  expectedRules: ['support-ticket-spike'],
  expectedSkipped: []
};

/* ==========================================================================
 * feature-adoption-stall
 * ========================================================================== */

/** No new feature in 30 days on an account that upgraded 60 days ago. */
export const adoptionStallFires: AlertFixture = {
  name: 'feature-adoption-stall fires: no new feature in 30 days on a recently upgraded account',
  signals: buildFixtureSignals({
    customerId: 'fixture-stall-fires',
    historyDays: FULL_HISTORY_DAYS,
    eras: [{ fromAgeDays: 0, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }],
    contract: { lastUpgradeDate: fixtureDate(60) }
  }),
  health: scoredHealthResult(60),
  expectedRules: ['feature-adoption-stall'],
  expectedSkipped: []
};

/** One newly adopted feature inside the window is enough to clear the rule. */
export const adoptionStallOffByOne: AlertFixture = {
  name: 'feature-adoption-stall misses: exactly one new feature in the trailing 30 days',
  signals: buildFixtureSignals({
    customerId: 'fixture-stall-new-feature',
    historyDays: FULL_HISTORY_DAYS,
    eras: [
      { fromAgeDays: 0, toAgeDays: 30, loginsPerDay: 1, features: [...STEADY_FEATURES, 'forecasting'] },
      { fromAgeDays: 30, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }
    ],
    contract: { lastUpgradeDate: fixtureDate(60) }
  }),
  health: scoredHealthResult(60),
  expectedRules: [],
  expectedSkipped: []
};

/** Stalled, but not growing: an upgrade 181 days ago and flat adoption. */
export const adoptionStallNotGrowing: AlertFixture = {
  name: 'feature-adoption-stall misses by one day: upgrade 181 days ago, adoption flat',
  signals: buildFixtureSignals({
    customerId: 'fixture-stall-not-growing',
    historyDays: FULL_HISTORY_DAYS,
    eras: [{ fromAgeDays: 0, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }],
    contract: { lastUpgradeDate: fixtureDate(181) }
  }),
  health: scoredHealthResult(60),
  expectedRules: [],
  expectedSkipped: [],
  note: `growingAccountUpgradeDays is ${DEFAULT_ALERT_RULE_CONFIG.growingAccountUpgradeDays}`
};

/** Growth by the second arm: days 31-60 broader than days 61-90, no upgrade at all. */
export const adoptionStallBroadeningArm: AlertFixture = {
  name: 'feature-adoption-stall fires on broadening adoption with no upgrade on record',
  signals: buildFixtureSignals({
    customerId: 'fixture-stall-broadening',
    historyDays: FULL_HISTORY_DAYS,
    eras: [
      { fromAgeDays: 0, toAgeDays: 60, loginsPerDay: 1, features: [...STEADY_FEATURES, 'alerts'] },
      { fromAgeDays: 60, toAgeDays: FULL_HISTORY_DAYS, loginsPerDay: 1, features: STEADY_FEATURES }
    ]
  }),
  health: scoredHealthResult(60),
  expectedRules: ['feature-adoption-stall'],
  expectedSkipped: []
};

/** 89 days of history: one short of what the stall rule needs. */
export const adoptionStallShortHistory: AlertFixture = {
  name: 'feature-adoption-stall skipped: 89 days of history, one short of 90',
  signals: buildFixtureSignals({
    customerId: 'fixture-stall-89-days',
    historyDays: 89,
    eras: [{ fromAgeDays: 0, toAgeDays: 89, loginsPerDay: 1, features: STEADY_FEATURES }],
    contract: { lastUpgradeDate: fixtureDate(60) }
  }),
  health: scoredHealthResult(60),
  expectedRules: [],
  expectedSkipped: ['feature-adoption-stall']
};

/** 90 days: the minimum at which the stall rule is evaluated, and it fires. */
export const adoptionStallMinimumHistory: AlertFixture = {
  name: 'feature-adoption-stall evaluated at exactly 90 days of history',
  signals: buildFixtureSignals({
    customerId: 'fixture-stall-90-days',
    historyDays: 90,
    eras: [{ fromAgeDays: 0, toAgeDays: 90, loginsPerDay: 1, features: STEADY_FEATURES }],
    contract: { lastUpgradeDate: fixtureDate(60) }
  }),
  health: scoredHealthResult(60),
  expectedRules: ['feature-adoption-stall'],
  expectedSkipped: []
};

/* ==========================================================================
 * Lifecycle, suppression and new customers
 * ========================================================================== */

/**
 * A rule true across three consecutive evaluations.
 *
 * The alert must stay in `state.open` throughout with **one unchanged `id`**, and
 * must never be suppressed by cooldown while open — cooldown gates only the
 * closed → open transition. Conflating the two is what makes a panel display an
 * alert once and then empty itself.
 */
export const openLifecycleFixture: AlertFixture = {
  name: 'open lifecycle: true across three evaluations, one id, one history entry on close',
  signals: supportSpikeFires.signals,
  health: scoredHealthResult(60),
  expectedRules: ['support-ticket-spike'],
  expectedSkipped: []
};

/** A nine-day-old account: two rules unevaluable, and no all-clear implied. */
export const newCustomerFixture: AlertFixture = {
  name: 'new customer: 9 days of history skips the cliff and the stall',
  signals: buildFixtureSignals({
    customerId: 'fixture-new-customer',
    historyDays: 9,
    eras: [{ fromAgeDays: 0, toAgeDays: 9, loginsPerDay: 1, features: STEADY_FEATURES }]
  }),
  expectedRules: [],
  expectedSkipped: ['engagement-cliff', 'feature-adoption-stall'],
  note: 'support-ticket-spike needs 7 days and is evaluated; it simply does not fire'
};

/** Every fixture, for a suite that wants to walk the whole set. */
export const alertFixtures: readonly AlertFixture[] = Object.freeze([
  paymentRiskFires,
  paymentRiskOffByOne,
  paymentRiskScoreDropFires,
  paymentRiskScoreDropOffByOne,
  paymentRiskMissingScoreHistory,
  engagementCliffFires,
  engagementCliffOffByOne,
  engagementCliffLowBaselineGuard,
  engagementCliffShortHistory,
  engagementCliffMinimumHistory,
  contractExpirationFires,
  contractExpirationRunwayOffByOne,
  contractExpirationScoreOffByOne,
  contractExpirationExpired,
  contractExpirationUnscored,
  supportSpikeFires,
  supportSpikeOffByOne,
  supportSpikeEscalationArm,
  adoptionStallFires,
  adoptionStallOffByOne,
  adoptionStallNotGrowing,
  adoptionStallBroadeningArm,
  adoptionStallShortHistory,
  adoptionStallMinimumHistory,
  openLifecycleFixture,
  newCustomerFixture
]);

/** Scores a fixture with the real calculator, for cases that do not pin a score. */
export function fixtureHealth(fixture: AlertFixture, asOf: string = FIXTURE_REFERENCE_DATE): HealthScoreResult {
  return fixture.health ?? scoreCustomerAt(fixture.signals, asOf);
}

/**
 * Where these fixtures knowingly fall short of the spec's fixture list, and why.
 *
 * Recorded here rather than left for a reader to notice: an undocumented gap in a
 * verification set is worse than a documented one.
 */
export const SPEC_DEVIATIONS: readonly string[] = Object.freeze([
  'The spec names src/data/health-fixtures.ts covering both the calculator and the alerts. The calculator shipped ahead of this module with a different, already-tested API (HealthScoreInput / HealthScoreValidationError rather than CustomerSignals / HealthCalculationError), so its band, rounding, and validation fixtures are not restated here; this module covers the alerts half only.',
  'The spec makes a Vitest suite asserting these fixtures a deliverable. This repository ships no committed suite for them, so the fixtures are data awaiting a runner rather than assertions that run today.',
  'Cooldown- and dismissal-suppressed variants are expressed as state transitions over the lifecycle fixtures rather than as separate signal fixtures: suppression is a property of MonitoringState, not of a customer, so a distinct signal set could not express it.'
]);
