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
  different colours for one customer. **The threshold constants and `getRiskLevel` are defined once,
  in the calculator module, and imported by every consumer including `CustomerCard`.**
- **`CustomerSelector`, `CustomerCard`, and `src/components/` do not exist in this repository yet.**
  `src/components/CustomerHealthDisplay.tsx` will be the first component in the codebase. Every
  requirement phrased as "consistent with other dashboard widgets" or "matching `CustomerCard`" is
  therefore a claim about *specs*, not shipped code — see *Deferred verification* under Acceptance
  Criteria for how each such criterion is handled. The widget must be usable standalone (input or
  result passed in directly by prop) so none of this blocks it.

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
can never disagree. `getRiskLevel` is a **total function** — it must return a `RiskLevel` for every
possible `number`, including fractional, out-of-range, and non-finite values, because it is exported
and `CustomerCard` is required to call it with its own raw `healthScore`:

```ts
getRiskLevel(score: number | null | undefined): RiskLevel
```

1. `null`, `undefined`, or non-finite (`NaN`, `±Infinity`) → `'unknown'`
2. Otherwise clamp into `[0, 100]`, then round to the nearest integer (`Math.round`, half-up)
3. Band that canonical value with **open-ended comparisons**, leaving no gap for fractional inputs:

| Condition | Risk level | Label |
|---|---|---|
| `score <= CRITICAL_MAX` (30) | `'critical'` | Critical |
| `score <= WARNING_MAX` (70) | `'warning'` | Warning |
| otherwise | `'healthy'` | Healthy |

- Thresholds `30` and `70` are declared once as named constants (`CRITICAL_MAX`, `WARNING_MAX`) and
  referenced everywhere — no inline literals in banding, styling, or tests
- The requirement's bands (`0-30`, `31-70`, `71-100`) leave gaps for fractional values. Closed by
  the clamp-and-round in step 2 plus the open-ended comparisons in step 3. A closed `31 <= score`
  form must **not** be used: `getRiskLevel(30.5)` would then match no band. This mirrors the
  resolution already adopted in `specs/customer-card-spec.md`.
- `getRiskLevel` alone can never return `'unknown'` for a finite number. The low-confidence
  `'unknown'` case below is decided by `calculateHealthScore`, not by banding.

#### Pure function API

All of the following are named exports of `src/lib/healthCalculator.ts`:

| Function | Signature | Notes |
|---|---|---|
| `calculateHealthScore` | `(input: HealthScoreInput) => HealthScoreResult` | Orchestrator |
| `calculatePaymentScore` | `(payment: PaymentHistory \| undefined, context?: FactorContext) => FactorScore` | 40% |
| `calculateEngagementScore` | `(engagement?: EngagementMetrics) => FactorScore` | 30% |
| `calculateContractScore` | `(contract?: ContractInformation) => FactorScore` | 20% |
| `calculateSupportScore` | `(support?: SupportData) => FactorScore` | 10% |
| `getRiskLevel` | `(score: number \| null \| undefined) => RiskLevel` | Banding only, total |

- Pure: same input → same output, always. No `Date.now()`, no `Math.random()`, no I/O, no mutation
  of arguments, no module-level mutable state.
- **All "days since / days until" values are supplied by the caller**, already computed. The module
  must not derive them from timestamps, because reading the clock would break purity and make tests
  time-dependent.
- **`FactorContext` exists because two payment curves need data that lives outside `PaymentHistory`.**
  Without it, `calculatePaymentScore(p)` and the payment slice of
  `calculateHealthScore({ payment: p, contract: c })` would return different numbers for the same
  customer, and the breakdown would not reconcile with the total:
  ```ts
  interface FactorContext {
    contractValue?: number;      // denominator for overdue-amount severity
    billingCycleDays?: number;   // scales the payment-recency curve
  }
  ```
  `calculateHealthScore` derives the context from `input.contract.contractValue` and
  `input.billingCycleDays` and passes it in. When `calculatePaymentScore` is called standalone
  without a context, the documented fallbacks apply, and the JSDoc must state that a standalone call
  may differ from the orchestrated one for this reason.

#### Normalization curves

Every raw signal maps to `[0, 100]`. Two helpers, so the clamping rule lives in exactly one place:

- `clampScore(value: number): number` — clamps to `[0, 100]`. **Every** curve returns through this,
  including the piecewise and step curves below.
- `normalizeLinear(value, bestAt, worstAt): number` — a single linear ramp, returning through
  `clampScore`. `bestAt` may be greater or less than `worstAt`, so the helper handles both
  directions.

Eight of the twelve curves are single monotonic ramps expressible with `normalizeLinear`. Four are
not, and are implemented as their own documented functions that still return through `clampScore`:
the support-ticket curve (**non-monotonic** by design), the four-segment renewal curve, the contract
momentum step function, and the CSAT rescale. The blanket claim "every curve is monotonic and uses
`normalizeLinear`" is false and must not appear in the implementation's JSDoc.

**Payment (factor weight 40%)**

| Signal | Curve | Sub-weight |
|---|---|---|
| `averagePaymentDelayDays` | `normalizeLinear`: 100 at `0`, 0 at `30`+ | 40% |
| `daysSinceLastPayment` | `normalizeLinear`: 100 at `<= 1 x cycle`, 0 at `>= 4 x cycle`, where `cycle` = `billingCycleDays` (default `30`) | 30% |
| `overdueAmount` | `normalizeLinear`: 100 at `0`, 0 at `25%` of `context.contractValue`; when contract value is absent, ceiling falls back to `10000` | 30% |

**Engagement (factor weight 30%)**

| Signal | Curve | Sub-weight |
|---|---|---|
| `loginsLast30Days` | `normalizeLinear`: 0 at `0`, 100 at `20`+ | 40% |
| `featureUsageCount` (distinct features used, last 30 days) | `normalizeLinear`: 0 at `0`, 100 at `8`+ | 40% |
| `supportTicketsLast30Days` | **non-monotonic, own function:** `0` → `70`; `1–3` → `100`; then linear `100` at `3` down to `0` at `15`+ | 20% |

**Contract (factor weight 20%)**

| Signal | Curve | Sub-weight |
|---|---|---|
| `daysUntilRenewal` | **four-segment, own function:** `< 0` (lapsed) → `0`; `0` → `30`; linear `30`→`60` across `0–30`; linear `60`→`100` across `30–120`; `>= 120` → `100` | 50% |
| `contractValueRatio` (`contractValue / previousContractValue`) | `normalizeLinear`-style, two ramps: `<= 0.5` → `0`; linear to `80` at `1.0`; `>= 1.1` → `100` | 25% |
| `contractMomentum` (see below) | **step function, own function:** base `70` when `recentUpgradeCount` is `0`, `100` when `>= 1`; minus `35` per `recentDowngradeCount`; through `clampScore` | 25% |

**Support (factor weight 10%)**

| Signal | Curve | Sub-weight |
|---|---|---|
| `satisfactionScore` (CSAT `1`–`5`) | own function: `(value - 1) / 4 * 100` | 50% |
| `averageResolutionTimeHours` | `normalizeLinear`: 100 at `<= 4`, 0 at `72`+ | 30% |
| `escalationCount` (last 90 days) | `normalizeLinear`: 100 at `0`, 0 at `5`+ | 20% |

**`contractMomentum` is one signal built from two fields.** `recentUpgradeCount` and
`recentDowngradeCount` are not independent signals — a downgrade count alone would otherwise have no
defined behaviour under the re-weighting rules. The signal is therefore **present when either field
is present**, and the absent field is treated as `0` within it. Both absent → the signal is missing
and its sub-weight is redistributed.

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
6. **Low-confidence results are not banded.** When `0 < confidence < MIN_BANDING_CONFIDENCE` (`0.5`),
   return the computed `score` but set `riskLevel: 'unknown'` and `provisional: true`.

   Rule 4 alone is not enough. Support-only input with `satisfactionScore: 1` scores the support
   factor `0`, re-normalizes its effective weight to `1.0`, and yields **total `0`, Critical, on 10%
   of the evidence** — exactly the libel rule 4 exists to prevent, arrived at by a different path.
   The score is still returned (the breakdown remains explainable and the trajectory still visible);
   what is withheld is the *categorical claim* that the customer is Critical or Healthy.
7. `contractValueRatio` requires `previousContractValue`; without it that signal is missing, not
   defaulted. Absolute `contractValue` is **never** a health signal on its own (see *Assumptions*).

#### New customers and edge cases
- `tenureDays` is an optional top-level input. When present and `< 30`, the result carries
  `provisional: true`, and the widget labels the score as provisional. The score itself is not
  adjusted — a genuinely healthy new customer should not be penalised for being new.
- `provisional` therefore has **two independent triggers**: `tenureDays < PROVISIONAL_TENURE_DAYS`
  (30), or `confidence < MIN_BANDING_CONFIDENCE` (0.5). Either sets it; the widget's wording should
  distinguish "too new to be sure" from "too little data to classify".
- `tenureDays < 30` combined with `daysSinceLastPayment === undefined` must not produce Critical;
  rules 4 and 6 cover it.
- Zero engagement across all signals is a legitimate `0` engagement score, not missing data.

#### Trend analysis
- `calculateHealthScore` accepts an optional `previous?: { score: number }`. When supplied and the
  current `score` is non-null, the result carries `trend`, using a dead band of
  `TREND_DEAD_BAND = 3` points to suppress noise:
  - `|current - previous| <= 3` → `'stable'` (a delta of exactly `±3` is **stable**)
  - `current - previous > 3` → `'improving'`
  - `current - previous < -3` → `'declining'`
- `trend` is omitted when `previous` is absent **or** when `score` is `null` — there is nothing to
  compare against.
- Trend is advisory metadata only. It **must not** feed back into the score — folding a delta into
  the total would double-count signals already scored and make the function non-reproducible from a
  single snapshot.

#### Validation
- `HealthScoreValidationError extends Error` with `name = 'HealthScoreValidationError'`, a
  descriptive message naming the offending field and the nature of the problem, and a
  `field: string` property
- **`field` is a dotted path from the input root** — `'payment.overdueAmount'`,
  `'support.satisfactionScore'`, `'previous.score'`, `'tenureDays'` — so a caller can locate the
  problem without parsing the message
- **Shape validation, before any numeric check:**
  - `input` must be a non-null, non-array plain object; `null`, `undefined`, arrays, and primitives
    throw with `field: 'input'`
  - each of `payment`, `engagement`, `contract`, `support`, and `previous`, **when present and not
    `null`**, must be a non-array plain object. `{ payment: 42 }` and `{ payment: 'hello' }` throw
    with `field: 'payment'` rather than silently scoring as an empty factor.
  - unknown extra properties are ignored, not rejected — forward compatibility over strictness
- **Numeric validation.** Throw on: non-`number` types for numeric fields; `NaN` / `Infinity` /
  `-Infinity`; negative values for fields that cannot be negative (`daysSinceLastPayment`,
  `averagePaymentDelayDays`, `overdueAmount`, `loginsLast30Days`, `featureUsageCount`,
  `supportTicketsLast30Days`, `contractValue`, `previousContractValue`, `recentUpgradeCount`,
  `recentDowngradeCount`, `averageResolutionTimeHours`, `escalationCount`, `tenureDays`,
  `billingCycleDays`); `satisfactionScore` outside `[1, 5]`; `previous.score` outside `[0, 100]` or
  non-finite; `billingCycleDays` of `0` (it is a divisor)
- `daysUntilRenewal` **may** be negative — it means the contract has lapsed and is scored as `0`
- `null` for an individual signal is treated as missing, identical to `undefined`
- One error per call is sufficient; fail fast on the first invalid field

### UI Component Integration
- `CustomerHealthDisplay` in `src/components/CustomerHealthDisplay.tsx`. It is the **first** component
  in this repository, so it *establishes* the pattern rather than following one: named export,
  exported props interface, Tailwind v4 styling, `@/*` imports — the conventions
  `specs/customer-card-spec.md` also specifies, so the two agree when `CustomerCard` lands.
- Displays the overall score prominently with the band colour and a **visible band label**
  ("Critical" / "Warning" / "Healthy") — colour is never the only signal
- Expandable breakdown listing all four factors with each factor's score, weight, effective
  (re-normalized) weight, and a "no data" marker for excluded factors. Collapsed by default;
  requires `'use client'` for the disclosure state.
- Renders the `confidence` value and, when `provisional`, a provisional-score notice
- **Three distinct unbanded presentations must be visually and textually different:**
  | State | Condition | Presentation |
  |---|---|---|
  | No data | `score === null`, `confidence === 0` | Neutral indicator, "Health score unavailable" |
  | Low confidence | `score !== null`, `riskLevel === 'unknown'` | Score shown, neutral indicator, "Insufficient data to classify" + confidence |
  | Too new | `provisional` via `tenureDays` | Score and band shown, with a "provisional — new customer" notice |
  Neither unbanded state may render a band colour, and neither may render `0` in place of a missing
  score.
- Error state: catches `HealthScoreValidationError` from a bad input and renders an inline error
  message; the widget must not crash the dashboard
- Loading state: the calculation itself is synchronous and has no loading state. The prop
  `isLoading?: boolean` exists for the **caller's** async input fetching and renders a skeleton.
  This distinction is deliberate — do not add artificial async to the calculator.
- Breakdown display precision: `FactorScore.score` is rounded to **one decimal place**; the widget
  renders factor scores and the total as integers. The total is computed from **unrounded** factor
  scores, so re-multiplying the displayed parts may differ from the displayed total by up to ~0.5
  points. The JSDoc must state this; the breakdown is an explanation, not an audit trail.

### Data Requirements
- All interfaces exported from `src/lib/healthCalculator.ts`: `HealthScoreInput`, `PaymentHistory`,
  `EngagementMetrics`, `ContractInformation`, `SupportData`, `FactorContext`, `FactorScore`,
  `HealthScoreResult`, `RiskLevel`
- `HealthScoreInput` shape:
  ```ts
  interface HealthScoreInput {
    payment?: PaymentHistory;
    engagement?: EngagementMetrics;
    contract?: ContractInformation;
    support?: SupportData;
    tenureDays?: number;
    billingCycleDays?: number;
    previous?: { score: number };
  }
  ```
- `FactorScore` shape:
  ```ts
  interface FactorScore {
    score: number | null;      // rounded to one decimal
    weight: number;            // nominal, e.g. 0.4
    effectiveWeight: number;   // after re-normalization; 0 when the factor is excluded
    signalsUsed: string[];
    signalsMissing: string[];
  }
  ```
- `HealthScoreResult` shape:
  ```ts
  interface HealthScoreResult {
    score: number | null;          // integer 0-100; null only when no data at all
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
  `riskLevel: 'unknown'` does **not** imply `score === null` — see missing-data rule 6.
- **The input data does not exist anywhere in this repository.** Mock health inputs are a
  deliverable of this feature: `src/data/mock-health-inputs.ts`, keyed by `Customer.id` so all
  eight `mockCustomers` resolve, exported as `Record<string, HealthScoreInput>`.

#### Inputs added beyond the requirements

`requirements/health-score-calculator.md` lists twelve input signals. This spec requires five things
it does not mention. Each is a deliberate addition with a cost to the caller, and any of them may be
struck by a stakeholder — in which case the dependent curve degrades to a missing signal and
re-weights, which is why none of them is load-bearing:

| Addition | Why | If struck |
|---|---|---|
| `previousContractValue` | "Contract value" alone is not a health signal (Assumption 1); the ratio is | `contractValueRatio` missing; contract factor scores on renewal + momentum |
| `recentDowngradeCount` | "Recent upgrades" with no downgrade counterpart cannot detect contraction | `contractMomentum` scores upgrades only |
| `tenureDays` | Required by "edge case handling for new customers" | No provisional flag for new customers |
| `billingCycleDays` | Payment recency is meaningless without a cycle (see Assumption 7) | Defaults to `30`; annual customers mis-scored |
| CSAT scale `1`–`5` | "Satisfaction scores" specifies no range; a range is needed to rescale | Rescale formula and the `[1, 5]` validation must both change |

The CSAT range is the riskiest of these: a source system encoding "no response" as `0`, or using
`1`–`10` or a percentage, will now **throw** rather than score. Confirm the scale before
implementation; if it is not 1–5, only the rescale function and one validation bound change.

### Required Test Fixtures

`src/lib/__fixtures__/health-score-fixtures.ts` is a deliverable, reusing the exported interfaces.
It must cover:

- **Band boundaries:** inputs engineered to total exactly `30`, `31`, `70`, `71`, `0`, and `100`
  (all reachable: setting every factor to the same score `s` yields a total of `s`, and each factor
  can reach both `0` and `100`)
- **Fractional totals:** a case totalling `70.5` (rounds to `71` → Healthy) and one totalling
  `30.4` (rounds to `30` → Critical), proving display and band agree
- **`getRiskLevel` direct inputs:** `30.4`, `30.5`, `70.4`, `70.5`, `-5`, `150`, `NaN`, `Infinity`,
  `null`, `undefined` — the exported-function path that bypasses the orchestrator's rounding. Note
  half-up rounding puts `30.5` in Warning and `70.5` in Healthy, not the band below.
- **Missing data:** every factor absent; exactly one factor present (each of the four); a factor
  object present but empty `{}`; a single signal present within a factor
- **Low confidence:** support-only with `satisfactionScore: 1` (the total-`0` case), and a
  payment+engagement input at `confidence 0.7` that *is* banded
- **`null` signals** interspersed with present ones
- **Invalid shapes:** `{ payment: 42 }`, `{ payment: 'hello' }`, `{ payment: [] }`, `null` input,
  `[]` input, `{ previous: { score: NaN } }`, `{ previous: { score: 200 } }`, `billingCycleDays: 0`
- **New customer:** `tenureDays: 5` with sparse data
- **Invalid numerics:** `NaN`, `Infinity`, negative `overdueAmount`, `satisfactionScore: 0`,
  `satisfactionScore: 6`, a string in a numeric field
- **Legitimately lapsed:** `daysUntilRenewal: -10`
- **Non-monotonic ticket curve:** `supportTicketsLast30Days` of `0`, `1`, `3`, `9`, `15`, `40`
- **Contract momentum:** upgrades only; downgrades only; both; neither
- **Billing cycle:** identical payment data at `billingCycleDays` `30` and `365`, proving the annual
  customer is not penalised
- **Payment context:** the same `PaymentHistory` scored standalone and through the orchestrator with
  a `contractValue`, documenting the intended difference
- **Extreme magnitudes:** `overdueAmount: 1e9`, `loginsLast30Days: 100000`

### Integration Requirements
- `CustomerSelector` integration: the widget accepts `customerId` (or a `Customer`) and looks the
  input up in `src/data/mock-health-inputs.ts`; changing the selection re-renders the score.
  **Blocked until `CustomerSelector` exists** — until then, verified via a scratch page passing
  fixtures directly.
- A customer with no entry in the mock inputs resolves to the no-data state, not a crash
- `CustomerCard` and `CustomerHealthDisplay` import the same threshold constants and the same
  `getRiskLevel`, so a given score always yields the same colour in both. `CustomerCard` does not
  exist yet; when it is built, importing them is a requirement of *its* implementation, and this
  spec's job is to make `getRiskLevel` total enough to be safely reused (see *Risk bands*).
- Import via the `@/*` alias (`@/lib/healthCalculator`), matching existing convention

### Accessibility Requirements
- Score announced with an accessible label, e.g. `aria-label="Health score 72 out of 100 — healthy"`;
  the no-data and low-confidence states announce their situation and name no band
- Expand/collapse control is a real `<button>` with `aria-expanded` and `aria-controls`, reachable
  and operable by keyboard
- Breakdown renders as a semantic list or table, not styled `<div>`s
- WCAG 2.1 AA contrast: 4.5:1 for text, 3:1 for meaningful non-text. The Warning/yellow band must
  be darkened or paired with a dark foreground — no light yellow on white.
- Heading level for the widget title is configurable via an optional `headingLevel` prop
  (`2 | 3 | 4`, default `3`), matching `specs/customer-card-spec.md`

## Constraints

### Technical Stack
- Next.js 15.5 (App Router), React 19.1, TypeScript 5 `strict: true`, Tailwind CSS v4, Node 20
- **No new runtime dependencies.** All arithmetic is plain TypeScript.
- One new **direct dev** dependency: a test runner (see below)

### Testing

`requirements/health-score-calculator.md` demands comprehensive unit tests, and this repository has
**no test runner** — `npm run lint` and `npm run type-check` are the only executable checks. A
scoring algorithm whose whole value is mathematical correctness cannot be signed off by eye.
**Resolution: add `vitest` as a devDependency** plus an `npm test` script, and write the suite in
`src/lib/healthCalculator.test.ts`. This is a deliberate, flagged deviation from the repo's
zero-tooling status quo; if the workshop requires the toolchain to stay untouched, the testing
acceptance criteria below become unverifiable, and that trade-off should be accepted explicitly
rather than silently.

Coverage required: every exported function; every curve at `bestAt`, `worstAt`, midpoint, and beyond
both ends; every band boundary plus the direct `getRiskLevel` inputs listed in the fixtures; every
re-weighting path; the low-confidence suppression rule; every validation error including shape
errors; the non-monotonic ticket curve; purity (calling twice with the same object yields deep-equal
results and does not mutate the input); weights summing to exactly 1; effective weights summing to 1
whenever at least one factor is present.

### Code Quality
- Named exports only — no default export
- No `any`; no non-null assertions to dodge the `number | null` score
- Descriptive identifiers; no abbreviations
- JSDoc on every exported function and on each curve, stating the business meaning, the formula, and
  **why** those thresholds were chosen
- Every magic number (weights, curve endpoints, dead band, banding-confidence floor, provisional
  tenure, default billing cycle, overdue fraction and fallback ceiling) is a named constant in one
  exported, frozen configuration block, so calibration is a single-file change
- The calculator module imports nothing from React, Next.js, or `src/components`

### Performance
- Target: a full `calculateHealthScore` call is a fixed, small number of arithmetic operations —
  no loops over unbounded data, and allocation bounded by the result object plus the
  `signalsUsed` / `signalsMissing` arrays it carries (at most twelve short strings per call).
  Comfortably sub-millisecond; re-computing for all eight mock customers on every selection change
  needs no optimisation.
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
  messages — validation errors name the **field path** and the **type problem**, never echo a
  monetary amount. This costs some debuggability for negative-amount errors; the field path plus the
  problem class is judged sufficient.
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
7. **Payment recency is meaningless without a billing cycle.** A fixed "0 at 120 days" curve treats
   every annually-billed customer as delinquent: paid-in-full at day 200 with no delay and nothing
   overdue would score the payment factor `70` instead of `100`, and an otherwise-60-across-the-board
   customer drops from **76 (Healthy) to 64 (Warning)** on identical payment behaviour. The curve is
   therefore expressed in multiples of `billingCycleDays` (100 at ≤1 cycle, 0 at ≥4 cycles), which
   reproduces the original 30/120-day numbers at the default of 30. Callers with non-monthly
   contracts **must** supply the real cycle.
8. **A categorical risk label needs majority evidence.** Below 50% confidence the score is reported
   but not banded (missing-data rule 6). The 0.5 floor is a judgement, not a fitted threshold.

### Calibration and validation (documentation deliverable)
- A short `## Calibration` section in the module JSDoc recording: that weights, endpoints, the trend
  dead band, and the confidence floor are unvalidated placeholders; that they should be re-fitted
  against observed churn once outcome data exists; that the single frozen config block is the
  intended tuning surface; and that any A/B or shadow-scoring comparison should run the alternative
  weights over the **same** inputs, which the pure-function design makes trivial.
- No live monitoring, telemetry, or experiment framework is built in this iteration.

## Out of Scope
- **The requirements' `## AI Collaboration Requirements` section** (collaborative exploration phase,
  AI-assisted algorithm design, iterative refinement). Those describe how this spec and the
  implementation are *produced*, not what the software must do. They are satisfied by the presence of
  documented assumptions, stated mathematical rationale, and this exclusion list rather than by any
  code artifact — recorded here so the omission is deliberate rather than overlooked.
- Reconciling or replacing `Customer.healthScore` in `src/data/mock-customers.ts`; migrating
  existing consumers to computed scores
- Real data sources — billing, CRM, analytics, or ticketing integrations
- Persistence or history of scores; the score is computed from a caller-supplied snapshot. `previous`
  is passed in by the caller, not looked up.
- Predictive/ML churn modelling and alerting (`requirements/predictive-alerts.md`). Note this
  narrows the requirements' "predictive analytics for churn risk" framing: what ships is a
  point-in-time score plus a trend flag, not a prediction.
- Building `CustomerSelector` or `CustomerCard`
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
- [ ] `getRiskLevel` returns a band for every direct input in the fixture list — `30.5` → Warning
      and `70.5` → Healthy (both round *up* under half-up rounding), `30.4` → Critical,
      `70.4` → Warning, `-5` → Critical, `150` → Healthy, `NaN` / `Infinity` / `null` / `undefined`
      → `'unknown'`; **no input returns `undefined`**
- [ ] Each curve asserted at `bestAt`, `worstAt`, one midpoint, and one value past each end
      (clamping proven); every curve's return value proven to be within `[0, 100]`
- [ ] Ticket curve asserted at `0` → `70`, `1` → `100`, `3` → `100`, `15` → `0`, `40` → `0`
- [ ] Missing one factor re-normalizes the remaining weights to sum to `1` and shifts the total as
      hand-computed; a missing signal within a factor does the same at sub-weight level
- [ ] All factors missing returns `score: null`, `riskLevel: 'unknown'`, `confidence: 0` — asserted
      **not** to return `0`
- [ ] Support-only input with `satisfactionScore: 1` returns `score: 0`, `riskLevel: 'unknown'`,
      `provisional: true`, `confidence: 0.1` — asserted **not** to return `'critical'`
- [ ] An input at `confidence >= 0.5` *is* banded normally
- [ ] `confidence` equals `0.4` for payment-only input and `1` for complete input
- [ ] `contractMomentum` is present with upgrades only, downgrades only, and both; missing only when
      both fields are absent
- [ ] Identical payment data at `billingCycleDays` `30` and `365` yields the documented difference,
      and the annual case is not penalised for recency
- [ ] `calculatePaymentScore(p)` and `calculateHealthScore({ payment: p, contract: c })` agree on the
      payment factor when the context supplies `contractValue`
- [ ] Every listed validation case throws `HealthScoreValidationError` with the correct dotted path
      in `error.field`; the message contains no monetary value
- [ ] Shape errors covered: `{ payment: 42 }`, `{ payment: 'hello' }`, `{ payment: [] }`, `null`,
      `[]`, `{ previous: { score: NaN } }`, `{ previous: { score: 200 } }`, `billingCycleDays: 0`
- [ ] Unknown extra properties on the input are ignored without throwing
- [ ] Missing (`undefined` / `null`) signals never throw
- [ ] `daysUntilRenewal: -10` scores the renewal signal `0` without throwing
- [ ] Purity: two calls on the same input are deep-equal and the input object is unmutated
      (asserted via a structural snapshot of the input before and after)
- [ ] `tenureDays: 5` yields `provisional: true` and an unchanged score relative to the same input
      without `tenureDays`
- [ ] Trend dead band: `+2` → `'stable'`, **`+3` → `'stable'`**, `+4` → `'improving'`,
      **`-3` → `'stable'`**, `-4` → `'declining'`; `trend` is absent when `previous` is omitted **or
      when `score` is `null`**, and supplying `previous` does not change `score`
- [ ] `FactorScore.score` values are rounded to at most one decimal place
- [ ] `src/lib/healthCalculator.ts` contains no `import` from React, Next.js, or `src/components`
- [ ] `mock-health-inputs.ts` has an entry for all eight `mockCustomers` ids, and every entry
      produces a result without throwing

### Manual — verified by rendering the fixture set on a scratch page and inspecting
- [ ] Overall score renders with the correct band colour and a visible band label
- [ ] Breakdown is collapsed by default and expands to show all four factors with score, nominal
      weight, effective weight, and a "no data" marker where applicable
- [ ] All three unbanded presentations are distinguishable: no-data, low-confidence, and provisional
      new customer. Neither unbanded state renders a band colour or a substitute `0`.
- [ ] `confidence` is displayed
- [ ] An invalid input renders the inline error state without crashing the page
- [ ] `isLoading` renders a skeleton
- [ ] Expand control is a `<button>` with correct `aria-expanded`, operable by keyboard alone
- [ ] Score exposes an accessible label; the no-data and low-confidence states announce their
      situation and name no band
- [ ] Breakdown uses semantic list or table markup
- [ ] Contrast checked with a tool for all states, Warning band included
- [ ] Widget title honours `headingLevel`, defaulting to `<h3>`
- [ ] Layout readable and intact at 320px, 768px, and 1024px
- [ ] No financial values in any `console` output while exercising every fixture
- [ ] No console errors or warnings across the full fixture set
- [ ] JSDoc explains each weight and curve endpoint with its rationale, states the standalone-vs-
      orchestrated `calculatePaymentScore` caveat and the breakdown-precision caveat, does **not**
      claim all curves are monotonic, and includes the `## Calibration` section

### Deferred verification — cannot be checked in this repository yet

These follow from requirements that presuppose components which do not exist. Each is recorded with
its trigger rather than listed as a checkbox that would be silently skipped:

- **Colour parity with `CustomerCard`** (requirements: "colour coding consistency with other
  dashboard health indicators"). Verifiable when `CustomerCard` is implemented. What *is* verifiable
  now: both specs name the same thresholds, and `getRiskLevel` is exported and total, so parity is a
  matter of `CustomerCard` importing it.
- **"Loading and error states consistent with other dashboard widgets"** (requirements:34). There
  are no other dashboard widgets; this component defines the pattern. Re-check when the second
  widget lands, and treat any divergence then as a bug in whichever component deviates from the
  agreed pattern.
- **Real-time updates on `CustomerSelector` selection change** (requirements:35, 81). Verifiable when
  `CustomerSelector` exists; until then the widget is exercised with fixtures passed directly.
- **Dashboard layout integration and responsive behaviour within the dashboard** (requirements:82).
  The component's own responsiveness at 320/768/1024px is checked above; its behaviour inside a
  dashboard grid cannot be until that grid exists.
