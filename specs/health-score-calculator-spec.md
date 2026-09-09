# Feature: Customer Health Score Calculator

## Context
- Multi-factor health scoring engine for the Customer Intelligence Dashboard, plus the
  `CustomerHealthDisplay` widget that renders its output
- Turns raw relationship signals (payment behaviour, product engagement, contract posture, support
  experience) into a single 0–100 score with a risk band, so analysts can triage accounts and spot
  churn risk without reading four separate reports
- Two deliverables with a hard boundary between them: a **pure, synchronous, side-effect-free
  calculation module** and a **presentational widget** that consumes it. The module never touches
  React, fetches nothing, logs nothing, and reads no clock.
- Every number the algorithm produces must be explainable to a non-technical stakeholder. The
  result object therefore carries the per-factor breakdown and a data-completeness confidence
  value, not just the headline score.

### Relationship to existing code
- `Customer` in `src/data/mock-customers.ts` carries a **pre-baked `healthScore: number`** and none
  of the inputs this calculator needs. This calculator does **not** read `Customer.healthScore`; it
  computes a score from a separate `HealthScoreInput` structure. Reconciling or replacing the stored
  `healthScore` field is out of scope — see *Out of Scope*.
- `CustomerCard` (`specs/customer-card-spec.md`) already bands a score as Red ≤30 / Yellow 31–70 /
  Green 71–100. This spec's risk bands are deliberately identical so the dashboard never shows two
  different colours for one customer. **The threshold constants are defined once, in the calculator
  module, and imported by every consumer including `CustomerCard`.**
- `CustomerSelector` **does not exist in this repository yet**. The integration requirements below
  are written against its specified props contract, not against shipped code, and are gated on it
  landing. The widget must be usable standalone (score passed in / customer passed in) so it is not
  blocked.

## Requirements

### Functional Requirements

#### Scoring model
- Produce an integer score in `[0, 100]` and a risk band for a given `HealthScoreInput`
- Combine four factors with fixed weights: **Payment 40%, Engagement 30%, Contract 20%, Support 10%**
  (sums to exactly 100%; the weights are declared once as a single frozen constant)
- Each factor is scored independently on `[0, 100]` by its own exported pure function, then combined
- Return the full breakdown alongside the total, plus a `confidence` value describing how much of
  the weight was actually backed by data
- Never throw for *missing* data; throw only for *invalid* data (see *Validation*)

#### Risk bands

Bands are computed from the **final rounded integer score**, so the number shown and the band shown
can never disagree:

| Condition | Risk level | Label |
|---|---|---|
| `0 <= score <= 30` | `'critical'` | Critical |
| `31 <= score <= 70` | `'warning'` | Warning |
| `71 <= score <= 100` | `'healthy'` | Healthy |

- Thresholds `30` and `70` are declared once as named constants (`CRITICAL_MAX`, `WARNING_MAX`) and
  referenced everywhere — no inline literals in banding, styling, or tests
- The requirement's bands (`0-30`, `31-70`, `71-100`) leave gaps for fractional values. Resolved by
  rounding the total to an integer **before** banding, so no gap is reachable.

#### Pure function API

All of the following are named exports of `src/lib/healthCalculator.ts`:

| Function | Signature | Notes |
|---|---|---|
| `calculateHealthScore` | `(input: HealthScoreInput) => HealthScoreResult` | Orchestrator |
| `calculatePaymentScore` | `(payment?: PaymentHistory) => FactorScore` | 40% |
| `calculateEngagementScore` | `(engagement?: EngagementMetrics) => FactorScore` | 30% |
| `calculateContractScore` | `(contract?: ContractInformation) => FactorScore` | 20% |
| `calculateSupportScore` | `(support?: SupportData) => FactorScore` | 10% |
| `getRiskLevel` | `(score: number) => RiskLevel` | Banding only |

- Pure: same input → same output, always. No `Date.now()`, no `Math.random()`, no I/O, no mutation
  of arguments, no module-level mutable state.
- **All "days since / days until" values are supplied by the caller**, already computed. The module
  must not derive them from timestamps, because reading the clock would break purity and make tests
  time-dependent.

#### Normalization curves

Every raw signal maps to `[0, 100]` via a documented monotonic piecewise-linear curve. Helper
`normalizeLinear(value, bestAt, worstAt)` clamps to `[0, 100]` and is used for all of them, so the
clamping rule exists in exactly one place. Curves and intra-factor weights:

**Payment (factor weight 40%)**

| Signal | Curve | Sub-weight |
|---|---|---|
| `averagePaymentDelayDays` | 100 at `0`, 0 at `30`+ | 40% |
| `daysSinceLastPayment` | 100 at `<=30`, 0 at `120`+ | 30% |
| `overdueAmount` | 100 at `0`, 0 at `25%` of `contractValue` (fallback `10000` when contract value is absent) | 30% |

**Engagement (factor weight 30%)**

| Signal | Curve | Sub-weight |
|---|---|---|
| `loginsLast30Days` | 0 at `0`, 100 at `20`+ | 40% |
| `featureUsageCount` (distinct features used, last 30 days) | 0 at `0`, 100 at `8`+ | 40% |
| `supportTicketsLast30Days` | **non-monotonic:** `0` → `70`; `1–3` → `100`; then linear `100` at `3` down to `0` at `15`+ | 20% |

**Contract (factor weight 20%)**

| Signal | Curve | Sub-weight |
|---|---|---|
| `daysUntilRenewal` | `<0` (lapsed) → `0`; `0` → `30`; linear `30`→`60` across `0–30`; linear `60`→`100` across `30–120`; `>=120` → `100` | 50% |
| `contractValueRatio` (`contractValue / previousContractValue`) | `<=0.5` → `0`; linear to `80` at `1.0`; `>=1.1` → `100` | 25% |
| `recentUpgradeCount` (last 180 days) | `0` → `70`; `>=1` → `100`; each `recentDowngradeCount` subtracts `35`, floored at `0` | 25% |

**Support (factor weight 10%)**

| Signal | Curve | Sub-weight |
|---|---|---|
| `satisfactionScore` (CSAT `1`–`5`) | `(value - 1) / 4 * 100` | 50% |
| `averageResolutionTimeHours` | 100 at `<=4`, 0 at `72`+ | 30% |
| `escalationCount` (last 90 days) | 100 at `0`, 0 at `5`+ | 20% |

#### Missing data and re-weighting

This is the algorithm's most consequential rule and must be implemented exactly:

1. Any signal may be `undefined` (or the property absent). Absent ≠ zero. Treating a missing
   `overdueAmount` as `0` would flatter a customer; treating it as worst-case would defame one.
2. **Within a factor:** score only the present signals and re-normalize their sub-weights to sum to
   1. A payment record with only `averagePaymentDelayDays` is scored purely on that signal.
3. **Across factors:** a factor with no present signals (or an absent factor object) is excluded,
   and the remaining factor weights are re-normalized to sum to 1.
4. **All four factors missing** → return `score: null`, `riskLevel: 'unknown'`, `confidence: 0`.
   Do **not** return `0`, which would read as Critical and libel the customer.
5. `confidence` = the fraction of the original 100% weight backed by at least one present signal,
   before re-normalization (Payment-only data → `0.4`). Rounded to two decimals.
6. `contractValueRatio` requires `previousContractValue`; without it that signal is missing, not
   defaulted. Absolute `contractValue` is **never** a health signal on its own (see *Assumptions*).

#### New customers and edge cases
- `tenureDays` is an optional top-level input. When present and `< 30`, the result carries
  `provisional: true`, and the widget labels the score as provisional. The score itself is not
  adjusted — a genuinely healthy new customer should not be penalised for being new.
- `tenureDays < 30` combined with `daysSinceLastPayment === undefined` must not produce Critical;
  rule 4 or the re-weighting rule covers it.
- Zero engagement across all signals is a legitimate `0` engagement score, not missing data.

#### Trend analysis
- `calculateHealthScore` accepts an optional `previous?: { score: number }`. When supplied, the
  result carries `trend: 'improving' | 'declining' | 'stable'` using a **±3 point dead band** to
  suppress noise.
- Trend is advisory metadata only. It **must not** feed back into the score — folding a delta into
  the total would double-count signals already scored and make the function non-reproducible from a
  single snapshot.

#### Validation
- `HealthScoreValidationError extends Error` with `name = 'HealthScoreValidationError'`, a
  descriptive message naming the offending field and the nature of the problem, and a
  `field: string` property
- Throw on: non-`number` types for numeric fields; `NaN` / `Infinity` / `-Infinity`; negative values
  for fields that cannot be negative (`daysSinceLastPayment`, `averagePaymentDelayDays`,
  `overdueAmount`, `loginsLast30Days`, `featureUsageCount`, `supportTicketsLast30Days`,
  `contractValue`, `previousContractValue`, `recentUpgradeCount`, `recentDowngradeCount`,
  `averageResolutionTimeHours`, `escalationCount`, `tenureDays`); `satisfactionScore` outside
  `[1, 5]`; a non-object, `null`, or `undefined` `input`
- `daysUntilRenewal` **may** be negative — it means the contract has lapsed and is scored as `0`
- `null` for an individual signal is treated as missing, identical to `undefined`
- One error per call is sufficient; fail fast on the first invalid field

### UI Component Integration
- `CustomerHealthDisplay` in `src/components/CustomerHealthDisplay.tsx`, following the
  `CustomerCard` patterns: named export, exported props interface, Tailwind v4 styling
- Displays the overall score prominently with the band colour and a **visible band label**
  ("Critical" / "Warning" / "Healthy") — colour is never the only signal
- Expandable breakdown listing all four factors with each factor's score, weight, effective
  (re-normalized) weight, and a "no data" marker for excluded factors. Collapsed by default;
  requires `'use client'` for the disclosure state.
- Renders the `confidence` value and, when `provisional`, a provisional-score notice
- The `unknown` state (`score: null`) renders a neutral indicator and "Health score unavailable" —
  never a band, never `0`
- Error state: catches `HealthScoreValidationError` from a bad input and renders an inline error
  message; the widget must not crash the dashboard
- Loading state: the calculation itself is synchronous and has no loading state. The prop
  `isLoading?: boolean` exists for the **caller's** async input fetching and renders a skeleton
  consistent with other dashboard widgets. This distinction is deliberate — do not add artificial
  async to the calculator.

### Data Requirements
- All interfaces exported from `src/lib/healthCalculator.ts`: `HealthScoreInput`, `PaymentHistory`,
  `EngagementMetrics`, `ContractInformation`, `SupportData`, `FactorScore`, `HealthScoreResult`,
  `RiskLevel`
- `HealthScoreInput` shape:
  ```ts
  interface HealthScoreInput {
    payment?: PaymentHistory;
    engagement?: EngagementMetrics;
    contract?: ContractInformation;
    support?: SupportData;
    tenureDays?: number;
    previous?: { score: number };
  }
  ```
- `FactorScore` shape:
  ```ts
  interface FactorScore {
    score: number | null;
    weight: number;
    effectiveWeight: number;
    signalsUsed: string[];
    signalsMissing: string[];
  }
  ```
- `HealthScoreResult` shape:
  ```ts
  interface HealthScoreResult {
    score: number | null;          // integer 0-100, or null when no data
    riskLevel: RiskLevel;          // 'healthy' | 'warning' | 'critical' | 'unknown'
    breakdown: {
      payment: FactorScore;
      engagement: FactorScore;
      contract: FactorScore;
      support: FactorScore;
    };
    confidence: number;            // 0-1, two decimals
    provisional: boolean;
    trend?: 'improving' | 'declining' | 'stable';
  }
  ```
- **The input data does not exist anywhere in this repository.** Mock health inputs are a
  deliverable of this feature: `src/data/mock-health-inputs.ts`, keyed by `Customer.id` so all
  eight `mockCustomers` resolve, exported as `Record<string, HealthScoreInput>`.

### Required Test Fixtures

`src/lib/__fixtures__/health-score-fixtures.ts` is a deliverable, reusing the exported interfaces.
It must cover:

- **Band boundaries:** inputs engineered to total exactly `30`, `31`, `70`, `71`, `0`, and `100`
- **Fractional totals:** a case totalling `70.5` (rounds to `71` → Healthy) and one totalling
  `30.4` (rounds to `30` → Critical), proving display and band agree
- **Missing data:** every factor absent; exactly one factor present (each of the four); a factor
  object present but empty `{}`; a single signal present within a factor
- **`null` signals** interspersed with present ones
- **New customer:** `tenureDays: 5` with sparse data
- **Invalid inputs:** `NaN`, `Infinity`, negative `overdueAmount`, `satisfactionScore: 0`,
  `satisfactionScore: 6`, a string in a numeric field, `null` input
- **Legitimately lapsed:** `daysUntilRenewal: -10`
- **Non-monotonic ticket curve:** `supportTicketsLast30Days` of `0`, `1`, `3`, `9`, `15`, `40`
- **Extreme magnitudes:** `overdueAmount: 1e9`, `loginsLast30Days: 100000`

### Integration Requirements
- `CustomerSelector` integration: the widget accepts `customerId` (or a `Customer`) and looks the
  input up in `src/data/mock-health-inputs.ts`; changing the selection re-renders the score.
  **Blocked until `CustomerSelector` exists** — until then, verified via a scratch page passing
  fixtures directly.
- A customer with no entry in the mock inputs resolves to the `unknown` state, not a crash
- `CustomerCard` and `CustomerHealthDisplay` import the same threshold constants and the same
  `getRiskLevel`, so a given score always yields the same colour in both. If `CustomerCard` has
  already shipped with local thresholds, refactoring it to import them is part of this work.
- Import via the `@/*` alias (`@/lib/healthCalculator`), matching existing convention

### Accessibility Requirements
- Score announced with an accessible label, e.g. `aria-label="Health score 72 out of 100 — healthy"`;
  the unknown state announces unavailability and names no band
- Expand/collapse control is a real `<button>` with `aria-expanded` and `aria-controls`, reachable
  and operable by keyboard
- Breakdown renders as a semantic list or table, not styled `<div>`s
- WCAG 2.1 AA contrast: 4.5:1 for text, 3:1 for meaningful non-text. The Warning/yellow band must
  be darkened or paired with a dark foreground — no light yellow on white.
- Heading level for the widget title is configurable via an optional `headingLevel` prop
  (`2 | 3 | 4`, default `3`), mirroring `CustomerCard`

## Constraints

### Technical Stack
- Next.js 15.5 (App Router), React 19.1, TypeScript 5 `strict: true`, Tailwind CSS v4, Node 20
- **No new runtime dependencies.** All arithmetic is plain TypeScript.
- One new **dev** dependency: a test runner (see below)

### Testing

`requirements/health-score-calculator.md` demands comprehensive unit tests, and this repository has
**no test runner** — `npm run lint` and `npm run type-check` are the only executable checks. A
scoring algorithm whose whole value is mathematical correctness cannot be signed off by eye.
**Resolution: add `vitest` as a devDependency** plus an `npm test` script, and write the suite in
`src/lib/healthCalculator.test.ts`. This is a deliberate, flagged deviation from the repo's
zero-tooling status quo; if the workshop requires the toolchain to stay untouched, the testing
acceptance criteria below become unverifiable, and that trade-off should be accepted explicitly
rather than silently.

Coverage required: every exported function; every normalization curve at `bestAt`, `worstAt`,
midpoint, and beyond both ends; every band boundary; every re-weighting path; every validation
error; the non-monotonic ticket curve; purity (calling twice with the same object yields deep-equal
results and does not mutate the input); weights summing to exactly 1; effective weights summing to
1 whenever at least one factor is present.

### Code Quality
- Named exports only — no default export
- No `any`; no non-null assertions to dodge the `number | null` score
- Descriptive identifiers; no abbreviations
- JSDoc on every exported function and on each normalization curve, stating the business meaning,
  the formula, and **why** those thresholds were chosen
- Every magic number (weights, curve endpoints, dead band, fallback overdue ceiling) is a named
  constant in one exported, frozen configuration block, so calibration is a single-file change
- The calculator module imports nothing from React, Next.js, or `src/components`

### Performance
- Target: a full `calculateHealthScore` call is a fixed, small number of arithmetic operations —
  no loops over unbounded data, no allocation beyond the result object. Comfortably sub-millisecond;
  re-computing for all eight mock customers on every selection change needs no optimisation.
- **Caching stays outside the pure core.** If memoization is wanted, expose a separate
  `createMemoizedHealthScore()` factory; do not put a cache in module scope inside
  `calculateHealthScore`, as that reintroduces state and breaks purity and testability.
- No `useMemo` for the calculation is required at this scale; add it only with a measurement.

### File Structure and Naming

| Path | Contents | Exists? |
|---|---|---|
| `src/lib/healthCalculator.ts` | Calculator, interfaces, constants, error class | New (`src/lib/` does not exist) |
| `src/lib/healthCalculator.test.ts` | Vitest suite | New |
| `src/lib/__fixtures__/health-score-fixtures.ts` | Test fixtures | New |
| `src/data/mock-health-inputs.ts` | Mock inputs keyed by customer id | New |
| `src/components/CustomerHealthDisplay.tsx` | Widget | New (`src/components/` does not exist) |

The requirement specifies `lib/healthCalculator.ts` at the repo root; this repo's `@/*` alias maps
to `./src/*`, so the path is **`src/lib/healthCalculator.ts`**. The camel-case filename is retained
as written in the requirement.

### Security Considerations
- No customer financial data (`overdueAmount`, `contractValue`) in `console` calls or thrown error
  messages — validation errors name the **field** and the **type problem**, never echo a monetary
  amount
- Render all values as JSX text; never `dangerouslySetInnerHTML`
- Scores and their inputs are internal analytics; nothing is sent to a third party

## Assumptions

State these in the module's JSDoc; they are business judgements, not derived facts, and a
stakeholder may overrule any of them:

1. **Absolute contract value does not indicate health.** A large unhappy account is not healthy. The
   contract factor scores *trajectory* (`contractValue / previousContractValue`) and renewal
   proximity; absolute value is used only as the denominator for overdue-amount severity.
2. **Support tickets are counted once.** The requirement lists tickets under both engagement and
   support. Ticket *volume* is scored as an engagement signal only; the support factor scores
   *experience quality* (satisfaction, resolution time, escalations). Scoring volume in both would
   double-penalise a customer for a single behaviour.
3. **Some support contact is healthier than none.** Hence the non-monotonic ticket curve: silence
   often means disengagement, not satisfaction.
4. **Near-term renewal is a risk signal, not a defect.** Renewal proximity depresses the contract
   score to surface accounts needing attention; it never alone drives a customer to Critical, since
   the factor caps at 20% of the total.
5. **Payment behaviour is the strongest churn predictor**, justifying its 40% weight. This is an
   assumption, not a measured result — see *Calibration* below.
6. Curve endpoints (30-day delay, 20 logins, 8 features, 72-hour resolution) are plausible
   placeholders, not empirically fitted values.

### Calibration and validation (documentation deliverable)
- A short `## Calibration` section in the module JSDoc recording: that weights and endpoints are
  unvalidated placeholders; that they should be re-fitted against observed churn once outcome data
  exists; that the single frozen config block is the intended tuning surface; and that any A/B or
  shadow-scoring comparison should run the alternative weights over the **same** inputs, which the
  pure-function design makes trivial.
- No live monitoring, telemetry, or experiment framework is built in this iteration.

## Out of Scope
- Reconciling or replacing `Customer.healthScore` in `src/data/mock-customers.ts`; migrating
  existing consumers to computed scores
- Real data sources — billing, CRM, analytics, or ticketing integrations
- Persistence or history of scores; the score is computed from a caller-supplied snapshot
- Predictive/ML churn modelling and alerting (`requirements/predictive-alerts.md`)
- Building `CustomerSelector` itself
- Production monitoring, telemetry, dashboards, and a live A/B testing harness

## Acceptance Criteria

### Automated — must pass
- [ ] `npm run type-check` passes with no errors
- [ ] `npm run lint` passes with no errors or warnings
- [ ] `npm test` passes; the suite covers every item under *Testing*
- [ ] `FACTOR_WEIGHTS` values sum to exactly `1` (asserted in a test, not by inspection)
- [ ] Payment 40 / Engagement 30 / Contract 20 / Support 10 weighting verified by a test with all
      factors at known scores and a hand-computed expected total
- [ ] Every band boundary asserted: `0`, `30`, `31`, `70`, `71`, `100`
- [ ] `70.5` totals to Healthy and `30.4` to Critical, with the displayed integer matching the band
- [ ] Each normalization curve asserted at `bestAt`, `worstAt`, one midpoint, and one value past
      each end (clamping proven)
- [ ] Ticket curve asserted at `0` → `70`, `1` → `100`, `3` → `100`, `15` → `0`, `40` → `0`
- [ ] Missing one factor re-normalizes the remaining weights to sum to `1` and shifts the total as
      hand-computed; a missing signal within a factor does the same at sub-weight level
- [ ] All factors missing returns `score: null`, `riskLevel: 'unknown'`, `confidence: 0` — asserted
      **not** to return `0`
- [ ] `confidence` equals `0.4` for payment-only input and `1` for complete input
- [ ] Every listed validation case throws `HealthScoreValidationError` with the offending field name
      in `error.field`; the message contains no monetary value
- [ ] Missing (`undefined` / `null`) signals never throw
- [ ] `daysUntilRenewal: -10` scores the renewal signal `0` without throwing
- [ ] Purity: two calls on the same input are deep-equal and the input object is unmutated
      (asserted via a structural snapshot of the input before and after)
- [ ] `tenureDays: 5` yields `provisional: true` and an unchanged score relative to the same input
      without `tenureDays`
- [ ] Trend dead band: `+2` → `'stable'`, `+4` → `'improving'`, `-4` → `'declining'`; `trend` is
      absent when `previous` is omitted, and supplying `previous` does not change `score`
- [ ] `src/lib/healthCalculator.ts` contains no `import` from React, Next.js, or `src/components`
- [ ] `mock-health-inputs.ts` has an entry for all eight `mockCustomers` ids, and every entry
      produces a result without throwing

### Manual — verified by rendering the fixture set on a scratch page and inspecting
- [ ] Overall score renders with the correct band colour and a visible band label
- [ ] Breakdown is collapsed by default and expands to show all four factors with score, nominal
      weight, effective weight, and a "no data" marker where applicable
- [ ] `confidence` is displayed; the provisional notice appears only for `tenureDays < 30`
- [ ] The `unknown` state shows a neutral indicator and "Health score unavailable", with no band
      colour and no `0`
- [ ] An invalid input renders the inline error state without crashing the page
- [ ] `isLoading` renders a skeleton consistent with other dashboard widgets
- [ ] Expand control is a `<button>` with correct `aria-expanded`, operable by keyboard alone
- [ ] Score exposes an accessible label; the unknown state announces unavailability
- [ ] Breakdown uses semantic list or table markup
- [ ] Contrast checked with a tool for all four states, Warning band included
- [ ] Widget title honours `headingLevel`, defaulting to `<h3>`
- [ ] A score of e.g. `72` shows the same colour in `CustomerHealthDisplay` and `CustomerCard`
- [ ] Layout readable and intact at 320px, 768px, and 1024px
- [ ] No financial values in any `console` output while exercising every fixture
- [ ] No console errors or warnings across the full fixture set
- [ ] JSDoc explains each weight and curve endpoint with its rationale, and the `## Calibration`
      section is present
