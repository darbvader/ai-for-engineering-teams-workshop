import type { Customer } from '@/data/mock-customers';

/** Lowest health score the card will display; anything below is clamped up to it. */
const HEALTH_SCORE_MINIMUM = 0;

/** Highest health score the card will display; anything above is clamped down to it. */
const HEALTH_SCORE_MAXIMUM = 100;

/** Inclusive upper bound of the poor (red) band. */
const POOR_BAND_UPPER_BOUND = 30;

/** Inclusive upper bound of the moderate (yellow) band. */
const MODERATE_BAND_UPPER_BOUND = 70;

interface HealthIndicatorState {
  /** The canonical score used for both the displayed number and the band, or null when unknown. */
  score: number | null;
  /** Short label rendered next to the color, so color is never the only signal. */
  bandLabel: string;
  /** Full sentence rendered screen-reader-only, replacing the abbreviated visible label. */
  accessibleLabel: string;
  /** Tailwind classes for the indicator surface, chosen to clear WCAG 2.1 AA contrast. */
  indicatorClassName: string;
}

/**
 * Normalizes a raw `healthScore` into a single canonical value and derives its
 * color band from that same value, so the displayed number and the band can
 * never disagree.
 *
 * Normalization, in order:
 * 1. A non-finite score (`NaN`, `Infinity`, `-Infinity`) is treated as unknown —
 *    it renders a neutral indicator and is deliberately assigned no band.
 * 2. Otherwise the score is clamped into `[HEALTH_SCORE_MINIMUM, HEALTH_SCORE_MAXIMUM]`.
 * 3. The clamped value is rounded to the nearest integer.
 *
 * Bands are open-ended comparisons on the canonical value, so fractional inputs
 * cannot fall into a gap:
 * - `0 <= score <= POOR_BAND_UPPER_BOUND` → poor (red)
 * - `POOR_BAND_UPPER_BOUND < score <= MODERATE_BAND_UPPER_BOUND` → moderate (yellow)
 * - `MODERATE_BAND_UPPER_BOUND < score <= 100` → good (green)
 *
 * @param rawHealthScore The `healthScore` from the customer record, unvalidated.
 * @returns The canonical score plus everything needed to render the indicator.
 */
function resolveHealthIndicator(rawHealthScore: number): HealthIndicatorState {
  if (!Number.isFinite(rawHealthScore)) {
    return {
      score: null,
      bandLabel: 'Unavailable',
      accessibleLabel: 'Health score unavailable',
      indicatorClassName: 'bg-slate-700 text-white dark:bg-slate-300 dark:text-slate-950'
    };
  }

  const clampedScore = Math.min(
    Math.max(rawHealthScore, HEALTH_SCORE_MINIMUM),
    HEALTH_SCORE_MAXIMUM
  );
  const score = Math.round(clampedScore);

  if (score <= POOR_BAND_UPPER_BOUND) {
    return {
      score,
      bandLabel: 'Poor',
      accessibleLabel: `Health score ${score} out of ${HEALTH_SCORE_MAXIMUM} — poor`,
      indicatorClassName: 'bg-red-700 text-white dark:bg-red-300 dark:text-red-950'
    };
  }

  if (score <= MODERATE_BAND_UPPER_BOUND) {
    return {
      score,
      bandLabel: 'Moderate',
      accessibleLabel: `Health score ${score} out of ${HEALTH_SCORE_MAXIMUM} — moderate`,
      indicatorClassName: 'bg-yellow-800 text-white dark:bg-yellow-300 dark:text-yellow-950'
    };
  }

  return {
    score,
    bandLabel: 'Good',
    accessibleLabel: `Health score ${score} out of ${HEALTH_SCORE_MAXIMUM} — good`,
    indicatorClassName: 'bg-green-700 text-white dark:bg-green-300 dark:text-green-950'
  };
}

export interface CustomerCardProps {
  /** The customer to display. The card renders only name, company, health score, and domains. */
  customer: Customer;
  /**
   * Heading level for the customer name. The card cannot know its surrounding
   * document structure, so the container chooses the level that keeps the page
   * hierarchy correct.
   */
  headingLevel?: 2 | 3 | 4;
}

/**
 * Presentational card showing a single customer's name, company, health score,
 * and domains. Holds no state and fetches no data.
 */
export function CustomerCard({ customer, headingLevel = 3 }: CustomerCardProps) {
  const { name, company, healthScore, domains } = customer;
  const healthIndicator = resolveHealthIndicator(healthScore);
  const HeadingTag = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const hasDomains = Array.isArray(domains) && domains.length > 0;

  return (
    <article className="flex min-h-[120px] max-w-[400px] flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
      <header className="flex flex-col gap-1">
        <HeadingTag className="text-lg font-semibold break-words text-neutral-900 dark:text-neutral-50">
          {name}
        </HeadingTag>
        <p className="text-sm font-medium break-words text-neutral-700 dark:text-neutral-300">
          {company}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-neutral-600 uppercase dark:text-neutral-400">
          Health
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${healthIndicator.indicatorClassName}`}
        >
          <span aria-hidden="true">
            {healthIndicator.score !== null && `${healthIndicator.score} · `}
            {healthIndicator.bandLabel}
          </span>
          <span className="sr-only">{healthIndicator.accessibleLabel}</span>
        </span>
      </div>

      {hasDomains && (
        <section className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-wide text-neutral-600 uppercase dark:text-neutral-400">
            Domains
            {domains.length > 1 && (
              <span className="ml-1 font-normal normal-case">
                ({domains.length} domains)
              </span>
            )}
          </p>
          <ul
            aria-label="Customer domains"
            className="flex flex-col gap-0.5 text-xs text-neutral-700 dark:text-neutral-300"
          >
            {domains.map((domain, domainIndex) => (
              <li key={`${domainIndex}-${domain}`} className="break-all">
                {domain}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
