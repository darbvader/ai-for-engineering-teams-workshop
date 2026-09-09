/**
 * Fixtures for the HealthIndicator component.
 *
 * `mockCustomers` cannot verify this component: its health scores (15, 35, 45,
 * 60, 73, 85, 88, 92) touch no band boundary, none is fractional, and none is
 * non-finite. These fixtures cover every boundary, the rounding cases, the
 * absent and non-finite scores, the band override, and each visual variant.
 *
 * Not production data — intended for scratch pages and manual verification.
 */

import type { HealthIndicatorProps } from '@/components/HealthIndicator';

/** One fixture: a human-readable name plus the exact props to render. */
export interface HealthIndicatorFixture {
  /** What this case is checking, shown beside the chip on a scratch page. */
  label: string;
  /** Typed as the component's own props so fixtures cannot drift from the API. */
  props: HealthIndicatorProps;
}

/** Scores sitting exactly on, or just past, each band boundary. */
export const bandBoundaryFixtures: HealthIndicatorFixture[] = [
  { label: 'score -1 — below range, clamps to 0, critical', props: { score: -1 } },
  { label: 'score 0 — critical floor', props: { score: 0 } },
  { label: 'score 30 — critical upper bound', props: { score: 30 } },
  { label: 'score 31 — warning lower bound', props: { score: 31 } },
  { label: 'score 70 — warning upper bound', props: { score: 70 } },
  { label: 'score 71 — healthy lower bound', props: { score: 71 } },
  { label: 'score 100 — healthy ceiling', props: { score: 100 } },
  { label: 'score 101 — above range, clamps to 100, healthy', props: { score: 101 } }
];

/** Fractional scores, pinning round-then-band rather than band-then-round. */
export const fractionalScoreFixtures: HealthIndicatorFixture[] = [
  { label: 'score 30.4 — rounds to 30, critical', props: { score: 30.4 } },
  { label: 'score 30.5 — rounds to 31, warning', props: { score: 30.5 } },
  { label: 'score 70.4 — rounds to 70, warning', props: { score: 70.4 } },
  { label: 'score 70.5 — rounds to 71, healthy', props: { score: 70.5 } }
];

/** Scores that yield no band at all, plus the negative-zero display case. */
export const unusableScoreFixtures: HealthIndicatorFixture[] = [
  { label: 'score NaN — unknown, no number', props: { score: Number.NaN } },
  { label: 'score Infinity — unknown, no number', props: { score: Number.POSITIVE_INFINITY } },
  { label: 'score -Infinity — unknown, no number', props: { score: Number.NEGATIVE_INFINITY } },
  { label: 'score null — unknown, no number', props: { score: null } },
  { label: 'score undefined — unknown, no number', props: { score: undefined } },
  { label: 'score -0 — displays 0, not -0', props: { score: -0 } }
];

/** Callers supplying a band explicitly, including one that contradicts the score. */
export const riskLevelOverrideFixtures: HealthIndicatorFixture[] = [
  {
    label: 'score 45 with riskLevel unknown — number shown, band withheld',
    props: { score: 45, riskLevel: 'unknown' }
  },
  {
    label: 'score 95 with riskLevel critical — override wins, 95 in red',
    props: { score: 95, riskLevel: 'critical' }
  }
];

/** Each visual variant, including a className that tries to fight the band colour. */
export const presentationVariantFixtures: HealthIndicatorFixture[] = [
  { label: 'size sm — default in-card chip', props: { score: 85, size: 'sm' } },
  { label: 'size lg — widget hero', props: { score: 85, size: 'lg' } },
  { label: 'size lg — unknown state at hero size', props: { score: null, size: 'lg' } },
  { label: 'hideScore — label only, colour still banded', props: { score: 15, hideScore: true } },
  {
    label: 'custom accessibleLabel — provisional wording from the caller',
    props: {
      score: 45,
      accessibleLabel: 'Health score 45 out of 100 — warning, provisional (new customer)'
    }
  },
  {
    label: 'empty accessibleLabel — falls back to the generated sentence',
    props: { score: 60, accessibleLabel: '' }
  },
  {
    label: 'className with a competing colour — band colour must still win',
    props: { score: 85, className: 'bg-purple-500 ml-2' }
  }
];

/** Every fixture, in the order a scratch page should render them. */
export const healthIndicatorFixtures: HealthIndicatorFixture[] = [
  ...bandBoundaryFixtures,
  ...fractionalScoreFixtures,
  ...unusableScoreFixtures,
  ...riskLevelOverrideFixtures,
  ...presentationVariantFixtures
];
