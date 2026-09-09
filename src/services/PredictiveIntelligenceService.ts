/**
 * Orchestrates the Predictive Intelligence read path.
 *
 * Fuses two evidence streams into one ranked list: internal signals (payment,
 * engagement, contract, support, adoption) through the shipped rules engine, and
 * external market sentiment through `MarketIntelligenceService`. Neither stream
 * alone is decisive — a health dip *plus* negative press is a stronger churn
 * indicator than either in isolation — and this service is where that compounding
 * is made explicit rather than left to a reader of two separate widgets.
 *
 * **All data is mock.** Signals are generated deterministically per customer id;
 * market data comes from `src/data/mock-market-intelligence.ts`. No external API,
 * no key, no third-party trust boundary. This is a poll over local data, not
 * real-time monitoring, and the UI says so.
 *
 * ## How the shipped engine is used
 *
 * `src/lib/alerts.ts` is called as a **pure detector**: it is handed a fresh
 * `MonitoringState` on every pass, seeded only with score history. Its own
 * cooldown and dismissal logic suppress *detection*, which would make a live risk
 * vanish from the dashboard; this feature suppresses *notification* instead, in
 * `src/server/alertStateStore.ts`. Reusing the engine's rules while owning the
 * state keeps one rules implementation and one state implementation, rather than
 * two of each.
 */

import {
  alertEngine,
  computeUrgencyWeight,
  createMonitoringState,
  daysBetween,
  deriveHealthScoreInput,
  scoreCustomerAt,
  type Alert as EngineAlert,
  type AlertPriority,
  type AlertRuleId as CoreAlertRuleId,
  type CustomerEvaluationInput,
  type CustomerSignals,
} from '@/lib/alerts';
import type { HealthScoreInput, HealthScoreResult } from '@/lib/healthCalculator';
import { mockCustomers, type Customer } from '@/data/mock-customers';
import { buildScoreHistory, getSignalsForCustomer } from '@/data/mock-customer-signals';
import {
  MarketIntelligenceService,
  marketIntelligenceService,
} from '@/services/MarketIntelligenceService';
import { PredictiveIntelligenceError } from '@/services/errors';
import {
  applyCaps,
  compareRankedAlerts,
  computePredictivePriorityScore,
  evaluateEngagementDeclineTrend,
  evaluateMarketSentimentRisk,
  type PredictiveRuleResult,
} from '@/services/predictiveRules';
import {
  resolveThresholds,
  type PredictiveThresholds,
  type PredictiveThresholdsOverride,
} from '@/server/alertThresholds';
import {
  getState,
  reconcile,
  type AlertDetection,
} from '@/server/alertStateStore';
import type { IntelligenceRequest } from '@/server/validateIntelligenceRequest';
import type {
  AlertEvidence,
  AlertHealthContext,
  MarketSignal,
  PredictiveAlert,
  PredictiveIntelligenceResponse,
  PredictiveRuleId,
  SkippedClause,
} from '@/types/predictive-intelligence';

/** Input-cache lifetime. Short, because the point is to survive one poll cycle. */
export const DEFAULT_INPUT_TTL_MS = 60_000;

/** Hard ceiling on cached customers, evicted least-recently-*accessed* first. */
export const MAX_INPUT_CACHE_ENTRIES = 200;

/** Bounds of the simulated delay applied on a cache miss. */
const MINIMUM_SIMULATED_DELAY_MS = 200;
const MAXIMUM_SIMULATED_DELAY_MS = 600;

/** Days of score history seeded per customer, so the score-drop clause is reachable. */
const SCORE_HISTORY_DAYS = 30;

/** Human-readable rule names for alert titles and messages. */
const RULE_LABELS: Readonly<Record<PredictiveRuleId, string>> = Object.freeze({
  'payment-risk': 'Payment risk',
  'engagement-cliff': 'Engagement cliff',
  'engagement-decline-trend': 'Engagement decline',
  'contract-expiration-risk': 'Contract expiration risk',
  'support-ticket-spike': 'Support ticket spike',
  'feature-adoption-stall': 'Feature adoption stall',
  'market-sentiment-risk': 'Market sentiment risk',
});

/** Constructor overrides. Every one exists so the service is testable. */
export interface PredictiveIntelligenceServiceOptions {
  /** Clock source. Without it, TTL, cooldown, and recency decay are untestable except by waiting. */
  now?: () => number;
  /** Input-cache lifetime in milliseconds. */
  ttlMs?: number;
  /** Simulated delay, applied on a cache miss only. */
  delayMs?: () => number;
  marketService?: MarketIntelligenceService;
  /** Signal loader. Injectable so tests can count generator invocations. */
  loadSignals?: (customerId: string) => CustomerSignals | undefined;
  /** Customer source. Injectable so tests can supply a synthetic 200-customer set. */
  loadCustomers?: () => readonly Customer[];
}

/** One customer's resolved inputs. The cache holds these, never scored results. */
export interface CachedCustomerInputs {
  signals: CustomerSignals;
  health: HealthScoreResult;
  scoreHistory: Array<{ date: string; score: number }>;
  /** `null` when the market feed failed for this customer. */
  market: MarketSignal | null;
  /** Whether the market lookup succeeded, distinct from a `null` sentiment. */
  marketAvailable: boolean;
}

interface CacheEntry {
  inputs: CachedCustomerInputs;
  expiresAt: number;
  /** The date the inputs were derived for; a new day invalidates them. */
  asOf: string;
}

/** The service's request shape: a validated read request plus threshold overrides. */
export interface IntelligenceServiceRequest extends IntelligenceRequest {
  thresholds?: PredictiveThresholdsOverride;
}

/** Everything one customer contributes to a pass, before ranking. */
interface CandidateAlert {
  customerId: string;
  ruleId: PredictiveRuleId;
  priority: AlertPriority;
  severity: number;
  triggeredClause: string;
  title: string;
  message: string;
  recommendedActions: string[];
  evidence: AlertEvidence[];
  annualRecurringRevenue: number;
  customerName: string;
  company: string;
  healthContext: AlertHealthContext;
}

/**
 * Builds the detail panel's health explanation.
 *
 * Shows the stored score *and* the recalculated one rather than silently
 * preferring either. No rule reads `recalculatedScore`: every health gate uses
 * `customer.healthScore`, so the widget and the alert can never reason about
 * different numbers.
 */
function toHealthContext(storedScore: number, health: HealthScoreResult): AlertHealthContext {
  const breakdown = health.breakdown;

  return {
    storedScore,
    recalculatedScore: health.score,
    confidence: health.confidence,
    factors: (['payment', 'engagement', 'contract', 'support'] as const).map((name) => ({
      name,
      score: breakdown[name].score,
      effectiveWeight: breakdown[name].effectiveWeight,
    })),
  };
}

/** Converts epoch milliseconds to the `YYYY-MM-DD` the rules engine reads. */
function toAsOfDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Reduces a market payload to the fields the rule reads.
 *
 * A rejected lookup yields `null`, never a synthesized neutral value.
 */
function toMarketSignal(payload: {
  sentiment: { score: number; label: MarketSignal['label']; confidence: number };
  articleCount: number;
  lastUpdated: string;
}): MarketSignal {
  return {
    score: payload.sentiment.score,
    label: payload.sentiment.label,
    confidence: payload.sentiment.confidence,
    articleCount: payload.articleCount,
    lastUpdated: payload.lastUpdated,
  };
}

export class PredictiveIntelligenceService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly delayMs: () => number;
  private readonly marketService: MarketIntelligenceService;
  private readonly loadSignals: (customerId: string) => CustomerSignals | undefined;
  private readonly loadCustomers: () => readonly Customer[];

  constructor(options: PredictiveIntelligenceServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_INPUT_TTL_MS;
    this.delayMs =
      options.delayMs ??
      (() =>
        MINIMUM_SIMULATED_DELAY_MS +
        Math.random() * (MAXIMUM_SIMULATED_DELAY_MS - MINIMUM_SIMULATED_DELAY_MS));
    this.marketService = options.marketService ?? marketIntelligenceService;
    this.loadSignals = options.loadSignals ?? getSignalsForCustomer;
    this.loadCustomers = options.loadCustomers ?? (() => mockCustomers);
  }

  /** Cached customer count. Tests and diagnostics only. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Drops every cached input. Tests only. */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Adapts dated signals into the health calculator's input at an instant.
   *
   * This feature owns the adapter, not the calculator: `healthCalculator.ts` is
   * pure and explicitly refuses to read the clock, so every *days since / days
   * until* value is derived here from the injected `now` and handed over
   * already computed. No clock access is added to the calculator.
   *
   * @param signals - The customer's dated signals.
   * @param nowMs - Epoch milliseconds, from the injected clock.
   * @returns The calculator's input for that instant.
   */
  toHealthScoreInput(signals: CustomerSignals, nowMs: number): HealthScoreInput {
    return deriveHealthScoreInput(signals, toAsOfDate(nowMs));
  }

  /**
   * Resolves the ranked alert list.
   *
   * Order: validate → load customers → resolve cached inputs → detect through the
   * engine and this feature's two extra rules → reconcile the server store →
   * escalate, score, rank, cap → drop dismissed → filter.
   *
   * @param request - A validated read request plus optional threshold overrides.
   * @returns The full response payload.
   * @throws {PredictiveIntelligenceError} `INVALID_INPUT` for unusable thresholds
   *         or an empty id list; `INTERNAL` for anything unexpected.
   */
  async getIntelligence(
    request: IntelligenceServiceRequest = {}
  ): Promise<PredictiveIntelligenceResponse> {
    const thresholds = this.resolveRequestThresholds(request);
    const nowMs = this.now();
    const asOf = toAsOfDate(nowMs);

    const { customers, unknownIds } = this.resolveCustomers(request.customerIds);
    const inputsByCustomerId = await this.resolveInputs(customers, asOf, nowMs);

    const marketDataAvailable = [...inputsByCustomerId.values()].some(
      (inputs) => inputs.marketAvailable
    );

    const skipped: SkippedClause[] = [];
    const candidates: CandidateAlert[] = [];

    const engineInputs: CustomerEvaluationInput[] = [];
    const seededScoreHistory: Record<string, Array<{ date: string; score: number }>> = {};

    for (const customer of customers) {
      const inputs = inputsByCustomerId.get(customer.id);
      if (inputs === undefined) {
        continue;
      }
      engineInputs.push({ customer: { id: customer.id }, signals: inputs.signals, health: inputs.health });
      seededScoreHistory[customer.id] = inputs.scoreHistory;
    }

    // A fresh state each pass: the engine detects, this feature's store remembers.
    const engineResult = alertEngine(
      engineInputs,
      createMonitoringState(seededScoreHistory),
      asOf,
      thresholds.core
    );

    for (const entry of engineResult.skipped) {
      skipped.push({
        customerId: entry.customerId,
        ruleId: entry.ruleId,
        clause: entry.ruleId,
        reason: entry.reason,
      });
    }

    const cliffFiredFor = new Set(
      engineResult.alerts
        .filter((alert) => alert.ruleId === 'engagement-cliff')
        .map((alert) => alert.customerId)
    );

    for (const customer of customers) {
      const inputs = inputsByCustomerId.get(customer.id);
      if (inputs === undefined) {
        continue;
      }

      for (const alert of engineResult.alerts) {
        if (alert.customerId !== customer.id) {
          continue;
        }
        candidates.push(this.toCandidate(customer, inputs, alert, asOf, thresholds));
      }

      const ruleInput = {
        customerId: customer.id,
        healthScore: customer.healthScore,
        signals: inputs.signals,
        market: inputs.market,
        thresholds,
        asOf,
      };

      // The trend rule is suppressed when the cliff fired, so one deteriorating
      // account never produces two engagement alerts.
      const trend = evaluateEngagementDeclineTrend(ruleInput);
      skipped.push(...trend.skipped);
      if (trend.fired !== null && !cliffFiredFor.has(customer.id)) {
        candidates.push(this.fromPredictiveRule(customer, inputs, trend.fired));
      }

      const market = evaluateMarketSentimentRisk(ruleInput);
      skipped.push(...market.skipped);
      if (market.fired !== null) {
        candidates.push(this.fromPredictiveRule(customer, inputs, market.fired));
      }
    }

    const escalated = this.applyCompoundEscalation(candidates);

    const detections: AlertDetection[] = escalated.map(({ candidate }) => ({
      key: `${candidate.customerId}:${candidate.ruleId}`,
      customerId: candidate.customerId,
      ruleId: candidate.ruleId,
      priority: candidate.priority,
    }));

    const reconciled = reconcile(detections, nowMs, thresholds, { timeZone: request.timezone });
    const storeState = getState();

    const scored: PredictiveAlert[] = [];

    for (const { candidate, isEscalated } of escalated) {
      const key = `${candidate.customerId}:${candidate.ruleId}`;
      const state = reconciled.get(key);
      const entry = state?.entry ?? storeState.get(key);
      if (entry === undefined) {
        continue;
      }

      // A dismissal filters the list the server assembles; it never reaches the
      // client, which is why the action endpoint exists at all.
      if (entry.status === 'dismissed') {
        continue;
      }

      scored.push({
        id: key,
        customerId: candidate.customerId,
        customerName: candidate.customerName,
        company: candidate.company,
        ruleId: candidate.ruleId,
        priority: candidate.priority,
        escalated: isEscalated,
        priorityScore: computePredictivePriorityScore({
          priority: candidate.priority,
          annualRecurringRevenue: candidate.annualRecurringRevenue,
          severity: candidate.severity,
          firstDetectedAt: entry.firstDetectedAt,
          now: nowMs,
        }),
        severity: candidate.severity,
        triggeredClause: candidate.triggeredClause,
        title: candidate.title,
        message: candidate.message,
        recommendedActions: candidate.recommendedActions,
        evidence: candidate.evidence,
        firstDetectedAt: entry.firstDetectedAt,
        lastTriggeredAt: entry.lastTriggeredAt,
        occurrenceCount: entry.occurrenceCount,
        notificationSuppressedUntil: state?.notificationSuppressedUntil ?? null,
        status: entry.status === 'actioned' ? 'actioned' : 'active',
        healthContext: candidate.healthContext,
      });
    }

    scored.sort(compareRankedAlerts);
    const { kept, suppressedByCap } = applyCaps(scored, thresholds.caps);

    // Filtering after capping keeps "+N more" honest about the whole list rather
    // than about the current filter.
    const visible =
      request.priority === undefined
        ? kept
        : kept.filter((alert) => alert.priority === request.priority);

    return {
      alerts: visible,
      summary: {
        high: kept.filter((alert) => alert.priority === 'high').length,
        medium: kept.filter((alert) => alert.priority === 'medium').length,
        suppressedByCap,
        customersEvaluated: customers.length,
      },
      marketDataAvailable,
      unknownIds,
      skipped,
      // Always the current time: the response is assembled now, whatever the
      // cache did, so a cached timestamp would be a lie.
      evaluatedAt: new Date(nowMs).toISOString(),
    };
  }

  /** Validates threshold overrides, mapping validation failure to a client error. */
  private resolveRequestThresholds(request: IntelligenceServiceRequest): PredictiveThresholds {
    try {
      return resolveThresholds(request.thresholds);
    } catch (error) {
      throw new PredictiveIntelligenceError(
        'INVALID_INPUT',
        error instanceof Error ? error.message : 'Threshold configuration is invalid.'
      );
    }
  }

  /** Splits requested ids into known customers and well-formed unknown ids. */
  private resolveCustomers(customerIds?: string[]): {
    customers: Customer[];
    unknownIds: string[];
  } {
    const all = this.loadCustomers();

    if (customerIds === undefined) {
      return { customers: [...all], unknownIds: [] };
    }

    const byId = new Map(all.map((customer) => [customer.id, customer]));
    const customers: Customer[] = [];
    const unknownIds: string[] = [];

    for (const id of customerIds) {
      const customer = byId.get(id);
      if (customer === undefined) {
        unknownIds.push(id);
      } else {
        customers.push(customer);
      }
    }

    return { customers, unknownIds };
  }

  /**
   * Resolves every customer's inputs, reading cache first.
   *
   * Market lookups run concurrently through `Promise.allSettled` — not
   * sequentially, and not `Promise.all`, where one rejection would discard every
   * other customer's data.
   */
  private async resolveInputs(
    customers: readonly Customer[],
    asOf: string,
    nowMs: number
  ): Promise<Map<string, CachedCustomerInputs>> {
    const resolved = new Map<string, CachedCustomerInputs>();
    const misses: Customer[] = [];

    for (const customer of customers) {
      const cached = this.readFromCache(customer.id, asOf, nowMs);
      if (cached !== null) {
        resolved.set(customer.id, cached);
      } else {
        misses.push(customer);
      }
    }

    if (misses.length === 0) {
      return resolved;
    }

    // One market lookup per distinct company, never one per alert.
    const companies = [...new Set(misses.map((customer) => customer.company))];
    const marketByCompany = new Map<string, MarketSignal | null>();

    const settled = await Promise.allSettled(
      companies.map((company) => this.marketService.getMarketIntelligence(company))
    );

    settled.forEach((outcome, index) => {
      const company = companies[index] ?? '';
      marketByCompany.set(
        company,
        outcome.status === 'fulfilled' ? toMarketSignal(outcome.value) : null
      );
    });

    await this.simulateDelay();

    for (const customer of misses) {
      const signals = this.loadSignals(customer.id);
      if (signals === undefined) {
        continue;
      }

      const market = marketByCompany.get(customer.company) ?? null;
      const inputs: CachedCustomerInputs = {
        signals,
        health: scoreCustomerAt(signals, asOf),
        scoreHistory: buildScoreHistory(customer.id, asOf, SCORE_HISTORY_DAYS),
        market,
        marketAvailable: market !== null,
      };

      this.writeToCache(customer.id, inputs, asOf, nowMs);
      resolved.set(customer.id, inputs);
    }

    return resolved;
  }

  /**
   * Reads one customer's inputs from the cache.
   *
   * True LRU: a hit is deleted and re-inserted so it moves to the tail, because a
   * `Map` preserves *insertion* order, not access order. Skipping that step
   * silently degrades the eviction policy to FIFO.
   */
  private readFromCache(customerId: string, asOf: string, nowMs: number): CachedCustomerInputs | null {
    const entry = this.cache.get(customerId);
    if (entry === undefined) {
      return null;
    }

    if (entry.expiresAt <= nowMs || entry.asOf !== asOf) {
      // Expired entries are evicted on access, never served stale.
      this.cache.delete(customerId);
      return null;
    }

    this.cache.delete(customerId);
    this.cache.set(customerId, entry);
    return entry.inputs;
  }

  private writeToCache(
    customerId: string,
    inputs: CachedCustomerInputs,
    asOf: string,
    nowMs: number
  ): void {
    this.cache.delete(customerId);
    this.cache.set(customerId, { inputs, asOf, expiresAt: nowMs + this.ttlMs });

    while (this.cache.size > MAX_INPUT_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.cache.delete(oldest.value);
    }
  }

  /** Sleeps for the configured simulated delay. Skipped entirely on a cache hit. */
  private async simulateDelay(): Promise<void> {
    const delay = this.delayMs();
    if (delay <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /** Maps one engine alert onto this feature's candidate shape. */
  private toCandidate(
    customer: Customer,
    inputs: CachedCustomerInputs,
    alert: EngineAlert,
    asOf: string,
    thresholds: PredictiveThresholds
  ): CandidateAlert {
    const evidence: AlertEvidence[] = [
      { label: 'Rule', value: RULE_LABELS[alert.ruleId] },
      { label: 'Finding', value: alert.detail },
      { label: 'Health score', value: String(customer.healthScore) },
    ];

    for (const note of alert.notes ?? []) {
      evidence.push({ label: 'Not evaluated', value: note });
    }

    return {
      customerId: customer.id,
      ruleId: alert.ruleId,
      priority: alert.priority,
      severity: computeUrgencyWeight(
        alert.ruleId as CoreAlertRuleId,
        inputs.signals,
        asOf,
        thresholds.core
      ),
      triggeredClause: alert.ruleId,
      title: alert.title,
      message: alert.detail,
      recommendedActions: [alert.recommendedAction],
      evidence,
      annualRecurringRevenue: inputs.signals.contract.annualRecurringRevenue,
      customerName: customer.name,
      company: customer.company,
      healthContext: toHealthContext(customer.healthScore, inputs.health),
    };
  }

  /** Maps one of this feature's own rule results onto the candidate shape. */
  private fromPredictiveRule(
    customer: Customer,
    inputs: CachedCustomerInputs,
    result: PredictiveRuleResult
  ): CandidateAlert {
    return {
      customerId: customer.id,
      ruleId: result.ruleId,
      priority: result.priority,
      severity: result.severity,
      triggeredClause: result.triggeredClause,
      title: result.title,
      message: result.message,
      recommendedActions: result.recommendedActions,
      evidence: result.evidence,
      annualRecurringRevenue: inputs.signals.contract.annualRecurringRevenue,
      customerName: customer.name,
      company: customer.company,
      healthContext: toHealthContext(customer.healthScore, inputs.health),
    };
  }

  /**
   * Escalates a market alert that co-occurs with a high alert for the same
   * customer.
   *
   * Escalation **rewrites `priority` to `'high'`** as well as setting the flag.
   * Leaving it `'medium'` while ranking it as high is how the top-ranked alert
   * disappears the moment a user filters to High, and how the summary miscounts.
   * Ranking, summary, and filter must agree on one field.
   *
   * It is never a synthesized extra alert — the existing one changes.
   */
  private applyCompoundEscalation(
    candidates: readonly CandidateAlert[]
  ): Array<{ candidate: CandidateAlert; isEscalated: boolean }> {
    const customersWithHighAlert = new Set(
      candidates.filter((candidate) => candidate.priority === 'high').map((c) => c.customerId)
    );

    return candidates.map((candidate) => {
      const isEscalated =
        candidate.ruleId === 'market-sentiment-risk' &&
        customersWithHighAlert.has(candidate.customerId);

      return {
        isEscalated,
        candidate: isEscalated ? { ...candidate, priority: 'high' as AlertPriority } : candidate,
      };
    });
  }
}

/** Shared instance used by the route handlers, so one cache serves every request. */
export const predictiveIntelligenceService = new PredictiveIntelligenceService();

/** Re-exported so callers need not reach into `src/lib` for the date helper. */
export { daysBetween };
