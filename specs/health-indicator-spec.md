# Feature: HealthIndicator Component

## Context

`HealthIndicator` is the single shared presentational chip that renders a health/risk band as
colour **plus** a visible text label. It is being extracted because four separate specs each
require "the same colour coding" and one of them already warns that duplicating it will drift:

> "Band colors are shared with `CustomerCard` through the exported threshold constants, not
> duplicated. If `CustomerCard` hardcodes its own thresholds when this is implemented, refactor it
> to import them — two sources of truth for one band will drift."
> — `specs/customer-health-monitoring-spec.md:464`

That drift already exists in the repository today. `src/components/CustomerCard.tsx:46` contains a
private `resolveHealthIndicator` function with its own `POOR_BAND_UPPER_BOUND` / `MODERATE_BAND_UPPER_BOUND`
constants and its own `Poor` / `Moderate` / `Good` vocabulary, while
`specs/health-score-calculator-spec.md:62-64` specifies `CRITICAL_MAX` / `WARNING_MAX` and
`Critical` / `Warning` / `Healthy` for the same 30/70 boundaries. This component is where that
duplication is resolved.

### Where it sits

| Path | Status | Relationship |
|---|---|---|
| `src/components/HealthIndicator.tsx` | **New — this spec** | The component |
| `src/data/health-indicator-fixtures.ts` | **New — this spec** | Fixtures |
| `src/lib/healthCalculator.ts` | Specified, **not yet written** (`src/lib/` does not exist) | Owns `RiskLevel`, `getRiskLevel`, `CRITICAL_MAX`, `WARNING_MAX` |
| `src/components/CustomerCard.tsx` | **Exists** | Consumer — its inline `resolveHealthIndicator` is deleted and replaced by this component |
| `src/components/CustomerHealthDisplay.tsx` | Specified, not yet written | Consumer |
| `src/data/mock-customers.ts` | **Exists** | Source of the `Customer` type used by fixtures |

### Dependency order

`src/lib/healthCalculator.ts` (banding) → **`HealthIndicator`** (presentation) →
`CustomerCard` refactor / `CustomerHealthDisplay`.

This component **must not** re-implement banding. It imports `getRiskLevel` and `RiskLevel` from
`@/lib/healthCalculator`, whose contract is binding here:

- `getRiskLevel(score: number | null | undefined): RiskLevel` is **total** — `null`, `undefined`,
  `NaN`, `±Infinity` → `'unknown'`; otherwise clamp to `[0, 100]`, `Math.round` half-up, then band
  with open-ended comparisons `score <= CRITICAL_MAX (30)` → `'critical'`,
  `score <= WARNING_MAX (70)` → `'warning'`, else `'healthy'`.
- `RiskLevel = 'healthy' | 'warning' | 'critical' | 'unknown'`.

The thresholds `30` and `70` are therefore **not declared in this file at all**. They are declared
once, in `healthCalculator.ts`, and this component never compares a score to a number.

### Requirement Traceability

| Requirement (source) | Covered in |
|---|---|
| Colour-coded health indicator, red 0-30 / yellow 31-70 / green 71-100 (`customer-card.md:12-15`) | Requirements → Banding, Visual Presentation |
| Preserve existing health-score colours through the selection enhancement (`customer-card-enhancement.md:11`) | Constraints → Consumer Migration |
| Overall health score display with colour-coded visualization (`health-score-calculator.md:32`) | Requirements → Props, Visual Presentation |
| Risk classification Healthy (71-100) / Warning (31-70) / Critical (0-30) (`health-score-calculator.md:16`) | Requirements → Banding, Band Vocabulary |
| "Colour coding consistency with other dashboard health indicators" (`health-score-calculator.md:83`) | Context, Constraints → Single Source of Truth |
| Edge-case handling for new customers and missing data (`health-score-calculator.md:57`) | Requirements → Unknown and Provisional States |
| TypeScript interfaces for all props; JSDoc; named exports; no abbreviations (`code-quality.md:9-19`) | Constraints → Code Quality |
| WCAG 2.1 AA contrast 4.5:1 / 3:1; ARIA labels; alt text for icons; screen-reader-friendly structure (`accessibility.md:11-17`) | Requirements → Accessibility |
| Colour must never be the only signal (`customer-card-spec.md`, `health-score-calculator-spec.md:241`) | Requirements → Visual Presentation |
| Three visually distinct unbanded presentations (`health-score-calculator-spec.md:247-253`) | Requirements → Unknown and Provisional States |

### Out of Scope

| Dropped requirement | Reason |
|---|---|
| Health **score calculation**, weighting, factor breakdown (`health-score-calculator.md:12-14`) | Owned by `src/lib/healthCalculator.ts`. This component receives a result and renders it. |
| Expandable factor breakdown, `confidence` display, provisional notice text (`health-score-calculator.md:33`) | Owned by `CustomerHealthDisplay`. This chip renders one band, not a panel. |
| Loading skeleton and error state (`health-score-calculator.md:34`) | Owned by the consuming widget, which knows what is loading. See Constraints → Out of Scope. |
| Market sentiment banding on the `-1…1` scale (`market-intelligence.md:29`, `specs/market-intelligence-spec.md:60`) | Different scale and different thresholds. Sentiment shares the *red/yellow/green language*, not this component's 0-100 banding. Reusing this chip there would require a second banding function inside it. |
| Alert priority colour coding (`predictive-alerts.md:41`) | Same reason — priority is a categorical enum, not a 0-100 score. Revisit only if a `riskLevel`-shaped adapter is wanted. |
| Trend arrows / deltas (`health-score-calculator-spec.md:200`) | The trend contract lives on `HealthScoreResult`; rendering it is the widget's job. |

## Requirements

### Props

Exported from `src/components/HealthIndicator.tsx`:

```ts
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
```

**Decision:** `riskLevel` is an optional *override* rather than the only input, because
`specs/health-score-calculator-spec.md:251` requires a state where the score is shown but the band
is deliberately withheld (`riskLevel: 'unknown'`, `score !== null`). A score-only prop could not
express that, and a riskLevel-only prop would force every caller to band separately.

**Decision:** `className` is accepted for layout spacing only, not for colour. Colour classes are
appended *after* `className` in the class string so a caller cannot accidentally override the band
colour and break the contrast guarantee.

### Banding

1. If `riskLevel` is supplied, use it verbatim. Do not re-derive.
2. Otherwise `resolvedRiskLevel = getRiskLevel(score)`.
3. The **displayed number** is the same canonical value the band was derived from: `null` when
   `score` is `null`, `undefined`, or non-finite; otherwise `Math.round(Math.min(Math.max(score, 0), 100))`.

**Decision:** step 3 duplicates the calculator's clamp-and-round arithmetic for *display*. To keep
one source of truth, `healthCalculator.ts` must also export
`normalizeHealthScore(score: number | null | undefined): number | null` performing exactly steps 1-2
of `getRiskLevel`, and `HealthIndicator` calls it. This is a small addition to that module's
surface; without it the displayed number and the band are computed by two different code paths,
which is precisely the defect both sibling specs warn about. **If the calculator ships without
`normalizeHealthScore`, this component must call `getRiskLevel` for the band and derive the number
from the same helper — never with an inline `Math.round` in the component.**

Because banding is delegated, this file contains **no numeric threshold literals**. Grepping
`HealthIndicator.tsx` for `30` or `70` must find nothing.

### Band Vocabulary

One canonical mapping, declared once in this component as `BAND_PRESENTATION`:

| `RiskLevel` | Visible label | Colour | Meaning |
|---|---|---|---|
| `'critical'` | `Critical` | Red | Score 0-30 |
| `'warning'` | `Warning` | Yellow | Score 31-70 |
| `'healthy'` | `Healthy` | Green | Score 71-100 |
| `'unknown'` | `Unavailable` | Neutral (slate) | No score, non-finite score, or a score the calculator declined to classify |

**Decision:** the canonical vocabulary is `Critical` / `Warning` / `Healthy`, not the
`Poor` / `Moderate` / `Good` currently shipped in `CustomerCard.tsx:65-84`. Two specs
(`health-score-calculator-spec.md:242`, `customer-health-monitoring-spec.md:440`) and the source
artifact (`health-score-calculator.md:16`) all use Critical/Warning/Healthy; only the shipped card
uses Poor/Moderate/Good, and it is the one place with no artifact backing for its wording. This
changes user-visible text in `CustomerCard` — see Open Questions.

The `'unknown'` row is **never** rendered in a band colour and **never** displays `0` in place of a
missing score (`health-score-calculator-spec.md:253`).

### Visual Presentation

- Root element is a `<span>` with `role="img"` and an accessible name — see Accessibility. It is
  inert: no click handling, no focus, no state, no `'use client'`.
- Renders, left to right: the numeric score (unless `null` or `hideScore`), a `·` separator, and the
  band label. The separator is only rendered when a number precedes it.
- **Colour is never the only signal.** The band label is always visible, in every size and in every
  state. `hideScore` may hide the number; nothing may hide the label.
- `size: 'sm'` — pill chip, `text-xs`, matching the existing chip at `CustomerCard.tsx:125`.
  `size: 'lg'` — the hero treatment for `CustomerHealthDisplay`, score at `text-3xl` with the label
  beneath at `text-sm`. **Decision:** two sizes rather than a free-form `size` scale, because only
  two call sites are specified and an open scale invites per-caller drift.
- Colours are Tailwind utility classes chosen to clear WCAG AA against their own foreground, in both
  light and dark mode. The values already verified in `CustomerCard.tsx:52-85` are carried over
  unchanged: `bg-red-700 text-white dark:bg-red-300 dark:text-red-950`,
  `bg-yellow-800 text-white dark:bg-yellow-300 dark:text-yellow-950`,
  `bg-green-700 text-white dark:bg-green-300 dark:text-green-950`,
  `bg-slate-700 text-white dark:bg-slate-300 dark:text-slate-950`.
- The yellow band must not be a light yellow on white; `yellow-800` is the floor, not a suggestion.

### Unknown and Provisional States

Three presentations the consuming widget must be able to produce through this component
(`health-score-calculator-spec.md:247-253`):

| Caller intent | Props | Rendered |
|---|---|---|
| No data at all | `score={null}` | Neutral chip, no number, label `Unavailable` |
| Score exists, band withheld | `score={45} riskLevel="unknown"` | Neutral chip, number `45` shown, label `Unavailable` |
| Provisional but banded | `score={45} accessibleLabel="Health score 45 out of 100 — warning, provisional"` | Yellow chip, number `45`, label `Warning`; the *provisional notice itself is rendered by the widget*, not here |

The second row is the reason `riskLevel` must override rather than merely default.

### Edge Cases

| Input | Behaviour |
|---|---|
| `score = NaN`, `Infinity`, `-Infinity` | Unknown state. No band colour, no number. Must not crash. |
| `score = null` / `undefined` | Unknown state. |
| `score = -1` / `101` | Clamped to `0` / `100`; bands `critical` / `healthy`; the *displayed* number is the clamped one, so number and colour agree. |
| `score = 30.5` | Rounds to `31` → `warning`; displays `31`. Number and band derive from the same canonical value. |
| `score = 70.5` | Rounds to `71` → `healthy`; displays `71`. |
| `score = -0` | Displays `0`, not `-0`. **Decision:** `Math.round(-0)` is `-0` and `` `${-0}` `` renders `"0"` in JS, so this is satisfied by the template literal already — no special-casing needed, but the fixture pins it. |
| `riskLevel` supplied with a contradicting `score` (e.g. `score={95} riskLevel="critical"`) | The override wins; the chip shows `95` in red. This is intentional (low-confidence case) and is the caller's responsibility. |
| `className` containing a colour utility | Band colour still wins — band classes are appended last. |
| `accessibleLabel=""` | Empty string is falsy and falls back to the generated sentence, so the chip is never nameless. |

### Fixtures

`src/data/health-indicator-fixtures.ts` is a deliverable of this spec. `mockCustomers` is
insufficient — its scores (15, 35, 45, 60, 73, 85, 88, 92) touch no band boundary and none is
non-finite. Export `healthIndicatorFixtures`, an array of
`{ label: string; props: HealthIndicatorProps }` covering:

- **Boundaries:** `-1`, `0`, `30`, `31`, `70`, `71`, `100`, `101`
- **Fractional:** `30.4`, `30.5`, `70.4`, `70.5`
- **Non-finite / absent:** `NaN`, `Infinity`, `-Infinity`, `null`, `undefined`, `-0`
- **Override:** `{ score: 45, riskLevel: 'unknown' }` and the contradicting `{ score: 95, riskLevel: 'critical' }`
- **Variants:** each `size`, `hideScore: true`, a custom `accessibleLabel`, a `className` carrying a
  competing colour utility

Fixtures import `HealthIndicatorProps` from the component so they cannot drift from it.

### Accessibility

- Root carries `role="img"` with `aria-label` set to `accessibleLabel` when supplied, else the
  generated sentence: `Health score {n} out of 100 — {band label, lowercased}` when a number
  exists, or `Health score unavailable` when it does not.
  **Decision:** `role="img"` with a single `aria-label` replaces the current
  `aria-hidden` + `sr-only` pairing at `CustomerCard.tsx:127-131`. Both are valid, but the
  sr-only approach announces the chip as two nodes when nested inside a link or button, which the
  card is about to become under `customer-card-enhancement.md`.
- Visible text inside the root is `aria-hidden="true"`, so the label is announced once, not twice.
- The chip is not focusable and contains no interactive element. It conveys no information a
  keyboard user could otherwise reach only by hovering.
- Contrast: 4.5:1 for the chip text at `sm`; the `lg` score digits qualify as large text at 3:1 but
  must still clear 4.5:1 — **Decision:** hold both sizes to 4.5:1 rather than tracking two
  thresholds for one component.
- No icons, so no alternative text is required. If an icon is added later it must be
  `aria-hidden`, since the label already carries the meaning.

## Constraints

### Technical Stack
- Next.js 15.5 (App Router), React 19.1, TypeScript 5 `strict`, Tailwind CSS v4
- No additional runtime dependencies
- Server Component — no `'use client'`, no hooks, no state

### File Structure and Naming

| Path | Contents |
|---|---|
| `src/components/HealthIndicator.tsx` | `HealthIndicator`, `HealthIndicatorProps`, `BAND_PRESENTATION` |
| `src/data/health-indicator-fixtures.ts` | `healthIndicatorFixtures` |

Component `PascalCase`, variables and functions `camelCase`, imports via the `@/*` alias.

### Single Source of Truth
- Thresholds `30` / `70` appear **only** in `src/lib/healthCalculator.ts`. `HealthIndicator.tsx`
  contains no numeric band literal.
- The `RiskLevel` → label/colour mapping appears **only** in `BAND_PRESENTATION`, as one object
  literal keyed by `RiskLevel`, so adding a band is a compile error everywhere it matters.
- **Binding:** if two components render a health band in different colours for the same score, the
  spec is not satisfied, regardless of how the code is organised.

### Consumer Migration

Landing this component **includes** deleting `resolveHealthIndicator`, `HealthIndicatorState`,
`POOR_BAND_UPPER_BOUND`, `MODERATE_BAND_UPPER_BOUND`, `HEALTH_SCORE_MINIMUM`, and
`HEALTH_SCORE_MAXIMUM` from `src/components/CustomerCard.tsx` and rendering
`<HealthIndicator score={healthScore} />` at `CustomerCard.tsx:124-133` instead. Leaving both in
place is the exact drift this component exists to prevent. `CustomerCard`'s other behaviour —
name, company, domains, `headingLevel` — is unchanged.

### Code Quality
- Named exports only; no default export
- Exported props interface; no `any`
- JSDoc on the component and on `BAND_PRESENTATION`, stating that banding is delegated and why
- Descriptive identifiers; no abbreviations

### Security
- All rendered values are numbers and component-owned literals. Caller-supplied `accessibleLabel`
  and `className` are strings rendered as an attribute value and a class list respectively — never
  via `dangerouslySetInnerHTML`.
- No logging.

### Performance
- **Sensible default:** the component is a pure function of its props with no memoization. At the
  scale specified elsewhere in this repo (hundreds of cards) memoization is not warranted; revisit
  only with a measurement.
- **Binding:** no work in render beyond one banding call and string concatenation.

### Out of Scope
- Score calculation, factor breakdown, confidence, trend — `src/lib/healthCalculator.ts`
- Loading skeletons and error states — the consuming widget owns them, because it owns the async
- Market sentiment and alert priority indicators — different scales, see Context → Out of Scope
- Click handling, selection, and hover states — the chip is inert
- Theming or a configurable palette

## Acceptance Criteria

The repository has **no test runner, no testing-library, and no accessibility tooling** —
`package.json` defines only `dev`, `build`, `start`, `lint` (`eslint`), and `type-check`
(`tsc --noEmit`). Criteria are split accordingly.

### Automated
Closable by `npm run type-check`, `npm run lint`, or by reading back the written source.

- [ ] `npm run type-check` passes with no errors
- [ ] `npm run lint` passes with no errors or warnings
- [ ] `HealthIndicator` and `HealthIndicatorProps` are named exports; there is no default export
- [ ] No `any` appears in `src/components/HealthIndicator.tsx` or the fixtures file
- [ ] Grepping `src/components/HealthIndicator.tsx` for the literals `30` and `70` returns nothing
- [ ] `BAND_PRESENTATION` is a single object literal keyed by every `RiskLevel` member; removing a
      key fails `type-check`
- [ ] The component imports `getRiskLevel` (and `normalizeHealthScore`, if it exists) from
      `@/lib/healthCalculator` and defines no banding logic of its own
- [ ] JSDoc is present on the component and on `BAND_PRESENTATION`
- [ ] No `dangerouslySetInnerHTML`, no `console` call
- [ ] No `'use client'`, no React hook, no state in the file
- [ ] `src/components/CustomerCard.tsx` no longer contains `resolveHealthIndicator`,
      `POOR_BAND_UPPER_BOUND`, or `MODERATE_BAND_UPPER_BOUND`, and renders `<HealthIndicator>`
- [ ] `src/data/health-indicator-fixtures.ts` exports every case listed under *Fixtures* and types
      each entry's `props` as `HealthIndicatorProps`

### Manual
Verified by rendering `healthIndicatorFixtures` on a scratch page.

- [ ] At 1280px, fixtures `0` and `30` render red; `31` and `70` render yellow; `71` and `100`
      render green
- [ ] Fixtures `-1` and `101` display `0` and `100` and band red and green respectively
- [ ] Fixtures `30.4` / `30.5` display `30` / `31` and band red / yellow; `70.4` / `70.5` display
      `70` / `71` and band yellow / green
- [ ] Fixtures `NaN`, `Infinity`, `-Infinity`, `null`, `undefined` each render the neutral chip
      with label `Unavailable`, no number, and no red/yellow/green, with no console error
- [ ] The `-0` fixture displays `0`, not `-0`
- [ ] The `{ score: 45, riskLevel: 'unknown' }` fixture shows `45` in the neutral chip
- [ ] The `{ score: 95, riskLevel: 'critical' }` fixture shows `95` in red
- [ ] The band label is visible in every fixture, including `hideScore: true` and `size: 'lg'`
- [ ] The `className`-with-competing-colour fixture still renders its band colour
- [ ] With a screen reader, each chip announces once — the generated sentence, or
      `accessibleLabel` where the fixture supplies one — and the unknown fixtures announce
      unavailability without naming a band
- [ ] Chip text at both `sm` and `lg` meets 4.5:1 against its background in light **and** dark mode,
      checked with a contrast tool; the yellow band included
- [ ] At 320px, an `sm` chip inside a `CustomerCard` does not overflow or wrap mid-label
- [ ] Rendering all of `mockCustomers` through the refactored `CustomerCard` shows the same colour
      per customer as before the refactor, with only the label wording changed
