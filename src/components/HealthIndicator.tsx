import {
  getRiskLevel,
  HEALTH_SCORE_MAXIMUM,
  normalizeHealthScore,
  type RiskLevel
} from '@/lib/healthCalculator';

/** How one risk band is presented: its visible wording and its colour surface. */
export interface BandPresentation {
  /** Always rendered, so colour is never the only signal of health. */
  label: string;
  /**
   * Tailwind classes for the chip surface, chosen to clear WCAG 2.1 AA contrast.
   *
   * Each carries the `!` important modifier. Appending these after a caller's
   * `className` is not enough on its own: Tailwind emits colour utilities in its
   * own order, so `bg-purple-500` from a caller would out-cascade `bg-green-700`
   * regardless of attribute order. Marking the band surface important is what
   * actually makes the contrast guarantee unbreakable from the call site.
   */
  surfaceClassName: string;
}

/**
 * The one place a `RiskLevel` becomes wording and colour.
 *
 * Banding itself is delegated to `@/lib/healthCalculator` and deliberately not
 * repeated here: this component owns *presentation*, the calculator owns the
 * thresholds. That split is why no numeric band boundary appears in this file —
 * two sources of truth for one band would drift the moment either moved.
 *
 * Typed as a total `Record<RiskLevel, …>`, so adding a band to `RiskLevel`
 * without giving it a presentation is a compile error rather than a blank chip.
 */
export const BAND_PRESENTATION: Record<RiskLevel, BandPresentation> = {
  critical: {
    label: 'Critical',
    surfaceClassName: 'bg-red-700! text-white! dark:bg-red-300! dark:text-red-950!'
  },
  warning: {
    label: 'Warning',
    surfaceClassName: 'bg-yellow-800! text-white! dark:bg-yellow-300! dark:text-yellow-950!'
  },
  healthy: {
    label: 'Healthy',
    surfaceClassName: 'bg-green-700! text-white! dark:bg-green-300! dark:text-green-950!'
  },
  unknown: {
    label: 'Unavailable',
    surfaceClassName: 'bg-slate-700! text-white! dark:bg-slate-300! dark:text-slate-950!'
  }
};

/** Announced when there is no usable score, so no band is ever named for one. */
const UNAVAILABLE_ACCESSIBLE_LABEL = 'Health score unavailable';

/** Layout and type scale per size. `sm` matches the in-card chip; `lg` is the widget hero. */
const SIZE_CLASS_NAMES: Record<'sm' | 'lg', string> = {
  sm: 'inline-flex flex-row items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
  lg: 'inline-flex flex-col items-center gap-0.5 rounded-lg px-4 py-3 font-semibold'
};

export interface HealthIndicatorProps {
  /**
   * The health score to display and band, on a 0-100 scale. Unvalidated —
   * `null`, `undefined`, and non-finite values render the unknown state.
   */
  score: number | null | undefined;
  /**
   * Overrides the band derived from `score`. Supply this when the band comes
   * from a calculator result (`HealthScoreResult.riskLevel`) rather than from
   * the raw number — notably the low-confidence case, where a score exists but
   * must not be classified.
   */
  riskLevel?: RiskLevel;
  /** Visual size. `sm` is the in-card chip; `lg` is the widget hero. Default `sm`. */
  size?: 'sm' | 'lg';
  /** Hides the numeric score, leaving colour + band label. Default `false`. */
  hideScore?: boolean;
  /**
   * Replaces the screen-reader sentence when the caller has more context than
   * the chip does — for example "Health score 45 out of 100 — warning, provisional".
   */
  accessibleLabel?: string;
  /** Extra classes appended to the root element, for spacing at the call site only. */
  className?: string;
}

/**
 * Shared chip rendering a health score as a colour band **plus** a visible text
 * label. It is the single presentation of a health band across the dashboard.
 *
 * The band comes from `getRiskLevel` unless the caller overrides it, and the
 * displayed number comes from `normalizeHealthScore` — the same helper the
 * calculator bands on — so the number and the colour can never disagree.
 *
 * Inert by design: no state, no interaction, no data fetching.
 */
export function HealthIndicator({
  score,
  riskLevel,
  size = 'sm',
  hideScore = false,
  accessibleLabel,
  className = ''
}: HealthIndicatorProps) {
  const resolvedRiskLevel = riskLevel ?? getRiskLevel(score);
  const presentation = BAND_PRESENTATION[resolvedRiskLevel];
  const normalizedScore = normalizeHealthScore(score);
  const showsScore = normalizedScore !== null && !hideScore;

  const generatedAccessibleLabel =
    normalizedScore === null
      ? UNAVAILABLE_ACCESSIBLE_LABEL
      : `Health score ${normalizedScore} out of ${HEALTH_SCORE_MAXIMUM} — ${presentation.label.toLowerCase()}`;

  // The band surface goes last, and its utilities are `!important`, so a
  // caller-supplied `className` can adjust spacing but cannot override the
  // colour and break the contrast guarantee. See `BandPresentation`.
  const rootClassName =
    `${SIZE_CLASS_NAMES[size]} ${className} ${presentation.surfaceClassName}`.replace(/\s+/g, ' ').trim();

  return (
    <span
      role="img"
      aria-label={accessibleLabel || generatedAccessibleLabel}
      className={rootClassName}
    >
      {showsScore && (
        <span aria-hidden="true" className={size === 'lg' ? 'text-3xl leading-none' : undefined}>
          {normalizedScore}
        </span>
      )}
      {showsScore && size === 'sm' && <span aria-hidden="true">·</span>}
      <span aria-hidden="true" className={size === 'lg' ? 'text-sm' : undefined}>
        {presentation.label}
      </span>
    </span>
  );
}
