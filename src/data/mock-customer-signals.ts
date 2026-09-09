/**
 * Mock signal history for the customer health monitoring feature.
 *
 * This module closes the largest gap between the requirements and the
 * repository: `Customer` carries a single pre-computed `healthScore` and no time
 * dimension at all, while four of the five alert rules are temporal. Everything
 * the calculator and the rules engine need is generated here.
 *
 * Three properties are load-bearing and deliberate:
 *
 * 1. **Deterministic.** No `Math.random()`, at module scope or at call time. Day
 *    quotas are spread arithmetically and the only stochastic element is a
 *    seeded PRNG keyed by an FNV-1a hash of the customer id. The same customer
 *    always produces the same history, the same score, and the same alerts — a
 *    demo that changes on refresh is not demonstrable.
 * 2. **Frozen in time.** Dates are generated backwards from
 *    {@link SIGNAL_REFERENCE_DATE}, never from `Date.now()`. Renewal runways and
 *    payment ages therefore do not drift as real days pass. That is the price of
 *    determinism and it is the intended trade.
 * 3. **Dates, not day counts.** Every temporal quantity is stored as a date or a
 *    per-day event, so passing a different `asOf` moves payment recency,
 *    contract runway, and the engagement windows *together*.
 *
 * `Customer.healthScore` is **not consumed** by this feature — not by the
 * calculator, not by any rule, not by either widget. The generator is merely
 * *calibrated* against it so the dashboard is not visibly self-contradictory;
 * see `SCORE_CALIBRATION` below for where it deviates and why.
 *
 * The signal interfaces live in `@/lib/alerts` and are re-exported here. The
 * reverse arrangement would force `src/lib` to import from `src/data`, which the
 * spec forbids for good reason: the library must outlive this mock module.
 */

import {
  daysBetween,
  scoreCustomerAt,
  validateCustomerSignals,
  type ContractSignals,
  type CustomerSignals,
  type DailySignals,
  type PaymentSignals
} from '@/lib/alerts';

export type { ContractSignals, CustomerSignals, DailySignals, PaymentSignals };

/**
 * The instant the whole demo is frozen at. Every generated date is counted
 * backwards from here and every `asOf` parameter defaults to it.
 */
export const SIGNAL_REFERENCE_DATE = '2026-09-09';

/**
 * Minimum generated history, in days.
 *
 * 90 rather than 60: `feature-adoption-stall` compares three consecutive 30-day
 * windows and the support factor aggregates over 90 days. New-customer fixtures
 * are the sole exception, since a short history is the thing they exist to test.
 */
export const MINIMUM_GENERATED_HISTORY_DAYS = 90;

/** Days of history generated for every established customer. */
const ESTABLISHED_HISTORY_DAYS = 120;

/** Default number of prior snapshots {@link buildScoreHistory} seeds. */
export const DEFAULT_SCORE_HISTORY_DAYS = 30;

/** The feature keys the mock product exposes. Order is meaningful only to the rotation. */
const FEATURE_KEYS = Object.freeze({
  core: ['dashboard', 'reports', 'api'],
  broad: ['dashboard', 'reports', 'api', 'alerts', 'export'],
  full: ['dashboard', 'reports', 'api', 'alerts', 'export', 'sso'],
  fullPlusNew: ['dashboard', 'reports', 'api', 'alerts', 'export', 'sso', 'webhooks'],
  wide: ['dashboard', 'reports', 'api', 'alerts', 'export', 'sso', 'webhooks', 'audit-log'],
  widePlusNew: ['dashboard', 'reports', 'api', 'alerts', 'export', 'sso', 'webhooks', 'audit-log', 'forecasting'],
  narrow: ['dashboard'],
  minimal: ['dashboard', 'reports']
});

/* ==========================================================================
 * Seeded pseudo-randomness
 * ========================================================================== */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a hash of a customer id, used purely as a PRNG seed. */
export function hashCustomerId(customerId: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < customerId.length; index += 1) {
    hash ^= customerId.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }

  return hash >>> 0;
}

/**
 * Mulberry32: a small, fast, fully deterministic PRNG.
 *
 * Seeded from the customer id so a customer's history is reproducible from its
 * id alone, with no shared mutable state between customers.
 */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==========================================================================
 * Date helpers
 * ========================================================================== */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The `YYYY-MM-DD` date `ageInDays` before `referenceDate`. */
export function dateBefore(referenceDate: string, ageInDays: number): string {
  const referenceInstant = Date.parse(`${referenceDate}T00:00:00.000Z`);
  return new Date(referenceInstant - ageInDays * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

/* ==========================================================================
 * Profiles — the behavioural script each customer's history is generated from
 * ========================================================================== */

/**
 * One era of a customer's behaviour, expressed as rates rather than totals so
 * the same profile can generate any history length.
 *
 * Ages count backwards from {@link SIGNAL_REFERENCE_DATE}: `fromAgeDays: 0,
 * toAgeDays: 7` is the trailing week.
 */
interface SignalSegment {
  /** Inclusive lower age bound, in days. */
  fromAgeDays: number;
  /** Exclusive upper age bound, in days. */
  toAgeDays: number;
  loginsPerDay: number;
  /** Features touched during this era; the rotation guarantees each one appears. */
  featurePool: readonly string[];
  featureTouchesPerDay: number;
  ticketsPerDay: number;
  escalationsPerDay: number;
  /** Hours per resolved ticket, or `null` for tickets opened but not yet resolved. */
  resolutionHoursPerTicket: number | null;
  /** Cadence of CSAT responses in days; `0` means none in this era. */
  csatEveryDays: number;
  /** The CSAT value recorded, `1..5`. */
  csatValue: number;
}

interface CustomerSignalProfile {
  customerId: string;
  /** What this customer exists to demonstrate. Rendered nowhere; documentation only. */
  scenario: string;
  historyDays: number;
  segments: readonly SignalSegment[];
  payment: {
    lastPaymentAgeDays: number;
    averagePaymentDelayDays: number;
    overdueAmount: number;
    overdueSinceAgeDays: number | null;
  };
  contract: {
    /** Positive is future, negative means the contract has already lapsed. */
    renewalInDays: number;
    annualRecurringRevenue: number;
    lastUpgradeAgeDays: number | null;
  };
}

/** A steady era, so profiles only state what differs from ordinary behaviour. */
function steadySegment(overrides: Partial<SignalSegment> & Pick<SignalSegment, 'fromAgeDays' | 'toAgeDays'>): SignalSegment {
  return {
    loginsPerDay: 1,
    featurePool: FEATURE_KEYS.broad,
    featureTouchesPerDay: 3,
    ticketsPerDay: 0.1,
    escalationsPerDay: 0,
    resolutionHoursPerTicket: 12,
    csatEveryDays: 12,
    csatValue: 4,
    ...overrides
  };
}

/**
 * The eight demo customers, one per `mockCustomers` id.
 *
 * Between them they reach **every** rule, which the shipped `mockCustomers`
 * scores (15, 35, 45, 60, 73, 85, 88, 92) reach none of — those numbers touch no
 * band boundary and carry no time dimension:
 *
 * | Id | Alerts expected |
 * |---|---|
 * | `1` | none — the all-clear case |
 * | `2` | `engagement-cliff` |
 * | `3` | `payment-risk` (arrears) **and** `contract-expiration-risk` — two at once |
 * | `4` | none |
 * | `5` | `support-ticket-spike` |
 * | `6` | none, and three rules *skipped* for short history (9 days) |
 * | `7` | `feature-adoption-stall` |
 * | `8` | `payment-risk` via the **score-drop** arm |
 *
 * The interaction the spec warns about is real: `contract-expiration-risk` needs
 * a score under 50, which the ±25 calibration puts out of reach for the 85/88/92
 * customers, so it is assigned to customer `3`.
 */
const CUSTOMER_SIGNAL_PROFILES: readonly CustomerSignalProfile[] = [
  {
    customerId: '1',
    scenario: 'Punctual, embedded, renewing comfortably. Fires nothing.',
    historyDays: ESTABLISHED_HISTORY_DAYS,
    segments: [
      // A genuinely new feature this month, so adoption is not stalled.
      steadySegment({ fromAgeDays: 0, toAgeDays: 30, loginsPerDay: 1.1, featurePool: FEATURE_KEYS.fullPlusNew, csatValue: 5 }),
      steadySegment({ fromAgeDays: 30, toAgeDays: ESTABLISHED_HISTORY_DAYS, featurePool: FEATURE_KEYS.full, csatValue: 5 })
    ],
    payment: { lastPaymentAgeDays: 8, averagePaymentDelayDays: 1, overdueAmount: 0, overdueSinceAgeDays: null },
    contract: { renewalInDays: 140, annualRecurringRevenue: 48000, lastUpgradeAgeDays: 120 }
  },
  {
    customerId: '2',
    scenario: 'Logins fall off a cliff in the trailing week. Fires engagement-cliff only.',
    historyDays: ESTABLISHED_HISTORY_DAYS,
    segments: [
      steadySegment({ fromAgeDays: 0, toAgeDays: 7, loginsPerDay: 0, featurePool: FEATURE_KEYS.minimal, resolutionHoursPerTicket: 30, csatValue: 3 }),
      steadySegment({
        fromAgeDays: 7,
        toAgeDays: ESTABLISHED_HISTORY_DAYS,
        loginsPerDay: 0.7,
        featurePool: FEATURE_KEYS.minimal,
        ticketsPerDay: 0.15,
        resolutionHoursPerTicket: 30,
        csatValue: 3
      })
    ],
    payment: { lastPaymentAgeDays: 41, averagePaymentDelayDays: 12, overdueAmount: 2500, overdueSinceAgeDays: 20 },
    // Renewal kept far out on purpose: this customer demonstrates the cliff, not expiry risk.
    contract: { renewalInDays: 200, annualRecurringRevenue: 12000, lastUpgradeAgeDays: null }
  },
  {
    customerId: '3',
    scenario: 'Overdue balance and a lapsed contract. Fires payment-risk and contract-expiration-risk together.',
    historyDays: ESTABLISHED_HISTORY_DAYS,
    segments: [
      steadySegment({
        fromAgeDays: 0,
        toAgeDays: 30,
        loginsPerDay: 0.1,
        featurePool: FEATURE_KEYS.narrow,
        featureTouchesPerDay: 1,
        ticketsPerDay: 0.28,
        resolutionHoursPerTicket: 68,
        csatEveryDays: 10,
        csatValue: 1
      }),
      steadySegment({
        fromAgeDays: 30,
        toAgeDays: ESTABLISHED_HISTORY_DAYS,
        loginsPerDay: 0.1,
        featurePool: FEATURE_KEYS.narrow,
        featureTouchesPerDay: 1,
        ticketsPerDay: 0.3,
        escalationsPerDay: 0.03,
        resolutionHoursPerTicket: 68,
        csatEveryDays: 10,
        csatValue: 1
      })
    ],
    payment: { lastPaymentAgeDays: 96, averagePaymentDelayDays: 27, overdueAmount: 9500, overdueSinceAgeDays: 75 },
    contract: { renewalInDays: -30, annualRecurringRevenue: 9000, lastUpgradeAgeDays: null }
  },
  {
    customerId: '4',
    scenario: 'Enterprise account in good standing. Fires nothing, and anchors the sort order.',
    historyDays: ESTABLISHED_HISTORY_DAYS,
    segments: [
      steadySegment({
        fromAgeDays: 0,
        toAgeDays: 30,
        loginsPerDay: 1.3,
        featurePool: FEATURE_KEYS.widePlusNew,
        featureTouchesPerDay: 4,
        resolutionHoursPerTicket: 3,
        csatEveryDays: 10,
        csatValue: 5
      }),
      steadySegment({
        fromAgeDays: 30,
        toAgeDays: ESTABLISHED_HISTORY_DAYS,
        loginsPerDay: 1.3,
        featurePool: FEATURE_KEYS.wide,
        featureTouchesPerDay: 4,
        resolutionHoursPerTicket: 3,
        csatEveryDays: 10,
        csatValue: 5
      })
    ],
    payment: { lastPaymentAgeDays: 12, averagePaymentDelayDays: 0, overdueAmount: 0, overdueSinceAgeDays: null },
    contract: { renewalInDays: 155, annualRecurringRevenue: 180000, lastUpgradeAgeDays: 40 }
  },
  {
    customerId: '5',
    scenario: 'Seven tickets and an escalation this week. Fires support-ticket-spike.',
    historyDays: ESTABLISHED_HISTORY_DAYS,
    segments: [
      steadySegment({
        fromAgeDays: 0,
        toAgeDays: 7,
        loginsPerDay: 0.6,
        featurePool: FEATURE_KEYS.broad,
        ticketsPerDay: 1,
        escalationsPerDay: 1 / 7,
        resolutionHoursPerTicket: 20
      }),
      steadySegment({
        fromAgeDays: 7,
        toAgeDays: ESTABLISHED_HISTORY_DAYS,
        loginsPerDay: 0.6,
        featurePool: FEATURE_KEYS.broad,
        resolutionHoursPerTicket: 20
      })
    ],
    payment: { lastPaymentAgeDays: 22, averagePaymentDelayDays: 6, overdueAmount: 0, overdueSinceAgeDays: null },
    contract: { renewalInDays: 160, annualRecurringRevenue: 30000, lastUpgradeAgeDays: null }
  },
  {
    customerId: '6',
    scenario: 'Nine days old. Engagement excluded from the score; three rules skipped for short history.',
    historyDays: 9,
    segments: [
      steadySegment({
        fromAgeDays: 0,
        toAgeDays: 9,
        loginsPerDay: 1,
        featurePool: FEATURE_KEYS.core,
        // No tickets and no CSAT yet, so the support factor is genuinely absent
        // rather than invented — exactly the new-customer case.
        ticketsPerDay: 0,
        resolutionHoursPerTicket: null,
        csatEveryDays: 0
      })
    ],
    payment: { lastPaymentAgeDays: 20, averagePaymentDelayDays: 3, overdueAmount: 0, overdueSinceAgeDays: null },
    contract: { renewalInDays: 353, annualRecurringRevenue: 18000, lastUpgradeAgeDays: null }
  },
  {
    customerId: '7',
    scenario: 'Growing account whose adoption has flattened. Fires feature-adoption-stall.',
    historyDays: ESTABLISHED_HISTORY_DAYS,
    segments: [
      // Nothing in the trailing 30 days that was absent from the preceding 30,
      // while days 31-60 broadened on days 61-90: a stall on a growing account.
      steadySegment({ fromAgeDays: 0, toAgeDays: 30, loginsPerDay: 1.2, featurePool: FEATURE_KEYS.broad, resolutionHoursPerTicket: 18 }),
      steadySegment({ fromAgeDays: 30, toAgeDays: 60, loginsPerDay: 1.2, featurePool: FEATURE_KEYS.broad, resolutionHoursPerTicket: 18 }),
      steadySegment({
        fromAgeDays: 60,
        toAgeDays: ESTABLISHED_HISTORY_DAYS,
        loginsPerDay: 1.2,
        featurePool: FEATURE_KEYS.core,
        resolutionHoursPerTicket: 18
      })
    ],
    payment: { lastPaymentAgeDays: 14, averagePaymentDelayDays: 2, overdueAmount: 0, overdueSinceAgeDays: null },
    contract: { renewalInDays: 200, annualRecurringRevenue: 96000, lastUpgradeAgeDays: 60 }
  },
  {
    customerId: '8',
    scenario:
      'Feature breadth collapsed a month ago, tickets spiked this week, and the only satisfaction data has just aged out of the 90-day window. The score falls more than 20 points across seven days, firing payment-risk on its score-drop arm — the balance it carries is only ten days old, so the arrears arm stays quiet.',
    historyDays: ESTABLISHED_HISTORY_DAYS,
    segments: [
      steadySegment({
        fromAgeDays: 0,
        toAgeDays: 7,
        loginsPerDay: 2 / 3,
        featurePool: FEATURE_KEYS.narrow,
        featureTouchesPerDay: 0,
        ticketsPerDay: 15 / 7,
        // Opened but not yet resolved, so no resolution hours enter the window.
        resolutionHoursPerTicket: null,
        csatEveryDays: 0
      }),
      steadySegment({
        fromAgeDays: 7,
        toAgeDays: 30,
        loginsPerDay: 2 / 3,
        featurePool: FEATURE_KEYS.narrow,
        featureTouchesPerDay: 0,
        ticketsPerDay: 0,
        resolutionHoursPerTicket: null,
        csatEveryDays: 0
      }),
      steadySegment({
        fromAgeDays: 30,
        toAgeDays: 91,
        loginsPerDay: 2 / 3,
        featurePool: FEATURE_KEYS.wide,
        featureTouchesPerDay: 4,
        ticketsPerDay: 0,
        resolutionHoursPerTicket: null,
        csatEveryDays: 0
      }),
      // Satisfaction data sits at ages 91-120 precisely so it is inside the
      // 90-day support window a week ago and outside it today: the support
      // factor is present at the prior snapshot and absent now.
      steadySegment({
        fromAgeDays: 91,
        toAgeDays: ESTABLISHED_HISTORY_DAYS,
        loginsPerDay: 2 / 3,
        featurePool: FEATURE_KEYS.wide,
        featureTouchesPerDay: 4,
        ticketsPerDay: 0,
        resolutionHoursPerTicket: null,
        csatEveryDays: 2,
        csatValue: 5
      })
    ],
    // Ten days of arrears, deliberately inside the 30-day threshold: this
    // customer is the off-by-one case for the arrears arm as well as the
    // positive case for the score-drop arm.
    payment: { lastPaymentAgeDays: 100, averagePaymentDelayDays: 25, overdueAmount: 5000, overdueSinceAgeDays: 10 },
    // Renewal deliberately beyond the 90-day horizon, so a low score alone
    // cannot drag contract-expiration-risk into this customer's queue.
    contract: { renewalInDays: 95, annualRecurringRevenue: 22000, lastUpgradeAgeDays: null }
  }
];

/* ==========================================================================
 * Generation
 * ========================================================================== */

/**
 * Spreads `ratePerDay` over consecutive days as whole events without randomness:
 * the count on day `index` is the difference of two running totals, so `n` days
 * carry exactly `round(n × rate)` events, evenly distributed.
 *
 * A PRNG draw per day would give the same mean with a variance that quietly
 * breaks threshold fixtures — 20 logins per 30 days is either at the curve's
 * best-case breakpoint or it is not.
 */
function eventsOnDay(index: number, ratePerDay: number): number {
  return Math.floor((index + 1) * ratePerDay) - Math.floor(index * ratePerDay);
}

function findSegment(segments: readonly SignalSegment[], ageInDays: number): SignalSegment {
  const segment = segments.find((candidate) => ageInDays >= candidate.fromAgeDays && ageInDays < candidate.toAgeDays);

  if (segment === undefined) {
    throw new Error(`Mock signal profile has no segment covering age ${ageInDays}`);
  }

  return segment;
}

/** Generates one customer's daily history, oldest first. */
function generateHistory(profile: CustomerSignalProfile, referenceDate: string): DailySignals[] {
  const random = createSeededRandom(hashCustomerId(profile.customerId));
  const rotationOffset = Math.floor(random() * FEATURE_KEYS.widePlusNew.length);
  const history: DailySignals[] = [];

  for (let ageInDays = profile.historyDays - 1; ageInDays >= 0; ageInDays -= 1) {
    const segment = findSegment(profile.segments, ageInDays);
    // Index within the segment, counted forwards in time, so the quota spread is
    // stable regardless of how long the whole history is.
    const segmentIndex = segment.toAgeDays - 1 - ageInDays;

    const ticketsOpened = eventsOnDay(segmentIndex, segment.ticketsPerDay);
    const supportTicketsEscalated = Math.min(ticketsOpened, eventsOnDay(segmentIndex, segment.escalationsPerDay));
    const featureTouches = eventsOnDay(segmentIndex, segment.featureTouchesPerDay);
    const featuresUsed: string[] = [];

    for (let touch = 0; touch < featureTouches; touch += 1) {
      const position = segmentIndex * segment.featureTouchesPerDay + touch + rotationOffset;
      featuresUsed.push(segment.featurePool[Math.floor(position) % segment.featurePool.length]);
    }

    history.push({
      date: dateBefore(referenceDate, ageInDays),
      logins: eventsOnDay(segmentIndex, segment.loginsPerDay),
      featuresUsed,
      supportTicketsOpened: ticketsOpened,
      supportTicketsEscalated,
      csatResponses:
        segment.csatEveryDays > 0 && segmentIndex % segment.csatEveryDays === 0 ? [segment.csatValue] : [],
      resolutionHours:
        segment.resolutionHoursPerTicket === null
          ? []
          : Array.from({ length: ticketsOpened }, () => segment.resolutionHoursPerTicket ?? 0)
    });
  }

  return history;
}

function buildSignals(profile: CustomerSignalProfile, referenceDate: string): CustomerSignals {
  const payment: PaymentSignals = {
    lastPaymentDate: dateBefore(referenceDate, profile.payment.lastPaymentAgeDays),
    averagePaymentDelayDays: profile.payment.averagePaymentDelayDays,
    overdueAmount: profile.payment.overdueAmount,
    overdueSince:
      profile.payment.overdueSinceAgeDays === null
        ? null
        : dateBefore(referenceDate, profile.payment.overdueSinceAgeDays)
  };

  const contract: ContractSignals = {
    renewalDate: dateBefore(referenceDate, -profile.contract.renewalInDays),
    annualRecurringRevenue: profile.contract.annualRecurringRevenue,
    lastUpgradeDate:
      profile.contract.lastUpgradeAgeDays === null ? null : dateBefore(referenceDate, profile.contract.lastUpgradeAgeDays)
  };

  return { customerId: profile.customerId, payment, contract, history: generateHistory(profile, referenceDate) };
}

/**
 * Generated signals for every `mockCustomers` id, in id order.
 *
 * Computed once at module load and never mutated. Regenerating per call would be
 * wasteful and would tempt a caller into mutating shared history.
 */
export const mockCustomerSignals: readonly CustomerSignals[] = CUSTOMER_SIGNAL_PROFILES.map((profile) =>
  buildSignals(profile, SIGNAL_REFERENCE_DATE)
);

/** Signals for one customer, or `undefined` — an unknown id is a legitimate state. */
export function getSignalsForCustomer(customerId: string): CustomerSignals | undefined {
  return mockCustomerSignals.find((signals) => signals.customerId === customerId);
}

/** What each customer is expected to demonstrate. Documentation, not behaviour. */
export const SIGNAL_SCENARIOS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(CUSTOMER_SIGNAL_PROFILES.map((profile) => [profile.customerId, profile.scenario]))
);

/**
 * Where the generated signals deviate from `Customer.healthScore`, and why.
 *
 * The generator is calibrated to land within ±25 of the stored score for at
 * least six of the eight customers so the dashboard is not visibly
 * self-contradictory. Customer `8` deviates by design: its score is engineered
 * to fall more than 20 points across seven days, which is the only way to reach
 * the score-drop arm of `payment-risk`, and the drop necessarily ends far from a
 * static stored number.
 */
export const SCORE_CALIBRATION_NOTE =
  'Signals are calibrated to within ±25 of Customer.healthScore for six of eight customers. Customer 8 deviates deliberately so the score-drop rule is reachable; Customer.healthScore is not consumed by this feature.';

/* ==========================================================================
 * Score history seeding
 * ========================================================================== */

/**
 * Seeds a customer's score history by running the calculator at each of the
 * prior `days` dates.
 *
 * This is what makes `trend` and the score-drop arm of `payment-risk` *execute*
 * rather than merely exist: without seeded history there is no 7-day-prior score
 * to compare against, and both features are permanently unavailable in the
 * running app.
 *
 * One snapshot per date, ascending, no duplicates. Expensive by design — `days`
 * calculator runs per customer — so it belongs at startup, not in a render.
 */
export function buildScoreHistory(
  customerId: string,
  asOf: string = SIGNAL_REFERENCE_DATE,
  days: number = DEFAULT_SCORE_HISTORY_DAYS
): Array<{ date: string; score: number }> {
  const signals = getSignalsForCustomer(customerId);

  if (signals === undefined) {
    return [];
  }

  const snapshots: Array<{ date: string; score: number }> = [];

  // Validated once for the whole seeding run: the signals are immutable and the
  // verdict cannot differ between snapshot dates, so re-validating per date
  // would multiply the most expensive path in the feature by `days`.
  validateCustomerSignals(signals);

  for (let ageInDays = days; ageInDays >= 1; ageInDays -= 1) {
    const date = dateBefore(asOf, ageInDays);

    if (daysBetween(signals.history[0]?.date ?? date, date) < 0) {
      // Before the customer existed: no snapshot rather than a fabricated one.
      continue;
    }

    const result = scoreCustomerAt(signals, date, { hasBeenValidated: true });

    if (result.score !== null && result.riskLevel !== 'unknown') {
      snapshots.push({ date, score: result.score });
    }
  }

  return snapshots;
}

/** Seeded score history for every mock customer, keyed by customer id. */
export function buildAllScoreHistories(
  asOf: string = SIGNAL_REFERENCE_DATE,
  days: number = DEFAULT_SCORE_HISTORY_DAYS
): Record<string, Array<{ date: string; score: number }>> {
  const histories: Record<string, Array<{ date: string; score: number }>> = {};

  for (const signals of mockCustomerSignals) {
    histories[signals.customerId] = buildScoreHistory(signals.customerId, asOf, days);
  }

  return histories;
}
