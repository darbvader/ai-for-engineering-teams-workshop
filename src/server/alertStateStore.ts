/**
 * Server-side alert state for the Predictive Intelligence feature.
 *
 * ## Process-local, not durable
 *
 * State lives in module-level `Map`s inside one Next server process. It **resets
 * on server restart** and is **not shared across instances** in a multi-instance
 * deployment. That is acceptable for a mock workshop app and is stated here so
 * nobody builds on a durability guarantee that does not exist. Durable,
 * multi-instance state is out of scope.
 *
 * The activity log below is **not a compliance audit trail** — it is a bounded
 * in-memory ring buffer that dies with the process.
 *
 * ## Why the server owns this
 *
 * The `GET` response carries `firstDetectedAt`, `occurrenceCount`, `status`, and
 * `notificationSuppressedUntil`; `priorityScore` has a recency term derived from
 * `firstDetectedAt`; and dismissals must filter the list the server assembles. A
 * server cannot read `localStorage`, so client-owned state would leave every one
 * of those unpopulatable. Server ownership also makes cross-session sync simply
 * true: every session reads this one store.
 *
 * Nothing here reads the clock. `now` is always injected, so cooldown windows and
 * the dismissal TTL are tested by advancing a number rather than by sleeping.
 */

import { isWithinBusinessHours, nextBusinessWindowOpen, serverTimeZone } from '@/server/businessHours';
import type { PredictiveThresholds } from '@/server/alertThresholds';
import type {
  AlertPriority,
  AlertStateEntry,
  AuditEntry,
  DismissalRateByRule,
  FatigueMetrics,
  PredictiveRuleId,
} from '@/types/predictive-intelligence';

/** Ring-buffer capacity for the activity log. */
export const AUDIT_LOG_CAPACITY = 1000;

/** Dismissal rate above which a threshold change is suggested. */
export const FATIGUE_DISMISSAL_RATE_THRESHOLD = 0.6;

/** Minimum triggers before a dismissal rate is considered meaningful. */
export const FATIGUE_MINIMUM_TRIGGERS = 5;

const HOUR_MS = 3_600_000;

/** Suppression reasons, recorded verbatim in `AuditEntry.detail`. */
export const SUPPRESSION_REASON = Object.freeze({
  cooldown: 'notification cooldown active',
  outsideBusinessHours: 'deferred to the next delivery window',
});

/** Raised when an action names a key the store has never seen. */
export class UnknownAlertKeyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super('No alert state exists for the requested alert.');
    this.name = 'UnknownAlertKeyError';
    this.key = key;
    Object.setPrototypeOf(this, UnknownAlertKeyError.prototype);
  }
}

/** One detection handed to {@link reconcile}. */
export interface AlertDetection {
  /** `${customerId}:${ruleId}` — the dedup identity. */
  key: string;
  customerId: string;
  ruleId: PredictiveRuleId;
  priority: AlertPriority;
}

/** Options for one reconciliation pass. */
export interface ReconcileOptions {
  /** The viewer's IANA zone; the server's own zone is a fallback only. */
  timeZone?: string;
}

/** What reconciliation concluded about one detection. */
export interface ReconciledAlertState {
  entry: AlertStateEntry;
  /**
   * When the next notification becomes deliverable, or `null` when this pass
   * notified. Detection is never suppressed — only notification.
   */
  notificationSuppressedUntil: string | null;
}

/** The state of every reconciled detection, keyed by dedup key. */
export type ReconcileResult = Map<string, ReconciledAlertState>;

/**
 * The store's backing collections, hung off `globalThis`.
 *
 * Next.js bundles each route handler separately, so a plain module-level `Map`
 * is instantiated **once per route bundle** — the read route would write state
 * the action route could never see, and a dismissal would 404. Dev-mode hot
 * reloading duplicates modules the same way. Keying the collections on
 * `globalThis` gives all three routes one store, which is the whole point of
 * server-side alert state.
 *
 * Still process-local: this survives module duplication, not a restart.
 */
interface AlertStoreGlobal {
  entries: Map<string, AlertStateEntry>;
  auditLog: AuditEntry[];
}

const STORE_SYMBOL = Symbol.for('predictive-intelligence.alertStateStore');

function getStore(): AlertStoreGlobal {
  const host = globalThis as typeof globalThis & { [STORE_SYMBOL]?: AlertStoreGlobal };

  if (host[STORE_SYMBOL] === undefined) {
    host[STORE_SYMBOL] = { entries: new Map<string, AlertStateEntry>(), auditLog: [] };
  }

  return host[STORE_SYMBOL];
}

function appendAudit(entry: AuditEntry): void {
  const { auditLog } = getStore();
  auditLog.push(entry);
  if (auditLog.length > AUDIT_LOG_CAPACITY) {
    // Ring buffer: the oldest line is dropped, never the newest.
    auditLog.splice(0, auditLog.length - AUDIT_LOG_CAPACITY);
  }
}

function hoursBetween(fromIso: string, toMs: number): number {
  return (toMs - Date.parse(fromIso)) / HOUR_MS;
}

function cooldownHoursFor(priority: AlertPriority, thresholds: PredictiveThresholds): number {
  return priority === 'high' ? thresholds.cooldown.highHours : thresholds.cooldown.mediumHours;
}

/** Splits a dedup key. The rule id is everything after the first colon. */
export function parseAlertKey(key: string): { customerId: string; ruleId: PredictiveRuleId } | null {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === key.length - 1) {
    return null;
  }

  return {
    customerId: key.slice(0, separatorIndex),
    ruleId: key.slice(separatorIndex + 1) as PredictiveRuleId,
  };
}

/**
 * The whole store, read-only.
 *
 * Entries are copied out, so a caller cannot mutate stored state by holding the
 * result. The engine reads this as `priorState` when computing recency.
 */
export function getState(): ReadonlyMap<string, AlertStateEntry> {
  const snapshot = new Map<string, AlertStateEntry>();
  for (const [key, entry] of getStore().entries) {
    snapshot.set(key, { ...entry });
  }
  return snapshot;
}

/** One entry, copied. `undefined` when the key is unknown. */
export function getEntry(key: string): AlertStateEntry | undefined {
  const entry = getStore().entries.get(key);
  return entry === undefined ? undefined : { ...entry };
}

/**
 * Expires dismissals that have outlived their TTL.
 *
 * A dismissal ends on a timer **or** when the rule stops firing, whichever comes
 * first. The timer is what makes dismissal usable at all: signals here are
 * deterministic, so a firing rule fires forever, and a dismissal that only ended
 * on rule-stop would hide live risk permanently.
 *
 * @param now - Epoch milliseconds.
 * @param thresholds - Supplies `dismissalTtlHours`.
 * @param firingKeys - Keys detected in this pass; a dismissed key absent from it
 *                     has stopped firing and is reactivated immediately.
 */
function expireDismissals(
  now: number,
  thresholds: PredictiveThresholds,
  firingKeys: ReadonlySet<string>
): void {
  const nowIso = new Date(now).toISOString();

  for (const entry of getStore().entries.values()) {
    if (entry.status !== 'dismissed') {
      continue;
    }

    const dismissedAt = entry.statusChangedAt;
    const ttlElapsed =
      dismissedAt !== null && hoursBetween(dismissedAt, now) >= thresholds.cooldown.dismissalTtlHours;
    const ruleStopped = !firingKeys.has(entry.key);

    if (!ttlElapsed && !ruleStopped) {
      continue;
    }

    // `occurrenceCount` and `firstDetectedAt` survive: the alert is the same
    // alert, returning, not a new one.
    entry.status = 'active';
    entry.statusChangedAt = nowIso;
    appendAudit({
      at: nowIso,
      key: entry.key,
      event: 'reactivated',
      detail: ttlElapsed ? 'dismissal expired' : 'rule stopped firing',
    });
  }
}

/**
 * Folds this pass's detections into the store.
 *
 * Dedup is by identity (`${customerId}:${ruleId}`), never by comparing message
 * text — text changes the moment a threshold value inside it changes, which
 * would silently split one alert into two.
 *
 * Cooldown suppresses **notification only**. A cooled-down alert still appears in
 * the list; making the risk vanish from the dashboard while it is live is the
 * opposite of what a monitoring feature is for.
 *
 * @param detections - Every alert detected in this pass.
 * @param now - Epoch milliseconds.
 * @param thresholds - Cooldown and dismissal-TTL values.
 * @param options - Viewer timezone for the delivery-window gate.
 * @returns Post-reconciliation state for each detection.
 */
export function reconcile(
  detections: readonly AlertDetection[],
  now: number,
  thresholds: PredictiveThresholds,
  options: ReconcileOptions = {}
): ReconcileResult {
  const nowIso = new Date(now).toISOString();
  const timeZone = options.timeZone ?? serverTimeZone();
  const firingKeys = new Set(detections.map((detection) => detection.key));

  expireDismissals(now, thresholds, firingKeys);

  const result: ReconcileResult = new Map();
  const { entries } = getStore();

  for (const detection of detections) {
    const existing = entries.get(detection.key);
    let entry: AlertStateEntry;

    if (existing === undefined) {
      entry = {
        key: detection.key,
        firstDetectedAt: nowIso,
        lastTriggeredAt: nowIso,
        lastNotifiedAt: null,
        status: 'active',
        statusChangedAt: null,
        occurrenceCount: 1,
      };
      entries.set(detection.key, entry);
    } else {
      // A re-trigger updates recency and the count; it never creates a second
      // row and never resets `firstDetectedAt`.
      existing.lastTriggeredAt = nowIso;
      existing.occurrenceCount += 1;
      entry = existing;
    }

    appendAudit({ at: nowIso, key: detection.key, event: 'triggered', detail: detection.ruleId });

    // Resolve notification first: it may stamp `lastNotifiedAt`, and the caller
    // must see the post-notification entry rather than a stale snapshot.
    const notificationSuppressedUntil = resolveNotification(
      entry,
      detection,
      now,
      thresholds,
      timeZone
    );

    result.set(detection.key, { entry: { ...entry }, notificationSuppressedUntil });
  }

  return result;
}

/**
 * Decides whether this pass notifies, and records the outcome.
 *
 * @returns When notification next becomes possible, or `null` if it just happened.
 */
function resolveNotification(
  entry: AlertStateEntry,
  detection: AlertDetection,
  now: number,
  thresholds: PredictiveThresholds,
  timeZone: string
): string | null {
  const nowIso = new Date(now).toISOString();

  // A dismissed or actioned alert is not notified about; the user has spoken.
  if (entry.status !== 'active') {
    return null;
  }

  const cooldownHours = cooldownHoursFor(detection.priority, thresholds);

  if (entry.lastNotifiedAt !== null && hoursBetween(entry.lastNotifiedAt, now) < cooldownHours) {
    const availableAt = new Date(Date.parse(entry.lastNotifiedAt) + cooldownHours * HOUR_MS);
    appendAudit({
      at: nowIso,
      key: entry.key,
      event: 'notification_suppressed',
      detail: SUPPRESSION_REASON.cooldown,
    });
    return availableAt.toISOString();
  }

  if (!isWithinBusinessHours(now, timeZone)) {
    appendAudit({
      at: nowIso,
      key: entry.key,
      event: 'notification_suppressed',
      detail: SUPPRESSION_REASON.outsideBusinessHours,
    });
    return new Date(nextBusinessWindowOpen(now, timeZone)).toISOString();
  }

  entry.lastNotifiedAt = nowIso;
  appendAudit({ at: nowIso, key: entry.key, event: 'notified' });
  return null;
}

/**
 * Records a user action against an alert.
 *
 * @param key - `${customerId}:${ruleId}`.
 * @param action - `'dismiss'` hides the alert until its TTL expires;
 *                 `'action'` marks it handled but leaves it visible.
 * @param now - Epoch milliseconds.
 * @returns The updated entry.
 * @throws {UnknownAlertKeyError} when the key is not in the store.
 */
export function recordAction(
  key: string,
  action: 'dismiss' | 'action',
  now: number
): AlertStateEntry {
  const entry = getStore().entries.get(key);
  if (entry === undefined) {
    throw new UnknownAlertKeyError(key);
  }

  const nowIso = new Date(now).toISOString();
  entry.status = action === 'dismiss' ? 'dismissed' : 'actioned';
  entry.statusChangedAt = nowIso;

  appendAudit({ at: nowIso, key, event: action === 'dismiss' ? 'dismissed' : 'actioned' });

  return { ...entry };
}

/** The activity log, oldest first. Copied, so callers cannot mutate it. */
export function getAudit(): readonly AuditEntry[] {
  return getStore().auditLog.map((entry) => ({ ...entry }));
}

/**
 * Alert-fatigue metrics, derived entirely from the activity log.
 *
 * Fatigue needs no ground truth about customer outcomes, which is why it is in
 * scope while alert-effectiveness correlation is not. Because the log is a
 * bounded ring buffer, these counts describe the retained window rather than all
 * time.
 *
 * @param now - Epoch milliseconds. Present for signature stability and for
 *              future time-boxed metrics; current metrics are window-wide.
 * @returns The fatigue readout.
 */
export function getFatigueMetrics(now: number): FatigueMetrics {
  void now;

  let notificationsSuppressedByCooldown = 0;
  let reactivationsAfterDismissal = 0;
  const triggeredByRule = new Map<PredictiveRuleId, number>();
  const dismissedByRule = new Map<PredictiveRuleId, number>();
  const hoursToAction: number[] = [];
  const { auditLog, entries } = getStore();

  for (const line of auditLog) {
    const parsed = parseAlertKey(line.key);
    const ruleId = parsed?.ruleId;

    if (line.event === 'notification_suppressed' && line.detail === SUPPRESSION_REASON.cooldown) {
      notificationsSuppressedByCooldown += 1;
    } else if (line.event === 'reactivated' && line.detail === 'dismissal expired') {
      reactivationsAfterDismissal += 1;
    } else if (line.event === 'triggered' && ruleId !== undefined) {
      triggeredByRule.set(ruleId, (triggeredByRule.get(ruleId) ?? 0) + 1);
    } else if ((line.event === 'dismissed' || line.event === 'actioned') && ruleId !== undefined) {
      if (line.event === 'dismissed') {
        dismissedByRule.set(ruleId, (dismissedByRule.get(ruleId) ?? 0) + 1);
      }

      const entry = entries.get(line.key);
      if (entry !== undefined) {
        const elapsed = (Date.parse(line.at) - Date.parse(entry.firstDetectedAt)) / HOUR_MS;
        if (Number.isFinite(elapsed) && elapsed >= 0) {
          hoursToAction.push(elapsed);
        }
      }
    }
  }

  const dismissalRateByRule: DismissalRateByRule[] = [...triggeredByRule.keys()]
    .sort()
    .map((ruleId) => {
      const triggered = triggeredByRule.get(ruleId) ?? 0;
      const dismissed = dismissedByRule.get(ruleId) ?? 0;
      return { ruleId, triggered, dismissed, rate: triggered === 0 ? 0 : dismissed / triggered };
    });

  return {
    notificationsSuppressedByCooldown,
    dismissalRateByRule,
    medianHoursToAction: median(hoursToAction),
    reactivationsAfterDismissal,
    recommendations: buildRecommendations(dismissalRateByRule),
  };
}

/** Median of a sample, or `null` when the sample is empty. */
function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
  return Math.round(value * 10) / 10;
}

/**
 * Turns dismissal rates into suggestions from fixed templates.
 *
 * Suggestions only — no threshold is ever changed automatically. Self-tuning
 * would need cohort assignment and durable persistence this app does not have,
 * and would let one impatient afternoon of dismissals silence a rule for good.
 */
function buildRecommendations(rates: readonly DismissalRateByRule[]): string[] {
  const recommendations: string[] = [];

  for (const rate of rates) {
    if (rate.triggered >= FATIGUE_MINIMUM_TRIGGERS && rate.rate > FATIGUE_DISMISSAL_RATE_THRESHOLD) {
      const percentage = Math.round(rate.rate * 100);
      recommendations.push(
        `${rate.ruleId} is dismissed ${percentage}% of the time over ${rate.triggered} triggers — consider raising its threshold. Suggestion only; nothing has been changed.`
      );
    }
  }

  return recommendations;
}

/** Empties the store and the log. Tests only. */
export function reset(): void {
  const store = getStore();
  store.entries.clear();
  store.auditLog.length = 0;
}
