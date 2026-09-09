'use client';

import type { FatigueMetrics } from '@/types/predictive-intelligence';

/** Card surface, matching `MarketIntelligenceWidget` so the panels sit flush. */
const CARD_CLASS_NAME =
  'flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-5 dark:border-neutral-700 dark:bg-neutral-900';

export interface AlertFatiguePanelProps {
  /** Metrics from `GET /api/predictive-intelligence/history`. */
  metrics: FatigueMetrics | null;
  /** Extra classes for the card root, so the dashboard grid can size the panel. */
  className?: string;
}

/**
 * Formats a rate as a whole percentage.
 *
 * @param rate - A ratio in 0..1.
 */
function toPercentage(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * Alert-fatigue monitoring.
 *
 * Answers "is this feature crying wolf?" from data the app already has: how often
 * notifications were held back, how often each rule gets dismissed, how long
 * alerts sit before someone acts, and how often a dismissed alert came back.
 *
 * Recommendations come from fixed templates against a stated rule and are
 * labelled as suggestions. **No threshold is ever changed automatically** —
 * self-tuning would let one impatient afternoon of dismissals silence a rule
 * permanently, and there is no ground truth here to tune against.
 */
export function AlertFatiguePanel({ metrics, className = '' }: AlertFatiguePanelProps) {
  if (metrics === null) {
    return (
      <section className={`${CARD_CLASS_NAME} ${className}`.trim()} aria-labelledby="fatigue-title">
        <h2 id="fatigue-title" className="text-lg font-semibold text-gray-900 dark:text-neutral-50">
          Alert fatigue
        </h2>
        <p className="text-sm text-gray-600 dark:text-neutral-300">
          Fatigue metrics are not available yet.
        </p>
      </section>
    );
  }

  return (
    <section className={`${CARD_CLASS_NAME} ${className}`.trim()} aria-labelledby="fatigue-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="fatigue-title" className="text-lg font-semibold text-gray-900 dark:text-neutral-50">
          Alert fatigue
        </h2>
        <span className="rounded border border-gray-300 px-1.5 py-0.5 text-xs font-medium text-gray-700 dark:border-neutral-600 dark:text-neutral-200">
          Sample data
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-gray-600 dark:text-neutral-400">
            Notifications held by cooldown
          </dt>
          <dd className="text-xl font-semibold text-gray-900 dark:text-neutral-50">
            {metrics.notificationsSuppressedByCooldown}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-gray-600 dark:text-neutral-400">Median hours to action</dt>
          <dd className="text-xl font-semibold text-gray-900 dark:text-neutral-50">
            {metrics.medianHoursToAction === null ? 'No actions yet' : metrics.medianHoursToAction}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-gray-600 dark:text-neutral-400">
            Returned after dismissal
          </dt>
          <dd className="text-xl font-semibold text-gray-900 dark:text-neutral-50">
            {metrics.reactivationsAfterDismissal}
          </dd>
        </div>
      </dl>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-neutral-100">
          Dismissal rate by rule
        </h3>
        {metrics.dismissalRateByRule.length === 0 ? (
          <p className="mt-1 text-sm text-gray-600 dark:text-neutral-300">
            No rules have triggered yet in this server process.
          </p>
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <caption className="sr-only">Dismissal rate for each alert rule</caption>
            <thead>
              <tr className="text-xs text-gray-600 dark:text-neutral-400">
                <th scope="col" className="py-1 pr-2 font-medium">
                  Rule
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Triggered
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Dismissed
                </th>
                <th scope="col" className="py-1 font-medium">
                  Rate
                </th>
              </tr>
            </thead>
            <tbody>
              {metrics.dismissalRateByRule.map((rule) => (
                <tr key={rule.ruleId} className="border-t border-gray-200 dark:border-neutral-700">
                  <th scope="row" className="py-1 pr-2 font-normal text-gray-900 dark:text-neutral-100">
                    {rule.ruleId}
                  </th>
                  <td className="py-1 pr-2 text-gray-700 dark:text-neutral-300">{rule.triggered}</td>
                  <td className="py-1 pr-2 text-gray-700 dark:text-neutral-300">{rule.dismissed}</td>
                  <td className="py-1 text-gray-700 dark:text-neutral-300">
                    {toPercentage(rule.rate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-neutral-100">Suggestions</h3>
        {metrics.recommendations.length === 0 ? (
          <p className="mt-1 text-sm text-gray-600 dark:text-neutral-300">
            No tuning suggestions. Nothing is changed automatically in any case.
          </p>
        ) : (
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-700 dark:text-neutral-300">
            {metrics.recommendations.map((recommendation) => (
              <li key={recommendation}>{recommendation}</li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-gray-500 dark:text-neutral-400">
        Counts cover the current server process only and reset when it restarts.
      </p>
    </section>
  );
}
