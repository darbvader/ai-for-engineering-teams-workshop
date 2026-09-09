'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AlertDetailPanel } from '@/components/AlertDetailPanel';
import type { Customer } from '@/data/mock-customers';
import type {
  AlertPriority,
  PredictiveAlert,
  PredictiveIntelligenceResponse,
} from '@/types/predictive-intelligence';

/** Card surface, copied from `MarketIntelligenceWidget` so the widgets sit flush. */
const CARD_CLASS_NAME =
  'flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-5 dark:border-neutral-700 dark:bg-neutral-900';

/** Default poll cadence. This is a poll over local mock data, not real-time push. */
const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** A hung request must surface as retryable, not as a forever-spinner. */
const REQUEST_TIMEOUT_MS = 8_000;

/** Fallback back-off when a 429 arrives without a usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 30_000;

const READ_ENDPOINT = '/api/predictive-intelligence';
const ACTION_ENDPOINT = '/api/predictive-intelligence/actions';

const TIMEOUT_ERROR_MESSAGE = 'Request timed out. Please try again.';
const NETWORK_ERROR_MESSAGE = 'Could not load predictive intelligence. Please try again.';
const THROTTLED_MESSAGE = 'Refreshing too quickly — retrying shortly.';
const ACTION_FAILED_MESSAGE = 'That action could not be saved. The alert has been restored.';

const ALL_PRIORITIES = 'all';

/**
 * Priority presentation.
 *
 * Colour is paired with a text label everywhere it appears, so colour is never
 * the only channel. Red/yellow mirror the health-score banding used elsewhere in
 * the dashboard.
 */
const PRIORITY_STYLES: Record<AlertPriority, { badge: string; label: string }> = {
  high: {
    badge: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-950 dark:text-red-200 dark:border-red-800',
    label: 'High',
  },
  medium: {
    badge:
      'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-950 dark:text-yellow-200 dark:border-yellow-800',
    label: 'Medium',
  },
};

const BUTTON_CLASS_NAME =
  'inline-flex min-h-11 items-center rounded border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800';

type WidgetStatus = 'idle' | 'loading' | 'success' | 'error';

/** Bookkeeping for one in-flight request, so an abort can be attributed. */
interface ActiveRequest {
  controller: AbortController;
  /** Set when a newer request replaced this one. A superseded abort renders no error. */
  superseded: boolean;
  /** Set when the timeout fired, which is a retryable error rather than silence. */
  timedOut: boolean;
}

export interface PredictiveIntelligenceWidgetProps {
  customers: Customer[];
  /** The dashboard's selection. Pins and highlights, never hides. */
  selectedCustomerId?: string;
  /** Called when a row is activated, so the other widgets can follow. */
  onSelectCustomer?: (id: string) => void;
  pollIntervalMs?: number;
  className?: string;
}

/** Formats an ISO timestamp as a short local time. */
function formatClockTime(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  return Number.isNaN(parsed.getTime())
    ? isoTimestamp
    : parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Renders an age in whole units, coarsening as it grows. */
function formatRelativeAge(isoTimestamp: string, nowMs: number): string {
  const elapsedMs = nowMs - Date.parse(isoTimestamp);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return 'just now';
  }

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/** The viewer's IANA zone, so business-hours gating happens in *their* day. */
function resolveBrowserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface AlertRowProps {
  alert: PredictiveAlert;
  isSelected: boolean;
  isExpanded: boolean;
  nowMs: number;
  busy: boolean;
  onActivate: (alert: PredictiveAlert) => void;
  onDismiss: (alert: PredictiveAlert) => void;
  onMarkActioned: (alert: PredictiveAlert) => void;
  onCloseDetail: () => void;
}

/**
 * One alert row.
 *
 * Memoized on the fields that can actually change what is drawn — a poll that
 * returns identical data re-renders nothing.
 */
const AlertRow = memo(
  function AlertRow({
    alert,
    isSelected,
    isExpanded,
    nowMs,
    busy,
    onActivate,
    onDismiss,
    onMarkActioned,
    onCloseDetail,
  }: AlertRowProps) {
    const style = PRIORITY_STYLES[alert.priority];
    const selectionClassName = isSelected
      ? 'ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-neutral-900'
      : '';

    return (
      <li className={`rounded border border-gray-200 dark:border-neutral-700 ${selectionClassName}`.trim()}>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onClick={() => onActivate(alert)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onActivate(alert);
            }
          }}
          className="flex w-full cursor-pointer flex-col gap-1 p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded border px-1.5 py-0.5 text-xs font-semibold ${style.badge}`}>
              {style.label}
            </span>
            {alert.escalated && (
              <span className="rounded border border-orange-300 bg-orange-100 px-1.5 py-0.5 text-xs font-semibold text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
                Escalated
              </span>
            )}
            <span className="min-w-0 break-words text-sm font-medium text-gray-900 dark:text-neutral-100">
              {alert.customerName}
            </span>
            <span className="min-w-0 break-words text-xs text-gray-600 dark:text-neutral-400">
              {alert.company}
            </span>
            {alert.occurrenceCount > 1 && (
              <span className="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-600 dark:border-neutral-600 dark:text-neutral-300">
                Seen {alert.occurrenceCount}×
              </span>
            )}
          </div>
          <p className="break-words text-sm text-gray-800 dark:text-neutral-200">{alert.title}</p>
          <p className="text-xs text-gray-500 dark:text-neutral-400">
            First detected {formatRelativeAge(alert.firstDetectedAt, nowMs)} · score{' '}
            {alert.priorityScore}
          </p>
        </div>

        {isExpanded && (
          <div className="px-3 pb-3">
            <AlertDetailPanel
              alert={alert}
              busy={busy}
              onClose={onCloseDetail}
              onDismiss={onDismiss}
              onMarkActioned={onMarkActioned}
            />
          </div>
        )}
      </li>
    );
  },
  (previous, next) =>
    previous.alert.id === next.alert.id &&
    previous.alert.lastTriggeredAt === next.alert.lastTriggeredAt &&
    previous.alert.priorityScore === next.alert.priorityScore &&
    previous.isSelected === next.isSelected &&
    previous.isExpanded === next.isExpanded &&
    previous.busy === next.busy
);

/**
 * Ranked, proactive risk monitoring across customers.
 *
 * Fuses internal signals with external market sentiment into one ordered list.
 * **All data is mock**, and the "Sample data" badge says so wherever alerts are
 * shown — this is a poll over locally generated data, not real-time monitoring,
 * and a demo audience must never be led to think otherwise.
 *
 * Selection **pins and highlights**; it never filters. Hard-filtering to the
 * selected customer would hide a burning high-priority alert for someone else,
 * which defeats the purpose of a monitoring widget.
 */
export function PredictiveIntelligenceWidget({
  customers,
  selectedCustomerId,
  onSelectCustomer,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  className = '',
}: PredictiveIntelligenceWidgetProps) {
  const [status, setStatus] = useState<WidgetStatus>('idle');
  const [payload, setPayload] = useState<PredictiveIntelligenceResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [throttled, setThrottled] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<AlertPriority | typeof ALL_PRIORITIES>(
    ALL_PRIORITIES
  );
  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const backOffUntilRef = useRef<number>(0);
  const hasLoadedRef = useRef(false);

  const customerIds = useMemo(
    () => customers.map((customer) => customer.id).join(','),
    [customers]
  );

  const load = useCallback(async () => {
    if (Date.now() < backOffUntilRef.current) {
      return;
    }

    // Supersession: the previous request is abandoned so a slow response can
    // never overwrite fresher data. A superseded abort is not an error.
    const previous = activeRequestRef.current;
    if (previous !== null) {
      previous.superseded = true;
      previous.controller.abort();
    }

    const request: ActiveRequest = {
      controller: new AbortController(),
      superseded: false,
      timedOut: false,
    };
    activeRequestRef.current = request;

    // Timeout is a separate concern from supersession, and both are needed.
    const timeoutId = setTimeout(() => {
      request.timedOut = true;
      request.controller.abort();
    }, REQUEST_TIMEOUT_MS);

    if (!hasLoadedRef.current) {
      setStatus('loading');
    }

    const query = new URLSearchParams({ timezone: resolveBrowserTimeZone() });
    if (customerIds.length > 0) {
      query.set('customerIds', customerIds);
    }

    try {
      const response = await fetch(`${READ_ENDPOINT}?${query.toString()}`, {
        signal: request.controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (response.status === 429) {
        // Throttling is a "slow down", not a failure: the previous list stays.
        const retryAfterSeconds = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
        const backOffMs = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : DEFAULT_RETRY_AFTER_MS;
        backOffUntilRef.current = Date.now() + backOffMs;
        setThrottled(true);
        return;
      }

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = (await response.json()) as PredictiveIntelligenceResponse;
      hasLoadedRef.current = true;
      setPayload(data);
      setThrottled(false);
      setErrorMessage(null);
      setStatus('success');
    } catch (error) {
      if (request.superseded) {
        return;
      }

      const message = request.timedOut ? TIMEOUT_ERROR_MESSAGE : NETWORK_ERROR_MESSAGE;
      setErrorMessage(message);
      // A failed poll after a good one keeps the good data on screen; only a
      // cold failure is allowed to blank the widget.
      setStatus(hasLoadedRef.current ? 'success' : 'error');
      void error;
    } finally {
      clearTimeout(timeoutId);
      if (activeRequestRef.current === request) {
        activeRequestRef.current = null;
      }
    }
  }, [customerIds]);

  useEffect(() => {
    void load();

    // A backgrounded tab that keeps polling generates work forever for nobody.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };

    const intervalId = setInterval(() => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      void load();
    }, pollIntervalMs);

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      const inFlight = activeRequestRef.current;
      if (inFlight !== null) {
        inFlight.superseded = true;
        inFlight.controller.abort();
      }
    };
  }, [load, pollIntervalMs]);

  const sendAction = useCallback(
    async (alert: PredictiveAlert, action: 'dismiss' | 'action') => {
      const snapshot = payload;
      if (snapshot === null) {
        return;
      }

      setPendingActionId(alert.id);
      setActionMessage(null);
      // Optimistic removal, rolled back below if the server disagrees.
      setPayload({ ...snapshot, alerts: snapshot.alerts.filter((row) => row.id !== alert.id) });
      setExpandedAlertId(null);

      try {
        const response = await fetch(ACTION_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alertId: alert.id, action }),
        });

        if (!response.ok) {
          throw new Error(`Action failed with status ${response.status}`);
        }
      } catch (error) {
        setPayload(snapshot);
        setActionMessage(ACTION_FAILED_MESSAGE);
        void error;
      } finally {
        setPendingActionId(null);
      }
    },
    [payload]
  );

  const handleActivate = useCallback(
    (alert: PredictiveAlert) => {
      setExpandedAlertId((current) => (current === alert.id ? null : alert.id));
      onSelectCustomer?.(alert.customerId);
    },
    [onSelectCustomer]
  );

  const handleDismiss = useCallback(
    (alert: PredictiveAlert) => {
      void sendAction(alert, 'dismiss');
    },
    [sendAction]
  );

  const handleMarkActioned = useCallback(
    (alert: PredictiveAlert) => {
      void sendAction(alert, 'action');
    },
    [sendAction]
  );

  const handleCloseDetail = useCallback(() => {
    setExpandedAlertId(null);
  }, []);

  const visibleAlerts = useMemo(() => {
    const alerts = payload?.alerts ?? [];
    const filtered =
      priorityFilter === ALL_PRIORITIES
        ? alerts
        : alerts.filter((alert) => alert.priority === priorityFilter);

    if (selectedCustomerId === undefined) {
      return filtered;
    }

    // Pinned, not filtered: the rest of the list stays visible below.
    return [
      ...filtered.filter((alert) => alert.customerId === selectedCustomerId),
      ...filtered.filter((alert) => alert.customerId !== selectedCustomerId),
    ];
  }, [payload, priorityFilter, selectedCustomerId]);

  const nowMs = Date.now();

  if (status === 'loading' && payload === null) {
    return (
      <section className={`${CARD_CLASS_NAME} ${className}`.trim()} aria-busy="true">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-neutral-50">
          Predictive Intelligence
        </h2>
        <p className="text-sm text-gray-600 dark:text-neutral-300">Loading alerts…</p>
      </section>
    );
  }

  if (status === 'error' && payload === null) {
    return (
      <section className={`${CARD_CLASS_NAME} ${className}`.trim()} aria-labelledby="predictive-title">
        <h2 id="predictive-title" className="text-lg font-semibold text-gray-900 dark:text-neutral-50">
          Predictive Intelligence
        </h2>
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {errorMessage ?? NETWORK_ERROR_MESSAGE}
        </p>
        <button type="button" className={`${BUTTON_CLASS_NAME} self-start`} onClick={() => void load()}>
          Retry
        </button>
      </section>
    );
  }

  const summary = payload?.summary;

  return (
    <section className={`${CARD_CLASS_NAME} ${className}`.trim()} aria-labelledby="predictive-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="predictive-title" className="text-lg font-semibold text-gray-900 dark:text-neutral-50">
          Predictive Intelligence
        </h2>
        <span className="rounded border border-gray-300 px-1.5 py-0.5 text-xs font-medium text-gray-700 dark:border-neutral-600 dark:text-neutral-200">
          Sample data
        </span>
        {payload !== null && !payload.marketDataAvailable && (
          <span className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200">
            Market data unavailable
          </span>
        )}
      </div>

      {summary !== undefined && (
        <p className="text-sm text-gray-700 dark:text-neutral-300">
          {summary.high} high · {summary.medium} medium across {summary.customersEvaluated} customers
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="predictive-priority-filter" className="text-sm text-gray-700 dark:text-neutral-300">
          Priority
        </label>
        <select
          id="predictive-priority-filter"
          className="min-h-11 rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
          value={priorityFilter}
          onChange={(event) =>
            setPriorityFilter(event.target.value as AlertPriority | typeof ALL_PRIORITIES)
          }
        >
          <option value={ALL_PRIORITIES}>All priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
        </select>
      </div>

      {throttled && (
        <p className="text-sm text-gray-700 dark:text-neutral-300">{THROTTLED_MESSAGE}</p>
      )}

      {errorMessage !== null && payload !== null && (
        <p className="text-xs text-gray-600 dark:text-neutral-400">
          Last updated {payload.evaluatedAt === undefined ? '' : formatClockTime(payload.evaluatedAt)}{' '}
          · retrying
        </p>
      )}

      {actionMessage !== null && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {actionMessage}
        </p>
      )}

      <div aria-live="polite" aria-atomic="false">
        {visibleAlerts.length === 0 ? (
          <p className="text-sm text-gray-700 dark:text-neutral-300">
            No active alerts across {summary?.customersEvaluated ?? customers.length} customers.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleAlerts.map((alert) => (
              <AlertRow
                key={alert.id}
                alert={alert}
                nowMs={nowMs}
                isSelected={alert.customerId === selectedCustomerId}
                isExpanded={expandedAlertId === alert.id}
                busy={pendingActionId === alert.id}
                onActivate={handleActivate}
                onDismiss={handleDismiss}
                onMarkActioned={handleMarkActioned}
                onCloseDetail={handleCloseDetail}
              />
            ))}
          </ul>
        )}
      </div>

      {summary !== undefined && summary.suppressedByCap > 0 && (
        <p className="text-xs text-gray-600 dark:text-neutral-400">
          +{summary.suppressedByCap} more held back to keep this list readable.
        </p>
      )}
    </section>
  );
}
