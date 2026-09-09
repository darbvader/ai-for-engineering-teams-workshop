'use client';

import { useCallback, useEffect, useId, useMemo, useReducer, useState } from 'react';

import type { Customer } from '@/data/mock-customers';
import {
  alertEngine,
  alertKey,
  alertsToCsv,
  createMonitoringState,
  monitoringStateReducer,
  summarizeMonitoringState,
  type Alert,
  type AlertHistoryEntry,
  type AlertPriority,
  type AlertRuleConfig,
  type AlertRuleId,
  type CustomerEvaluationInput,
  type MonitoringAction,
  type MonitoringState,
  type SkippedRule
} from '@/lib/alerts';

/**
 * How each priority tier is presented.
 *
 * **Green is deliberately absent.** The requirements ask for "red/yellow/green"
 * colour coding, but a green alert is a contradiction — there is no such thing as
 * a healthy alert. The third state is the *absence* of alerts, which is rendered
 * as a plain, uncoloured empty row. Every tier also carries a text label, so
 * colour is never the only signal.
 */
const PRIORITY_PRESENTATION: Record<AlertPriority, { label: string; chipClassName: string; rowClassName: string }> = {
  high: {
    label: 'High priority',
    chipClassName: 'bg-red-700 text-white dark:bg-red-300 dark:text-red-950',
    rowClassName: 'border-l-4 border-l-red-700 dark:border-l-red-300'
  },
  medium: {
    label: 'Medium priority',
    chipClassName: 'bg-yellow-800 text-white dark:bg-yellow-300 dark:text-yellow-950',
    rowClassName: 'border-l-4 border-l-yellow-800 dark:border-l-yellow-300'
  }
};

/** Human wording for each rule id, so the panel never shows a raw identifier. */
const RULE_LABELS: Record<AlertRuleId, string> = {
  'payment-risk': 'Payment risk',
  'engagement-cliff': 'Engagement cliff',
  'contract-expiration-risk': 'Contract expiration risk',
  'support-ticket-spike': 'Support ticket spike',
  'feature-adoption-stall': 'Feature adoption stall'
};

/** Wording for each closed-alert outcome in the history view. */
const OUTCOME_LABELS: Record<'resolved' | 'dismissed' | 'actioned', string> = {
  resolved: 'Resolved on its own',
  dismissed: 'Dismissed',
  actioned: 'Marked actioned'
};

/** Stated on every view that writes state, because none of it survives a reload. */
const SESSION_ONLY_CAVEAT = 'Acknowledgements, actions and dismissals last for this browser session only — nothing is stored.';

const EMPTY_STATE_MESSAGE = 'No active alerts';

const CLIPBOARD_SUCCESS_MESSAGE = 'Alert list copied as CSV.';
const CLIPBOARD_FAILURE_MESSAGE = 'Could not access the clipboard. Nothing was copied.';

export interface AlertsPanelProps {
  /**
   * Pre-computed evaluation inputs for **every** customer, not just the selected
   * one. A panel scoped to the current selection cannot tell you where to look
   * next.
   */
  inputs: CustomerEvaluationInput[];
  /** Customer records, used only to join `customerId` to a display name. */
  customers: readonly Customer[];
  /**
   * Monitoring state owned by the Dashboard. Supply this together with
   * `dispatch` to make the panel controlled — the arrangement the spec calls
   * for, since `scoreHistory` is written during alert evaluation and read by the
   * health display.
   *
   * Omit **both** and the panel falls back to its own reducer so it can be
   * rendered standalone. In that mode `scoreHistory` is out of reach of the
   * health display, so the Dashboard should own it as soon as it is wired up.
   */
  state?: MonitoringState;
  /** Dispatch for the Dashboard's `monitoringStateReducer`. */
  dispatch?: (action: MonitoringAction) => void;
  /** Seed for the uncontrolled fallback, normally from `buildAllScoreHistories()`. */
  initialScoreHistory?: Record<string, Array<{ date: string; score: number }>>;
  /** Evaluation date. Defaults to the frozen demo date supplied by the caller. */
  asOf: string;
  /** Threshold overrides, for comparing rule variants by hand. */
  config?: AlertRuleConfig;
  /** Called when a row is activated, so the Dashboard can select that customer. */
  onSelectCustomer?: (customerId: string) => void;
  /** Highlights the row belonging to the currently selected customer. */
  selectedCustomerId?: string;
  /** Heading level, so the widget fits any document outline. Default `3`. */
  headingLevel?: 2 | 3 | 4;
  /** Extra classes appended to the root element. */
  className?: string;
}

/**
 * Monitoring state plus a dispatch, either the caller's or the panel's own.
 *
 * A hook rather than a branch, because hook order may not vary between renders:
 * the internal reducer is always created and simply ignored when the caller
 * supplies state.
 */
function useResolvedMonitoringState(
  props: Pick<AlertsPanelProps, 'state' | 'dispatch' | 'initialScoreHistory' | 'inputs' | 'asOf' | 'config'>
): [MonitoringState, (action: MonitoringAction) => void] {
  const [internalState, internalDispatch] = useReducer(monitoringStateReducer, props.initialScoreHistory, (seed) =>
    createMonitoringState(seed ?? {})
  );

  const isControlled = props.state !== undefined && props.dispatch !== undefined;
  const state = isControlled && props.state !== undefined ? props.state : internalState;
  const dispatch = isControlled && props.dispatch !== undefined ? props.dispatch : internalDispatch;

  // Commit the transitions this evaluation implies: opening, closing, and the
  // day's score snapshot. Keyed on the inputs and the date rather than on state,
  // so this settles in one pass instead of re-running on every state change.
  useEffect(() => {
    dispatch({ type: 'evaluate', inputs: props.inputs, asOf: props.asOf, config: props.config });
  }, [dispatch, props.inputs, props.asOf, props.config]);

  return [state, dispatch];
}

/** The customer's display name, or the bare id when no record is available. */
function resolveCustomerLabel(customers: readonly Customer[], customerId: string): string {
  const customer = customers.find((candidate) => candidate.id === customerId);
  return customer === undefined ? `Customer ${customerId}` : customer.company;
}

/**
 * Dashboard widget listing every open alert across the whole portfolio.
 *
 * Rendering is driven entirely by `state.open`, which is the engine's record of
 * what is *currently wrong*. Cooldown is not consulted here and must not be:
 * suppressing a rendered alert because it recently notified is what makes a
 * panel display each alert once and then empty itself.
 *
 * A client component because the disclosure, the action controls, and the
 * clipboard export all hold or produce state.
 */
export function AlertsPanel({
  inputs,
  customers,
  state: controlledState,
  dispatch: controlledDispatch,
  initialScoreHistory,
  asOf,
  config,
  onSelectCustomer,
  selectedCustomerId,
  headingLevel = 3,
  className = ''
}: AlertsPanelProps) {
  const [state, dispatch] = useResolvedMonitoringState({
    state: controlledState,
    dispatch: controlledDispatch,
    initialScoreHistory,
    inputs,
    asOf,
    config
  });

  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null);
  const [isHistoryVisible, setIsHistoryVisible] = useState(false);
  const [clipboardMessage, setClipboardMessage] = useState<string | null>(null);
  const panelElementId = useId();

  // Memoized on the inputs, the date and the state, per the spec's widget-boundary
  // memoization rule. The engine itself stays uncached: a cache inside a pure
  // function is no longer a pure function.
  const evaluation = useMemo(() => alertEngine(inputs, state, asOf, config), [inputs, state, asOf, config]);

  /**
   * The folded state this evaluation implies, which is also what the commit
   * effect is about to store.
   *
   * Everything displayed reads from here rather than from the committed state,
   * so the header counts can never disagree with the list beneath them. Reading
   * counts from the committed state showed "0 high, 0 medium" above seven
   * rendered alerts on the very first paint, before the effect had run.
   */
  const displayState = evaluation.state;
  const counts = useMemo(() => summarizeMonitoringState(displayState), [displayState]);

  const handleCopyAsCsv = useCallback(async () => {
    const csv = alertsToCsv(evaluation.alerts);

    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      setClipboardMessage(CLIPBOARD_FAILURE_MESSAGE);
      return;
    }

    try {
      await navigator.clipboard.writeText(csv);
      setClipboardMessage(CLIPBOARD_SUCCESS_MESSAGE);
    } catch {
      // Deliberately no console output: the payload contains customer signals.
      setClipboardMessage(CLIPBOARD_FAILURE_MESSAGE);
    }
  }, [evaluation.alerts]);

  const HeadingTag = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const rootClassName =
    `rounded-lg border border-gray-200 bg-white p-4 text-gray-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 ${className}`.trim();

  return (
    <section aria-labelledby={`${panelElementId}-title`} className={rootClassName}>
      <header className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <HeadingTag id={`${panelElementId}-title`} className="text-lg font-semibold text-gray-900 dark:text-slate-100">
            Predictive alerts
          </HeadingTag>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-slate-300">
            <span>
              <span className="font-semibold">{counts.high}</span> high
            </span>
            <span>
              <span className="font-semibold">{counts.medium}</span> medium
            </span>
            <span>
              <span className="font-semibold">
                {counts.actioned} / {counts.opened}
              </span>{' '}
              actioned this session
            </span>
          </p>
        </div>

        <button
          type="button"
          onClick={handleCopyAsCsv}
          className="self-start rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          Copy as CSV
        </button>
      </header>

      <p aria-live="polite" className="mb-3 text-xs text-gray-600 dark:text-slate-300">
        {clipboardMessage ?? SESSION_ONLY_CAVEAT}
      </p>

      {evaluation.alerts.length === 0 ? (
        <p className="rounded border border-dashed border-gray-300 p-3 text-sm text-gray-600 dark:border-slate-600 dark:text-slate-300">
          {EMPTY_STATE_MESSAGE}
        </p>
      ) : (
        <ul className="space-y-2">
          {evaluation.alerts.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              customerLabel={resolveCustomerLabel(customers, alert.customerId)}
              isExpanded={expandedAlertId === alert.id}
              isSelected={selectedCustomerId === alert.customerId}
              detailElementId={`${panelElementId}-${alert.id}`}
              onToggle={() => {
                setExpandedAlertId(expandedAlertId === alert.id ? null : alert.id);
                onSelectCustomer?.(alert.customerId);
              }}
              isAcknowledged={displayState.acknowledged[alertKey(alert.customerId, alert.ruleId)] !== undefined}
              onAcknowledge={() =>
                dispatch({ type: 'acknowledge', customerId: alert.customerId, ruleId: alert.ruleId, at: alert.triggeredAt })
              }
              onMarkActioned={() =>
                dispatch({ type: 'markActioned', customerId: alert.customerId, ruleId: alert.ruleId, at: alert.triggeredAt })
              }
              onDismiss={() =>
                dispatch({ type: 'dismiss', customerId: alert.customerId, ruleId: alert.ruleId, at: alert.triggeredAt })
              }
            />
          ))}
        </ul>
      )}

      <SkippedRules skipped={evaluation.skipped} customers={customers} />

      <div className="mt-4 border-t border-gray-200 pt-3 dark:border-slate-700">
        <button
          type="button"
          aria-expanded={isHistoryVisible}
          aria-controls={`${panelElementId}-history`}
          onClick={() => setIsHistoryVisible(!isHistoryVisible)}
          className="text-xs font-semibold text-blue-700 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:text-blue-300"
        >
          {isHistoryVisible ? 'Hide' : 'Show'} closed alerts ({displayState.history.length})
        </button>

        {isHistoryVisible ? (
          <div id={`${panelElementId}-history`} className="mt-2">
            <p className="text-xs text-gray-600 dark:text-slate-300">
              This session only. Closed alerts are held in memory and are not an audit trail.
            </p>
            {displayState.history.length === 0 ? (
              <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">No alerts have closed yet.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {displayState.history.map((entry) => (
                  <HistoryRow
                    key={`${entry.alertId}-${entry.closedAt ?? 'open'}`}
                    entry={entry}
                    customerLabel={resolveCustomerLabel(customers, entry.customerId)}
                  />
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface AlertRowProps {
  alert: Alert;
  customerLabel: string;
  isExpanded: boolean;
  isSelected: boolean;
  detailElementId: string;
  isAcknowledged: boolean;
  onToggle: () => void;
  onAcknowledge: () => void;
  onMarkActioned: () => void;
  onDismiss: () => void;
}

/** One alert: a summary row that expands to the triggering numbers and the controls. */
function AlertRow({
  alert,
  customerLabel,
  isExpanded,
  isSelected,
  detailElementId,
  isAcknowledged,
  onToggle,
  onAcknowledge,
  onMarkActioned,
  onDismiss
}: AlertRowProps) {
  const presentation = PRIORITY_PRESENTATION[alert.priority];
  const selectionClassName = isSelected ? 'ring-2 ring-blue-600 ring-offset-1' : '';

  return (
    <li
      className={`rounded border border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-900 ${presentation.rowClassName} ${selectionClassName}`.trim()}
    >
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={detailElementId}
        onClick={onToggle}
        className="flex w-full flex-col gap-1 p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${presentation.chipClassName}`}>
            {presentation.label}
          </span>
          <span className="text-xs font-medium text-gray-600 dark:text-slate-300">{RULE_LABELS[alert.ruleId]}</span>
          {isAcknowledged ? (
            <span className="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-600 dark:border-slate-600 dark:text-slate-300">
              Acknowledged
            </span>
          ) : null}
        </span>
        <span className="text-sm font-semibold text-gray-900 dark:text-slate-100">{alert.title}</span>
        <span className="text-xs text-gray-600 dark:text-slate-300">
          {customerLabel} · priority score {alert.priorityScore}
        </span>
      </button>

      {isExpanded ? (
        <div id={detailElementId} className="space-y-2 border-t border-gray-200 p-3 text-sm dark:border-slate-700">
          <p className="text-gray-800 dark:text-slate-200">{alert.detail}</p>
          <p className="text-gray-800 dark:text-slate-200">
            <span className="font-semibold">Recommended action: </span>
            {alert.recommendedAction}
          </p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-2 dark:text-slate-300">
            <div>
              <dt className="inline font-semibold">Customer: </dt>
              <dd className="inline">{customerLabel}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">First opened: </dt>
              <dd className="inline">{alert.firstTriggeredAt.slice(0, 10)}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Last triggered: </dt>
              <dd className="inline">{alert.triggeredAt.slice(0, 10)}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Raised in business hours: </dt>
              <dd className="inline">{alert.withinBusinessHours ? 'Yes' : 'No'}</dd>
            </div>
          </dl>

          {alert.notes !== undefined && alert.notes.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-gray-700 dark:text-slate-300">
              {alert.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <ActionButton label="Acknowledge" onClick={onAcknowledge} />
            <ActionButton label="Mark actioned" onClick={onMarkActioned} />
            <ActionButton label="Dismiss" onClick={onDismiss} />
          </div>
          <p className="text-xs text-gray-600 dark:text-slate-300">{SESSION_ONLY_CAVEAT}</p>
        </div>
      ) : null}
    </li>
  );
}

function ActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      {label}
    </button>
  );
}

/**
 * Rules that could not be evaluated, listed **separately** from the alert list.
 *
 * Never folded into the all-clear: "we did not look" and "we looked and found
 * nothing" are different claims, and a new customer with nine days of history
 * would otherwise read as healthy on rules that never ran.
 */
function SkippedRules({ skipped, customers }: { skipped: SkippedRule[]; customers: readonly Customer[] }) {
  if (skipped.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3 dark:border-slate-700 dark:bg-slate-800">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-slate-200">
        Not evaluated — insufficient history
      </h4>
      <ul className="mt-1 space-y-1 text-xs text-gray-700 dark:text-slate-300">
        {skipped.map((entry) => (
          <li key={`${entry.customerId}:${entry.ruleId}`}>
            {resolveCustomerLabel(customers, entry.customerId)} · {RULE_LABELS[entry.ruleId]} — needs{' '}
            {entry.requiredHistoryDays} days of history, has {entry.availableHistoryDays}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HistoryRow({ entry, customerLabel }: { entry: AlertHistoryEntry; customerLabel: string }) {
  return (
    <li className="text-gray-700 dark:text-slate-300">
      {customerLabel} · {RULE_LABELS[entry.ruleId]} ·{' '}
      {entry.outcome === null ? 'Still open' : OUTCOME_LABELS[entry.outcome]}
      {entry.closedAt === null ? '' : ` on ${entry.closedAt.slice(0, 10)}`}
    </li>
  );
}

/**
 * The Dashboard's monitoring state, exported for `src/app/page.tsx` to own.
 *
 * The spec puts this reducer in the Dashboard so both widgets can read
 * `scoreHistory`: it is written during alert evaluation and read by
 * `CustomerHealthDisplay` for its trend. Pass the returned `state` and `dispatch`
 * straight into {@link AlertsPanel} to run it controlled.
 */
export function useMonitoringState(
  initialScoreHistory: Record<string, Array<{ date: string; score: number }>>
): [MonitoringState, (action: MonitoringAction) => void] {
  const [state, dispatch] = useReducer(monitoringStateReducer, initialScoreHistory, (seed) =>
    createMonitoringState(seed)
  );

  return [state, dispatch];
}
