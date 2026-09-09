# Feature: CustomerHealthMonitoring

## Context

- Combined health scoring and predictive alerting capability for the Customer Intelligence Dashboard, specified from `requirements/health-score-calculator.md` and `requirements/predictive-alerts.md`
- Two requirements documents, one feature: the alerts engine cannot be built without the calculator, because three of its five rules are expressed in terms of a health score. They are specified together so the seam between them is designed once rather than negotiated twice
- Serves customer success managers who need to know **which** accounts are at risk (score) and **why, right now** (alerts), in time to act
- Five layers, built in order: a mock signal-history data module, a pure health calculator (`src/lib/healthCalculator.ts`), a pure alerts engine (`src/lib/alerts.ts`), a `CustomerHealthDisplay` widget, and an `AlertsPanel` widget. The Dashboard owns customer selection and passes the selected customer down
- All data is **mock and locally generated**. There is no backend, no database, no scheduler, and no external payment/support/analytics integration in this repository, so nothing here is genuinely "real-time" and the UI must not claim otherwise

## Prerequisites and Repository Reality

**Both requirements documents describe a system considerably larger than this repository.** At the time of writing, the repo is a bare Next.js 15.5 App Router app: `src/` contains only `app/{layout,page,globals.css}` and `data/{mock-customers,mock-market-intelligence}.ts`. There is no `src/components/`, no `src/lib/`, no `src/services/`, no API route, **no test runner, and no state persistence of any kind**.

Concretely, the following requirement lines have no substrate to land on and are handled as noted:

| Requirement text | Source | Disposition |
|---|---|---|
| "Real-time monitoring of customer health score changes" | alerts | Reframed: scores and alerts are **derived on render** from the in-memory signal history. No polling, no subscription |
| "Efficient rule evaluation … for hundreds of customers" | alerts | Honored as an algorithmic constraint (see Performance), not as infrastructure |
| "Alert state synchronization across multiple dashboard sessions" | alerts | **Out of scope** — requires a server and a shared store, neither of which exists |
| "External data source integration (payment, engagement, support)" | alerts | **Out of scope** — replaced by the mock signal module below |
| "Rate limiting on alert generation to prevent system abuse" | alerts | **Out of scope as a security control** — there is no server endpoint to abuse. The cooldown logic below covers the real concern, which is alert fatigue |
| "Audit trail logging for all triggered alerts and user actions" | alerts | Reduced to an in-memory, session-lifetime `AlertHistoryEntry[]`. Not durable, not an audit trail in the compliance sense, and must not be described as one |
| "A/B testing framework for rule optimization" | both | **Out of scope.** Thresholds are exported named constants so they *can* be varied; no experiment framework is built |
| "Caching considerations for repeated calculations" | calculator | Honored as memoization at the widget boundary only (see Performance) |
| "Export capabilities for alert data and historical analysis" | alerts | **In scope, minimally**: a "Copy as CSV" control on `AlertsPanel` writing the current alert list to the clipboard. No file download, no server round-trip |
| "Alert effectiveness tracking (correlation with actual customer outcomes)" | alerts | **Out of scope** — requires real outcomes (renewed vs churned) that no mock dataset can supply. Fabricating a correlation would be worse than omitting it |
| "Alert fatigue monitoring and optimization recommendations" | alerts | Reduced to a displayed per-customer alert count over the session and the cooldown mechanism. No recommendation engine |
| "Monitoring and calibration recommendations for production deployment" | calculator | Discharged as a **documentation deliverable**: a "Calibration notes" section at the end of `src/lib/healthCalculator.ts` listing which constants are guesses, what would falsify them, and what to measure first. Not code |
| "Business assumption documentation and validation" | calculator | Discharged by the per-factor JSDoc rationale plus the breakdown UI. The assumptions are named in this spec's factor tables and must be restated at the code |
| "System performance metrics and resource usage analytics" | alerts | **Out of scope** — no telemetry sink exists. Covered instead by the performance test budget below |
| "AI collaboration requirements" (both docs, whole sections) | both | Not product requirements. These describe how the workshop exercise is *conducted*, not what the software does, and generate no acceptance criteria |

Do not implement a stub for an out-of-scope item, and do not describe an in-memory array as an audit trail.

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

Create `src/data/mock-customer-signals.ts` exporting the following. `Customer` itself is **not modified** — the existing `healthScore` field stays where it is and is reinterpreted below.

```ts
/** One day's observed signals for one customer. Newest last. */
export interface DailySignals {
  date: string;                    // ISO date, YYYY-MM-DD, one entry per day, no gaps
  logins: number;                  // >= 0
  featuresUsed: string[];          // feature keys touched that day
  supportTicketsOpened: number;    // >= 0
  supportTicketsEscalated: number; // >= 0, <= supportTicketsOpened
}

export interface PaymentSignals {
  daysSinceLastPayment: number;      // >= 0
  averagePaymentDelayDays: number;   // may be negative (pays early)
  overdueAmount: number;             // >= 0, USD
}

export interface ContractSignals {
  daysUntilRenewal: number;          // may be negative (already expired)
  annualRecurringRevenue: number;    // USD; the ARR the alerts doc assumes exists
  upgradedWithinDays: number | null; // days since last upgrade, null if never
}

export interface SupportSignals {
  averageResolutionHours: number;    // >= 0
  satisfactionScore: number;         // 1..5 CSAT
  escalationsLast90Days: number;     // >= 0
}

export interface CustomerSignals {
  customerId: string;                // matches Customer.id
  payment: PaymentSignals;
  contract: ContractSignals;
  support: SupportSignals;
  history: DailySignals[];           // >= 60 days where available; shorter for new customers
}

export const SIGNAL_REFERENCE_DATE = '2026-09-09';
export const mockCustomerSignals: CustomerSignals[];
export function getSignalsForCustomer(customerId: string): CustomerSignals | undefined;
```

Constraints on the mock data itself — it is a deliverable, not filler:

- **Deterministic.** No `Math.random()` at module scope or at call time. Generate from a seeded PRNG keyed by an FNV-1a hash of `customerId`, so the same customer always produces the same history, the same score, and the same alerts. A demo that changes on refresh is not demonstrable, and a test cannot assert on it
- **Dates are relative to a fixed reference date, not `Date.now()`.** History is generated backwards from `SIGNAL_REFERENCE_DATE`, and every function that needs "today" takes an `asOf: string` parameter defaulting to that constant
- **`healthScore` on `Customer` is reinterpreted** as the *previously recorded* score — the baseline that the "dropped >20 points in 7 days" rule compares against. It is no longer displayed as the live score; the calculator's output is. Signals must be generated so the computed score lands within ±25 of the stored `healthScore` for most customers, so the two are not visibly absurd side by side
- **Every rule must be reachable, and the current data reaches none of them.** The eight `mockCustomers` scores (15, 35, 45, 60, 73, 85, 88, 92) touch no band boundary, and there is no temporal data at all. The generated signal set must include at least one customer that fires each of the five rules, at least one that fires none, at least one that fires two simultaneously, and at least one **new customer** with fewer than 14 days of history

## Requirements

### Part 1 — Health Score Calculator (`src/lib/healthCalculator.ts`)

#### Weighting and bands

Weights are fixed by the requirements. Declare them once, exported, **as integer percentages** — `FACTOR_WEIGHTS = { payment: 40, engagement: 30, contract: 20, support: 10 }` — and divide by 100 at the point of use. In IEEE-754, `0.40 + 0.30 + 0.20 + 0.10` evaluates to `0.9999999999999999`, so a fractional-weight table cannot be asserted to sum to 1.0 without a tolerance, and the re-normalization "excluded weight exceeds 0.50" comparison below becomes float-fragile. Integer percentages make both checks exact.

| Factor | Weight | Rationale to carry in JSDoc |
|---|---|---|
| Payment | 40 | Money actually changing hands is the least ambiguous signal of account health — behavioral, not attitudinal |
| Engagement | 30 | Usage predicts renewal but is noisy; seasonality and role changes move it for benign reasons |
| Contract | 20 | Renewal proximity is a timing signal, not a health signal. It raises urgency more than it indicates sickness |
| Support | 10 | CSAT is low-volume and self-selected, so it is weighted for corroboration rather than as a driver |

Final score is `round(Σ factorScore × weight)`, clamped to `[0, 100]`. Bands match the existing `CustomerCard` red/yellow/green banding exactly, so the dashboard never shows two colors for one customer:

| Condition | Risk level | Color |
|---|---|---|
| `0 <= score <= 30` | `critical` | Red |
| `30 < score <= 70` | `warning` | Yellow |
| `70 < score <= 100` | `healthy` | Green |

The requirements write these as `71-100 / 31-70 / 0-30`, which leaves fractional values between 30 and 31 unbanded. Bands are therefore implemented as the **open-ended comparisons above**, with `HEALTH_BAND_THRESHOLDS = { critical: 30, warning: 70 }` declared once and referenced everywhere. Round before banding and use the same rounded value for display, so the number and the color can never disagree.

#### Factor scoring — concrete formulas

The requirements ask for "normalization strategies" without specifying any. These are the specified ones. Each returns `0..100`, each is piecewise linear between named breakpoints, and every breakpoint is an exported named constant — no inline magic numbers.

**`scorePayment(signals: PaymentSignals): number`** — three sub-signals, combined 50/30/20:

- *Recency* (50%): `daysSinceLastPayment` of 0–35 → 100, decaying linearly to 0 at 120 days. A monthly biller is healthy at 35 days; 120 days is a full quarter of silence
- *Punctuality* (30%): average delay `<= 0` → 100, decaying linearly to 0 at 45 days
- *Arrears* (20%): `overdueAmount == 0` → 100, decaying linearly to 0 at $25,000. Absolute dollars rather than a percentage of ARR, because a ratio hides genuine risk on small accounts

**`scoreEngagement(signals: CustomerSignals, asOf: string): number`** — computed over the trailing 30 days, combined 50/30/20:

- *Login frequency* (50%): logins/day, `>= 1.0/day` → 100, linear to 0 at zero logins
- *Feature breadth* (30%): distinct features used in the window, `>= 8` → 100, linear to 0 at 0
- *Ticket load* (20%): tickets opened in the window, `0` → 100, linear to 0 at 8. Support tickets appear here **and** in the support factor, deliberately: volume is an engagement-friction signal, satisfaction is a sentiment signal. The double-count is bounded at 6% of the final score (20% × 30%) and is documented rather than hidden

**`scoreContract(signals: ContractSignals): number`**

- *Renewal runway* (60%): `daysUntilRenewal >= 180` → 100; linear from 100 at 180 days down to 20 at 0 days; already expired (`< 0`) → 0. The step from 20 to 0 at expiry is deliberate — an expired contract is a categorically different state, not the end of a ramp
- *Account size* (20%): `log10`-scaled ARR, $1,000 → 0 and $500,000 → 100. Logarithmic because the health difference between a $1k and a $10k account is real while $400k vs $500k is noise
- *Momentum* (20%): upgraded within 90 days → 100; 90–365 days → 60; never or over 365 days → 30. Never 0 — the absence of a recent upgrade is not evidence of ill health

**`scoreSupport(signals: SupportSignals): number`**

- *Satisfaction* (50%): CSAT 1–5 mapped linearly to 0–100, `(csat - 1) / 4 × 100`
- *Resolution speed* (30%): `<= 4h` → 100, linear to 0 at 72h
- *Escalations* (20%): `0` → 100, linear to 0 at 5 escalations in 90 days

#### Missing data and new customers

The requirements ask for "edge case handling for new customers and missing data" without saying what the handling is. Specified:

- A factor whose inputs are absent is **excluded**, and the remaining weights are **re-normalized to sum to 100**. Substituting a neutral 50 would be worse: it silently invents evidence and drags every incomplete customer toward the warning band
- If the excluded weight **exceeds `MAX_MISSING_WEIGHT = 50`**, no score is returned. `calculateHealthScore` returns `{ status: 'insufficient-data', availableFactors, missingFactors }` instead of a number. A confident 62 computed from one factor is more harmful than an honest blank
- **New customers** — fewer than `MINIMUM_HISTORY_DAYS = 14` days of `history` — are scored on payment, contract, and support only, with engagement excluded by the rule above. Engagement is weight 30, so this stays under the 50 ceiling and a score is still produced. The result carries `isProvisional: true` and the widget labels it
- Engagement windows are computed over `min(30, history.length)` days as a **rate**, never a raw total, so a 10-day-old account is not penalized for having had fewer days in which to log in

#### Trend

The calculator requirements ask for "trend analysis consideration for improving vs declining customers", and the alerts requirements ask for "login pattern analysis for gradual vs sudden engagement drops". Both are served by one addition rather than a second subsystem, because the raw material — score snapshots and a daily login series — already exists.

`calculateHealthScore` accepts an optional `priorScores?: Array<{ date: string; score: number }>` and returns:

```ts
trend: 'improving' | 'declining' | 'stable' | 'unknown';
trendDelta: number | null;  // points changed vs the oldest snapshot in the window, null when unknown
```

- Computed as the current score minus the score from the oldest snapshot within `TREND_WINDOW_DAYS = 30`. `> +5` → `improving`, `< -5` → `declining`, otherwise `stable`
- **`unknown` when fewer than two snapshots span at least 7 days.** Every customer is `unknown` on first render, and that is correct — a trend asserted from a single data point is fabrication
- **Trend never affects the score.** It is a separate, additive output. Folding momentum into the score would double-count the factors that already moved and make the number unexplainable in the breakdown UI, which is the one thing the requirements are most insistent about
- *Gradual vs sudden* engagement drops fall out of the `engagement-cliff` rule's non-overlapping 7-day-vs-preceding-30-day windows: a sudden drop shows a large ratio gap while the 30-day baseline stays high, whereas a gradual decline moves both windows together and correctly does **not** fire the cliff rule — it surfaces as `trend: 'declining'` instead. This distinction is the reason the windows do not overlap

#### Purity and signatures

- Every function is pure: same inputs → same output, no `Date.now()`, no `Math.random()`, no I/O, no logging, no mutation of arguments
- **"Today" is always an explicit `asOf: string` parameter** defaulting to `SIGNAL_REFERENCE_DATE`. This is the single most important purity constraint here — a calculator that reads the clock cannot be tested and will silently change behavior overnight
- Return type:

```ts
export type RiskLevel = 'healthy' | 'warning' | 'critical';

export interface FactorScore {
  factor: 'payment' | 'engagement' | 'contract' | 'support';
  score: number;         // 0..100, rounded
  weight: number;        // effective weight after re-normalization
  contribution: number;  // score * weight, for the breakdown UI
  available: boolean;
}

export type HealthScoreResult =
  | {
      status: 'scored';
      score: number;
      riskLevel: RiskLevel;
      isProvisional: boolean;
      factors: FactorScore[];
      trend: 'improving' | 'declining' | 'stable' | 'unknown';
      trendDelta: number | null;
    }
  | { status: 'insufficient-data'; availableFactors: string[]; missingFactors: string[] };
```

A discriminated union, not `score: number | null`, so the "no score" case cannot be accidentally rendered as a number or fed into an alert threshold comparison.

#### Validation

- `HealthCalculationError extends Error` with a `field` property, thrown on structurally invalid input: non-finite numbers, negative counts, CSAT outside 1–5, `date` strings that are not `YYYY-MM-DD`, `history` not sorted ascending
- Messages name the offending field and the received value: `"averageResolutionHours must be a finite number >= 0, received -3"`. Never include customer names, email addresses, or dollar amounts in error messages — those propagate into logs
- Absent optional data is **not** an error; it drives the missing-data path above. Malformed present data **is** an error. Keeping these two distinct is the point of the validation layer

### Part 2 — Alerts Engine (`src/lib/alerts.ts`)

#### Rules

Five rules, exactly as the requirements list them, with the ambiguities resolved. Every threshold is an exported named constant.

**High priority**

1. **`payment-risk`** — fires when `payment.overdueAmount > 0 && payment.daysSinceLastPayment > 30`, **or** the computed score is more than 20 points below the score recorded 7 days earlier.
   - *Resolved:* "payment overdue >30 days" maps onto two separate fields in the data model. Requiring both prevents firing on a $0 balance that is merely old
   - The score-drop arm depends on stored prior scores — see Score History below
2. **`engagement-cliff`** — logins/day over the trailing 7 days is less than 50% of logins/day over the preceding 30 days.
   - *Resolved:* the requirement says "drops >50% compared to 30-day average" without naming the recent window. It is the **trailing 7 days**, compared against the **30 days ending 7 days ago** — non-overlapping, so the baseline is not diluted by the very drop it is meant to detect
   - *Guard:* suppressed unless the baseline is at least `MIN_BASELINE_LOGINS_PER_DAY = 0.15` (about 4 logins per 30 days). Without this guard, an account that logged in twice a month and now logs in once trips a "cliff" — the single largest false-positive source in this rule
3. **`contract-expiration-risk`** — `contract.daysUntilRenewal < 90 && contract.daysUntilRenewal >= 0` and score `< 50`.
   - *Resolved:* already-expired contracts are excluded. That is a different business event, not a prediction. Requires `status: 'scored'` — an unscored customer cannot satisfy "score < 50", and must not be treated as if it does

**Medium priority**

4. **`support-ticket-spike`** — more than 3 tickets opened in the trailing 7 days, **or** any escalated ticket in that window.
   - *Noted:* the escalation arm makes a single escalated ticket sufficient, which is noisy by the requirement's own design. Kept as specified; the 7-day cooldown is what makes it tolerable
5. **`feature-adoption-stall`** — no feature key appears in the trailing 30 days that was absent from the preceding 30 days, **and** the account is growing.
   - *Resolved:* "growing account" is undefined in the requirements. Defined as `contract.upgradedWithinDays !== null && contract.upgradedWithinDays <= 180`, **or** the distinct-feature count in the preceding 30 days exceeded that of the 30 days before it. Scoping to growing accounts is the requirement's own intent: a flat account not adopting features is not news

#### Priority scoring

The requirements ask for "weighted factors (customer value, urgency, recency)". Specified as `0..100`:

```
priorityScore = round(
    40 * severityWeight   // high = 1.0, medium = 0.5
  + 30 * valueWeight      // log10-scaled ARR: $1k -> 0, $500k -> 1
  + 20 * urgencyWeight    // rule-specific, below
  + 10 * recencyWeight    // 1.0 if first triggered today, decaying to 0 over 14 days
)
```

`urgencyWeight` per rule: `payment-risk` 1.0, `contract-expiration-risk` `1 - daysUntilRenewal / 90`, `engagement-cliff` 0.8, `support-ticket-spike` 0.5, `feature-adoption-stall` 0.3.

Severity dominates by design, so a medium alert on a large account never outranks a high alert on a small one. The requirements' "workload balancing" is served by ordering *within* a severity tier, not across tiers — a queue that buries a critical small-account alert under enterprise noise is worse than no ordering at all.

#### State, deduplication, and cooldown — kept pure

Dedup, cooldown, history, and dismissal are inherently stateful, and the requirements simultaneously demand pure functions. Reconciled by making state an **explicit argument and an explicit return value**, never module-level mutable data:

```ts
export interface AlertState {
  /** Key: `${customerId}:${ruleId}` */
  lastTriggeredAt: Record<string, string>;
  dismissed: Record<string, string>;   // same key -> ISO dismissal timestamp
  /** Rolling score snapshots, newest last, used by the score-drop rule. */
  scoreHistory: Record<string, Array<{ date: string; score: number }>>;
  history: AlertHistoryEntry[];
}

export function evaluateAlerts(input: {
  customer: Customer;
  signals: CustomerSignals;
  health: HealthScoreResult;
  state: AlertState;
  asOf?: string;
}): { alerts: Alert[]; state: AlertState };  // new state, structurally shared; input never mutated

export function evaluateAllAlerts(
  customers: Customer[],
  state: AlertState,
  asOf?: string,
): { alerts: Alert[]; state: AlertState };
```

- **Dedup** is per `(customerId, ruleId)`: one open alert per rule per customer, never two. It is *not* per customer — a customer with a payment problem and an engagement cliff has two distinct problems and gets two alerts. The UI groups them by customer; the engine does not merge them
- **Cooldown**: `COOLDOWN_HOURS = { high: 72, medium: 168 }`. A rule that fired within its cooldown for that customer is suppressed even if it is still true. This, not "rate limiting", is the real answer to alert fatigue
- **Dismissal** suppresses the `(customer, rule)` pair for `DISMISSAL_SUPPRESS_HOURS = 336` (14 days), then allows it to re-fire. A dismissed-forever alert is a silent failure
- **Score history** is appended by the caller on each evaluation and capped at `SCORE_HISTORY_DAYS = 30` entries per customer. If no snapshot exists within 5–9 days of `asOf`, the score-drop arm of `payment-risk` is **skipped rather than assumed false**, and `Alert.notes` records that the comparison was unavailable. Inferring "no drop" from missing history is how a monitoring system goes quietly blind
- **Business hours** ("business hours consideration for alert delivery timing"): nothing is delivered — no email, no push, no channel of any kind — so this is implemented as a pure predicate `isWithinBusinessHours(iso: string): boolean` (Mon–Fri, 09:00–17:00 viewer-local) exposed on the alert **for display only**. It never suppresses an alert. Hiding a critical alert from a dashboard someone is actively looking at because it is 6pm would be a defect, not a feature

#### Alert shape

```ts
export interface Alert {
  id: string;                 // `${customerId}:${ruleId}:${firstTriggeredDate}` — stable across re-evaluation
  ruleId: AlertRuleId;
  customerId: string;
  priority: 'high' | 'medium';
  priorityScore: number;      // 0..100
  title: string;              // e.g. "Payment overdue 47 days"
  detail: string;             // the triggering comparison, in numbers
  recommendedAction: string;  // one imperative sentence
  triggeredAt: string;        // ISO
  withinBusinessHours: boolean;
  notes?: string[];           // e.g. "7-day score comparison unavailable"
}
```

`id` is derived, not random, so React keys and dedup keys are the same value and survive re-render.

### Part 3 — UI Components

#### `CustomerHealthDisplay` (`src/components/CustomerHealthDisplay.tsx`)

- Props: `{ customer: Customer; signals?: CustomerSignals; asOf?: string }`. No data fetching and no `useEffect`-driven loading — the data is a synchronous module import
- Displays the overall score large, with the red/yellow/green band color **and a visible band label** (`Healthy` / `Warning` / `Critical`). Color is never the only signal
- Expandable breakdown listing all four factors with sub-score, effective weight, and contribution. Collapsed by default. The breakdown is where the algorithm becomes explainable to a stakeholder, so it shows the arithmetic, not just the outcome
- Trend indicator beside the score — an arrow **plus a text label** (`Improving` / `Declining` / `Stable`) and the point delta. The `unknown` trend renders nothing rather than a flat/neutral arrow, which would read as "stable"
- **`insufficient-data`** renders "Not enough data to score" plus which factors are missing — never a number, never a band color
- **`isProvisional`** renders the score with a "Provisional — limited history" qualifier and names the excluded factor
- The requirements ask for "loading and error states consistent with other dashboard widgets". There is no loading state to have; keep the skeleton markup for shape but render it only if a future async source appears. An error boundary around the widget catches `HealthCalculationError` from malformed fixtures and renders an error banner without taking down the dashboard
- Card shell matches `CustomerCard` if it exists when this is implemented; otherwise `rounded-lg border border-gray-200 bg-white p-4 shadow-sm` with heading `text-lg font-semibold text-gray-900 mb-3`. Do not claim conformance to a pattern you did not open and read

#### `AlertsPanel` (`src/components/AlertsPanel.tsx`)

- Renders alerts across all customers, sorted by `priority` then `priorityScore` descending
- Priority visualization uses red (high) and yellow (medium), each with a text priority label alongside. **Green is not used** — a green alert is a contradiction. The requirements' "red/yellow/green" color coding is honored as red/yellow for alerts plus a plain, uncolored "No active alerts" empty state
- Each row expands to a detail panel: the triggering numbers, the recommended action, the customer, and any `notes`
- Dismiss control per alert, updating `AlertState` through `useReducer`. Dismissal is session-lifetime only and the panel says so
- Historical view lists the session's `AlertHistoryEntry[]` with a visible "this session only" caveat
- Alert counts by priority in the header, so the panel is scannable without expanding anything
- A "Copy as CSV" control writing the current alert list to the clipboard, honoring the same redaction rules as the alert text — no emails, names, or exact dollar figures

### Integration

- The Dashboard (`src/app/page.tsx`) owns selected-customer state, as `CustomerSelector` already does for cards. Both widgets are driven by props and re-derive on selection change
- `CustomerHealthDisplay` shows the selected customer. `AlertsPanel` shows **all** customers regardless of selection — an alerts panel scoped to the current selection cannot tell you where to look next. Clicking an alert selects that customer
- Import `Customer` from `@/data/mock-customers` via the configured `@/*` path alias
- Band colors are shared with `CustomerCard` through the exported threshold constants, not duplicated. If `CustomerCard` hardcodes its own thresholds when this is implemented, refactor it to import them — two sources of truth for one band will drift

## Constraints

### Technical stack

- Next.js 15.5 (App Router), React 19.1, TypeScript 5 with `strict: true`, Tailwind CSS v4
- **No new runtime dependencies.** Vitest and `@vitest/coverage-v8` as devDependencies only
- `src/lib/*` is framework-free: no React import, no `next/*` import, no DOM access. It must run in a plain Node test process
- Server Components by default. `'use client'` only on `AlertsPanel` (it holds dismissal state) and `CustomerHealthDisplay` (expand/collapse)

### Code quality

- Named exports throughout; no default exports
- No `any`, no non-null assertions on signal data, and no type assertions used to paper over the discriminated union
- JSDoc on every scoring function stating the business rationale and the formula, and on the weight and threshold constant blocks. The requirements' "explainable algorithm decisions" obligation is discharged here and in the breakdown UI
- Every threshold, weight, and breakpoint is a named exported constant, defined once. A magic number inside a scoring function is a defect
- Descriptive identifiers; no abbreviations such as `calc`, `cust`, or `hs`

### Performance

- Whole-portfolio evaluation is `O(customers × historyDays)` with a single pass per customer per window. No nested scans over `history` and no re-deriving the same window twice — compute window aggregates once and share them between the calculator and the engine
- Budget: 500 customers × 60 days of history evaluated in **under 50ms** on a mid-range laptop, asserted in a test
- Memoize per-customer results at the widget boundary with `useMemo` keyed on `(customerId, asOf)`. Do not memoize inside `src/lib` — a cache inside a pure function is no longer a pure function

### Security

- Validate all signal data at the `src/lib` boundary before use. Treat mock data as untrusted input so the validation is already real when a live source replaces it
- `Alert.title` and `Alert.detail` contain **no email addresses, no exact dollar amounts, and no customer names** — they reference `customerId` and let the UI join to the display name. Alert strings are the most likely part of this feature to end up in a log or a screenshot
- All strings rendered as JSX text content; never `dangerouslySetInnerHTML`
- No customer data in `console` calls anywhere in the feature
- **Stated plainly: a client-side rules engine is not a security boundary.** Every customer's signals are already in the browser bundle. The requirements' "no sensitive customer data exposure in alert messages" is honored as data hygiene and log safety, not as access control. When a real backend arrives, rule evaluation moves server-side; do not present this implementation as having solved authorization

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
- **Fractional and rounding:** inputs producing raw `30.4`, `30.5`, `70.5`, so rounding-then-banding is pinned
- **Clamping:** a factor combination whose weighted sum would land outside `0..100`
- **Per-factor extremes:** best-case and worst-case inputs for each of the four factors independently, so a sign error in one factor cannot hide behind the other three
- **Missing data:** one factor absent (re-normalization path); two absent totaling exactly `50`, i.e. engagement + contract (boundary — still scored); three absent (`insufficient-data` path)
- **New customer:** 3 days and 13 days of history (provisional), 14 days (not provisional)
- **Invalid input:** `NaN`, `Infinity`, negative counts, CSAT of `0` and `6`, unsorted `history`, malformed `date` — each expected to throw `HealthCalculationError` naming the field
- **Per-rule alert fixtures:** for each of the five rules, one customer that fires it, one that misses it by a single unit on each threshold in the rule, and one that would fire but is suppressed by cooldown or dismissal
- **Engagement-cliff guard:** a low-baseline customer (3 logins per 30 days) whose logins halve, expected **not** to fire
- **Missing score history:** a customer with no snapshot in the 5–9 day window, expected to skip the score-drop arm and record a note

### Out of scope

- Any server, database, API route, or persistence beyond session memory
- Real payment, CRM, analytics, or support-desk integration
- Notification delivery of any kind — email, Slack, push, webhook
- Cross-session or cross-user alert state
- Alert effectiveness tracking against real customer outcomes, and the A/B testing framework — both need production data this repository will never have
- Modifying the `Customer` interface or `mockCustomers`
- Domain health checking (owned by the domain health widget) and market sentiment (owned by the market intelligence widget)

## Acceptance Criteria

### Automated — must pass

- [ ] `npm run type-check` passes with no errors
- [ ] `npm run lint` passes with no errors or warnings
- [ ] `npm run test` passes, and `src/lib/healthCalculator.ts` and `src/lib/alerts.ts` reach **100% branch coverage** — they are pure arithmetic with no untestable paths, so anything less means an untested threshold
- [ ] Integer factor weights sum to exactly `100`, asserted in a test (exact equality, no tolerance — this is why they are integers)
- [ ] Scores `0` and `30` band `critical`; `31` and `70` band `warning`; `71` and `100` band `healthy`
- [ ] Raw scores `30.4`, `30.5`, `70.5` land in exactly one band, and the displayed number matches the band shown
- [ ] Weighted sums outside `0..100` clamp, and no input produces a score outside `0..100`
- [ ] Each factor's best-case inputs score 100 and worst-case inputs score 0, tested per factor
- [ ] Every hand-computed fixture matches the implementation to the integer — the mathematical-accuracy requirement
- [ ] One missing factor re-normalizes the remaining weights to `100`; a missing weight of exactly `50` still scores; more than `50` returns `insufficient-data`
- [ ] `trend` is `improving` / `declining` / `stable` / `unknown` on the correct fixtures, and `unknown` whenever fewer than two snapshots span 7+ days
- [ ] A customer with 13 days of history returns `isProvisional: true`; 14 days returns `false`
- [ ] Engagement is computed as a rate, verified by a test where a 10-day and a 30-day customer with identical logins/day score identically
- [ ] Every invalid-input fixture throws `HealthCalculationError` naming the offending field, and no error message contains a customer name, email address, or dollar amount
- [ ] Each of the five rules fires on its positive fixture and does not fire on its off-by-one fixture
- [ ] `engagement-cliff` does not fire on the low-baseline fixture
- [ ] A rule that is true but within cooldown produces no alert; the same rule after cooldown produces one
- [ ] A dismissed alert is suppressed for 336 hours and re-fires afterward
- [ ] Missing 7-day score history skips the score-drop arm and records a note, rather than treating it as no drop
- [ ] `evaluateAlerts` does not mutate its `state` or `signals` arguments, asserted by deep-freezing the inputs
- [ ] A customer firing two rules yields two alerts with distinct, stable `id`s, and re-evaluating with the same inputs yields identical `id`s
- [ ] High-priority alerts sort above every medium-priority alert regardless of ARR
- [ ] Calling the calculator twice with the same inputs returns identical results, and no file in `src/lib` references `Date.now`, `new Date()` without an argument, or `Math.random` — asserted by a source-level test
- [ ] 500 customers × 60 days of history evaluates in under 50ms
- [ ] No file in `src/lib` imports from `react` or `next`, asserted by a source-level test

### Manual — verified by rendering the dashboard and inspecting

- [ ] Health score renders with the correct band color and a visible band label
- [ ] Breakdown expands to show all four factors with sub-score, weight, and contribution, and the contributions sum to the displayed score
- [ ] `insufficient-data` renders the explanatory state with no number and no band color
- [ ] The provisional state is visibly labeled and names the excluded factor
- [ ] The widget updates when the selected customer changes
- [ ] `AlertsPanel` shows all customers' alerts, not just the selected customer's; clicking an alert selects that customer
- [ ] High alerts are red and medium alerts are yellow, each with a text label; no green is used for any alert
- [ ] The empty state reads "No active alerts" with no colored row
- [ ] Dismissing an alert removes it, and it does not return on re-render
- [ ] Session-only caveats appear on the dismissal and history views
- [ ] The trend indicator shows an arrow, a text label, and a delta; an `unknown` trend renders no indicator at all
- [ ] "Copy as CSV" places the current alert list on the clipboard with the same redactions as the on-screen text
- [ ] `healthCalculator.ts` ends with a "Calibration notes" section naming which constants are guesses and what would falsify them
- [ ] Two dashboard reloads produce identical scores and identical alerts — determinism is visible, not merely tested
- [ ] Each of the five rules is observably fired by at least one customer in `mockCustomers`, and at least one customer shows no alerts
- [ ] No alert text contains an email address, a customer name, or an exact dollar figure
- [ ] Layout is readable and structurally intact at 320px, 768px, and 1024px
- [ ] No `dangerouslySetInnerHTML` and no customer data in any `console` call across the feature
- [ ] No console errors or warnings when rendering all of `mockCustomers` plus the full fixture set
