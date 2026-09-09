'use client';

import { useId, useState } from 'react';
import { HealthIndicator } from '@/components/HealthIndicator';
import { mockHealthInputs } from '@/data/mock-health-inputs';
import type { Customer } from '@/data/mock-customers';
import {
  calculateHealthScore,
  HEALTH_SCORE_MAXIMUM,
  HealthScoreValidationError,
  MIN_BANDING_CONFIDENCE,
  PROVISIONAL_TENURE_DAYS,
  type FactorScore,
  type HealthScoreInput,
  type HealthScoreResult
} from '@/lib/healthCalculator';

/** Display order and wording of the four factors, matching the breakdown keys. */
const FACTOR_ROWS: ReadonlyArray<{ key: keyof HealthScoreResult['breakdown']; label: string }> = [
  { key: 'payment', label: 'Payment' },
  { key: 'engagement', label: 'Engagement' },
  { key: 'contract', label: 'Contract' },
  { key: 'support', label: 'Support' }
];

/** Shown in place of a factor score when the factor had no signals at all. */
const NO_DATA_MARKER = 'No data';

/** Wording for each unbanded presentation, so the three are never confusable. */
const NO_DATA_HEADLINE = 'Health score unavailable';
const NO_DATA_DETAIL = 'No health signals have been recorded for this customer yet.';
const LOW_CONFIDENCE_HEADLINE = 'Insufficient data to classify';
const PROVISIONAL_TENURE_HEADLINE = 'Provisional — new customer';

export interface CustomerHealthDisplayProps {
  /**
   * A pre-computed result. Supply this when the caller already ran the
   * calculator; it takes precedence over `input` and `customerId`.
   */
  result?: HealthScoreResult;
  /** Raw signals to score. Invalid signals render the inline error state. */
  input?: HealthScoreInput;
  /** Resolves signals from `mockHealthInputs`; a customer with no entry is a no-data state. */
  customerId?: string;
  /** Convenience alternative to `customerId`; also supplies the default title. */
  customer?: Customer;
  /** Overrides the widget title. Defaults to the customer name, else "Customer health". */
  title?: string;
  /** Heading level for the title, so the widget fits any document outline. Default `3`. */
  headingLevel?: 2 | 3 | 4;
  /**
   * Renders a skeleton. For the **caller's** async fetching of the input only —
   * the calculation itself is synchronous and has no loading state.
   */
  isLoading?: boolean;
  /** Starts the breakdown expanded. Default `false`, per the collapsed-by-default rule. */
  defaultExpanded?: boolean;
  /** Extra classes appended to the root element, for spacing at the call site. */
  className?: string;
}

/** Renders one factor's percentage weight, e.g. `0.4` as `40%`. */
function formatWeightPercentage(weight: number): string {
  return `${Math.round(weight * 100)}%`;
}

/** Renders a factor score as an integer, or the no-data marker when excluded. */
function formatFactorScore(factor: FactorScore): string {
  return factor.score === null ? NO_DATA_MARKER : `${Math.round(factor.score)}`;
}

/**
 * Widget for one customer's health score: the headline number with its band, the
 * confidence behind it, and an expandable per-factor breakdown.
 *
 * It is presentational. All banding and arithmetic come from
 * `@/lib/healthCalculator`, and the band's colour comes from `HealthIndicator`,
 * so no threshold or colour is re-derived here.
 *
 * Three unbanded states are rendered distinctly and none of them shows a band
 * colour or substitutes `0` for a missing score:
 * - **No data** — `score === null`: neutral chip, "Health score unavailable".
 * - **Low confidence** — score present but `riskLevel === 'unknown'`: the number
 *   is shown against a neutral chip with "Insufficient data to classify".
 * - **Too new** — provisional by tenure: score *and* band shown, with a
 *   new-customer notice, because the score itself is trustworthy.
 *
 * A client component solely because the breakdown disclosure holds state.
 */
export function CustomerHealthDisplay({
  result,
  input,
  customerId,
  customer,
  title,
  headingLevel = 3,
  isLoading = false,
  defaultExpanded = false,
  className = ''
}: CustomerHealthDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const breakdownElementId = useId();

  const HeadingTag = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const widgetTitle = title ?? (customer ? `${customer.name} — health` : 'Customer health');
  const resolvedCustomerId = customerId ?? customer?.id;

  const cardClassName =
    `rounded-lg border border-slate-200 bg-white p-4 text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 ${className}`.trim();

  if (isLoading) {
    return (
      <section aria-busy="true" aria-label={`${widgetTitle} loading`} className={cardClassName}>
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-32 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="h-16 w-24 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="h-3 w-40 rounded bg-slate-200 dark:bg-slate-700" />
        </div>
      </section>
    );
  }

  // Resolution order: an explicit result, then explicit signals, then a lookup.
  const resolvedInput =
    input ?? (resolvedCustomerId === undefined ? undefined : mockHealthInputs[resolvedCustomerId]);

  let healthScoreResult: HealthScoreResult | null = result ?? null;
  let errorMessage: string | null = null;

  if (healthScoreResult === null && resolvedInput !== undefined) {
    try {
      healthScoreResult = calculateHealthScore(resolvedInput);
    } catch (caughtError) {
      // A bad input must never take the dashboard down with it.
      errorMessage =
        caughtError instanceof HealthScoreValidationError
          ? caughtError.message
          : 'Unable to calculate this health score.';
    }
  }

  if (errorMessage !== null) {
    return (
      <section aria-labelledby={`${breakdownElementId}-title`} className={cardClassName}>
        <HeadingTag id={`${breakdownElementId}-title`} className="text-sm font-semibold break-words">
          {widgetTitle}
        </HeadingTag>
        <p
          role="alert"
          className="mt-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
        >
          {errorMessage}
        </p>
      </section>
    );
  }

  const score = healthScoreResult?.score ?? null;
  const riskLevel = healthScoreResult?.riskLevel ?? 'unknown';
  const confidence = healthScoreResult?.confidence ?? 0;

  const hasNoData = score === null;
  const isLowConfidence = score !== null && riskLevel === 'unknown';
  const isProvisionalByTenure =
    healthScoreResult !== null && healthScoreResult.provisional && !isLowConfidence && !hasNoData;

  const accessibleLabel = hasNoData
    ? `${NO_DATA_HEADLINE} — no health signals recorded`
    : isLowConfidence
      ? `Health score ${score} out of ${HEALTH_SCORE_MAXIMUM} — ${LOW_CONFIDENCE_HEADLINE.toLowerCase()}`
      : `Health score ${score} out of ${HEALTH_SCORE_MAXIMUM} — ${riskLevel}${
          isProvisionalByTenure ? ', provisional' : ''
        }`;

  return (
    <section aria-labelledby={`${breakdownElementId}-title`} className={cardClassName}>
      <HeadingTag id={`${breakdownElementId}-title`} className="text-sm font-semibold break-words">
        {widgetTitle}
      </HeadingTag>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <HealthIndicator
          score={score}
          riskLevel={riskLevel}
          size="lg"
          accessibleLabel={accessibleLabel}
        />
        <div className="text-sm">
          <p>
            Confidence:{' '}
            <span className="font-semibold">{Math.round(confidence * 100)}%</span> of the scoring
            weight is backed by data
          </p>
          {healthScoreResult?.trend !== undefined && (
            <p className="text-slate-600 dark:text-slate-300">
              Trend since the previous score: {healthScoreResult.trend}
            </p>
          )}
        </div>
      </div>

      {hasNoData && (
        <p className="mt-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100">
          <span className="font-semibold">{NO_DATA_HEADLINE}.</span> {NO_DATA_DETAIL}
        </p>
      )}

      {isLowConfidence && (
        <p className="mt-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100">
          <span className="font-semibold">{LOW_CONFIDENCE_HEADLINE}.</span> The score is shown, but
          fewer than {Math.round(MIN_BANDING_CONFIDENCE * 100)}% of the scoring weight is backed by
          data, so no risk band is claimed.
        </p>
      )}

      {isProvisionalByTenure && (
        <p className="mt-3 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50">
          <span className="font-semibold">{PROVISIONAL_TENURE_HEADLINE}.</span> Under{' '}
          {PROVISIONAL_TENURE_DAYS} days of history, so treat this score as provisional. It is not
          adjusted for tenure.
        </p>
      )}

      {healthScoreResult !== null && (
        <>
          <button
            type="button"
            aria-expanded={isExpanded}
            aria-controls={breakdownElementId}
            onClick={() => setIsExpanded((wasExpanded) => !wasExpanded)}
            className="mt-4 min-h-11 rounded border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 dark:border-slate-600 dark:hover:bg-slate-800"
          >
            {isExpanded ? 'Hide score breakdown' : 'Show score breakdown'}
          </button>

          <div id={breakdownElementId} hidden={!isExpanded} className="mt-3">
            <table className="w-full text-left text-sm">
              <caption className="caption-bottom pt-2 text-xs text-slate-600 dark:text-slate-300">
                Factor scores are rounded for display and the total is computed from the unrounded
                values, so the parts may not re-multiply to the total exactly. Effective weight is
                the factor&apos;s share after factors without data are excluded.
              </caption>
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-1 pr-2 font-semibold">
                    Factor
                  </th>
                  <th scope="col" className="py-1 pr-2 font-semibold">
                    Score
                  </th>
                  <th scope="col" className="py-1 pr-2 font-semibold">
                    Weight
                  </th>
                  <th scope="col" className="py-1 font-semibold">
                    Effective weight
                  </th>
                </tr>
              </thead>
              <tbody>
                {FACTOR_ROWS.map(({ key, label }) => {
                  const factor = healthScoreResult.breakdown[key];
                  return (
                    <tr key={key} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      <th scope="row" className="py-1 pr-2 font-normal">
                        {label}
                      </th>
                      <td className="py-1 pr-2">{formatFactorScore(factor)}</td>
                      <td className="py-1 pr-2">{formatWeightPercentage(factor.weight)}</td>
                      <td className="py-1">{formatWeightPercentage(factor.effectiveWeight)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
