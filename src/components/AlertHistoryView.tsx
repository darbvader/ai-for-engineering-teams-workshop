'use client';

import { useMemo, useState } from 'react';

import { toCsv } from '@/services/predictiveCsv';
import type { AuditEntry } from '@/types/predictive-intelligence';

/** Card surface, matching the sibling widgets. */
const CARD_CLASS_NAME =
  'flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-5 dark:border-neutral-700 dark:bg-neutral-900';

const CONTROL_CLASS_NAME =
  'min-h-11 rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100';

const BUTTON_CLASS_NAME =
  'inline-flex min-h-11 items-center rounded border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800';

/** The events this view shows: what a human did, and what came back. */
const SHOWN_EVENTS: ReadonlySet<AuditEntry['event']> = new Set([
  'dismissed',
  'actioned',
  'reactivated',
]);

/** Column order, shared by the on-screen table and both exports. */
const EXPORT_COLUMNS: readonly string[] = Object.freeze([
  'at',
  'customerId',
  'ruleId',
  'event',
  'detail',
]);

const ALL_FILTER_VALUE = 'all';

export interface AlertHistoryViewProps {
  /** Audit entries from `GET /api/predictive-intelligence/history`. */
  audit: readonly AuditEntry[];
  className?: string;
}

/** Splits a dedup key into its parts for display and filtering. */
function splitKey(key: string): { customerId: string; ruleId: string } {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex <= 0) {
    return { customerId: key, ruleId: '' };
  }
  return { customerId: key.slice(0, separatorIndex), ruleId: key.slice(separatorIndex + 1) };
}

/**
 * Triggers a client-side download of a text payload.
 *
 * Object URLs are revoked immediately after the click, so a long-lived page does
 * not accumulate blobs.
 */
function downloadTextFile(fileName: string, mimeType: string, contents: string): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The alert activity log: dismissals, actions, and alerts that came back.
 *
 * Filterable by customer and rule, exportable as JSON and CSV.
 *
 * The log is a process-local ring buffer that resets when the server restarts, so
 * it is **not a compliance audit trail** — the footer says as much on screen
 * rather than leaving a reader to assume durability.
 */
export function AlertHistoryView({ audit, className = '' }: AlertHistoryViewProps) {
  const [customerFilter, setCustomerFilter] = useState<string>(ALL_FILTER_VALUE);
  const [ruleFilter, setRuleFilter] = useState<string>(ALL_FILTER_VALUE);

  const rows = useMemo(
    () =>
      audit
        .filter((entry) => SHOWN_EVENTS.has(entry.event))
        .map((entry) => ({ ...entry, ...splitKey(entry.key) }))
        .reverse(),
    [audit]
  );

  const customerIds = useMemo(
    () => [...new Set(rows.map((row) => row.customerId))].sort(),
    [rows]
  );
  const ruleIds = useMemo(() => [...new Set(rows.map((row) => row.ruleId))].sort(), [rows]);

  const visibleRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          (customerFilter === ALL_FILTER_VALUE || row.customerId === customerFilter) &&
          (ruleFilter === ALL_FILTER_VALUE || row.ruleId === ruleFilter)
      ),
    [rows, customerFilter, ruleFilter]
  );

  const exportRows = visibleRows.map((row) => [
    row.at,
    row.customerId,
    row.ruleId,
    row.event,
    row.detail ?? '',
  ]);

  return (
    <section className={`${CARD_CLASS_NAME} ${className}`.trim()} aria-labelledby="alert-history-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="alert-history-title"
          className="text-lg font-semibold text-gray-900 dark:text-neutral-50"
        >
          Alert history
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            className={BUTTON_CLASS_NAME}
            onClick={() =>
              downloadTextFile(
                'alert-history.json',
                'application/json',
                JSON.stringify(visibleRows, null, 2)
              )
            }
          >
            Export JSON
          </button>
          <button
            type="button"
            className={BUTTON_CLASS_NAME}
            onClick={() =>
              downloadTextFile(
                'alert-history.csv',
                'text/csv',
                toCsv(EXPORT_COLUMNS, exportRows)
              )
            }
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="history-customer-filter" className="text-sm text-gray-700 dark:text-neutral-300">
            Customer
          </label>
          <select
            id="history-customer-filter"
            className={CONTROL_CLASS_NAME}
            value={customerFilter}
            onChange={(event) => setCustomerFilter(event.target.value)}
          >
            <option value={ALL_FILTER_VALUE}>All customers</option>
            {customerIds.map((customerId) => (
              <option key={customerId} value={customerId}>
                {customerId}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="history-rule-filter" className="text-sm text-gray-700 dark:text-neutral-300">
            Rule
          </label>
          <select
            id="history-rule-filter"
            className={CONTROL_CLASS_NAME}
            value={ruleFilter}
            onChange={(event) => setRuleFilter(event.target.value)}
          >
            <option value={ALL_FILTER_VALUE}>All rules</option>
            {ruleIds.map((ruleId) => (
              <option key={ruleId} value={ruleId}>
                {ruleId}
              </option>
            ))}
          </select>
        </div>
      </div>

      {visibleRows.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-neutral-300">
          No dismissals, actions, or reactivations recorded yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
          <caption className="sr-only">Alert dismissals, actions, and reactivations</caption>
          <thead>
            <tr className="text-xs text-gray-600 dark:text-neutral-400">
              <th scope="col" className="py-1 pr-2 font-medium">
                When
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                Customer
              </th>
              <th scope="col" className="py-1 pr-2 font-medium">
                Rule
              </th>
              <th scope="col" className="py-1 font-medium">
                Event
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={`${row.at}-${row.key}-${row.event}`}
                className="border-t border-gray-200 dark:border-neutral-700"
              >
                <td className="py-1 pr-2 text-gray-700 dark:text-neutral-300">{row.at}</td>
                <td className="py-1 pr-2 text-gray-700 dark:text-neutral-300">{row.customerId}</td>
                <td className="py-1 pr-2 text-gray-700 dark:text-neutral-300">{row.ruleId}</td>
                <td className="py-1 text-gray-700 dark:text-neutral-300">{row.event}</td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-500 dark:text-neutral-400">
        Process-local log, capped and reset on server restart. Not a compliance audit trail.
      </p>
    </section>
  );
}
