/**
 * The two rules the shipped engine does not carry, plus this feature's ranking.
 *
 * `src/lib/alerts.ts` implements five rules and is not this feature's to edit, so
 * `engagement-decline-trend` (gradual disengagement) and `market-sentiment-risk`
 * (the external evidence stream) live here instead. Everything in this module is
 * **pure**: no clock, no network, no storage. `now` and the market payload arrive
 * as arguments, exactly as they do for the shipped rules.
 *
 * Ranking also lives here rather than in the engine, because this feature's
 * `priorityScore` has a documented 20–100 range and takes its recency term from
 * server-side `priorState` — neither of which the shipped scorer knows about.
 */

import {
  daysBetween,
  type AlertPriority,
  type CustomerSignals,
  type DailySignals,
} from '@/lib/alerts';
import type { PredictiveThresholds } from '@/server/alertThresholds';
import type {
  AlertEvidence,
  MarketSignal,
  PredictiveRuleId,
  SkippedClause,
} from '@/types/predictive-intelligence';

/** ARR at which the value component of the score saturates. */
export const VALUE_SATURATION_ARR = 250_000;

/** Points contributed by each component of `priorityScore`. */
export const SCORE_COMPONENTS = Object.freeze({
  highBase: 50,
  mediumBase: 20,
  valueMax: 20,
  urgencyMax: 20,
  recencyMax: 10,
});

/** Hours over which the recency component decays to zero. */
export const RECENCY_DECAY_HOURS = 168;

/** The attainable score range. A medium alert at zero on everything still scores 20. */
export const MIN_PRIORITY_SCORE = SCORE_COMPONENTS.mediumBase;
export const MAX_PRIORITY_SCORE =
  SCORE_COMPONENTS.highBase + SCORE_COMPONENTS.valueMax + SCORE_COMPONENTS.urgencyMax + SCORE_COMPONENTS.recencyMax;

/** What a rule in this module produces when it fires. */
export interface PredictiveRuleResult {
  ruleId: PredictiveRuleId;
  priority: AlertPriority;
  /** 0..1 normalized breach magnitude. */
  severity: number;
  /** Which clause fired; drives the title so a heading never names the wrong problem. */
  triggeredClause: string;
  title: string;
  message: string;
  recommendedActions: string[];
  evidence: AlertEvidence[];
}

/**
 * A rule's verdict.
 *
 * `fired` and `skipped` are independent: a rule may fire on one clause while
 * reporting another as unevaluable. Treating them as exclusive is how a real
 * alert gets thrown away because a secondary comparison had no data.
 */
export interface PredictiveRuleOutcome {
  fired: PredictiveRuleResult | null;
  skipped: SkippedClause[];
}

/** Everything the rules in this module read. */
export interface PredictiveRuleInput {
  customerId: string;
  /** The dashboard's displayed score — the single source of truth for every gate. */
  healthScore: number;
  signals: CustomerSignals;
  /** `null` means *unavailable*, and is never read as neutral-good. */
  market: MarketSignal | null;
  thresholds: PredictiveThresholds;
  /** `YYYY-MM-DD`, derived from the service's injected clock. */
  asOf: string;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Sums logins in a bucket of days ending `offsetDays` before `asOf`.
 *
 * @returns The login total, and how many dated days the bucket actually covered.
 */
function loginsInBucket(
  history: readonly DailySignals[],
  asOf: string,
  offsetDays: number,
  lengthDays: number
): { logins: number; dayCount: number } {
  let logins = 0;
  let dayCount = 0;

  for (const day of history) {
    const age = daysBetween(day.date, asOf);
    if (age >= offsetDays && age < offsetDays + lengthDays) {
      logins += day.logins;
      dayCount += 1;
    }
  }

  return { logins, dayCount };
}

/**
 * **Engagement decline trend** (medium) — gradual disengagement.
 *
 * Three consecutive buckets of `bucketDays`, oldest to newest, must be strictly
 * decreasing and give up at least `minTotalDropRatio` of the oldest bucket.
 * Medium priority on purpose: a slow slide is a monitor-closely signal, not an
 * interrupt. The caller suppresses it when `engagement-cliff` fired for the same
 * customer, so one deteriorating account never produces two engagement alerts.
 *
 * The low-volume guard is an **absolute count**, not a rate: a rate guard set
 * high enough to be meaningful silences the ordinary two-or-three-times-a-week
 * user entirely.
 */
export function evaluateEngagementDeclineTrend(input: PredictiveRuleInput): PredictiveRuleOutcome {
  const { bucketDays, minTotalDropRatio, minBaselineLogins } = input.thresholds.engagementTrend;
  const skipped: SkippedClause[] = [];

  const newest = loginsInBucket(input.signals.history, input.asOf, 0, bucketDays);
  const middle = loginsInBucket(input.signals.history, input.asOf, bucketDays, bucketDays);
  const oldest = loginsInBucket(input.signals.history, input.asOf, bucketDays * 2, bucketDays);

  const coveredDays = newest.dayCount + middle.dayCount + oldest.dayCount;
  if (coveredDays < bucketDays * 3) {
    skipped.push({
      customerId: input.customerId,
      ruleId: 'engagement-decline-trend',
      clause: 'buckets',
      reason: `needs ${bucketDays * 3} days of history, has ${coveredDays}`,
    });
    return { fired: null, skipped };
  }

  if (oldest.logins < minBaselineLogins) {
    skipped.push({
      customerId: input.customerId,
      ruleId: 'engagement-decline-trend',
      clause: 'buckets',
      reason: `baseline of ${oldest.logins} logins is below the ${minBaselineLogins}-login floor for a meaningful ratio`,
    });
    return { fired: null, skipped };
  }

  const strictlyDecreasing = oldest.logins > middle.logins && middle.logins > newest.logins;
  const dropRatio = (oldest.logins - newest.logins) / oldest.logins;

  if (!strictlyDecreasing || dropRatio < minTotalDropRatio) {
    return { fired: null, skipped };
  }

  const dropPercentage = Math.round(dropRatio * 100);

  return {
    skipped,
    fired: {
      ruleId: 'engagement-decline-trend',
      priority: 'medium',
      severity: clampUnit(dropRatio),
      triggeredClause: 'loginTrend',
      title: `Logins declining steadily — down ${dropPercentage}% over ${bucketDays * 3} days`,
      message: `Logins fell across three consecutive ${bucketDays}-day periods, from ${oldest.logins} to ${middle.logins} to ${newest.logins}, a ${dropPercentage}% decline. This is a gradual slide rather than a sudden stop.`,
      recommendedActions: [
        'Review which teams have stopped logging in and confirm they still have a use case.',
        'Offer a refresher session on the workflows this account adopted first.',
        'Check whether a champion has left the account.',
      ],
      evidence: [
        { label: 'Logins, oldest period', value: String(oldest.logins) },
        { label: 'Logins, middle period', value: String(middle.logins) },
        { label: 'Logins, most recent period', value: String(newest.logins) },
        { label: 'Total decline', value: `${dropPercentage}%` },
      ],
    },
  };
}

/**
 * **Market sentiment risk** (medium) — negative external coverage on a customer
 * whose health is already below the ceiling.
 *
 * Medium on its own, because mock news sentiment is weak evidence and does not
 * justify interrupting anyone. Escalation to high happens only in the ranking
 * step, when it co-occurs with a high alert for the same customer.
 *
 * `market: null` means the feed is unavailable and produces a skipped clause, not
 * an all-clear. Substituting a neutral-positive default would read as "no market
 * risk", which is a false negative dressed as data.
 */
export function evaluateMarketSentimentRisk(input: PredictiveRuleInput): PredictiveRuleOutcome {
  const skipped: SkippedClause[] = [];
  const { minConfidence, healthCeiling } = input.thresholds.market;

  if (input.market === null) {
    skipped.push({
      customerId: input.customerId,
      ruleId: 'market-sentiment-risk',
      clause: 'market',
      reason: 'market sentiment is unavailable for this company',
    });
    return { fired: null, skipped };
  }

  const { label, confidence, score, articleCount } = input.market;

  if (label !== 'negative' || confidence < minConfidence || input.healthScore >= healthCeiling) {
    return { fired: null, skipped };
  }

  const severity = clampUnit(Math.abs(score) * confidence);

  return {
    skipped,
    fired: {
      ruleId: 'market-sentiment-risk',
      priority: 'medium',
      severity,
      triggeredClause: 'negativeSentiment',
      title: 'Negative market coverage alongside a below-target health score',
      message: `Recent coverage of this company scored negative at ${confidence.toFixed(2)} confidence across ${articleCount} articles, while the account's health score sits below ${healthCeiling}. Neither signal is decisive alone; together they raise churn risk.`,
      recommendedActions: [
        'Read the recent coverage before the next customer conversation.',
        'Check whether renewal or expansion plans depend on the affected part of their business.',
        'Flag the account for a closer check-in over the next two weeks.',
      ],
      evidence: [
        { label: 'Sentiment', value: 'negative' },
        { label: 'Confidence', value: confidence.toFixed(2) },
        { label: 'Sentiment score', value: score.toFixed(2) },
        { label: 'Articles considered', value: String(articleCount) },
        { label: 'Health score', value: String(input.healthScore) },
      ],
    },
  };
}

/**
 * The feature's priority score: `tierBase + value + urgency + recency`.
 *
 * The attainable range is **20–100**, not 0–100 — a medium alert with no ARR, no
 * severity, and a week of age still scores 20. Recency comes from the store's
 * `firstDetectedAt`, never from this pass's trigger time: scoring against the
 * current pass would hold every unresolved alert at full recency forever and
 * freeze the ranking.
 *
 * @param parameters.priority - Post-escalation priority.
 * @param parameters.annualRecurringRevenue - Currency units, not cents.
 * @param parameters.severity - 0..1.
 * @param parameters.firstDetectedAt - ISO 8601, from the server store.
 * @param parameters.now - Epoch milliseconds.
 * @returns An integer in 20..100.
 */
export function computePredictivePriorityScore(parameters: {
  priority: AlertPriority;
  annualRecurringRevenue: number;
  severity: number;
  firstDetectedAt: string;
  now: number;
}): number {
  const tierBase =
    parameters.priority === 'high' ? SCORE_COMPONENTS.highBase : SCORE_COMPONENTS.mediumBase;

  const valuePoints = Math.round(
    SCORE_COMPONENTS.valueMax *
      clampUnit(Math.max(parameters.annualRecurringRevenue, 0) / VALUE_SATURATION_ARR)
  );

  const urgencyPoints = Math.round(SCORE_COMPONENTS.urgencyMax * clampUnit(parameters.severity));

  const hoursSinceFirstDetected = (parameters.now - Date.parse(parameters.firstDetectedAt)) / 3_600_000;
  const recencyPoints = Math.round(
    SCORE_COMPONENTS.recencyMax * clampUnit(1 - Math.max(hoursSinceFirstDetected, 0) / RECENCY_DECAY_HOURS)
  );

  return tierBase + valuePoints + urgencyPoints + recencyPoints;
}

/** The minimum an alert needs to be ranked. */
export interface RankableAlert {
  customerId: string;
  ruleId: PredictiveRuleId;
  priorityScore: number;
}

/**
 * Orders alerts deterministically.
 *
 * Score descending, then rule id ascending, then customer id ascending. Explicit
 * tie-breaks rather than relying on sort stability or object key order, so the
 * same input always renders the same list.
 */
export function compareRankedAlerts(left: RankableAlert, right: RankableAlert): number {
  if (left.priorityScore !== right.priorityScore) {
    return right.priorityScore - left.priorityScore;
  }
  if (left.ruleId !== right.ruleId) {
    return left.ruleId < right.ruleId ? -1 : 1;
  }
  if (left.customerId !== right.customerId) {
    return left.customerId < right.customerId ? -1 : 1;
  }
  return 0;
}

/** How many alerts a capping pass kept, and how many it withheld. */
export interface CappedAlerts<T extends RankableAlert> {
  kept: T[];
  suppressedByCap: number;
}

/**
 * Applies the per-customer and global caps to a ranked list.
 *
 * These are **fatigue controls, not security controls**: they bound how much one
 * screen asks a human to read. Withheld alerts are counted so the widget can say
 * "+N more" rather than dropping them silently.
 *
 * @param ranked - Alerts already in final order.
 * @param caps - `maxPerCustomer` and `maxAlerts`.
 */
export function applyCaps<T extends RankableAlert>(
  ranked: readonly T[],
  caps: PredictiveThresholds['caps']
): CappedAlerts<T> {
  const perCustomer = new Map<string, number>();
  const kept: T[] = [];
  let suppressedByCap = 0;

  for (const alert of ranked) {
    const used = perCustomer.get(alert.customerId) ?? 0;

    if (used >= caps.maxPerCustomer || kept.length >= caps.maxAlerts) {
      suppressedByCap += 1;
      continue;
    }

    perCustomer.set(alert.customerId, used + 1);
    kept.push(alert);
  }

  return { kept, suppressedByCap };
}
