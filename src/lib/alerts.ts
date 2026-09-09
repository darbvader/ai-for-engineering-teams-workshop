/**
 * Predictive alerts rules engine.
 *
 * Framework-free and dependency-free by design: this module imports nothing from
 * `react`, `next`, or `src/data`, so it runs in a plain Node process and can be
 * pointed at a real signal source later without touching a line of it. The
 * signal interfaces are declared **here**, in `src/lib`, and re-exported by the
 * mock data module — the reverse arrangement (types living beside the mock data)
 * would have forced this library to import from `src/data`.
 *
 * Everything is pure: no `Date.now()`, no `Math.random()`, no I/O, no logging, no
 * mutation of arguments. "Today" is always an explicit `asOf` date string.
 *
 * The health score itself is **not** recomputed here. It arrives pre-computed on
 * `CustomerEvaluationInput.health`, produced by `@/lib/healthCalculator`, which
 * owns every threshold and band in the scoring half of this feature.
 */

import {
  calculateHealthScore,
  type HealthScoreInput,
  type HealthScoreResult
} from '@/lib/healthCalculator';

/* ==========================================================================
 * Signal interfaces — the input contract for the whole monitoring feature
 * ========================================================================== */

/**
 * One day's observed signals for one customer. Newest last, one entry per day,
 * no gaps.
 *
 * Everything temporal is stored as an event series rather than a pre-computed
 * day count, so passing a different `asOf` moves every derived duration
 * together. A stored `daysSinceLastPayment` would freeze while the dated
 * windows advanced, producing internally inconsistent results from the very
 * parameter that exists to make the system deterministic.
 */
export interface DailySignals {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Sessions that day, `>= 0`. */
  logins: number;
  /** One entry per feature *touch*, so repeats are meaningful for depth. */
  featuresUsed: string[];
  /** `>= 0`. */
  supportTicketsOpened: number;
  /** `>= 0` and `<= supportTicketsOpened`. */
  supportTicketsEscalated: number;
  /** Each `1..5`; usually empty. Stored per day so trends are derivable. */
  csatResponses: number[];
  /** One entry per ticket resolved that day, hours, `>= 0`. */
  resolutionHours: number[];
}

/** Payment posture. Dates, never day counts — see {@link DailySignals}. */
export interface PaymentSignals {
  /** `YYYY-MM-DD`. */
  lastPaymentDate: string;
  /** Finite; may be negative, meaning the account pays early. */
  averagePaymentDelayDays: number;
  /** `>= 0`, USD. Never echoed into alert text. */
  overdueAmount: number;
  /** `YYYY-MM-DD`; `null` if and only if `overdueAmount === 0`. */
  overdueSince: string | null;
}

/** Contract posture. */
export interface ContractSignals {
  /** `YYYY-MM-DD`; may be in the past, meaning the contract has lapsed. */
  renewalDate: string;
  /** USD, must be `> 0`: the value weight takes `log10` of it. */
  annualRecurringRevenue: number;
  /** `YYYY-MM-DD`, or `null` if the account has never upgraded. */
  lastUpgradeDate: string | null;
}

/** Everything the monitoring feature knows about one customer. */
export interface CustomerSignals {
  /** Matches `Customer.id`. */
  customerId: string;
  payment: PaymentSignals;
  contract: ContractSignals;
  /** Ascending by date, no duplicates, no gaps. */
  history: DailySignals[];
}

/**
 * The identity this engine needs from a customer record.
 *
 * Deliberately structural and minimal rather than an import of `Customer` from
 * `@/data/mock-customers`: `src/lib` must not depend on `src/data`, and the
 * engine has no use for a display name it is forbidden from putting in alert
 * text. Any `Customer` satisfies this shape, so call sites pass one directly.
 */
export interface AlertCustomerIdentity {
  id: string;
}

/* ==========================================================================
 * Date arithmetic — the single helper every rule and window shares
 * ========================================================================== */

/** `YYYY-MM-DD`, anchored so partial matches are rejected. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The hour of `asOf` that alert timestamps are stamped at, in UTC. */
const ALERT_TIMESTAMP_TIME_OF_DAY = 'T12:00:00.000Z';

/** Days in each month of a common year; February is corrected for leap years. */
const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Shift between the proleptic Gregorian era epoch and 1970-01-01. */
const DAYS_FROM_ERA_TO_UNIX_EPOCH = 719468;
const DAYS_PER_ERA = 146097;

/**
 * Whole days from `fromIso` to `toIso`, both `YYYY-MM-DD`, at UTC midnight.
 *
 * The one place date arithmetic happens in this feature. No rule, window, or
 * component does its own: a second implementation is how an off-by-one enters a
 * threshold comparison and never leaves.
 *
 * @throws AlertEvaluationError when either argument is not a valid calendar date.
 */
export function daysBetween(fromIso: string, toIso: string): number {
  return parseIsoDate(toIso, 'toIso') - parseIsoDate(fromIso, 'fromIso');
}

/**
 * Parses `YYYY-MM-DD` to a day number counted from the Unix epoch.
 *
 * Closed-form arithmetic (Hinnant's `days_from_civil`) rather than `Date.parse`
 * plus a `Date` allocation, because this runs once per history day per window:
 * with six windows over 120 days of history for 500 customers it is the entire
 * hot path, and the spec sets a 50ms evaluation budget. Integer day numbers also
 * remove any possibility of a daylight-saving or millisecond rounding artifact.
 */
function parseIsoDate(value: string, field: string): number {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    throw new AlertEvaluationError(field, `must be a YYYY-MM-DD date string, received ${describe(value)}`);
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

  if (month < 1 || month > 12 || day < 1) {
    throw new AlertEvaluationError(field, `must be a real calendar date, received ${describe(value)}`);
  }

  const monthLength = month === 2 && isLeapYear ? 29 : DAYS_IN_MONTH[month - 1];

  if (day > monthLength) {
    throw new AlertEvaluationError(field, `must be a real calendar date, received ${describe(value)}`);
  }

  // March-based year, so the leap day falls at the end of the cycle.
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;

  return era * DAYS_PER_ERA + dayOfEra - DAYS_FROM_ERA_TO_UNIX_EPOCH;
}

/**
 * A stable ISO timestamp for a transition observed on `asOf`.
 *
 * Midday UTC rather than the wall clock: alert identity is derived from this
 * value, and a real clock would make two evaluations of identical inputs produce
 * different `id`s.
 */
export function alertTimestampFor(asOf: string): string {
  parseIsoDate(asOf, 'asOf');
  return `${asOf}${ALERT_TIMESTAMP_TIME_OF_DAY}`;
}

/* ==========================================================================
 * Business hours — a predicate, not a delivery gate
 * ========================================================================== */

/**
 * Timezone business hours are evaluated in. A **parameter with a default**, never
 * the host's locale: a host-dependent predicate would make `Alert` equality
 * depend on the machine that produced it.
 */
export const BUSINESS_TIME_ZONE = 'UTC';

/** Mon–Fri, 09:00–17:00 inclusive of 09:00, exclusive of 17:00. */
export const BUSINESS_HOURS = Object.freeze({ startHour: 9, endHour: 17 });

const WEEKEND_WEEKDAYS: readonly string[] = ['Sat', 'Sun'];

/**
 * Whether an ISO instant falls inside business hours in `timeZone`.
 *
 * Nothing is delivered anywhere in this repository — no email, no push, no
 * webhook — so this is metadata only and **never suppresses an alert**. Hiding a
 * critical alert from a dashboard someone is actively looking at because it is
 * 6pm would be a defect, not a feature.
 */
export function isWithinBusinessHours(iso: string, timeZone: string = BUSINESS_TIME_ZONE): boolean {
  const instant = Date.parse(iso);

  if (!Number.isFinite(instant)) {
    throw new AlertEvaluationError('iso', `must be a parseable ISO timestamp, received ${describe(iso)}`);
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    hour12: false
  }).formatToParts(new Date(instant));

  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? Number.NaN);

  if (WEEKEND_WEEKDAYS.includes(weekday)) {
    return false;
  }

  return hour >= BUSINESS_HOURS.startHour && hour < BUSINESS_HOURS.endHour;
}

/* ==========================================================================
 * Rules, configuration and thresholds
 * ========================================================================== */

export type AlertRuleId =
  | 'payment-risk'
  | 'engagement-cliff'
  | 'contract-expiration-risk'
  | 'support-ticket-spike'
  | 'feature-adoption-stall';

export type AlertPriority = 'high' | 'medium';

/** Every rule's priority tier, declared once. */
export const RULE_PRIORITY: Record<AlertRuleId, AlertPriority> = Object.freeze({
  'payment-risk': 'high',
  'engagement-cliff': 'high',
  'contract-expiration-risk': 'high',
  'support-ticket-spike': 'medium',
  'feature-adoption-stall': 'medium'
});

/** Evaluation order, and the tie-break within equal priority scores. */
export const ALERT_RULE_IDS: readonly AlertRuleId[] = Object.freeze([
  'payment-risk',
  'engagement-cliff',
  'contract-expiration-risk',
  'support-ticket-spike',
  'feature-adoption-stall'
]);

/**
 * Days of daily history each rule needs before it can be evaluated at all.
 *
 * A rule with too little data is **skipped**, not answered `false`: reporting an
 * all-clear for a comparison that was never made is how a monitoring system goes
 * quietly blind. `engagement-cliff` needs 7 + 30 non-overlapping days;
 * `feature-adoption-stall` compares three consecutive 30-day windows.
 */
export const MIN_HISTORY_DAYS_FOR_RULE: Record<AlertRuleId, number> = Object.freeze({
  'payment-risk': 0,
  'engagement-cliff': 37,
  'contract-expiration-risk': 0,
  'support-ticket-spike': 7,
  'feature-adoption-stall': 90
});

/**
 * Every threshold in the engine, gathered into one injectable object.
 *
 * Exported constants are compile-time, and the requirement asks for
 * *configurable* thresholds — so `alertEngine` takes this object and reads no
 * threshold from a module constant. It makes threshold variants comparable by
 * hand; it is not an experiment framework.
 */
export interface AlertRuleConfig {
  /** Days a balance must have been outstanding before `payment-risk` fires. */
  paymentOverdueDays: number;
  /** Points of score loss that trips the drop arm of `payment-risk`. */
  scoreDropPoints: number;
  /** Nominal lookback for the score comparison, in days. */
  scoreDropWindowDays: number;
  /** Recent-versus-baseline logins/day ratio below which the cliff fires. */
  engagementCliffRatio: number;
  /** Baseline floor guarding the cliff rule against low-traffic false positives. */
  minBaselineLoginsPerDay: number;
  /** Renewal runway, in days, below which expiry risk is considered. */
  contractExpiryDays: number;
  /** Score at or above which expiry proximity is not treated as risk. */
  contractExpiryMaxScore: number;
  /** Tickets in the window that must be *exceeded* to spike. */
  ticketSpikeCount: number;
  ticketSpikeWindowDays: number;
  /** Length of each adoption comparison window, in days. */
  adoptionStallWindowDays: number;
  /** Upgrade recency, in days, that qualifies an account as growing. */
  growingAccountUpgradeDays: number;
  /** Re-notification hold-off per tier, applied only to closed → open. */
  cooldownHours: { high: number; medium: number };
  /** How long a dismissal suppresses re-opening. */
  dismissalSuppressHours: number;
}

/** The calibrated defaults. Each value is justified in the rule that reads it. */
export const DEFAULT_ALERT_RULE_CONFIG: AlertRuleConfig = Object.freeze({
  paymentOverdueDays: 30,
  scoreDropPoints: 20,
  scoreDropWindowDays: 7,
  engagementCliffRatio: 0.5,
  minBaselineLoginsPerDay: 0.15,
  contractExpiryDays: 90,
  contractExpiryMaxScore: 50,
  ticketSpikeCount: 3,
  ticketSpikeWindowDays: 7,
  adoptionStallWindowDays: 30,
  growingAccountUpgradeDays: 180,
  cooldownHours: Object.freeze({ high: 72, medium: 168 }),
  dismissalSuppressHours: 336
});

/** Used only when a caller omits `asOf` entirely; callers should pass one. */
const SIGNAL_EVALUATION_FALLBACK_DATE = '2026-09-09';

/** Tolerance around `scoreDropWindowDays` when hunting for a prior snapshot. */
export const SCORE_DROP_WINDOW_TOLERANCE_DAYS = 2;

/** Below this many days of history, engagement is excluded from the score. */
export const MINIMUM_HISTORY_DAYS = 14;

/** Engagement windows are capped at 30 days and always read as a rate. */
export const ENGAGEMENT_WINDOW_DAYS = 30;

/** Support aggregates are derived over this window. */
export const SUPPORT_WINDOW_DAYS = 90;

/** Snapshots older than this are dropped from `scoreHistory`. */
export const TREND_WINDOW_DAYS = 30;

/* ==========================================================================
 * Priority scoring
 * ========================================================================== */

/**
 * Weights of the four priority components, summing to 100.
 *
 * Severity dominates by design, so a medium alert on an enterprise account never
 * outranks a high alert on a small one. Workload balancing is served by ordering
 * *within* a tier: a queue that buries a critical small-account alert under
 * enterprise noise is worse than no ordering at all.
 */
export const PRIORITY_WEIGHTS = Object.freeze({
  severity: 40,
  value: 30,
  urgency: 20,
  recency: 10
});

/** Severity multiplier per tier. */
export const SEVERITY_WEIGHTS: Record<AlertPriority, number> = Object.freeze({ high: 1, medium: 0.5 });

/** ARR anchors for the value weight: `$1k` maps to 0, `$500k` to 1. */
export const VALUE_WEIGHT_ARR_FLOOR = 1000;
export const VALUE_WEIGHT_ARR_CEILING = 500000;

/** Days over which the recency weight decays from 1 to 0. */
export const RECENCY_DECAY_DAYS = 14;

/** Fixed urgency per rule; `contract-expiration-risk` computes its own. */
export const RULE_URGENCY_WEIGHTS: Record<AlertRuleId, number> = Object.freeze({
  'payment-risk': 1,
  'engagement-cliff': 0.8,
  'contract-expiration-risk': 1,
  'support-ticket-spike': 0.5,
  'feature-adoption-stall': 0.3
});

/** Clamps to `[0, 1]`; every unbounded weight passes through it. */
export function clampUnitInterval(value: number): number {
  if (!Number.isFinite(value)) {
    throw new AlertEvaluationError('weight', `must be a finite number, received ${describe(value)}`);
  }

  return Math.min(Math.max(value, 0), 1);
}

/**
 * Customer value as a `0..1` weight, `log10`-scaled between the ARR anchors and
 * **clamped**.
 *
 * Logarithmic because the gap between a $1k and a $10k account is real while
 * $400k versus $500k is noise. Clamped because the mapping is unbounded at both
 * ends: a $500 account computes below 0 and a $1M account above 1, which would
 * let one account claim more than its allotted 30 points.
 */
export function computeValueWeight(annualRecurringRevenue: number): number {
  if (!Number.isFinite(annualRecurringRevenue) || annualRecurringRevenue <= 0) {
    throw new AlertEvaluationError(
      'contract.annualRecurringRevenue',
      `must be a finite number greater than zero, received ${describe(annualRecurringRevenue)}`
    );
  }

  const span = Math.log10(VALUE_WEIGHT_ARR_CEILING) - Math.log10(VALUE_WEIGHT_ARR_FLOOR);
  return clampUnitInterval((Math.log10(annualRecurringRevenue) - Math.log10(VALUE_WEIGHT_ARR_FLOOR)) / span);
}

/**
 * Rule-specific urgency as a `0..1` weight.
 *
 * `contract-expiration-risk` scales with how little runway is left and is
 * clamped, so an already-expired contract lands at exactly 1.0 rather than above
 * it.
 */
export function computeUrgencyWeight(
  ruleId: AlertRuleId,
  signals: CustomerSignals,
  asOf: string,
  config: AlertRuleConfig
): number {
  if (ruleId !== 'contract-expiration-risk') {
    return clampUnitInterval(RULE_URGENCY_WEIGHTS[ruleId]);
  }

  const daysUntilRenewal = daysBetween(asOf, signals.contract.renewalDate);
  return clampUnitInterval(1 - daysUntilRenewal / config.contractExpiryDays);
}

/** Recency as a `0..1` weight: 1 on the day the pair first opened, 0 after 14 days. */
export function computeRecencyWeight(firstTriggeredAt: string, asOf: string): number {
  const ageInDays = daysBetween(firstTriggeredAt.slice(0, 10), asOf);
  return clampUnitInterval(1 - ageInDays / RECENCY_DECAY_DAYS);
}

/**
 * The `0..100` queue-ordering score: severity 40, customer value 30, urgency 20,
 * recency 10, every component clamped before it is weighted.
 */
export function computePriorityScore(parameters: {
  priority: AlertPriority;
  valueWeight: number;
  urgencyWeight: number;
  recencyWeight: number;
}): number {
  return Math.round(
    PRIORITY_WEIGHTS.severity * SEVERITY_WEIGHTS[parameters.priority] +
      PRIORITY_WEIGHTS.value * clampUnitInterval(parameters.valueWeight) +
      PRIORITY_WEIGHTS.urgency * clampUnitInterval(parameters.urgencyWeight) +
      PRIORITY_WEIGHTS.recency * clampUnitInterval(parameters.recencyWeight)
  );
}

/* ==========================================================================
 * Alert, history and monitoring state
 * ========================================================================== */

export interface Alert {
  /** `${customerId}:${ruleId}:${firstTriggeredAt}` — stable for as long as it stays open. */
  id: string;
  ruleId: AlertRuleId;
  customerId: string;
  priority: AlertPriority;
  /** `0..100`. */
  priorityScore: number;
  /** Short headline. Contains no name, email address, or dollar amount. */
  title: string;
  /** The triggering comparison, in numbers. Same redaction rules as `title`. */
  detail: string;
  /** One imperative sentence. */
  recommendedAction: string;
  /** ISO — when this (customer, rule) pair first opened. */
  firstTriggeredAt: string;
  /** ISO — the most recent transition into open. */
  triggeredAt: string;
  /** Metadata only; never gates display. */
  withinBusinessHours: boolean;
  /** Comparisons that could not be made, e.g. a missing prior score. */
  notes?: string[];
}

/**
 * A closed alert's record, retained for the session only.
 *
 * Explicitly **not** an audit trail: it is an in-memory array that dies with the
 * tab. Describing it as an audit trail would imply a durability guarantee that
 * nothing in this repository provides.
 */
export interface AlertHistoryEntry {
  alertId: string;
  ruleId: AlertRuleId;
  customerId: string;
  openedAt: string;
  closedAt: string | null;
  outcome: 'resolved' | 'dismissed' | 'actioned' | null;
}

/**
 * Session monitoring state.
 *
 * `open` and cooldown are deliberately separate concerns. `open` is what the
 * panel renders; cooldown gates only **transitions into** `open`. Conflating
 * them makes every alert appear once and then vanish on the next render.
 */
export interface MonitoringState {
  /** Currently-open alerts. Key: `${customerId}:${ruleId}`. */
  open: Record<string, Alert>;
  /** First time each pair opened — backs the stable `Alert.id`. */
  firstTriggeredAt: Record<string, string>;
  /** Last time each pair *transitioned into* open — backs cooldown. */
  lastTriggeredAt: Record<string, string>;
  dismissed: Record<string, string>;
  acknowledged: Record<string, string>;
  actioned: Record<string, string>;
  /** One snapshot per date per customer, retained by date window, not entry count. */
  scoreHistory: Record<string, Array<{ date: string; score: number }>>;
  history: AlertHistoryEntry[];
}

/** Pre-computed inputs for one customer. The engine never resolves data itself. */
export interface CustomerEvaluationInput {
  customer: AlertCustomerIdentity;
  signals: CustomerSignals;
  health: HealthScoreResult;
}

/** A rule that could not be evaluated, and what it would have needed. */
export interface SkippedRule {
  customerId: string;
  ruleId: AlertRuleId;
  /** Days of history the rule requires. */
  requiredHistoryDays: number;
  /** Days of history the customer actually has. */
  availableHistoryDays: number;
  /** Why it was skipped, safe to render verbatim. */
  reason: string;
}

export interface AlertEngineResult {
  /** Every open alert across all customers, sorted for the queue. */
  alerts: Alert[];
  /** A new state object; the argument is never mutated. */
  state: MonitoringState;
  skipped: SkippedRule[];
}

/** Composite key for a (customer, rule) pair. Never build one by hand. */
export function alertKey(customerId: string, ruleId: AlertRuleId): string {
  return `${customerId}:${ruleId}`;
}

/**
 * Thrown for malformed engine input: state, config, or signals.
 *
 * A distinct class from the calculator's `HealthScoreValidationError` on purpose
 * — borrowing that name would be a lie in a stack trace. Messages name the field
 * and the received value, and never a customer name, email address, or amount.
 */
export class AlertEvaluationError extends Error {
  public readonly field: string;

  constructor(field: string, problem: string) {
    super(`Invalid alert evaluation input at "${field}": ${problem}`);
    this.name = 'AlertEvaluationError';
    this.field = field;
  }
}

/** Renders a received value for an error message without leaking business data. */
function describe(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }

  if (typeof value === 'string') {
    return ISO_DATE_PATTERN.test(value) ? value : `a ${value.length}-character string`;
  }

  return typeof value;
}

/** An empty state, optionally seeded with score history. */
export function createMonitoringState(
  scoreHistory: Record<string, Array<{ date: string; score: number }>> = {}
): MonitoringState {
  return {
    open: {},
    firstTriggeredAt: {},
    lastTriggeredAt: {},
    dismissed: {},
    acknowledged: {},
    actioned: {},
    scoreHistory,
    history: []
  };
}

/* ==========================================================================
 * Validation
 * ========================================================================== */

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new AlertEvaluationError(field, `must be a finite number of at least zero, received ${describe(value)}`);
  }
}

/** Validates one customer's signals structurally. Absent data is not an error; malformed data is. */
export function validateCustomerSignals(signals: CustomerSignals): void {
  if (typeof signals?.customerId !== 'string' || signals.customerId.length === 0) {
    throw new AlertEvaluationError('customerId', 'must be a non-empty string');
  }

  const { payment, contract, history } = signals;

  parseIsoDate(payment?.lastPaymentDate, 'payment.lastPaymentDate');

  if (!Number.isFinite(payment.averagePaymentDelayDays)) {
    throw new AlertEvaluationError(
      'payment.averagePaymentDelayDays',
      `must be a finite number, received ${describe(payment.averagePaymentDelayDays)}`
    );
  }

  assertFiniteNonNegative(payment.overdueAmount, 'payment.overdueAmount');

  if (payment.overdueAmount > 0) {
    parseIsoDate(payment.overdueSince ?? '', 'payment.overdueSince');
  } else if (payment.overdueSince !== null) {
    throw new AlertEvaluationError('payment.overdueSince', 'must be null when there is no outstanding balance');
  }

  parseIsoDate(contract?.renewalDate, 'contract.renewalDate');

  if (!Number.isFinite(contract.annualRecurringRevenue) || contract.annualRecurringRevenue <= 0) {
    throw new AlertEvaluationError(
      'contract.annualRecurringRevenue',
      `must be a finite number greater than zero, received ${describe(contract.annualRecurringRevenue)}`
    );
  }

  if (contract.lastUpgradeDate !== null) {
    parseIsoDate(contract.lastUpgradeDate, 'contract.lastUpgradeDate');
  }

  if (!Array.isArray(history)) {
    throw new AlertEvaluationError('history', `must be an array, received ${describe(history)}`);
  }

  let previousDate = '';

  for (const day of history) {
    parseIsoDate(day?.date, 'history[].date');

    if (day.date === previousDate) {
      throw new AlertEvaluationError('history[].date', `must be unique, received a duplicate of ${day.date}`);
    }

    if (day.date < previousDate) {
      throw new AlertEvaluationError('history[].date', `must be sorted ascending, received ${day.date} out of order`);
    }

    previousDate = day.date;

    assertFiniteNonNegative(day.logins, 'history[].logins');
    assertFiniteNonNegative(day.supportTicketsOpened, 'history[].supportTicketsOpened');
    assertFiniteNonNegative(day.supportTicketsEscalated, 'history[].supportTicketsEscalated');

    if (day.supportTicketsEscalated > day.supportTicketsOpened) {
      throw new AlertEvaluationError(
        'history[].supportTicketsEscalated',
        `must not exceed supportTicketsOpened, received ${describe(day.supportTicketsEscalated)}`
      );
    }

    if (!Array.isArray(day.featuresUsed)) {
      throw new AlertEvaluationError('history[].featuresUsed', `must be an array, received ${describe(day.featuresUsed)}`);
    }

    for (const response of day.csatResponses) {
      if (!Number.isFinite(response) || response < 1 || response > 5) {
        throw new AlertEvaluationError(
          'history[].csatResponses',
          `must each be between 1 and 5, received ${describe(response)}`
        );
      }
    }

    for (const hours of day.resolutionHours) {
      assertFiniteNonNegative(hours, 'history[].resolutionHours');
    }
  }
}

/** Validates the injected config. A negative window or an out-of-range ratio is a defect, not a preference. */
export function validateAlertRuleConfig(config: AlertRuleConfig): void {
  const nonNegativeFields: Array<keyof AlertRuleConfig> = [
    'paymentOverdueDays',
    'scoreDropPoints',
    'scoreDropWindowDays',
    'contractExpiryDays',
    'contractExpiryMaxScore',
    'ticketSpikeCount',
    'ticketSpikeWindowDays',
    'adoptionStallWindowDays',
    'growingAccountUpgradeDays',
    'dismissalSuppressHours'
  ];

  for (const field of nonNegativeFields) {
    assertFiniteNonNegative(config[field] as number, `config.${field}`);
  }

  for (const field of ['engagementCliffRatio', 'minBaselineLoginsPerDay'] as const) {
    const value = config[field];

    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new AlertEvaluationError(`config.${field}`, `must be a ratio between 0 and 1, received ${describe(value)}`);
    }
  }

  assertFiniteNonNegative(config.cooldownHours?.high, 'config.cooldownHours.high');
  assertFiniteNonNegative(config.cooldownHours?.medium, 'config.cooldownHours.medium');
}

/** Validates monitoring state, including that `open` keys agree with their alerts. */
export function validateMonitoringState(state: MonitoringState): void {
  for (const field of ['open', 'firstTriggeredAt', 'lastTriggeredAt', 'dismissed', 'acknowledged', 'actioned', 'scoreHistory'] as const) {
    if (state?.[field] === null || typeof state?.[field] !== 'object') {
      throw new AlertEvaluationError(`state.${field}`, `must be an object, received ${describe(state?.[field])}`);
    }
  }

  if (!Array.isArray(state.history)) {
    throw new AlertEvaluationError('state.history', `must be an array, received ${describe(state.history)}`);
  }

  for (const [key, alert] of Object.entries(state.open)) {
    if (alertKey(alert.customerId, alert.ruleId) !== key) {
      throw new AlertEvaluationError('state.open', `key must equal "customerId:ruleId", received ${describe(key)}`);
    }
  }

  for (const [customerId, snapshots] of Object.entries(state.scoreHistory)) {
    if (!Array.isArray(snapshots)) {
      throw new AlertEvaluationError('state.scoreHistory', `must map to an array, received ${describe(snapshots)}`);
    }

    const seenDates = new Set<string>();

    for (const snapshot of snapshots) {
      parseIsoDate(snapshot?.date, 'state.scoreHistory[].date');

      if (seenDates.has(snapshot.date)) {
        throw new AlertEvaluationError(
          'state.scoreHistory[].date',
          `must hold one snapshot per date, received a duplicate of ${snapshot.date}`
        );
      }

      seenDates.add(snapshot.date);

      if (!Number.isFinite(snapshot.score)) {
        throw new AlertEvaluationError(
          'state.scoreHistory[].score',
          `must be a finite number, received ${describe(snapshot.score)}`
        );
      }
    }

    if (customerId.length === 0) {
      throw new AlertEvaluationError('state.scoreHistory', 'must be keyed by a non-empty customer id');
    }
  }
}

/* ==========================================================================
 * Window aggregates — computed once per customer, shared by every rule
 * ========================================================================== */

/** Aggregates over one date window, all derived in a single pass. */
export interface WindowAggregate {
  /** Days of history actually present in the window. */
  dayCount: number;
  logins: number;
  /** Distinct feature keys, so breadth is separable from depth. */
  distinctFeatures: string[];
  /** Total feature *touches*, which with `distinctFeatures` gives depth. */
  featureTouches: number;
  ticketsOpened: number;
  ticketsEscalated: number;
  csatResponses: number[];
  resolutionHours: number[];
}

/** One window to aggregate: `lengthDays` of history ending `offsetDays` before `asOf`. */
export interface WindowSpec {
  lengthDays: number;
  offsetDays: number;
  /**
   * Collect distinct feature keys. Default `true`; set `false` for a window whose
   * consumer only reads counts.
   */
  withFeatures?: boolean;
  /**
   * Collect the raw CSAT and resolution-hour samples. Default `true`; set `false`
   * where only ticket counts are read.
   *
   * Both flags exist because seeding runs this over 90 days thirty times per
   * customer, and collecting a set of feature keys nobody reads is the single
   * largest avoidable cost on that path.
   */
  withSupportSamples?: boolean;
}

/**
 * Aggregates several windows in **one pass** over `history`.
 *
 * The windows a customer's rules need overlap heavily — the trailing 7, the 30
 * before that, three consecutive 30s — so scanning once and testing each day
 * against every range keeps evaluation at `O(days × windows)` with a single
 * traversal, rather than one traversal per window. That is what holds the
 * spec's 50ms budget for 500 customers.
 */
export function aggregateWindows(
  history: DailySignals[],
  asOf: string,
  windows: readonly WindowSpec[]
): WindowAggregate[] {
  const asOfDay = parseIsoDate(asOf, 'asOf');
  const aggregates = windows.map(() => emptyAggregate());
  const featureSets = windows.map(() => new Set<string>());

  // `DailySignals` promises one entry per day with no gaps, so when the first
  // and last dates are exactly `length - 1` days apart every age in between is
  // implied and the per-day date parse can be skipped. Verified rather than
  // assumed: a history that turns out to have a gap falls back to parsing.
  const firstDay = history.length > 0 ? parseIsoDate(history[0].date, 'history[].date') : 0;
  const lastDay =
    history.length > 0 ? parseIsoDate(history[history.length - 1].date, 'history[].date') : 0;
  const isContiguous = history.length === 0 || lastDay - firstDay === history.length - 1;

  for (let dayIndex = 0; dayIndex < history.length; dayIndex += 1) {
    const day = history[dayIndex];
    const age = isContiguous
      ? asOfDay - (firstDay + dayIndex)
      : asOfDay - parseIsoDate(day.date, 'history[].date');

    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];

      if (age < window.offsetDays || age >= window.offsetDays + window.lengthDays) {
        continue;
      }

      const aggregate = aggregates[index];
      aggregate.dayCount += 1;
      aggregate.logins += day.logins;
      aggregate.featureTouches += day.featuresUsed.length;
      aggregate.ticketsOpened += day.supportTicketsOpened;
      aggregate.ticketsEscalated += day.supportTicketsEscalated;

      if (window.withSupportSamples !== false) {
        for (const response of day.csatResponses) {
          aggregate.csatResponses.push(response);
        }

        for (const hours of day.resolutionHours) {
          aggregate.resolutionHours.push(hours);
        }
      }

      if (window.withFeatures !== false) {
        for (const feature of day.featuresUsed) {
          featureSets[index].add(feature);
        }
      }
    }
  }

  for (let index = 0; index < aggregates.length; index += 1) {
    aggregates[index].distinctFeatures = [...featureSets[index]];
  }

  return aggregates;
}

function emptyAggregate(): WindowAggregate {
  return {
    dayCount: 0,
    logins: 0,
    distinctFeatures: [],
    featureTouches: 0,
    ticketsOpened: 0,
    ticketsEscalated: 0,
    csatResponses: [],
    resolutionHours: []
  };
}

/**
 * Aggregates the single window `[asOf - offsetDays - lengthDays, asOf - offsetDays)`.
 *
 * `offsetDays: 0` is the trailing window ending on `asOf` inclusive.
 */
export function aggregateWindow(
  history: DailySignals[],
  asOf: string,
  lengthDays: number,
  offsetDays = 0
): WindowAggregate {
  return aggregateWindows(history, asOf, [{ lengthDays, offsetDays }])[0];
}

/** Arithmetic mean, or `null` for an empty sample — never a substituted zero. */
function meanOrNull(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Adapts dated signals into the calculator's snapshot input at `asOf`.
 *
 * This is the seam between the two halves of the feature and the only place that
 * knows both shapes. Every duration is derived from `asOf`, so passing a
 * different date moves payment recency, contract runway, and the engagement and
 * support windows **together**.
 *
 * `options.hasBeenValidated` lets a caller that has already validated the same
 * immutable signals skip re-validating them. Seeding score history runs this
 * adapter once per snapshot date — thirty times per customer — and validation is
 * `O(history)` with an identical verdict every time. It is an assertion by the
 * caller, not a way to admit unchecked data: the default validates.
 *
 * Engagement is expressed as a 30-day *rate* rather than a raw total, so a
 * 20-day-old account is not penalised for having had fewer days in which to log
 * in, and is omitted entirely below {@link MINIMUM_HISTORY_DAYS} — under two
 * weeks there is no usage pattern to read, and inventing one drags every new
 * customer toward the warning band.
 */
export function deriveHealthScoreInput(
  signals: CustomerSignals,
  asOf: string,
  options: { hasBeenValidated?: boolean } = {}
): HealthScoreInput {
  if (options.hasBeenValidated !== true) {
    validateCustomerSignals(signals);
  }

  const historyDays = countHistoryDaysThrough(signals.history, asOf);
  const engagementWindowDays = Math.min(ENGAGEMENT_WINDOW_DAYS, Math.max(historyDays, 1));
  const [engagementWindow, supportWindow] = aggregateWindows(signals.history, asOf, [
    { lengthDays: engagementWindowDays, offsetDays: 0, withSupportSamples: false },
    { lengthDays: SUPPORT_WINDOW_DAYS, offsetDays: 0, withFeatures: false }
  ]);
  const observedDays = Math.max(engagementWindow.dayCount, 1);

  const satisfactionScore = meanOrNull(supportWindow.csatResponses);
  const averageResolutionTimeHours = meanOrNull(supportWindow.resolutionHours);
  const hasSupportData = satisfactionScore !== null || averageResolutionTimeHours !== null;

  // A payment or a balance dated *after* `asOf` had not happened yet at that
  // date, so the signal is treated as unknown rather than as a negative age.
  // This is what keeps a retrospective evaluation honest, and it is the reason
  // score history can be seeded at all.
  const daysSinceLastPayment = daysBetween(signals.payment.lastPaymentDate, asOf);
  const overdueHasStarted =
    signals.payment.overdueSince !== null && daysBetween(signals.payment.overdueSince, asOf) >= 0;

  const input: HealthScoreInput = {
    payment: {
      daysSinceLastPayment: daysSinceLastPayment >= 0 ? daysSinceLastPayment : null,
      averagePaymentDelayDays: signals.payment.averagePaymentDelayDays,
      overdueAmount: overdueHasStarted ? signals.payment.overdueAmount : 0
    },
    contract: {
      daysUntilRenewal: daysBetween(asOf, signals.contract.renewalDate),
      contractValue: signals.contract.annualRecurringRevenue,
      recentUpgradeCount: isRecentUpgrade(signals.contract.lastUpgradeDate, asOf) ? 1 : 0,
      recentDowngradeCount: 0
    },
    tenureDays: historyDays,
    billingCycleDays: null
  };

  if (historyDays >= MINIMUM_HISTORY_DAYS) {
    input.engagement = {
      loginsLast30Days: roundToOneDecimal((engagementWindow.logins / observedDays) * ENGAGEMENT_WINDOW_DAYS),
      featureUsageCount: engagementWindow.distinctFeatures.length,
      supportTicketsLast30Days: roundToOneDecimal(
        (engagementWindow.ticketsOpened / observedDays) * ENGAGEMENT_WINDOW_DAYS
      )
    };
  }

  if (hasSupportData) {
    input.support = {
      satisfactionScore,
      averageResolutionTimeHours,
      escalationCount: supportWindow.ticketsEscalated
    };
  }

  return input;
}

/**
 * Days of history a customer has **as at `asOf`**, ignoring anything dated after
 * it.
 *
 * Counting `history.length` instead would let a customer appear to have had 90
 * days of history a month before those days happened, which is how a
 * retrospective evaluation quietly scores data from the future.
 */
export function countHistoryDaysThrough(history: DailySignals[], asOf: string): number {
  return history.filter((day) => day.date <= asOf).length;
}

/** An upgrade inside the last year counts as recent momentum for the calculator. */
const RECENT_UPGRADE_DAYS = 365;

function isRecentUpgrade(lastUpgradeDate: string | null, asOf: string): boolean {
  return lastUpgradeDate !== null && daysBetween(lastUpgradeDate, asOf) <= RECENT_UPGRADE_DAYS;
}

/**
 * Whether a health result carries a score that a threshold comparison may use.
 *
 * A result with no score, or one the calculator declined to band for want of
 * evidence, is **not** treated as satisfying "score below 50". A confident
 * threshold comparison against absent evidence is the failure mode this guards.
 */
export function hasComparableScore(health: HealthScoreResult): health is HealthScoreResult & { score: number } {
  return health.score !== null && health.riskLevel !== 'unknown';
}

/* ==========================================================================
 * The five rules
 * ========================================================================== */

/** What a rule returns when it has enough data to answer. */
interface RuleEvaluation {
  fires: boolean;
  title: string;
  detail: string;
  recommendedAction: string;
  notes: string[];
}

/** Everything a rule needs, computed once per customer. */
interface RuleContext {
  input: CustomerEvaluationInput;
  asOf: string;
  config: AlertRuleConfig;
  /** Trailing `ticketSpikeWindowDays`. */
  spikeWindow: WindowAggregate;
  /** Trailing 7 days, for the cliff's recent arm. */
  cliffRecentWindow: WindowAggregate;
  /** The 30 days ending 7 days ago — non-overlapping with the recent window. */
  cliffBaselineWindow: WindowAggregate;
  /** Trailing 30 / 31-60 / 61-90 day adoption windows. */
  adoptionWindows: [WindowAggregate, WindowAggregate, WindowAggregate];
  scoreSnapshots: Array<{ date: string; score: number }>;
}

/** The cliff's recent arm is fixed at 7 days; the baseline is the 30 before it. */
const CLIFF_RECENT_WINDOW_DAYS = 7;

const NO_FIRE_TITLE = '';

function notFiring(): RuleEvaluation {
  return { fires: false, title: NO_FIRE_TITLE, detail: '', recommendedAction: '', notes: [] };
}

/**
 * **Payment risk** (high) — a balance outstanding longer than
 * `paymentOverdueDays`, **or** a score drop beyond `scoreDropPoints` against the
 * snapshot recorded `scoreDropWindowDays` ago.
 *
 * "Overdue >30 days" is read as *the balance* having been outstanding 30 days,
 * which is what `overdueSince` records — a customer can pay on time every month
 * and still carry a disputed balance, so days-since-last-payment answers a
 * different question.
 *
 * When no prior snapshot exists in the tolerance window the drop arm is
 * **skipped and noted**, never assumed false.
 */
export function evaluatePaymentRisk(context: RuleContext): RuleEvaluation {
  const { asOf, config } = context;
  const { payment } = context.input.signals;
  const notes: string[] = [];

  const overdueDays =
    payment.overdueAmount > 0 && payment.overdueSince !== null ? daysBetween(payment.overdueSince, asOf) : null;
  const arrearsFires = overdueDays !== null && overdueDays > config.paymentOverdueDays;

  const priorSnapshot = findPriorSnapshot(context.scoreSnapshots, asOf, config.scoreDropWindowDays);
  const health = context.input.health;
  let dropFires = false;
  let dropPoints: number | null = null;

  if (priorSnapshot === null || !hasComparableScore(health)) {
    notes.push(
      `${config.scoreDropWindowDays}-day score comparison unavailable — the drop arm of this rule was not evaluated`
    );
  } else {
    dropPoints = priorSnapshot.score - health.score;
    dropFires = dropPoints > config.scoreDropPoints;
  }

  if (!arrearsFires && !dropFires) {
    return { ...notFiring(), notes };
  }

  const title = arrearsFires
    ? `Balance outstanding ${overdueDays} days`
    : `Health score down ${Math.round(dropPoints ?? 0)} points in ${config.scoreDropWindowDays} days`;

  const detailParts: string[] = [];

  if (arrearsFires) {
    detailParts.push(`Outstanding balance is ${overdueDays} days old against a ${config.paymentOverdueDays}-day threshold`);
  }

  if (dropFires && dropPoints !== null) {
    detailParts.push(
      `Score moved from ${Math.round(priorSnapshot?.score ?? 0)} to ${Math.round(health.score ?? 0)}, a drop of ${Math.round(dropPoints)} points against a ${config.scoreDropPoints}-point threshold`
    );
  }

  return {
    fires: true,
    title,
    detail: detailParts.join('. '),
    recommendedAction: 'Contact the account owner in billing to confirm the balance and agree a payment date.',
    notes
  };
}

/** The prior snapshot nearest the nominal lookback, within the tolerance window. */
function findPriorSnapshot(
  snapshots: Array<{ date: string; score: number }>,
  asOf: string,
  windowDays: number
): { date: string; score: number } | null {
  const lowerBound = windowDays - SCORE_DROP_WINDOW_TOLERANCE_DAYS;
  const upperBound = windowDays + SCORE_DROP_WINDOW_TOLERANCE_DAYS;
  let best: { date: string; score: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const snapshot of snapshots) {
    const age = daysBetween(snapshot.date, asOf);

    if (age < lowerBound || age > upperBound) {
      continue;
    }

    const distance = Math.abs(age - windowDays);

    if (distance < bestDistance) {
      best = snapshot;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * **Engagement cliff** (high) — logins/day over the trailing 7 days below
 * `engagementCliffRatio` of logins/day over the **preceding, non-overlapping** 30
 * days.
 *
 * Non-overlapping so the baseline is not diluted by the very drop it is meant to
 * detect. Guarded by `minBaselineLoginsPerDay`: without the floor, an account
 * that logged in twice a month and now logs in once trips a "cliff", which is
 * this rule's largest false-positive source.
 *
 * A *gradual* decline moves both windows together, correctly does not fire here,
 * and surfaces instead as a declining trend on the health display.
 */
export function evaluateEngagementCliff(context: RuleContext): RuleEvaluation {
  const { config } = context;

  // No days observed in either window means there is nothing to compare, which
  // is not the same as a collapse: an account whose history simply stops short
  // of `asOf` would otherwise read as having dropped to zero logins.
  if (context.cliffRecentWindow.dayCount === 0 || context.cliffBaselineWindow.dayCount === 0) {
    return notFiring();
  }

  const recentDays = Math.max(context.cliffRecentWindow.dayCount, 1);
  const baselineDays = Math.max(context.cliffBaselineWindow.dayCount, 1);
  const recentRate = context.cliffRecentWindow.logins / recentDays;
  const baselineRate = context.cliffBaselineWindow.logins / baselineDays;

  if (baselineRate < config.minBaselineLoginsPerDay) {
    return notFiring();
  }

  if (recentRate >= config.engagementCliffRatio * baselineRate) {
    return notFiring();
  }

  const dropPercentage = Math.round((1 - recentRate / baselineRate) * 100);

  return {
    fires: true,
    title: `Logins down ${dropPercentage}% against the 30-day baseline`,
    detail: `${roundToOneDecimal(recentRate)} logins/day over the trailing ${CLIFF_RECENT_WINDOW_DAYS} days against ${roundToOneDecimal(baselineRate)} logins/day over the preceding ${ENGAGEMENT_WINDOW_DAYS}, below the ${Math.round(config.engagementCliffRatio * 100)}% threshold`,
    recommendedAction: 'Book a check-in with the day-to-day users to find out what changed.',
    notes: []
  };
}

/**
 * **Contract expiration risk** (high) — renewal runway under
 * `contractExpiryDays` **and** a score under `contractExpiryMaxScore`.
 *
 * Expired contracts are **included**: a negative day count satisfies "< 90", and
 * excluding them left the worst-off account in the portfolio — lapsed contract,
 * lowest score — generating no alerts at all. Requires a comparable score; an
 * unscored customer cannot satisfy "score below 50" and must not be treated as
 * if it does.
 */
export function evaluateContractExpirationRisk(context: RuleContext): RuleEvaluation {
  const { asOf, config } = context;
  const health = context.input.health;

  if (!hasComparableScore(health)) {
    return notFiring();
  }

  const daysUntilRenewal = daysBetween(asOf, context.input.signals.contract.renewalDate);

  if (daysUntilRenewal >= config.contractExpiryDays || health.score >= config.contractExpiryMaxScore) {
    return notFiring();
  }

  const runwayDescription =
    daysUntilRenewal < 0 ? `expired ${Math.abs(daysUntilRenewal)} days ago` : `renews in ${daysUntilRenewal} days`;

  return {
    fires: true,
    title: `Contract ${runwayDescription} at score ${health.score}`,
    detail: `Renewal runway is ${daysUntilRenewal} days against a ${config.contractExpiryDays}-day threshold, with a health score of ${health.score} against a ceiling of ${config.contractExpiryMaxScore}`,
    recommendedAction: 'Escalate to the renewal owner and agree a save plan this week.',
    notes: []
  };
}

/**
 * **Support ticket spike** (medium) — more than `ticketSpikeCount` tickets opened
 * in the trailing window, **or** any escalated ticket in it.
 *
 * The escalation arm makes a single escalated ticket sufficient, which is noisy
 * by the requirement's own design. Kept as specified; the medium-tier cooldown is
 * what makes it tolerable.
 */
export function evaluateSupportTicketSpike(context: RuleContext): RuleEvaluation {
  const { config } = context;
  const { ticketsOpened, ticketsEscalated } = context.spikeWindow;
  const volumeFires = ticketsOpened > config.ticketSpikeCount;
  const escalationFires = ticketsEscalated > 0;

  if (!volumeFires && !escalationFires) {
    return notFiring();
  }

  const title = volumeFires
    ? `${ticketsOpened} tickets opened in ${config.ticketSpikeWindowDays} days`
    : `Ticket escalated in the last ${config.ticketSpikeWindowDays} days`;

  return {
    fires: true,
    title,
    detail: `${ticketsOpened} tickets opened and ${ticketsEscalated} escalated over the trailing ${config.ticketSpikeWindowDays} days, against a threshold of more than ${config.ticketSpikeCount} opened or any escalation`,
    recommendedAction: 'Review the open tickets with support and confirm an owner for the escalation.',
    notes: []
  };
}

/**
 * **Feature adoption stall** (medium) — no feature key in the trailing 30 days
 * that was absent from the preceding 30, **and** the account is growing.
 *
 * "Growing account" is undefined in the requirements. Defined here as an upgrade
 * within `growingAccountUpgradeDays`, **or** distinct-feature count in days 31-60
 * exceeding days 61-90. A stalled account that is not growing is a different
 * conversation and does not belong in this queue.
 *
 * The detail reports usage *depth* — mean touches per distinct feature — as
 * context. Depth is deliberately reported and not scored: the engagement factor
 * scores breadth only.
 */
export function evaluateFeatureAdoptionStall(context: RuleContext): RuleEvaluation {
  const { config, asOf } = context;
  const [recent, previous, earliest] = context.adoptionWindows;
  const previousFeatures = new Set(previous.distinctFeatures);
  const newFeatures = recent.distinctFeatures.filter((feature) => !previousFeatures.has(feature));

  if (newFeatures.length > 0) {
    return notFiring();
  }

  const lastUpgradeDate = context.input.signals.contract.lastUpgradeDate;
  const upgradedRecently =
    lastUpgradeDate !== null && daysBetween(lastUpgradeDate, asOf) <= config.growingAccountUpgradeDays;
  const broadeningAdoption = previous.distinctFeatures.length > earliest.distinctFeatures.length;

  if (!upgradedRecently && !broadeningAdoption) {
    return notFiring();
  }

  const depth =
    recent.distinctFeatures.length === 0
      ? 0
      : roundToOneDecimal(recent.featureTouches / recent.distinctFeatures.length);

  return {
    fires: true,
    title: `No new features adopted in ${config.adoptionStallWindowDays} days`,
    detail: `${recent.distinctFeatures.length} distinct features used in the trailing ${config.adoptionStallWindowDays} days, none of them new, at a depth of ${depth} touches per feature. Account qualifies as growing (${upgradedRecently ? 'recent upgrade' : 'broadening adoption'})`,
    recommendedAction: 'Send the expansion team in with a walkthrough of the features this account has never opened.',
    notes: []
  };
}

const RULE_EVALUATORS: Record<AlertRuleId, (context: RuleContext) => RuleEvaluation> = {
  'payment-risk': evaluatePaymentRisk,
  'engagement-cliff': evaluateEngagementCliff,
  'contract-expiration-risk': evaluateContractExpirationRisk,
  'support-ticket-spike': evaluateSupportTicketSpike,
  'feature-adoption-stall': evaluateFeatureAdoptionStall
};

/* ==========================================================================
 * The engine
 * ========================================================================== */

const HOURS_TO_MILLISECONDS = 60 * 60 * 1000;

/** Hours between two ISO instants, for the cooldown and suppression windows. */
function hoursBetweenInstants(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new AlertEvaluationError('timestamp', 'must be a parseable ISO timestamp');
  }

  return (to - from) / HOURS_TO_MILLISECONDS;
}

/**
 * Evaluates every rule against every customer and folds the results into new
 * monitoring state.
 *
 * Takes **pre-computed** inputs rather than customer ids: resolving signals here
 * would hard-wire this library to the mock data module it is meant to outlive.
 *
 * Transitions:
 * - true and not open → **opens**, subject to cooldown and dismissal suppression
 * - true and already open → **stays** open with its original `id` and
 *   `firstTriggeredAt`, and cooldown is *not* consulted
 * - false and open → **closes**, appending one history entry with `'resolved'`
 *
 * Neither `state`, `inputs`, nor `config` is mutated; the returned state is a new
 * object throughout, so callers may deep-freeze the arguments.
 */
export function alertEngine(
  inputs: CustomerEvaluationInput[],
  state: MonitoringState,
  asOf: string = SIGNAL_EVALUATION_FALLBACK_DATE,
  config: AlertRuleConfig = DEFAULT_ALERT_RULE_CONFIG
): AlertEngineResult {
  validateAlertRuleConfig(config);
  validateMonitoringState(state);
  parseIsoDate(asOf, 'asOf');

  const observedAt = alertTimestampFor(asOf);
  const withinBusinessHours = isWithinBusinessHours(observedAt);

  const open: Record<string, Alert> = {};
  const firstTriggeredAt: Record<string, string> = { ...state.firstTriggeredAt };
  const lastTriggeredAt: Record<string, string> = { ...state.lastTriggeredAt };
  const scoreHistory: Record<string, Array<{ date: string; score: number }>> = {};
  const history: AlertHistoryEntry[] = [...state.history];
  const skipped: SkippedRule[] = [];
  const evaluatedKeys = new Set<string>();

  for (const [customerId, snapshots] of Object.entries(state.scoreHistory)) {
    scoreHistory[customerId] = snapshots.map((snapshot) => ({ ...snapshot }));
  }

  for (const input of inputs) {
    validateCustomerSignals(input.signals);

    const customerId = input.customer.id;
    const historyDays = countHistoryDaysThrough(input.signals.history, asOf);
    // Every window this customer's rules need, in one traversal of `history`.
    const [spikeWindow, cliffRecentWindow, cliffBaselineWindow, recentAdoption, previousAdoption, earliestAdoption] =
      aggregateWindows(input.signals.history, asOf, [
        { lengthDays: config.ticketSpikeWindowDays, offsetDays: 0, withFeatures: false, withSupportSamples: false },
        { lengthDays: CLIFF_RECENT_WINDOW_DAYS, offsetDays: 0, withFeatures: false, withSupportSamples: false },
        {
          lengthDays: ENGAGEMENT_WINDOW_DAYS,
          offsetDays: CLIFF_RECENT_WINDOW_DAYS,
          withFeatures: false,
          withSupportSamples: false
        },
        { lengthDays: config.adoptionStallWindowDays, offsetDays: 0, withSupportSamples: false },
        {
          lengthDays: config.adoptionStallWindowDays,
          offsetDays: config.adoptionStallWindowDays,
          withSupportSamples: false
        },
        {
          lengthDays: config.adoptionStallWindowDays,
          offsetDays: config.adoptionStallWindowDays * 2,
          withSupportSamples: false
        }
      ]);

    const context: RuleContext = {
      input,
      asOf,
      config,
      spikeWindow,
      cliffRecentWindow,
      cliffBaselineWindow,
      adoptionWindows: [recentAdoption, previousAdoption, earliestAdoption],
      scoreSnapshots: scoreHistory[customerId] ?? []
    };

    scoreHistory[customerId] = appendScoreSnapshot(context.scoreSnapshots, asOf, input.health);

    for (const ruleId of ALERT_RULE_IDS) {
      const key = alertKey(customerId, ruleId);
      const requiredHistoryDays = MIN_HISTORY_DAYS_FOR_RULE[ruleId];

      if (historyDays < requiredHistoryDays) {
        skipped.push({
          customerId,
          ruleId,
          requiredHistoryDays,
          availableHistoryDays: historyDays,
          reason: `not evaluated — needs ${requiredHistoryDays} days of history, has ${historyDays}`
        });
        continue;
      }

      evaluatedKeys.add(key);

      const evaluation = RULE_EVALUATORS[ruleId](context);
      const existing = state.open[key];

      if (!evaluation.fires) {
        if (existing !== undefined) {
          history.push(closeEntry(existing, observedAt, 'resolved'));
        }
        continue;
      }

      if (existing !== undefined) {
        // Already open: identity is preserved and cooldown is not consulted.
        open[key] = {
          ...existing,
          priorityScore: computePriorityScore({
            priority: existing.priority,
            valueWeight: computeValueWeight(input.signals.contract.annualRecurringRevenue),
            urgencyWeight: computeUrgencyWeight(ruleId, input.signals, asOf, config),
            recencyWeight: computeRecencyWeight(existing.firstTriggeredAt, asOf)
          }),
          title: evaluation.title,
          detail: evaluation.detail,
          recommendedAction: evaluation.recommendedAction,
          withinBusinessHours,
          ...(evaluation.notes.length > 0 ? { notes: evaluation.notes } : {})
        };
        continue;
      }

      const priority = RULE_PRIORITY[ruleId];
      const dismissedAt = state.dismissed[key];

      if (dismissedAt !== undefined && hoursBetweenInstants(dismissedAt, observedAt) < config.dismissalSuppressHours) {
        continue;
      }

      const previousTrigger = lastTriggeredAt[key];

      if (
        previousTrigger !== undefined &&
        hoursBetweenInstants(previousTrigger, observedAt) < config.cooldownHours[priority]
      ) {
        continue;
      }

      const openedFirstAt = firstTriggeredAt[key] ?? observedAt;
      firstTriggeredAt[key] = openedFirstAt;
      lastTriggeredAt[key] = observedAt;

      open[key] = {
        id: `${customerId}:${ruleId}:${openedFirstAt}`,
        ruleId,
        customerId,
        priority,
        priorityScore: computePriorityScore({
          priority,
          valueWeight: computeValueWeight(input.signals.contract.annualRecurringRevenue),
          urgencyWeight: computeUrgencyWeight(ruleId, input.signals, asOf, config),
          recencyWeight: computeRecencyWeight(openedFirstAt, asOf)
        }),
        title: evaluation.title,
        detail: evaluation.detail,
        recommendedAction: evaluation.recommendedAction,
        firstTriggeredAt: openedFirstAt,
        triggeredAt: observedAt,
        withinBusinessHours,
        ...(evaluation.notes.length > 0 ? { notes: evaluation.notes } : {})
      };
    }
  }

  // An alert whose customer was not in `inputs` at all is neither resolved nor
  // discarded: it stays open, because nothing was observed to close it.
  for (const [key, alert] of Object.entries(state.open)) {
    if (!evaluatedKeys.has(key) && open[key] === undefined) {
      open[key] = alert;
    }
  }

  return {
    alerts: sortAlerts(Object.values(open)),
    state: {
      open,
      firstTriggeredAt,
      lastTriggeredAt,
      dismissed: { ...state.dismissed },
      acknowledged: { ...state.acknowledged },
      actioned: { ...state.actioned },
      scoreHistory,
      history
    },
    skipped
  };
}

/**
 * Adds today's score to a customer's history, keyed **by date** so repeated
 * evaluations on the same day are idempotent rather than filling the window with
 * same-day duplicates and hiding the 7-day-prior score.
 */
export function appendScoreSnapshot(
  snapshots: Array<{ date: string; score: number }>,
  asOf: string,
  health: HealthScoreResult
): Array<{ date: string; score: number }> {
  const retained = snapshots
    .filter((snapshot) => snapshot.date !== asOf && daysBetween(snapshot.date, asOf) <= TREND_WINDOW_DAYS)
    .map((snapshot) => ({ ...snapshot }));

  if (hasComparableScore(health)) {
    retained.push({ date: asOf, score: health.score });
  }

  return retained.sort((left, right) => (left.date < right.date ? -1 : 1));
}

function closeEntry(alert: Alert, closedAt: string, outcome: AlertHistoryEntry['outcome']): AlertHistoryEntry {
  return {
    alertId: alert.id,
    ruleId: alert.ruleId,
    customerId: alert.customerId,
    openedAt: alert.firstTriggeredAt,
    closedAt,
    outcome
  };
}

/**
 * Queue order: high before medium, then `priorityScore` descending, then rule id
 * for a stable total order.
 */
export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority === 'high' ? -1 : 1;
    }

    if (left.priorityScore !== right.priorityScore) {
      return right.priorityScore - left.priorityScore;
    }

    return left.id < right.id ? -1 : 1;
  });
}

/* ==========================================================================
 * Monitoring state reducer — owned by the Dashboard, defined here
 * ========================================================================== */

export type MonitoringAction =
  | { type: 'evaluate'; inputs: CustomerEvaluationInput[]; asOf: string; config?: AlertRuleConfig }
  | { type: 'acknowledge'; customerId: string; ruleId: AlertRuleId; at: string }
  | { type: 'markActioned'; customerId: string; ruleId: AlertRuleId; at: string }
  | { type: 'dismiss'; customerId: string; ruleId: AlertRuleId; at: string };

/**
 * Pure reducer over {@link MonitoringState}, so the Dashboard can own monitoring
 * state with `useReducer` while every transition stays testable in plain Node.
 *
 * Acknowledgement leaves an alert open — it records that a human has seen it.
 * Marking actioned and dismissing both **close** it and append exactly one
 * history entry with the matching outcome. All three are session-lifetime only.
 */
export function monitoringStateReducer(state: MonitoringState, action: MonitoringAction): MonitoringState {
  if (action.type === 'evaluate') {
    return alertEngine(action.inputs, state, action.asOf, action.config).state;
  }

  const key = alertKey(action.customerId, action.ruleId);
  const alert = state.open[key];

  if (action.type === 'acknowledge') {
    return { ...state, acknowledged: { ...state.acknowledged, [key]: action.at } };
  }

  if (alert === undefined) {
    return state;
  }

  const outcome = action.type === 'dismiss' ? 'dismissed' : 'actioned';
  const open = { ...state.open };
  delete open[key];

  return {
    ...state,
    open,
    dismissed: action.type === 'dismiss' ? { ...state.dismissed, [key]: action.at } : { ...state.dismissed },
    actioned: action.type === 'markActioned' ? { ...state.actioned, [key]: action.at } : { ...state.actioned },
    history: [...state.history, closeEntry(alert, action.at, outcome)]
  };
}

/* ==========================================================================
 * Convenience derivations for the panel
 * ========================================================================== */

/** Session counts the panel header shows, labelled there as session-only. */
export interface MonitoringCounts {
  high: number;
  medium: number;
  opened: number;
  acknowledged: number;
  actioned: number;
}

/** Derives the header counts from state. `opened` counts distinct pairs ever opened. */
export function summarizeMonitoringState(state: MonitoringState): MonitoringCounts {
  const openAlerts = Object.values(state.open);

  return {
    high: openAlerts.filter((alert) => alert.priority === 'high').length,
    medium: openAlerts.filter((alert) => alert.priority === 'medium').length,
    opened: Object.keys(state.firstTriggeredAt).length,
    acknowledged: Object.keys(state.acknowledged).length,
    actioned: Object.keys(state.actioned).length
  };
}

/** CSV column order, shared by the header row and the body rows. */
export const ALERT_CSV_COLUMNS: readonly string[] = Object.freeze([
  'customerId',
  'ruleId',
  'priority',
  'priorityScore',
  'title',
  'detail',
  'recommendedAction',
  'firstTriggeredAt',
  'triggeredAt'
]);

/** Escapes one CSV field: quote-wrapped, with embedded quotes doubled. */
function toCsvField(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Serializes alerts to CSV.
 *
 * Carries exactly the fields already on screen — `customerId`, never a name or
 * an email address — so an exported file cannot leak more than the panel does.
 */
export function alertsToCsv(alerts: Alert[]): string {
  const rows = alerts.map((alert) =>
    [
      alert.customerId,
      alert.ruleId,
      alert.priority,
      alert.priorityScore,
      alert.title,
      alert.detail,
      alert.recommendedAction,
      alert.firstTriggeredAt,
      alert.triggeredAt
    ]
      .map(toCsvField)
      .join(',')
  );

  return [ALERT_CSV_COLUMNS.map(toCsvField).join(','), ...rows].join('\n');
}

/**
 * Scores one customer at `asOf` from dated signals.
 *
 * A thin composition of {@link deriveHealthScoreInput} and the calculator,
 * exported so the panel, the health display, and score-history seeding all reach
 * the same number by the same route.
 */
export function scoreCustomerAt(
  signals: CustomerSignals,
  asOf: string,
  options: { hasBeenValidated?: boolean } = {}
): HealthScoreResult {
  return calculateHealthScore(deriveHealthScoreInput(signals, asOf, options));
}
