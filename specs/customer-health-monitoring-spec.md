# Feature: CustomerHealthMonitoring

## Context

- Combined health scoring and predictive alerting capability for the Customer Intelligence Dashboard, specified from `requirements/health-score-calculator.md` and `requirements/predictive-alerts.md`
- Two requirements documents, one feature: the alerts engine cannot be built without the calculator, because three of its five rules are expressed in terms of a health score. They are specified together so the seam between them is designed once rather than negotiated twice
- Serves customer success managers who need to know **which** accounts are at risk (score) and **why, right now** (alerts), in time to act
- Six layers, built in order: a mock signal-history data module, a pure health calculator (`src/lib/healthCalculator.ts`), a pure alerts engine (`src/lib/alerts.ts`), a Dashboard-owned monitoring state, a `CustomerHealthDisplay` widget, and an `AlertsPanel` widget
- All data is **mock and locally generated**. There is no backend, no database, no scheduler, and no external payment/support/analytics integration in this repository, so nothing here is genuinely "real-time" and the UI must not claim otherwise

## Prerequisites and Repository Reality

**Both requirements documents describe a system considerably larger than this repository.** At the time of writing, the repo is a bare Next.js 15.5 App Router app: `src/` contains only `app/{layout,page,globals.css}` and `data/{mock-customers,mock-market-intelligence}.ts`. There is no `src/components/`, no `src/lib/`, no `src/services/`, no API route, **no test runner, and no state persistence of any kind**.

Concretely, the following requirement lines have no substrate to land on and are handled as noted. Every line in both documents that is not implemented as written appears here — if a requirement is neither specified below nor in this table, that is a defect in this spec.

| Requirement text | Source | Disposition |
|---|---|---|
| "Real-time monitoring of customer health score changes" | alerts | Reframed: scores and alerts are **derived on render** from the in-memory signal history. No polling, no subscription |
| "Efficient rule evaluation … for hundreds of customers" | alerts | Honored as an algorithmic constraint (see Performance), not as infrastructure |
| "Scalable architecture supporting growing customer base" | alerts | Honored only as the `O(customers × windowDays)` bound below. There is no horizontal scaling story to specify without a server, and one must not be implied |
| "Alert state synchronization across multiple dashboard sessions" | alerts | **Out of scope** — requires a server and a shared store, neither of which exists |
| "External data source integration (payment, engagement, support)" | alerts | **Out of scope** — replaced by the mock signal module below |
| "Rate limiting on alert generation to prevent system abuse" | alerts | **Out of scope as a security control** — there is no server endpoint to abuse. The cooldown logic below covers the real concern, which is alert fatigue |
| "Audit trail logging for all triggered alerts and user actions" | alerts | Reduced to an in-memory, session-lifetime `AlertHistoryEntry[]`. Not durable, not an audit trail in the compliance sense, and must not be described as one |
| "A/B testing framework for rule optimization" | both | **Out of scope.** `AlertRuleConfig` (below) makes thresholds injectable so variants *can* be compared by hand; no experiment framework, no assignment, no measurement |
| "Caching considerations for repeated calculations" | calculator | Honored as memoization at the widget boundary only (see Performance) |
| "Export capabilities for alert data and historical analysis" | alerts | **In scope, minimally**: a "Copy as CSV" control on `AlertsPanel` writing the current alert list to the clipboard. No file download, no server round-trip |
| "Alert effectiveness tracking (correlation with actual customer outcomes)" | alerts | **Out of scope** — requires real outcomes (renewed vs churned) that no mock dataset can supply. Fabricating a correlation would be worse than omitting it |
| "Alert fatigue monitoring and optimization recommendations" | alerts | Reduced to displayed per-customer alert counts and the cooldown mechanism. No recommendation engine |
| "User engagement with alerts and action completion rates" | alerts | **In scope, minimally** — see Action Tracking below. Counts acknowledged and actioned alerts for the session. Not a durable metric |
| "Payment timing and behavior change detection" | alerts | **Out of scope, and named as a gap.** Detecting a *change* in payment behavior needs a per-invoice event series (`{ dueDate, paidDate }[]`), which `PaymentSignals` deliberately does not carry. `averagePaymentDelayDays` is a single aggregate and cannot express a trend. The score-drop arm of `payment-risk` is the only change signal available |
| "Feature usage **depth** and adoption pattern analysis" | alerts | Depth is derived but **not scored**: mean touches per distinct feature over the window, surfaced in the `feature-adoption-stall` alert `detail` for context. The engagement factor scores breadth only, which is stated at the code |
| "Monitoring and calibration recommendations for production deployment" | calculator | Discharged as a **documentation deliverable**: a "Calibration notes" section at the end of `src/lib/healthCalculator.ts` listing which constants are guesses, what would falsify them, and what to measure first. Not code |
| "Business assumption documentation and validation" | calculator | Discharged by the per-factor JSDoc rationale plus the breakdown UI. The assumptions are named in this spec's factor tables and must be restated at the code |
| "System performance metrics and resource usage analytics" | alerts | **Out of scope** — no telemetry sink exists. Covered instead by the performance test budgets below |
| "Optimized data structures for health score breakdown display" | calculator | Honored as `FactorScore[]` — a flat, pre-computed array requiring no derivation in render. Nothing further is implied |
| "Dashboard layout integration maintaining responsive design" | calculator | Honored as the 320px / 768px / 1024px manual checks below, matching the existing card components |
| "AI collaboration requirements" (both docs, whole sections) | both | Not product requirements. These describe how the workshop exercise is *conducted*, not what the software does, and generate no acceptance criteria |

Do not implement a stub for an out-of-scope item, and do not describe an in-memory array as an audit trail.

### Naming deviations from the requirements

- The requirements say `lib/healthCalculator.ts` and `lib/alerts.ts`. This repo puts source under `src/`, so the paths are `src/lib/…`. Same modules, repo-correct location
- The requirements name the top-level entry point **`alertEngine`**. That name is used verbatim. An earlier draft of this spec renamed it `evaluateAllAlerts`; the requirement's name wins

### Testing prerequisite — a decision this spec makes

Both documents demand "comprehensive unit test coverage" and "mathematical accuracy verification tests". The repo's only executable checks are `npm run lint` and `npm run type-check`.

For a visual component, manual inspection is an acceptable substitute. **For this feature it is not** — the deliverable is arithmetic over roughly a dozen numeric inputs with piecewise thresholds, where the failure mode is a plausible-looking wrong number that no amount of looking at the screen will catch. So:

- **Adding Vitest is a deliverable of this spec**, as devDependencies (`vitest`, `@vitest/coverage-v8`), with `"test": "vitest run"` and `"test:watch": "vitest"` added to `package.json`. No runtime dependency is added, so the shipped bundle is unaffected
- If the workshop forbids adding any dependency, the fallback is a `src/app/health-check/page.tsx` scratch route that renders every fixture with its expected value beside its computed value and highlights mismatches. This is strictly worse and should be treated as a temporary measure, not the plan

## Required New Data: Signal History

**This is the largest gap between the requirements and the repo, and it must be closed first.**

`Customer` (in `src/data/mock-customers.ts`) carries a *pre-computed* `healthScore: number` and nothing else numeric. It has none of the calculator's inputs — no payment history, engagement counts, contract dates, or support metrics — and no time dimension at all. Meanwhile the alert rules are almost entirely temporal:

- "health score drops >20 points in 7 days" — needs prior scores
- "login frequency drops >50% compared to 30-day average" — needs a login time series
- "contract expires in <90 days" — needs a renewal date
- ">3 support tickets in 7 days" — needs ticket timestamps
- "no new feature usage in 30 days" — needs feature-adoption history
- "alert prioritization … considering customer value (ARR)" — needs ARR, which does not exist anywhere in the data model; `subscriptionTier` is the only proxy present

### Everything temporal is stored as a date, never as a day count

This is the load-bearing rule of the data design. An earlier draft stored `daysSinceLastPayment`, `daysUntilRenewal`, and `escalationsLast90Days` as pre-computed deltas. That is wrong: those deltas are implicitly relative to one fixed instant, so passing a different `asOf` would move the engagement windows (derived from dated history) while leaving payment and contract runway frozen, producing internally inconsistent results from the very parameter that exists to make the system deterministic. **Store dates and event series; derive every duration from `asOf`.**

The same rule removes a second defect: any quantity stored *both* as an aggregate and as a derivable sum has two sources of truth that can silently disagree. So CSAT, resolution hours, and escalations are stored only as per-day events and every aggregate is derived.

Create `src/data/mock-customer-signals.ts` exporting the following. `Customer` itself is **not modified**.

```ts
/** One day's observed signals for one customer. Newest last, one entry per day, no gaps. */
export interface DailySignals {
  date: string;                    // YYYY-MM-DD
  logins: number;                  // >= 0
  featuresUsed: string[];          // one entry per feature *touch*, so repeats are meaningful
  supportTicketsOpened: number;    // >= 0
  supportTicketsEscalated: number; // >= 0, <= supportTicketsOpened
  csatResponses: number[];         // each 1..5; usually empty
  resolutionHours: number[];       // >= 0 each; one entry per ticket resolved that day
}

export interface PaymentSignals {
  lastPaymentDate: string;          // YYYY-MM-DD
  averagePaymentDelayDays: number;  // finite; may be negative (pays early)
  overdueAmount: number;            // >= 0, USD
  overdueSince: string | null;      // YYYY-MM-DD; null iff overdueAmount === 0
}

export interface ContractSignals {
  renewalDate: string;              // YYYY-MM-DD; may be in the past (expired)
  annualRecurringRevenue: number;   // USD, must be > 0 — see Validation
  lastUpgradeDate: string | null;   // null if never upgraded
}

export interface CustomerSignals {
  customerId: string;               // matches Customer.id
  payment: PaymentSignals;
  contract: ContractSignals;
  history: DailySignals[];          // >= MINIMUM_GENERATED_HISTORY_DAYS, except for new-customer fixtures
}

export const SIGNAL_REFERENCE_DATE = '2026-09-09';
/** 90, not 60: the feature-adoption-stall growth test spans three consecutive 30-day windows. */
export const MINIMUM_GENERATED_HISTORY_DAYS = 90;
export const mockCustomerSignals: CustomerSignals[];
export function getSignalsForCustomer(customerId: string): CustomerSignals | undefined;

/** Seeds score history by running the calculator at each of the prior `days` dates. */
export function buildScoreHistory(
  customerId: string, asOf?: string, days?: number,
): Array<{ date: string; score: number }>;
```

There is no `SupportSignals` interface. Every support aggregate — CSAT mean, mean resolution hours, escalation count — is derived from `history` over its stated window, so the stored-versus-derived disagreement is structurally impossible rather than merely discouraged.

Constraints on the mock data itself — it is a deliverable, not filler:

- **Deterministic.** No `Math.random()` at module scope or at call time. Generate from a seeded PRNG keyed by an FNV-1a hash of `customerId`, so the same customer always produces the same history, the same score, and the same alerts. A demo that changes on refresh is not demonstrable, and a test cannot assert on it
- **Dates are generated backwards from `SIGNAL_REFERENCE_DATE`, never from `Date.now()`.** Every function needing "today" takes `asOf: string`, defaulting to that constant. The demo is therefore explicitly **frozen in time**: renewal runways and payment ages do not drift as real days pass. That is the price of determinism and is the intended trade
- **At least `MINIMUM_GENERATED_HISTORY_DAYS` (90) days of history**, because `feature-adoption-stall`'s growth test compares three consecutive 30-day windows and the support factor uses a 90-day window. An earlier draft promised 60 and specified rules needing 90
- **`Customer.healthScore` is *not* consumed by this feature.** Not by the calculator, not by any rule, not by either widget. It is stale pre-computed data superseded by the calculator's output, and it remains only because `CustomerCard` already reads it and this spec does not modify existing components. An earlier draft reinterpreted it as the 7-day-prior baseline for the score-drop rule; that reinterpretation was orphaned, because the rule reads `scoreHistory` instead. The field is now explicitly unused here, and the generator is merely *calibrated* against it: signals must produce a computed score within ±25 of the stored value for at least six of the eight mock customers, so the dashboard is not visibly self-contradictory
- **Every rule must be reachable, and the current data reaches none of them.** The eight `mockCustomers` scores (15, 35, 45, 60, 73, 85, 88, 92) touch no band boundary, and there is no temporal data at all. The generated set must include at least one customer firing each of the five rules, at least one firing none, at least one firing two simultaneously, and at least one **new customer** with fewer than 14 days of history
  - *Note the interaction:* `contract-expiration-risk` needs a score below 50, which the ±25 calibration above puts out of reach for the 85/88/92 customers. Assign that rule to one of the 15/35/45 customers. The two constraints are satisfiable together but not independently — the generator author should not have to discover this

## Requirements

### Part 1 — Health Score Calculator (`src/lib/healthCalculator.ts`)

#### Weighting and bands

Weights are fixed by the requirements. Declare them once, exported, **as integer percentages** — `FACTOR_WEIGHTS = { payment: 40, engagement: 30, contract: 20, support: 10 }` — and divide by 100 at the point of use. In IEEE-754, `0.40 + 0.30 + 0.20 + 0.10` evaluates to `0.9999999999999999`, so a fractional table cannot be asserted to sum to 1.0 without a tolerance, and the "missing weight exceeds 50" comparison below becomes float-fragile. Integer percentages make both checks exact.

| Factor | Weight | Rationale to carry in JSDoc |
|---|---|---|
| Payment | 40 | Money actually changing hands is the least ambiguous signal of account health — behavioral, not attitudinal |
| Engagement | 30 | Usage predicts renewal but is noisy; seasonality and role changes move it for benign reasons |
| Contract | 20 | Renewal proximity is a timing signal, not a health signal. It raises urgency more than it indicates sickness |
| Support | 10 | CSAT is low-volume and self-selected, so it is weighted for corroboration rather than as a driver |

The score is rounded to an integer before banding, and the same rounded value is used for display, so the number and the color can never disagree. Bands are then the requirements' own integer ranges, which after rounding cover every possible value with no gap:

| Rounded score | Risk level | Color |
|---|---|---|
| `0 … 30` | `critical` | Red |
| `31 … 70` | `warning` | Yellow |
| `71 … 100` | `healthy` | Green |

Implement as `score <= MAX_CRITICAL_SCORE` / `score <= MAX_WARNING_SCORE` / else, with `HEALTH_BAND_THRESHOLDS = { maxCritical: 30, maxWarning: 70 }` declared once. The keys are named `maxCritical`/`maxWarning` rather than `critical`/`warning` because they are the *upper bounds* of those bands, and the shorter names read as the opposite.

These bands match `CustomerCard`'s existing red/yellow/green banding, so the dashboard never shows two colors for one customer.

#### Factor scoring — concrete formulas

The requirements ask for "normalization strategies" without specifying any. These are the specified ones. Each factor function returns `0..100`, each is piecewise linear between named breakpoints, and every breakpoint is an exported named constant — no inline magic numbers.

**Every sub-signal is clamped to its stated output range before being combined.** This is not decoration: two of the mappings below are logarithmic and unbounded at both ends, and an unclamped `log10` mapping produces negative sub-scores for small inputs and over-100 sub-scores for large ones. Verified: with the account-size mapping unclamped, an ARR of \$500 yields −11.2 and \$1,000,000 yields +111.2.

**`scorePayment(payment: PaymentSignals, asOf: string): number`** — three sub-signals, combined 50/30/20:

- *Recency* (50%): `daysBetween(lastPaymentDate, asOf)` of 0–35 → 100, decaying linearly to 0 at 120 days. A monthly biller is healthy at 35 days; 120 days is a full quarter of silence
- *Punctuality* (30%): `averagePaymentDelayDays <= 0` → 100, decaying linearly to 0 at 45 days
- *Arrears* (20%): `overdueAmount === 0` → 100, decaying linearly to 0 at \$25,000. Absolute dollars rather than a percentage of ARR, because a ratio hides genuine risk on small accounts

**`scoreEngagement(history: DailySignals[], asOf: string): number`** — trailing 30 days, combined 50/30/20:

- *Login frequency* (50%): logins/day, `>= 1.0/day` → 100, linear to 0 at zero logins
- *Feature breadth* (30%): **distinct** feature keys in the window, `>= 8` → 100, linear to 0 at 0. Breadth only — see the depth disposition above
- *Ticket load* (20%): tickets opened in the window, `0` → 100, linear to 0 at 8. Support tickets appear here **and** in the support factor, deliberately: volume is an engagement-friction signal, satisfaction is a sentiment signal. The double-count is bounded at 6% of the final score (20% × 30%) and is documented rather than hidden

**`scoreContract(contract: ContractSignals, asOf: string): number`**

- *Renewal runway* (60%): let `d = daysBetween(asOf, renewalDate)`. `d >= 180` → 100; linear from 100 at 180 down to 20 at 0; `d < 0` (expired) → 0. The step from 20 to 0 at expiry is deliberate — an expired contract is a categorically different state, not the end of a ramp
- *Account size* (20%): `log10`-scaled ARR, \$1,000 → 0 and \$500,000 → 100, **clamped to 0..100**. Logarithmic because the difference between a \$1k and a \$10k account is real while \$400k vs \$500k is noise
- *Momentum* (20%): upgraded within 90 days → 100; 90–365 days → 60; never or over 365 days → 30. Never 0 — the absence of a recent upgrade is not evidence of ill health

**`scoreSupport(history: DailySignals[], asOf: string): number | null`** — all three sub-signals derived from the trailing 90 days. Returns `null` when the window contains **no `csatResponses` and no `resolutionHours`**, which routes the factor to the missing-data path below rather than inventing a value:

- *Satisfaction* (50%): mean CSAT over the window, mapped `(mean - 1) / 4 × 100`. If there are no responses but there is resolution data, this sub-signal is dropped and the remaining two re-normalize to 100
- *Resolution speed* (30%): mean `resolutionHours`, `<= 4h` → 100, linear to 0 at 72h
- *Escalations* (20%): `sum(supportTicketsEscalated)` over the window, `0` → 100, linear to 0 at 5

#### Missing data and new customers

The requirements ask for "edge case handling for new customers and missing data" without saying what the handling is. Specified:

- A factor whose inputs are absent is **excluded**, and the remaining weights are **re-normalized to sum to 100**. Substituting a neutral 50 would be worse: it silently invents evidence and drags every incomplete customer toward the warning band
- If the excluded weight **exceeds `MAX_MISSING_WEIGHT = 50`**, no score is returned. `calculateHealthScore` returns `{ status: 'insufficient-data', availableFactors, missingFactors }` instead of a number. A confident 62 computed from one factor is more harmful than an honest blank
- **New customers** — fewer than `MINIMUM_HISTORY_DAYS = 14` days of `history` — have **engagement excluded** (weight 30, under the 50 ceiling, so a score is still produced) and are marked `isProvisional: true`
- For customers *at or above* 14 days, engagement windows use `min(30, history.length)` days as a **rate**, never a raw total, so a 20-day-old account is not penalized for having had fewer days in which to log in

#### Trend

The calculator requirements ask for "trend analysis consideration for improving vs declining customers"; the alerts requirements ask for "login pattern analysis for gradual vs sudden engagement drops" and "support satisfaction trends". All three are served here rather than by a second subsystem.

`calculateHealthScore` accepts `priorScores?: Array<{ date: string; score: number }>` and returns:

```ts
trend: 'improving' | 'declining' | 'stable' | 'unknown';
trendDelta: number | null;   // points vs the oldest snapshot in the window, null when unknown
csatTrend: 'improving' | 'declining' | 'stable' | 'unknown';
```

- `trend` is the current score minus the score from the oldest snapshot within `TREND_WINDOW_DAYS = 30`. `> +5` → `improving`, `< -5` → `declining`, otherwise `stable`
- **`unknown` when fewer than two snapshots span at least 7 days.** A trend asserted from a single data point is fabrication
- `csatTrend` compares mean CSAT over the trailing 45 days against the preceding 45, `unknown` unless both windows hold at least two responses. This is what makes "support satisfaction trends" deliverable, and it is only possible because CSAT is stored per-day
- **Trend never affects the score.** It is a separate, additive output. Folding momentum into the score would double-count the factors that already moved and make the number unexplainable in the breakdown UI, which is the thing the requirements are most insistent about
- *Gradual vs sudden* engagement drops fall out of `engagement-cliff`'s non-overlapping windows: a sudden drop shows a large ratio gap while the 30-day baseline stays high, whereas a gradual decline moves both windows together, correctly does **not** fire the cliff rule, and surfaces as `trend: 'declining'` instead

**`priorScores` must actually reach the calculator.** Score history is owned by the Dashboard and threaded to both widgets — see Monitoring State. An earlier draft omitted the prop from `CustomerHealthDisplay` and parked score history inside `AlertsPanel`'s local reducer, which made `trend` permanently `unknown` in the running app: a specified feature that could never execute.

#### Purity and signatures

- Every function is pure: same inputs → same output, no `Date.now()`, no `Math.random()`, no I/O, no logging, no mutation of arguments
- **"Today" is always an explicit `asOf: string` parameter** defaulting to `SIGNAL_REFERENCE_DATE`. A calculator that reads the clock cannot be tested and will silently change behavior overnight
- Date arithmetic goes through one exported helper, `daysBetween(fromIso, toIso): number`, operating on `YYYY-MM-DD` at UTC midnight. No component or rule may do its own date math
- Return type:

```ts
export type RiskLevel = 'healthy' | 'warning' | 'critical';
export type Trend = 'improving' | 'declining' | 'stable' | 'unknown';

export interface FactorScore {
  factor: 'payment' | 'engagement' | 'contract' | 'support';
  score: number;         // 0..100, rounded
  weight: number;        // effective integer weight after re-normalization
  contribution: number;  // score * weight / 100, for the breakdown UI
  available: boolean;
}

export type HealthScoreResult =
  | {
      status: 'scored';
      score: number;
      riskLevel: RiskLevel;
      isProvisional: boolean;
      factors: FactorScore[];
      trend: Trend;
      trendDelta: number | null;
      csatTrend: Trend;
    }
  | { status: 'insufficient-data'; availableFactors: string[]; missingFactors: string[] };
```

A discriminated union, not `score: number | null`, so the "no score" case cannot be accidentally rendered as a number or fed into an alert threshold comparison.

#### Validation

- `HealthCalculationError extends Error` with a `field` property, thrown on structurally invalid input: non-finite numbers, negative counts, CSAT outside 1–5, `annualRecurringRevenue <= 0`, date strings that are not `YYYY-MM-DD`, `overdueSince` null while `overdueAmount > 0` (or vice versa), `history` not sorted ascending, duplicate dates in `history`
- **`annualRecurringRevenue <= 0` is rejected explicitly**, not merely discouraged: the account-size sub-score takes `log10(arr)`, and `log10(0)` is `-Infinity`, which would propagate to `NaN` through the weighted sum and render as a blank score with no error. A free-tier account must be modeled with a nominal positive ARR or excluded, not passed as 0
- Messages name the offending field and the received value: `"averagePaymentDelayDays must be a finite number, received NaN"`. Never include customer names, email addresses, or dollar amounts in error messages — those propagate into logs
- Absent optional data is **not** an error; it drives the missing-data path. Malformed present data **is** an error. Keeping these two distinct is the point of the validation layer

### Part 2 — Alerts Engine (`src/lib/alerts.ts`)

#### Rules

Five rules, exactly as the requirements list them, with the ambiguities resolved. Every threshold lives in `AlertRuleConfig`.

**High priority**

1. **`payment-risk`** — fires when `overdueAmount > 0 && daysBetween(overdueSince, asOf) > 30`, **or** the score is more than 20 points below the score recorded 7 days earlier.
   - *Resolved:* "payment overdue >30 days" means the *balance* has been outstanding 30 days, which is what `overdueSince` records. An earlier draft approximated this with `daysSinceLastPayment > 30`, which is a different question — a customer can pay on time monthly and still carry a disputed balance
   - The score-drop arm requires seeded score history; see Monitoring State
2. **`engagement-cliff`** — logins/day over the trailing 7 days is less than 50% of logins/day over the 30 days ending 7 days ago.
   - *Resolved:* the requirement names no recent window. It is the **trailing 7 days** against the **preceding, non-overlapping 30** — so the baseline is not diluted by the very drop it is meant to detect. Requires 37 days of history
   - *Guard:* suppressed unless the baseline is at least `config.minBaselineLoginsPerDay` (default `0.15`, i.e. 4.5 logins per 30 days). Without it, an account that logged in twice a month and now logs in once trips a "cliff" — the largest false-positive source in this rule
3. **`contract-expiration-risk`** — `daysBetween(asOf, renewalDate) < 90` and score `< 50`. **Expired contracts are included** (negative day counts satisfy `< 90`), with `urgencyWeight` clamped at 1.0.
   - *Reversed from an earlier draft*, which excluded expired contracts as "a different business event". That left the worst-off customer in the portfolio — lapsed contract, lowest score — generating **zero** alerts, with nothing else in the spec surfacing them. Literal fidelity to "expires in <90 days" is also the simpler reading
   - Requires `status: 'scored'`; an `insufficient-data` customer cannot satisfy "score < 50" and must not be treated as if it does

**Medium priority**

4. **`support-ticket-spike`** — more than 3 tickets opened in the trailing 7 days, **or** any escalated ticket in that window.
   - *Noted:* the escalation arm makes a single escalated ticket sufficient, which is noisy by the requirement's own design. Kept as specified; the 7-day cooldown is what makes it tolerable
5. **`feature-adoption-stall`** — no feature key appears in the trailing 30 days that was absent from the preceding 30, **and** the account is growing.
   - *Resolved:* "growing account" is undefined in the requirements. Defined as `lastUpgradeDate !== null && daysBetween(lastUpgradeDate, asOf) <= 180`, **or** distinct-feature count in days 31–60 exceeding that in days 61–90. Requires 90 days of history
   - The alert `detail` reports usage **depth** — mean touches per distinct feature over the trailing 30 days — as context, per the depth disposition above

#### Short history

Rules have different minimum history requirements, and a rule evaluated against too little data does not return `false`, it returns nothing:

```ts
export const MIN_HISTORY_DAYS_FOR_RULE = {
  'payment-risk': 0,               // payment fields are dated, not history-derived
  'engagement-cliff': 37,
  'contract-expiration-risk': 0,
  'support-ticket-spike': 7,
  'feature-adoption-stall': 90,
} as const;
```

A rule whose minimum is unmet is **skipped**, and the skip is recorded on the customer's evaluation result so the UI can say "not enough history to evaluate" rather than implying an all-clear. An earlier draft specified new-customer handling for the calculator but left the alerts engine silent, which would have divided by zero computing an engagement baseline over three days of data.

#### Configurable thresholds

The requirements ask for a "rule-based triggering system with **configurable** thresholds and conditions". Exported constants are compile-time, not configurable, so every threshold is gathered into an injectable object:

```ts
export interface AlertRuleConfig {
  paymentOverdueDays: number;         // 30
  scoreDropPoints: number;            // 20
  scoreDropWindowDays: number;        // 7
  engagementCliffRatio: number;       // 0.5
  minBaselineLoginsPerDay: number;    // 0.15
  contractExpiryDays: number;         // 90
  contractExpiryMaxScore: number;     // 50
  ticketSpikeCount: number;           // 3
  ticketSpikeWindowDays: number;      // 7
  adoptionStallWindowDays: number;    // 30
  growingAccountUpgradeDays: number;  // 180
  cooldownHours: { high: number; medium: number };   // 72 / 168
  dismissalSuppressHours: number;     // 336
}

export const DEFAULT_ALERT_RULE_CONFIG: AlertRuleConfig;
```

`alertEngine` takes `config: AlertRuleConfig = DEFAULT_ALERT_RULE_CONFIG`. This is what makes threshold variants comparable by hand; it is not an experiment framework.

#### Priority scoring

The requirements ask for "weighted factors (customer value, urgency, recency)". Specified as `0..100`:

```
priorityScore = round(
    40 * severityWeight   // high = 1.0, medium = 0.5
  + 30 * valueWeight      // log10-scaled ARR, $1k -> 0, $500k -> 1, CLAMPED to 0..1
  + 20 * urgencyWeight    // rule-specific, below, CLAMPED to 0..1
  + 10 * recencyWeight    // 1.0 if first triggered on asOf, decaying to 0 over 14 days
)
```

`urgencyWeight`: `payment-risk` 1.0, `contract-expiration-risk` `clamp(1 - daysBetween(asOf, renewalDate) / config.contractExpiryDays, 0, 1)` (so an expired contract is 1.0, not >1), `engagement-cliff` 0.8, `support-ticket-spike` 0.5, `feature-adoption-stall` 0.3.

Both `valueWeight` and `urgencyWeight` are **clamped**, for the same reason as the account-size sub-score: the ARR mapping is unbounded and a \$1M account would otherwise contribute more than its allotted 30 points.

Severity dominates by design, so a medium alert on a large account never outranks a high alert on a small one. "Workload balancing" is served by ordering *within* a severity tier, not across tiers — a queue that buries a critical small-account alert under enterprise noise is worse than no ordering at all.

#### Monitoring state — open alerts are not the same thing as cooldown

This is the correction that matters most. An earlier draft suppressed any rule that had fired within its cooldown, while the panel re-evaluated on every render — so each alert would appear once and then **vanish** on the next render, leaving a permanently empty panel that nonetheless claimed to show counts and support dismissal. The bug was conflating *"should this notify again"* with *"is this problem currently open"*.

They are now separate. `open` is the rendered list; cooldown only gates **transitions into** `open` and appends to `history`:

```ts
export interface AlertHistoryEntry {
  alertId: string;
  ruleId: AlertRuleId;
  customerId: string;
  openedAt: string;
  closedAt: string | null;
  outcome: 'resolved' | 'dismissed' | 'actioned' | null;
}

export interface MonitoringState {
  /** Currently-open alerts, the source of truth for what the panel renders. Key: `${customerId}:${ruleId}` */
  open: Record<string, Alert>;
  /** First time each (customer, rule) pair opened — backs the stable `Alert.id`. */
  firstTriggeredAt: Record<string, string>;
  /** Last time each pair *transitioned into* open — backs cooldown. */
  lastTriggeredAt: Record<string, string>;
  dismissed: Record<string, string>;
  acknowledged: Record<string, string>;
  actioned: Record<string, string>;
  /** One snapshot per date, retained TREND_WINDOW_DAYS by date — not by entry count. */
  scoreHistory: Record<string, Array<{ date: string; score: number }>>;
  history: AlertHistoryEntry[];
}

export interface CustomerEvaluationInput {
  customer: Customer;
  signals: CustomerSignals;
  health: HealthScoreResult;
}

export function alertEngine(
  inputs: CustomerEvaluationInput[],
  state: MonitoringState,
  asOf?: string,
  config?: AlertRuleConfig,
): { alerts: Alert[]; state: MonitoringState; skipped: Array<{ customerId: string; ruleId: AlertRuleId }> };
```

- **`alertEngine` takes pre-computed inputs**, never customer IDs. An earlier draft's signature omitted `signals` and `health`, which would have forced `src/lib/alerts.ts` to import `src/data/mock-customer-signals.ts` — hard-wiring the library to mock data and contradicting the instruction to treat that data as untrusted input from a source that will later be replaced. `src/lib` imports nothing from `src/data`
- **State transitions.** A rule that is true and not currently open **opens** it, subject to cooldown and dismissal. A rule that is true and already open **stays** open with its original `id` and `firstTriggeredAt`, and cooldown is not consulted. A rule that is false **closes** it, appending an `AlertHistoryEntry` with `outcome: 'resolved'`
- **Cooldown**: `cooldownHours = { high: 72, medium: 168 }`, applied only to the closed → open transition. A problem that resolves and immediately recurs does not re-alert within the window; a problem that never resolved never disappears from the panel
- **Dedup** is per `(customerId, ruleId)`: one open alert per rule per customer, never two. It is *not* per customer — a payment problem and an engagement cliff are two distinct problems and get two alerts. The UI groups them by customer; the engine does not merge them
- **Dismissal** closes the alert and suppresses re-opening for `dismissalSuppressHours = 336` (14 days), then allows it back. A dismissed-forever alert is a silent failure
- **Score history** is seeded at startup by `buildScoreHistory` and thereafter holds **one snapshot per date**, retained by date window. An earlier draft capped at "30 entries" while appending on every evaluation, so all thirty slots filled with same-day duplicates: the 7-day-prior score never existed, which silently disabled both the `trend` output and the score-drop arm of `payment-risk`. Keying by date makes duplicate appends idempotent
- If no snapshot exists within 5–9 days of `asOf`, the score-drop arm is **skipped rather than assumed false**, and `Alert.notes` records that the comparison was unavailable. Inferring "no drop" from missing history is how a monitoring system goes quietly blind
- **Business hours** ("business hours consideration for alert delivery timing"): nothing is delivered — no email, no push, no channel — so this is a pure predicate `isWithinBusinessHours(iso: string, timeZone: string): boolean` (Mon–Fri, 09:00–17:00), with `BUSINESS_TIME_ZONE = 'UTC'` as the default and `Intl.DateTimeFormat` used with an explicit `timeZone`. **The timezone is a parameter, not the host's locale.** An earlier draft said "viewer-local", which would have made `Alert.withinBusinessHours` — and therefore alert equality — depend on the machine running the test. It never suppresses an alert: hiding a critical alert from a dashboard someone is actively looking at because it is 6pm would be a defect, not a feature

#### Action tracking

The requirements ask for an "alert dismissal and action tracking interface" and "action completion rates". Dismissal alone does not cover it, so `MonitoringState` carries `acknowledged` and `actioned`, and `AlertsPanel` offers three controls per alert — Acknowledge, Mark actioned, Dismiss. The header shows `actioned / opened` for the session, labeled as session-only. `AlertHistoryEntry.outcome` records which of the three closed each alert.

#### Alert shape

```ts
export interface Alert {
  id: string;                 // `${customerId}:${ruleId}:${firstTriggeredAt}` — from state, stable while open
  ruleId: AlertRuleId;
  customerId: string;
  priority: 'high' | 'medium';
  priorityScore: number;      // 0..100
  title: string;              // e.g. "Balance outstanding 47 days"
  detail: string;             // the triggering comparison, in numbers
  recommendedAction: string;  // one imperative sentence
  firstTriggeredAt: string;   // ISO — when this pair first opened
  triggeredAt: string;        // ISO — most recent transition into open
  withinBusinessHours: boolean;
  notes?: string[];           // e.g. "7-day score comparison unavailable"
}
```

`id` derives from `state.firstTriggeredAt`, which is why that field exists. An earlier draft built `id` from a `firstTriggeredDate` that `AlertState` never stored, so the "stable across re-evaluation" guarantee had nothing behind it.

#### Validation

`AlertEvaluationError extends Error` with a `field` property, thrown on a malformed `MonitoringState` or `AlertRuleConfig` — non-finite thresholds, negative windows, ratios outside `0..1`, `open` entries whose keys disagree with their `Alert.customerId`/`ruleId`. The alerts engine gets its own error class rather than borrowing `HealthCalculationError`, which would be a naming lie in a stack trace.

### Part 3 — UI Components

#### Monitoring state ownership

`src/app/page.tsx` owns both the selected customer and the single `MonitoringState`, via `useReducer`, and threads slices to both widgets. Neither widget owns monitoring state, because `scoreHistory` is written during alert evaluation and read by the health display — an earlier draft put it inside `AlertsPanel`, out of reach of its other consumer.

#### `CustomerHealthDisplay` (`src/components/CustomerHealthDisplay.tsx`)

- Props: `{ customer: Customer; signals?: CustomerSignals; priorScores?: Array<{ date: string; score: number }>; asOf?: string }`. No data fetching and no `useEffect`-driven loading — the data is a synchronous module import
- Displays the score large, with the band color **and a visible band label** (`Healthy` / `Warning` / `Critical`). Color is never the only signal
- Expandable breakdown listing all four factors with sub-score, effective weight, and contribution. Collapsed by default. This is where the algorithm becomes explainable to a stakeholder, so it shows the arithmetic, not just the outcome
- Trend indicator beside the score — an arrow **plus a text label** and the point delta. `unknown` renders nothing rather than a flat arrow, which would read as "stable". CSAT trend appears in the breakdown beside the support factor
- **`insufficient-data`** renders "Not enough data to score" plus the missing factors — never a number, never a band color
- **`isProvisional`** renders the score with a "Provisional — limited history" qualifier naming the excluded factor
- There is no loading state to have, since the data is synchronous; keep the skeleton markup for shape but render it only if a future async source appears. An error boundary catches `HealthCalculationError` and renders an error banner without taking down the dashboard
- Card shell matches `CustomerCard` if it exists when this is implemented; otherwise `rounded-lg border border-gray-200 bg-white p-4 shadow-sm` with heading `text-lg font-semibold text-gray-900 mb-3`. Do not claim conformance to a pattern you did not open and read

#### `AlertsPanel` (`src/components/AlertsPanel.tsx`)

- Renders `state.open` across all customers, sorted by `priority` then `priorityScore` descending
- Priority visualization uses red (high) and yellow (medium), each with a text label. **Green is not used** — a green alert is a contradiction. The requirements' "red/yellow/green" is honored as red/yellow plus a plain, uncolored "No active alerts" empty state
- Each row expands to a detail panel: the triggering numbers, the recommended action, the customer, usage depth where relevant, and any `notes`
- Acknowledge / Mark actioned / Dismiss per alert, dispatching to the Dashboard reducer. All three are session-lifetime only and the panel says so
- Rules skipped for insufficient history are listed separately as "not evaluated — needs N days of history", never folded into the all-clear
- Header shows counts by priority plus `actioned / opened` for the session
- Historical view lists `state.history` with a visible "this session only" caveat
- "Copy as CSV" writes the current alert list to the clipboard, honoring the same redaction rules as the on-screen text

### Integration

- The Dashboard owns selection and `MonitoringState`; both widgets are driven by props and re-derive on change
- `CustomerHealthDisplay` shows the selected customer. `AlertsPanel` shows **all** customers regardless of selection — a panel scoped to the current selection cannot tell you where to look next. Clicking an alert selects that customer
- Import `Customer` from `@/data/mock-customers` via the configured `@/*` alias
- Band colors are shared with `CustomerCard` through the exported threshold constants, not duplicated. If `CustomerCard` hardcodes its own thresholds when this is implemented, refactor it to import them — two sources of truth for one band will drift

## Constraints

### Technical stack

- Next.js 15.5 (App Router), React 19.1, TypeScript 5 with `strict: true`, Tailwind CSS v4
- **No new runtime dependencies.** Vitest and `@vitest/coverage-v8` as devDependencies only
- `src/lib/*` is framework-free and imports nothing from `src/data/*`: no React, no `next/*`, no DOM. It must run in a plain Node test process
- Server Components by default. `'use client'` on `src/app/page.tsx` (it holds the reducer), `AlertsPanel`, and `CustomerHealthDisplay`

### Code quality

- Named exports throughout; no default exports
- No `any`, no non-null assertions on signal data, and no type assertions used to paper over the discriminated union
- JSDoc on every scoring function stating the business rationale and the formula, and on the weight and threshold blocks. The "explainable algorithm decisions" obligation is discharged here and in the breakdown UI
- Every threshold, weight, and breakpoint is a named constant or an `AlertRuleConfig` field, defined once. A magic number inside a scoring function is a defect
- Descriptive identifiers; no abbreviations such as `calc`, `cust`, or `hs`

### Performance

- Single-date evaluation is `O(customers × windowDays)` with one pass per customer per window. No nested scans over `history`, and window aggregates are computed once and shared between the calculator and the engine
- Two separate budgets, asserted in tests, because seeding and evaluation have different shapes:
  - **Evaluation:** 500 customers × 90 days at one `asOf` in **under 50ms**
  - **Seeding:** `buildScoreHistory` for 500 customers × 30 snapshots in **under 300ms**. This is the expensive path — 30 calculator runs per customer — and it runs once at startup, not per render
- Memoize per-customer results at the widget boundary with `useMemo` keyed on `(customerId, asOf)`. Do not memoize inside `src/lib` — a cache inside a pure function is no longer a pure function

### Security

- Validate all signal data at the `src/lib` boundary before use. Treat mock data as untrusted input so the validation is already real when a live source replaces it
- `Alert.title` and `Alert.detail` contain **no email addresses, no exact dollar amounts, and no customer names** — they reference `customerId` and let the UI join to the display name. Alert strings are the most likely part of this feature to end up in a log or a screenshot
- All strings rendered as JSX text content; never `dangerouslySetInnerHTML`
- No customer data in `console` calls anywhere in the feature
- **Stated plainly: a client-side rules engine is not a security boundary.** Every customer's signals are already in the browser bundle. "No sensitive customer data exposure in alert messages" is honored as data hygiene and log safety, not as access control. When a real backend arrives, rule evaluation moves server-side; do not present this implementation as having solved authorization

### File structure

```
src/lib/healthCalculator.ts
src/lib/healthCalculator.test.ts
src/lib/alerts.ts
src/lib/alerts.test.ts
src/data/mock-customer-signals.ts
src/data/health-fixtures.ts
src/components/CustomerHealthDisplay.tsx
src/components/AlertsPanel.tsx
```

`src/lib/` and `src/components/` do not exist yet. PascalCase components, camelCase functions, `SCREAMING_SNAKE_CASE` constants.

### Required test fixtures (`src/data/health-fixtures.ts`)

`mockCustomers` plus generated signals are for the demo; these are for verification. Reuse the exported interfaces so fixtures cannot drift from the types.

- **Band boundaries:** factor inputs engineered to produce final scores of `0`, `30`, `31`, `70`, `71`, `100`
- **Rounding:** inputs producing raw `30.4`, `30.5`, `70.5`, so rounding-then-banding is pinned
- **Sub-signal range:** ARR of `$500`, `$1,000`, `$500,000`, and `$1,000,000`, asserting the account-size sub-score stays within `0..100` at all four. Verified unclamped values are `-11.2`, `0`, `100`, `111.2`, so this fixture fails loudly if a clamp is dropped
  - Note there is deliberately **no** "weighted sum outside 0..100" fixture. With every factor clamped to `0..100` and non-negative weights summing to 100, the weighted mean is provably inside `0..100`, so such a fixture cannot be constructed. An earlier draft required one — it was unsatisfiable except via the missing clamp, i.e. the criterion was only passable because of a bug. The final clamp remains as a defensive assertion and is tested by calling the clamp helper directly
- **Per-factor extremes:** best- and worst-case inputs for each factor independently, so a sign error in one cannot hide behind the other three
- **Missing data:** one factor absent (re-normalization); two absent totaling exactly `50`, i.e. engagement + contract (boundary — still scored); three absent (`insufficient-data`)
- **Support absence:** a 90-day window with no `csatResponses` and no `resolutionHours` (support factor `null`); and one with resolution data but no CSAT (sub-signal re-normalization inside the factor)
- **New customer:** 3 days and 13 days of history (provisional, engagement excluded), 14 days (not provisional)
- **Engagement rate:** a 14-day and a 30-day customer with identical logins/day, expected to score identically. Fourteen, not ten — below `MINIMUM_HISTORY_DAYS` engagement is excluded outright, so a 10-day customer has no engagement score to compare and the earlier draft's version of this fixture was unsatisfiable
- **Invalid input:** `NaN`, `Infinity`, negative counts, CSAT of `0` and `6`, **ARR of `0` and `-1`**, `overdueAmount > 0` with `overdueSince: null`, unsorted `history`, duplicate `history` dates, malformed `date` — each expected to throw naming the field
- **Per-rule alert fixtures:** for each of the five rules, one customer that fires it, one that misses it by a single unit on each threshold in the rule, and one that would fire but is suppressed by cooldown or dismissal
- **Engagement-cliff guard:** a low-baseline customer (3 logins per 30 days, i.e. 0.1/day against a 0.15 floor) whose logins halve, expected **not** to fire
- **Short history per rule:** 36 days (cliff skipped), 37 (evaluated), 89 (stall skipped), 90 (evaluated)
- **Expired contract:** `renewalDate` 30 days in the past with score `< 50`, expected to fire `contract-expiration-risk` with `urgencyWeight` exactly 1.0
- **Open-alert lifecycle:** a rule true across three consecutive evaluations, expected to remain in `open` with one unchanged `id` throughout and exactly one `history` entry on close
- **Missing score history:** no snapshot in the 5–9 day window, expected to skip the score-drop arm and record a note

### Out of scope

- Any server, database, API route, or persistence beyond session memory
- Real payment, CRM, analytics, or support-desk integration
- Notification delivery of any kind — email, Slack, push, webhook
- Cross-session or cross-user alert state
- Alert effectiveness tracking against real outcomes, and the A/B testing framework — both need production data this repository will never have
- Payment behavior *change* detection, which needs a per-invoice event series the data shape omits
- Modifying the `Customer` interface or `mockCustomers`
- Domain health checking (owned by the domain health widget) and market sentiment (owned by the market intelligence widget)

## Acceptance Criteria

### Automated — must pass

- [ ] `npm run type-check` passes with no errors
- [ ] `npm run lint` passes with no errors or warnings
- [ ] `npm run test` passes, and `src/lib/healthCalculator.ts` and `src/lib/alerts.ts` reach **100% branch coverage** — pure logic with no untestable paths, so anything less means an untested threshold
- [ ] Integer factor weights sum to exactly `100` (exact equality, no tolerance — this is why they are integers)
- [ ] Scores `0` and `30` band `critical`; `31` and `70` band `warning`; `71` and `100` band `healthy`
- [ ] Raw scores `30.4`, `30.5`, `70.5` round to `30`, `31`, `71` and land in exactly one band, matching the displayed number
- [ ] The account-size sub-score is within `0..100` for ARR of `$500`, `$1k`, `$500k`, and `$1M`; `valueWeight` and `urgencyWeight` are within `0..1` at the same extremes
- [ ] `annualRecurringRevenue` of `0` and `-1` throw `HealthCalculationError`, and no code path can produce `NaN` or `±Infinity` as a score
- [ ] Each factor's best-case inputs score 100 and worst-case score 0, tested per factor
- [ ] Every hand-computed fixture matches the implementation to the integer — the mathematical-accuracy requirement
- [ ] One missing factor re-normalizes remaining weights to `100`; missing weight of exactly `50` still scores; more than `50` returns `insufficient-data`
- [ ] `scoreSupport` returns `null` for a window with no CSAT and no resolution data, and re-normalizes its sub-signals when CSAT alone is absent
- [ ] A 13-day history returns `isProvisional: true`; 14 days returns `false`
- [ ] A 14-day and a 30-day customer with identical logins/day score engagement identically
- [ ] `trend` and `csatTrend` return each of their four values on the correct fixtures, and `unknown` whenever the window lacks two qualifying data points
- [ ] `buildScoreHistory` yields one snapshot per date with no duplicates, and appending the same date twice is idempotent
- [ ] A seeded 30-day score history makes a 7-day-prior score available, and the `payment-risk` score-drop arm fires on a >20-point drop
- [ ] Missing 7-day score history skips the score-drop arm and records a note, rather than treating it as no drop
- [ ] Every invalid-input fixture throws with the offending field named, and no message contains a customer name, email address, or dollar amount
- [ ] `AlertEvaluationError` is thrown for a malformed `MonitoringState` or `AlertRuleConfig`, and `HealthCalculationError` is never thrown from `alerts.ts`
- [ ] Each of the five rules fires on its positive fixture and not on its off-by-one fixture
- [ ] `engagement-cliff` does not fire on the low-baseline fixture
- [ ] Rules are skipped, and reported in `skipped`, at 36 days (cliff) and 89 days (stall); evaluated at 37 and 90
- [ ] An expired contract with score `< 50` fires `contract-expiration-risk` with `urgencyWeight` exactly `1.0`
- [ ] **A rule true across three consecutive evaluations stays in `state.open` throughout, with an unchanged `id`, and is never suppressed by cooldown while open**
- [ ] Cooldown blocks only the closed → open transition: a rule that resolves and recurs within the window does not re-open; after the window it does
- [ ] A dismissed alert closes, is suppressed for 336 hours, and re-opens afterward
- [ ] Closing an alert appends exactly one `AlertHistoryEntry` with the correct `outcome`
- [ ] `alertEngine` does not mutate its `state`, `inputs`, or `config` arguments, asserted by deep-freezing them
- [ ] A customer firing two rules yields two alerts with distinct, stable `id`s; re-evaluating with the same inputs yields identical `id`s
- [ ] High-priority alerts sort above every medium-priority alert regardless of ARR
- [ ] `isWithinBusinessHours` returns identical results for a given `(iso, timeZone)` pair regardless of the host timezone, verified by running the suite under at least two `TZ` values
- [ ] Passing a different `asOf` moves payment recency, contract runway, and engagement **together and consistently** — no quantity is frozen while others advance
- [ ] Calling the calculator twice with the same inputs returns identical results, and no file in `src/lib` references `Date.now`, `new Date()` without an argument, or `Math.random` — asserted by a source-level test
- [ ] No file in `src/lib` imports from `react`, `next`, or `src/data` — asserted by a source-level test
- [ ] A non-default `AlertRuleConfig` changes which alerts fire, proving thresholds are genuinely injected rather than read from module constants
- [ ] Evaluation budget: 500 customers × 90 days at one `asOf` under 50ms. Seeding budget: 500 customers × 30 snapshots under 300ms

### Manual — verified by rendering the dashboard and inspecting

- [ ] Health score renders with the correct band color and a visible band label
- [ ] Breakdown shows all four factors with sub-score, weight, and contribution, and the contributions sum to the displayed score
- [ ] `insufficient-data` renders the explanatory state with no number and no band color
- [ ] The provisional state is visibly labeled and names the excluded factor
- [ ] **The trend indicator shows a real value, not `unknown`, on first load** — the seeded score history makes this observable rather than theoretical
- [ ] CSAT trend appears beside the support factor in the breakdown
- [ ] The widget updates when the selected customer changes
- [ ] `AlertsPanel` shows all customers' alerts, not just the selected customer's; clicking an alert selects that customer
- [ ] **Alerts stay visible across re-renders and selection changes** — switch customers repeatedly and confirm the panel does not empty itself
- [ ] High alerts are red and medium yellow, each with a text label; no green is used for any alert
- [ ] The empty state reads "No active alerts" with no colored row
- [ ] Rules skipped for short history are listed separately and not presented as an all-clear
- [ ] Acknowledge, Mark actioned, and Dismiss each work; the header's `actioned / opened` count updates
- [ ] Dismissing an alert removes it and it does not return on re-render
- [ ] Session-only caveats appear on the action, dismissal, and history views
- [ ] "Copy as CSV" places the current alert list on the clipboard with the same redactions as the on-screen text
- [ ] `healthCalculator.ts` ends with a "Calibration notes" section naming which constants are guesses and what would falsify them
- [ ] Two dashboard reloads produce identical scores and identical alerts — determinism is visible, not merely tested
- [ ] Each of the five rules is observably fired by at least one customer in `mockCustomers`, and at least one customer shows no alerts
- [ ] No alert text contains an email address, a customer name, or an exact dollar figure
- [ ] Layout is readable and structurally intact at 320px, 768px, and 1024px
- [ ] No `dangerouslySetInnerHTML` and no customer data in any `console` call across the feature
- [ ] No console errors or warnings when rendering all of `mockCustomers` plus the full fixture set
