/**
 * Shared types for the Predictive Intelligence feature.
 *
 * Imported by `src/server`, `src/services`, the route handlers, and the widget so
 * every layer agrees on one shape.
 *
 * ## Relationship to `src/lib/alerts.ts`
 *
 * The rules engine in `src/lib/alerts.ts` already shipped, with five kebab-case
 * rule ids (`payment-risk`, …), its own `Alert` shape, and a client-side
 * `MonitoringState`. This feature **consumes** that engine rather than
 * reimplementing it, and adds the two rules it does not carry
 * (`market-sentiment-risk`, `engagement-decline-trend`) in
 * `src/services/predictiveRules.ts`. The rule-id union below is therefore the
 * shipped five plus those two, in the shipped kebab-case style, not the
 * SCREAMING_SNAKE ids the spec drafted before the engine existed.
 */

import type { AlertPriority, AlertRuleId as CoreAlertRuleId } from '@/lib/alerts';
import type { SentimentLabel } from '@/types/market-intelligence';

export type { AlertPriority };

/** The two rules this feature adds on top of the shipped five. */
export type PredictiveOnlyRuleId = 'market-sentiment-risk' | 'engagement-decline-trend';

/** Every rule id this feature can report. */
export type PredictiveRuleId = CoreAlertRuleId | PredictiveOnlyRuleId;

/** Every rule id, in evaluation and tie-break order. */
export const PREDICTIVE_RULE_IDS: readonly PredictiveRuleId[] = Object.freeze([
  'contract-expiration-risk',
  'engagement-cliff',
  'engagement-decline-trend',
  'feature-adoption-stall',
  'market-sentiment-risk',
  'payment-risk',
  'support-ticket-spike',
]);

/**
 * The market evidence one rule needs, reduced to the fields it reads.
 *
 * `null` at the call site means *unavailable* and is never treated as
 * neutral-good: a missing feed must not read as "no market risk".
 */
export interface MarketSignal {
  /** Net sentiment, -1..1. */
  score: number;
  label: SentimentLabel;
  /** 0..1. */
  confidence: number;
  articleCount: number;
  /** ISO 8601. */
  lastUpdated: string;
}

/** A clause that could not be evaluated. Firing and skipping are not exclusive. */
export interface SkippedClause {
  customerId: string;
  ruleId: PredictiveRuleId;
  /** e.g. `'healthDrop'`. */
  clause: string;
  /** Safe to render verbatim; contains no customer data. */
  reason: string;
}

/** Server-side state for one `${customerId}:${ruleId}` pair. */
export interface AlertStateEntry {
  /** `${customerId}:${ruleId}` — the dedup identity. */
  key: string;
  firstDetectedAt: string;
  lastTriggeredAt: string;
  lastNotifiedAt: string | null;
  status: 'active' | 'dismissed' | 'actioned';
  statusChangedAt: string | null;
  occurrenceCount: number;
}

/** One line of the process-local activity log. Not a compliance audit trail. */
export interface AuditEntry {
  at: string;
  key: string;
  event:
    | 'triggered'
    | 'notified'
    | 'notification_suppressed'
    | 'dismissed'
    | 'actioned'
    | 'reactivated';
  /** Template text only, never raw customer data. */
  detail?: string;
}

/** Per-rule dismissal statistics backing the fatigue panel. */
export interface DismissalRateByRule {
  ruleId: PredictiveRuleId;
  triggered: number;
  dismissed: number;
  /** `dismissed / triggered`, 0 when never triggered. */
  rate: number;
}

/** Alert-fatigue readout. Computed from the audit log; no ground truth required. */
export interface FatigueMetrics {
  notificationsSuppressedByCooldown: number;
  dismissalRateByRule: DismissalRateByRule[];
  medianHoursToAction: number | null;
  reactivationsAfterDismissal: number;
  /** Template-generated suggestions. Nothing self-tunes. */
  recommendations: string[];
}

/** One evidence row. Label and value are template text plus numbers only. */
export interface AlertEvidence {
  label: string;
  value: string;
}

/** One factor's contribution to a recalculated health score. */
export interface HealthFactorBreakdown {
  name: 'payment' | 'engagement' | 'contract' | 'support';
  /** 0..100, or `null` when the factor had no data. */
  score: number | null;
  /** Weight after cross-factor re-normalization. */
  effectiveWeight: number;
}

/**
 * The detail panel's health-score explanation.
 *
 * Both numbers are shown, and the computed one is labelled "recalculated". No
 * rule consumes `recalculatedScore`: gating on it would let a widget display one
 * number while an alert reasoned about another.
 */
export interface AlertHealthContext {
  /** `Customer.healthScore` — the single source of truth for every rule. */
  storedScore: number;
  /** The calculator's total for the same instant, or `null` when it had no data. */
  recalculatedScore: number | null;
  /** Fraction of the weighting backed by real data, 0..1. */
  confidence: number;
  factors: HealthFactorBreakdown[];
}

/** One ranked alert as the API returns it. */
export interface PredictiveAlert {
  /** Stable: `${customerId}:${ruleId}`. */
  id: string;
  customerId: string;
  customerName: string;
  company: string;
  ruleId: PredictiveRuleId;
  /** `'high'` when escalated; the filter and the summary both read this field. */
  priority: AlertPriority;
  escalated: boolean;
  /** Integer, 20..100. */
  priorityScore: number;
  /** 0..1 normalized breach magnitude. */
  severity: number;
  /** Which clause actually fired; drives the title. */
  triggeredClause: string;
  title: string;
  message: string;
  recommendedActions: string[];
  evidence: AlertEvidence[];
  firstDetectedAt: string;
  lastTriggeredAt: string;
  occurrenceCount: number;
  notificationSuppressedUntil: string | null;
  /** `'dismissed'` never reaches the client from GET. */
  status: 'active' | 'actioned';
  /** Present when the health calculator could be run for this customer. */
  healthContext?: AlertHealthContext;
}

/** Counts shown in the widget header. */
export interface PredictiveSummary {
  high: number;
  medium: number;
  suppressedByCap: number;
  customersEvaluated: number;
}

/** Successful `GET /api/predictive-intelligence` payload. */
export interface PredictiveIntelligenceResponse {
  alerts: PredictiveAlert[];
  summary: PredictiveSummary;
  marketDataAvailable: boolean;
  unknownIds: string[];
  skipped: SkippedClause[];
  /** ISO 8601, always the current time — never cached. */
  evaluatedAt: string;
}

/** Successful `GET /api/predictive-intelligence/history` payload. */
export interface PredictiveHistoryResponse {
  audit: AuditEntry[];
  fatigue: FatigueMetrics;
  generatedAt: string;
}

/** Error body returned for every non-2xx response on this feature's routes. */
export interface PredictiveIntelligenceErrorBody {
  error: string;
}
