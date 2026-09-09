'use client';

import { useCallback, useEffect, useRef } from 'react';

import type { PredictiveAlert } from '@/types/predictive-intelligence';

/** Elements that can take focus inside the dialog. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const BUTTON_CLASS_NAME =
  'inline-flex min-h-11 items-center rounded border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800';

export interface AlertDetailPanelProps {
  alert: PredictiveAlert;
  /** Closes the panel. Focus returns to the row that opened it. */
  onClose: () => void;
  onDismiss: (alert: PredictiveAlert) => void;
  onMarkActioned: (alert: PredictiveAlert) => void;
  /** Disables the action buttons while a request is in flight. */
  busy?: boolean;
}

/**
 * Formats an ISO timestamp for display, falling back to the raw string.
 */
function formatTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  return Number.isNaN(parsed.getTime())
    ? isoTimestamp
    : parsed.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/**
 * The full record behind one alert.
 *
 * Shows why it fired (`triggeredClause` and the evidence table, including the
 * supporting-signal annotations), what to do about it, how long it has been
 * running, and the health-score breakdown.
 *
 * When the recalculated total disagrees with the stored score, **both** are
 * shown and the computed one is labelled "recalculated" — silently preferring
 * either is how a widget ends up displaying one number while the alert reasons
 * about another.
 *
 * Focus is trapped while open, Escape closes, and focus returns to the
 * originating row.
 */
export function AlertDetailPanel({
  alert,
  onClose,
  onDismiss,
  onMarkActioned,
  busy = false,
}: AlertDetailPanelProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Remember the row that opened the panel so focus can go back to it.
  useEffect(() => {
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []
      );
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, so Tab can never escape the dialog.
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    },
    [onClose]
  );

  const { healthContext } = alert;
  const scoresDisagree =
    healthContext !== undefined &&
    healthContext.recalculatedScore !== null &&
    healthContext.recalculatedScore !== healthContext.storedScore;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`alert-detail-title-${alert.id}`}
      onKeyDown={handleKeyDown}
      className="mt-2 flex flex-col gap-3 rounded-lg border border-gray-300 bg-gray-50 p-4 text-sm dark:border-neutral-600 dark:bg-neutral-800"
    >
      <div className="flex items-start justify-between gap-3">
        <h3
          id={`alert-detail-title-${alert.id}`}
          className="text-base font-semibold text-gray-900 dark:text-neutral-50"
        >
          {alert.title}
        </h3>
        <button type="button" className={BUTTON_CLASS_NAME} onClick={onClose}>
          Close
        </button>
      </div>

      <p className="text-gray-700 dark:text-neutral-300">{alert.message}</p>

      <p className="text-xs text-gray-600 dark:text-neutral-400">
        Triggered by: <span className="font-medium">{alert.triggeredClause}</span>
      </p>

      <div>
        <h4 className="font-semibold text-gray-900 dark:text-neutral-100">Evidence</h4>
        <table className="mt-1 w-full text-left">
          <caption className="sr-only">Evidence behind this alert</caption>
          <tbody>
            {alert.evidence.map((row) => (
              <tr key={`${row.label}-${row.value}`} className="border-t border-gray-200 dark:border-neutral-700">
                <th
                  scope="row"
                  className="w-1/3 py-1 pr-2 text-left font-normal text-gray-600 dark:text-neutral-400"
                >
                  {row.label}
                </th>
                <td className="py-1 break-words text-gray-800 dark:text-neutral-200">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h4 className="font-semibold text-gray-900 dark:text-neutral-100">Recommended actions</h4>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-gray-700 dark:text-neutral-300">
          {alert.recommendedActions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ol>
      </div>

      <div>
        <h4 className="font-semibold text-gray-900 dark:text-neutral-100">Detection history</h4>
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-gray-700 dark:text-neutral-300">
          <dt className="text-gray-600 dark:text-neutral-400">First detected</dt>
          <dd>{formatTimestamp(alert.firstDetectedAt)}</dd>
          <dt className="text-gray-600 dark:text-neutral-400">Last triggered</dt>
          <dd>{formatTimestamp(alert.lastTriggeredAt)}</dd>
          <dt className="text-gray-600 dark:text-neutral-400">Times detected</dt>
          <dd>{alert.occurrenceCount}</dd>
          <dt className="text-gray-600 dark:text-neutral-400">Notifications</dt>
          <dd>
            {alert.notificationSuppressedUntil === null
              ? 'Delivered'
              : `Held until ${formatTimestamp(alert.notificationSuppressedUntil)}`}
          </dd>
        </dl>
      </div>

      {healthContext !== undefined && (
        <div>
          <h4 className="font-semibold text-gray-900 dark:text-neutral-100">Health score</h4>
          <p className="mt-1 text-gray-700 dark:text-neutral-300">
            Dashboard score <span className="font-semibold">{healthContext.storedScore}</span>
            {healthContext.recalculatedScore !== null && (
              <>
                {' · '}
                <span className="font-semibold">{healthContext.recalculatedScore}</span> recalculated
              </>
            )}
          </p>
          {scoresDisagree && (
            <p className="text-xs text-gray-600 dark:text-neutral-400">
              The rules use the dashboard score. The recalculated total is shown for context only.
            </p>
          )}
          <table className="mt-1 w-full text-left">
            <caption className="sr-only">Recalculated health score by factor</caption>
            <thead>
              <tr className="text-xs text-gray-600 dark:text-neutral-400">
                <th scope="col" className="py-1 pr-2 font-medium">
                  Factor
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Score
                </th>
                <th scope="col" className="py-1 font-medium">
                  Weight
                </th>
              </tr>
            </thead>
            <tbody>
              {healthContext.factors.map((factor) => (
                <tr key={factor.name} className="border-t border-gray-200 dark:border-neutral-700">
                  <th scope="row" className="py-1 pr-2 font-normal text-gray-800 dark:text-neutral-200">
                    {factor.name}
                  </th>
                  <td className="py-1 pr-2 text-gray-800 dark:text-neutral-200">
                    {factor.score === null ? 'No data' : factor.score}
                  </td>
                  <td className="py-1 text-gray-800 dark:text-neutral-200">
                    {Math.round(factor.effectiveWeight * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON_CLASS_NAME}
          disabled={busy}
          onClick={() => onDismiss(alert)}
        >
          Dismiss
        </button>
        <button
          type="button"
          className={BUTTON_CLASS_NAME}
          disabled={busy}
          onClick={() => onMarkActioned(alert)}
        >
          Mark actioned
        </button>
      </div>
    </div>
  );
}
