# Feature: PredictiveIntelligence

> **Revision 2.** This spec was rewritten after an adversarial review against `@requirements/predictive-alerts.md`. The review's findings and where each is addressed are listed in **Appendix: Review Response** at the end. The most consequential change: alert state is now **server-side**, because revision 1 put it in `localStorage` while assembling the alert list on the server — a boundary that could not close.

## Context
- Proactive risk-monitoring feature for the Customer Intelligence Dashboard. It fuses two evidence streams into one ranked alert list:
  - **Internal signals** — payment behaviour, login engagement, contract runway, support tickets, feature adoption (`@requirements/predictive-alerts.md`)
  - **External market signals** — news sentiment for the customer's company (`@requirements/market-intelligence.md`)
- The value of combining them is that neither stream alone is decisive. A health-score dip plus negative press is a stronger churn indicator than either signal in isolation, and this spec makes that compounding explicit rather than leaving it to the reader of two separate widgets.
- Composed of seven layers: a deterministic mock signals module, a pure rules engine (`src/lib/alerts.ts`), a server-side alert state store, a service that orchestrates signals + health + market data, two API routes (read and action), a dashboard widget with detail/history panels, and a fatigue-analytics panel.
- **All data is mock.** Internal signals are generated deterministically per customer id; market data comes from `src/data/mock-market-intelligence.ts`. There are no external APIs, no API keys, and no third-party trust boundary.
- The source requirements call this "real-time monitoring". It is not real-time and must not be presented as such. It is a 60-second poll over locally generated data. The UI labels it as sample data so a demo audience is never misled.

### State Ownership — read this before implementing anything

Alert state (first-detection time, occurrence counts, dismissals, cooldown timers, the audit log) lives **on the server**, in `src/server/alertStateStore.ts`. The client holds no authoritative alert state.

This is the load-bearing decision of the spec, because every one of these depends on it:
- The `GET` response returns `firstDetectedAt`, `occurrenceCount`, `status`, and `notificationSuppressedUntil`. A server cannot read `localStorage`, so client-owned state would make those fields unpopulatable by the route that returns them.
- `priorityScore` includes a recency term derived from `firstDetectedAt`. Ranking therefore requires state at scoring time, which happens server-side.
- Dismissals must filter the list the server assembles, so the server has to know about them — hence the action endpoint below rather than a client-only flag.
- Requirement line 85 asks for "alert state synchronization across multiple dashboard sessions". With server-side state this is simply true: every session reads the same store. With `localStorage` it is unachievable.

**The honest limit:** the store is a module-level `Map` in the Next server process. It resets on server restart and is not shared across instances in a multi-instance deployment. That is acceptable for a mock workshop app and must be stated in a comment at the top of the module. Durable, multi-instance state is Out of Scope, and the words "compliance audit trail" must not be used for this store.

## Prerequisites and Pattern Sources

**This spec forward-references modules that do not exist in the repository yet.** At the time of writing, `src/` contains only `app/{layout,page,globals.css,favicon.ico}` and `data/{mock-customers,mock-market-intelligence}.ts`. There is no `src/components/`, no `src/lib/`, no `src/services/`, no `src/server/`, and no API route of any kind. `src/app/page.tsx` loads `CustomerCard` through a `require()` placeholder because it is built in a later exercise.

Every "match the existing pattern" instruction below is therefore conditional. For each dependency:

| Dependency | If it exists when you implement | If it does not exist |
|---|---|---|
| `calculateHealthScore` (`src/lib/healthCalculator.ts`, per `@specs/health-score-calculator-spec.md`) | Call it for the per-factor breakdown shown in the detail panel, subject to **Health Score Integration** below | Omit the factor breakdown from the detail panel; every rule still uses `customer.healthScore` |
| `MarketIntelligenceService` (`@specs/market-intelligence-spec.md`) | Call `getMarketIntelligence(company)` and reuse its cache | Call `generateMockMarketData` / `calculateMockSentiment` directly, and see **Market Signal Preconditions** below |
| `CustomerSelector` / `Dashboard` | Receive `selectedCustomer` via props from the Dashboard's existing selection state | Render standalone against `mockCustomers` with an internal selector stub |
| Sibling widget card shell, loading and error states | Copy padding, border, radius, heading treatment, skeleton and error banner verbatim | Use the fallback card shell below |
| `ErrorBoundary` (`src/components/ErrorBoundary.tsx`) | Wrap the widget in it | Introduce it here; it is a plain class-based boundary |

**Fallback card shell:** `rounded-lg border border-gray-200 bg-white p-4 shadow-sm`, heading `text-lg font-semibold text-gray-900 mb-3`, body `text-sm text-gray-600`. Priority colour language mirrors the health-score banding used elsewhere in the dashboard (red 0–30 / yellow 31–70 / green 71–100): red = high priority, yellow = medium priority, green = no alerts.

Do not claim conformance to a pattern you did not actually open and read.

### Health Score Integration

`@specs/health-score-calculator-spec.md` now exists and is concrete, which creates three seams this spec must pin rather than leave to the implementer.

**1. `customer.healthScore` is the single source of truth for every rule.** Three rules gate on a health value (`PAYMENT_RISK`'s drop clause, `CONTRACT_EXPIRATION_RISK`, `MARKET_SENTIMENT_RISK`), and `healthHistory`'s newest entry is required to equal `customer.healthScore`. If rules instead consumed a freshly computed `calculateHealthScore` result, that computed value could differ from the score the rest of the dashboard displays — reproducing exactly the "widget shows one number while the alert reasons about another" bug this spec forbids in its own Data Requirements. So `calculateHealthScore` is used **only** to populate the detail panel's factor breakdown, never to drive a trigger. When the computed total and `customer.healthScore` disagree, the panel shows both and labels the computed one "recalculated", rather than silently preferring either.

**2. The adapter belongs to this feature, not to the calculator.** That module is pure and explicitly refuses to read the clock: "all *days since / days until* values are supplied by the caller, already computed." `PredictiveIntelligenceService` therefore owns a `toHealthScoreInput(signals, now)` adapter that derives `daysSinceLastPayment`, `daysUntilRenewal`, and every other delta from the injected `now`. Do not add clock access to `healthCalculator.ts`.

**3. Units differ and must be converted at the boundary.** `CustomerSignals` stores money in **cents** (`overdueAmountCents`, `arrCents`); `HealthScoreInput` takes `overdueAmount` and `contractValue` in **currency units**. The adapter divides by 100. Passing cents straight through would inflate overdue severity by 100× and silently zero out the payment factor — a defect that produces plausible-looking scores, so a unit-conversion test is required rather than optional.

### Market Signal Preconditions

`src/data/mock-market-intelligence.ts` as shipped **cannot** drive the market dimension of this feature. Verified by running it against the eight `mockCustomers` companies: every company returns `label: 'positive'` with `score` saturated at exactly `1.000` and zero populated URLs, because no template contains a negative keyword and `totalScore / totalWords * 10` clamps to 1 for any input. A negative-sentiment alert is therefore unreachable.

The fixes are specified as M1–M4 in `@specs/market-intelligence-spec.md` (negative/neutral templates, deterministic seeding, non-saturating score, populated `url`). **Implement those first.**

**Two sentiment profiles must be pinned there, not left to the hash**, because this spec's fixture guarantees depend on them and the seed is keyed on company name, which this spec's signals module cannot influence:

| Company | Required profile | Why |
|---|---|---|
| `TechStart Inc` | `negative`, `confidence >= 0.6` | The only way to guarantee a reachable `MARKET_SENTIMENT_RISK` and a compound escalation (customer `2`, health 45 < 70) |
| `CloudFirst Solutions` | `positive` or `neutral` | Customer `8` is the missing-data fixture and must fire **nothing**; a negative profile would fire the market rule and break that guarantee |

If M1–M4 are not yet in place, `MARKET_SENTIMENT_RISK` must still be built and unit-tested against injected sentiment values, and the market dimension reported as unavailable at runtime rather than silently returning "all positive".

## Requirements

### Data Requirements

#### The signal gap

`Customer` (`src/data/mock-customers.ts:6`) is:

```ts
interface Customer {
  id: string; name: string; company: string; healthScore: number;
  email?: string; subscriptionTier?: 'basic' | 'premium' | 'enterprise';
  domains?: string[]; createdAt?: string; updatedAt?: string;
}
```

Not one alert rule in `@requirements/predictive-alerts.md` can be evaluated from that shape. There is no payment history, no login data, no contract dates, no support tickets, no feature usage, no ARR — and no health-score *history*, which the payment rule's "drops >20 points in 7 days" clause requires. **Do not extend `Customer`**; `mock-customers.ts` is shared with other workshop exercises and widening it would break their fixtures. Add a sibling module instead.

#### `src/data/mock-customer-signals.ts`

```ts
export interface HealthSnapshot { date: string; score: number }      // ISO 8601 date

export interface PaymentSignals {
  daysOverdue: number;                    // 0 when current
  overdueAmountCents: number;
  averagePaymentDelayDays: number;        // trailing 6 payments
  averagePaymentDelayDaysPrior: number;   // the 6 before those — enables behaviour-change detection
  lastPaymentAt: string | null;           // null for a customer who has never paid
}

export interface EngagementSignals {
  loginsLast7Days: number;
  loginsTrailing30To7Days: number;        // 23-day window ending 7 days ago; see baseline note
  loginBuckets10Day: [number, number, number];  // oldest -> newest, covering the trailing 30 days
  distinctFeaturesUsedLast30Days: number;
  distinctFeaturesUsedPrevious30Days: number;   // days 31-60; enables usage-depth trend
  firstUseOfNewFeatureAt: string | null;
  seatCount: number;
  seatCount90DaysAgo: number;
}

export interface ContractSignals {
  renewalDate: string | null;
  arrCents: number;
  upgradedAt: string | null;
}

export interface SupportSignals {
  ticketsLast7Days: number;
  escalatedTicketLast7Days: boolean;
  averageSatisfaction: number | null;         // 1..5 over trailing 30 days, null when no rated tickets
  averageSatisfactionPrior: number | null;    // 1..5 over days 31-60; enables satisfaction trend
}

export interface CustomerSignals {
  customerId: string;
  healthHistory: HealthSnapshot[];        // ascending by date, >= 1 entry, <= 30 entries
  payment: PaymentSignals;
  engagement: EngagementSignals;
  contract: ContractSignals;
  support: SupportSignals;
  generatedAt: string;
}

export function generateMockSignals(customerId: string, now?: number): CustomerSignals;
```

- **Explicit fixture table, not a bare hash.** `generateMockSignals` resolves `customerId` against the pinned table below first, falling back to FNV-1a-seeded generation for ids not in it. Revision 1 asked a pure hash to satisfy seven coverage guarantees across eight fixed ids, which no hash can be *asked* to do. `Math.random()` remains prohibited: it makes every alert unreproducible and every assertion flaky.
- **Deterministic.** The same customer id yields the same signals across repeated calls and across process restarts.
- **Clock-injectable.** All relative dates derive from the `now` argument (default `Date.now()`), never from a bare `new Date()` inside the generator, so tests can place a customer 89 or 91 days from renewal without waiting.
- **Consistent with the displayed score.** The newest `healthHistory` entry must equal `customer.healthScore` exactly. Otherwise the widget shows one number while the alert reasons about another, and the alert looks like a bug.
- **ARR.** `@requirements/predictive-alerts.md` requires prioritisation by customer value, and no ARR field exists anywhere in the repo. `arrCents` lives here, and must correlate with `subscriptionTier` (enterprise > premium > basic) so the ranking looks defensible in a demo rather than arbitrary.

#### Pinned fixture table

Every value is chosen to make a specific criterion verifiable. Health scores and tiers below are the real values in `mock-customers.ts`, confirmed by reading it.

| id | company | health | tier | Intended outcome |
|---|---|---|---|---|
| `1` | Acme Corp | 85 | premium | **Zero alerts.** `daysOverdue: 29` — a deliberate near-threshold miss that must not fire |
| `2` | TechStart Inc | 45 | basic | `PAYMENT_RISK` (`daysOverdue: 45`) **+** `MARKET_SENTIMENT_RISK` → the **compound escalation** fixture |
| `3` | Global Solutions | 15 | basic | `CONTRACT_EXPIRATION_RISK` (`renewalDate` = now + 89d, near-threshold hit) **+** `SUPPORT_TICKET_SPIKE` (5 tickets) |
| `4` | Innovation Labs | 92 | enterprise | `FEATURE_ADOPTION_STALL` — growing (seats 40 vs 30), `firstUseOfNewFeatureAt` 45 days ago |
| `5` | Future Systems | 60 | premium | `ENGAGEMENT_CLIFF` — baseline 14 logins/23d, 2 in the last 7d |
| `6` | Smart Ventures | 73 | premium | `ENGAGEMENT_DECLINE_TREND` — `loginBuckets10Day: [12, 8, 5]`, gradual, must **not** trip the cliff rule |
| `7` | DataFlow Analytics | 88 | enterprise | **Zero alerts** (the second one, so the empty state is reachable) |
| `8` | CloudFirst Solutions | 35 | basic | **Missing data fires nothing:** `lastPaymentAt: null`, single-entry `healthHistory`, `renewalDate: null` |

Coverage this guarantees, asserted in `mock-customer-signals.test.ts` rather than left to inspection: all seven rules fire at least once; two customers produce zero alerts; one compound escalation occurs; thresholds are exercised from both sides (`1` at 29 days overdue must not fire, `3` at 89 days to renewal must fire); and one customer with absent data fires nothing.

**Baseline window note.** The requirement says login frequency versus "the 30-day average", but the trailing 30 days *includes* the 7-day drop being measured, which dampens the very signal being detected. `loginsTrailing30To7Days` therefore covers the 23 days ending 7 days ago, giving a clean pre-drop baseline. This is a deliberate deviation from the literal wording; keep the field name explicit so it cannot be misread as a plain 30-day count.

### Functional Requirements

#### Configurable Thresholds — `src/lib/alertThresholds.ts`

Requirement line 13 asks for "configurable thresholds and conditions", and line 68 for validation of "rule parameters". Revision 1 hardcoded every threshold, which left both unmet and line 68 with nothing to validate.

```ts
export interface AlertThresholds {
  payment:    { overdueDays: number; healthDropPoints: number; healthDropWindowDays: number };
  engagement: { cliffDropRatio: number; baselineMinLogins: number;
                trendMinTotalDropRatio: number };
  contract:   { horizonDays: number; healthCeiling: number };
  support:    { ticketCount: number; windowDays: number };
  adoption:   { staleDays: number; growthRatio: number; growthWindowDays: number;
                minAccountAgeDays: number };
  market:     { minConfidence: number; healthCeiling: number };
  cooldown:   { highHours: number; mediumHours: number; dismissalTtlHours: number };
  caps:       { maxPerCustomer: number; maxAlerts: number };
}

export const DEFAULT_THRESHOLDS: AlertThresholds;   // the values in the rule table below
export function validateThresholds(input: unknown): AlertThresholds;   // throws on invalid
```

`validateThresholds` enforces: every number finite; counts and day-windows positive integers; ratios in `(0, 1]`; `healthCeiling` and `healthDropPoints` in `0..100`; `minConfidence` in `0..1`; caps `>= 1`. Callers pass a partial override that is deep-merged over `DEFAULT_THRESHOLDS` and then validated as a whole — never validated field-by-field in isolation, so a combination like `healthDropPoints: 0` cannot slip through.

#### Rules Engine — `src/lib/alerts.ts`

Pure functions only. No `Date.now()`, no `fetch`, no storage access, no logging inside this module — every time-dependent and stateful value arrives through the input.

```ts
export type AlertPriority = 'high' | 'medium';
export type AlertRuleId =
  | 'PAYMENT_RISK' | 'ENGAGEMENT_CLIFF' | 'CONTRACT_EXPIRATION_RISK'
  | 'SUPPORT_TICKET_SPIKE' | 'FEATURE_ADOPTION_STALL' | 'MARKET_SENTIMENT_RISK'
  | 'ENGAGEMENT_DECLINE_TREND';

export interface MarketSignal {
  score: number;                    // -1..1
  label: 'positive' | 'neutral' | 'negative';
  confidence: number;               // 0..1
  articleCount: number;
  lastUpdated: string;
}

export interface RuleInput {
  customer: Pick<Customer, 'id' | 'name' | 'company' | 'healthScore' | 'subscriptionTier' | 'createdAt'>;
  signals: CustomerSignals;
  market: MarketSignal | null;      // null = unavailable, never treated as neutral-good
  thresholds: AlertThresholds;
  now: number;                      // epoch ms, injected
}

export interface SkippedClause {
  customerId: string;
  ruleId: AlertRuleId;
  clause: string;                   // e.g. 'healthDrop'
  reason: string;
}

export interface RuleResult {
  ruleId: AlertRuleId;
  priority: AlertPriority;
  severity: number;                 // 0..1, normalized breach magnitude
  triggeredClause: string;          // which clause actually fired; drives the title
  title: string;
  message: string;                  // built from a template; see Security
  recommendedActions: string[];     // 2-3 concrete steps
  evidence: Array<{ label: string; value: string }>;
  triggeredAt: string;              // ISO 8601, derived from `now`
  skipped: SkippedClause[];         // clauses that could not be evaluated, even when the rule fired
}

// One exported pure function per rule. Each returns null when it does not fire; a rule that
// fires may STILL report skipped clauses, so firing and skipping are not mutually exclusive.
export function evaluatePaymentRisk(input: RuleInput): RuleResult | null;
export function evaluateEngagementCliff(input: RuleInput): RuleResult | null;
export function evaluateEngagementDeclineTrend(input: RuleInput): RuleResult | null;
export function evaluateContractExpirationRisk(input: RuleInput): RuleResult | null;
export function evaluateSupportTicketSpike(input: RuleInput): RuleResult | null;
export function evaluateFeatureAdoptionStall(input: RuleInput): RuleResult | null;
export function evaluateMarketSentimentRisk(input: RuleInput): RuleResult | null;

export interface AlertEngineOptions {
  thresholds?: Partial<AlertThresholds>;
  maxPerCustomer?: number;          // default DEFAULT_THRESHOLDS.caps.maxPerCustomer
  maxAlerts?: number;               // default DEFAULT_THRESHOLDS.caps.maxAlerts
}

export interface AlertEngineInput {
  ruleInputs: RuleInput[];
  priorState: ReadonlyMap<string, AlertStateEntry>;   // key: `${customerId}:${ruleId}`
  options?: AlertEngineOptions;
}

export interface AlertEngineResult {
  alerts: ScoredAlert[];            // ranked, capped
  suppressedByCap: number;
  skipped: SkippedClause[];         // flattened across every rule and clause
  evaluatedCustomerCount: number;
}

export function alertEngine(input: AlertEngineInput): AlertEngineResult;
```

**`priorState` is an explicit input, not ambient.** `priorityScore` needs `firstDetectedAt` for its recency term; revision 1 declared the engine pure but gave it no way to obtain that value. State enters here and only here — the individual rule functions never see it, so they stay trivially testable.

**Universal rule invariants:**
- **Missing data never triggers an alert.** A clause whose inputs are absent, `null`, or insufficient contributes a `SkippedClause` and is treated as not-firing. Treating "unknown" as "bad" would fire a payment alert at every new customer.
- **A rule may fire and skip simultaneously.** A customer 40 days overdue with a single health snapshot fires on the overdue clause *and* reports `healthDrop` as skipped. Skips are per-clause, not per-rule.
- **Thresholds are exclusive exactly as written.** `>30 days` means 31 triggers and 30 does not. Every boundary has a test at threshold, threshold−1, and threshold+1.
- Rules are independent: no rule reads another's output. Compounding happens only in `alertEngine`.
- **Supporting signals annotate; they never trigger.** Payment-delay drift, satisfaction trend, and usage-depth trend adjust `severity` and populate `evidence` only when the rule's requirement-specified trigger has already fired. They cannot create an alert of their own, because the requirements do not list them as triggers.

#### Alert Rules

| Rule | Priority | Trigger | Severity | Skipped clause when |
|---|---|---|---|---|
| `PAYMENT_RISK` | high | `daysOverdue > 30` **OR** health drop `> 20` points over the trailing 7 days | `max(min(1,(daysOverdue-30)/60), min(1,(drop-20)/40))`, then `+0.1` (capped at 1) if `averagePaymentDelayDays > averagePaymentDelayDaysPrior * 1.5` | `healthDrop`: fewer than 2 snapshots in the 7-day window. `overdue`: `lastPaymentAt` is null **and** `daysOverdue` is 0 — never paid, nothing overdue to measure |
| `ENGAGEMENT_CLIFF` | high | `recentRate < 0.5 * baselineRate`, where `recentRate = loginsLast7Days/7` and `baselineRate = loginsTrailing30To7Days/23` | `min(1, (1 - recentRate/baselineRate - 0.5) / 0.5)` | `baseline`: `loginsTrailing30To7Days < 4` — see the low-volume guard |
| `ENGAGEMENT_DECLINE_TREND` | medium | `loginBuckets10Day` strictly decreasing across all three buckets **AND** `(b0-b2)/b0 >= 0.30` **AND** `ENGAGEMENT_CLIFF` did not fire | `min(1, (b0-b2)/b0)` | `buckets`: `b0 < 4`, same low-volume reasoning |
| `CONTRACT_EXPIRATION_RISK` | high | `0 < daysUntilRenewal < 90` **AND** `healthScore < 50` | `min(1, (90-daysUntilRenewal)/90)` | `renewal`: `renewalDate` is null, or `daysUntilRenewal <= 0` (already expired is a billing state, not a prediction) |
| `SUPPORT_TICKET_SPIKE` | medium | `ticketsLast7Days > 3` **OR** `escalatedTicketLast7Days` | `min(1,(tickets-3)/6)`, floored at `0.5` when escalated, then `+0.15` (capped at 1) if `averageSatisfaction` is at least 1.0 below `averageSatisfactionPrior` | `satisfactionTrend`: either satisfaction average is null. The trigger still evaluates — zero tickets is valid data, not missing data |
| `FEATURE_ADOPTION_STALL` | medium | account is **growing** **AND** no new-feature first-use in the trailing 30 days | `min(1, growthRate)`, then `+0.15` (capped at 1) if `distinctFeaturesUsedLast30Days < distinctFeaturesUsedPrevious30Days` | `accountAge`: `createdAt` is absent. Rule does not fire at all when the account is under 30 days old — it has not had time to stall |
| `MARKET_SENTIMENT_RISK` | medium → **high when escalated** | `market.label === 'negative'` **AND** `market.confidence >= 0.6` **AND** `healthScore < 70` | `min(1, abs(score) * confidence)` | `market`: `market` is null |

**Growing account** is `seatCount >= seatCount90DaysAgo * 1.1` **OR** `upgradedAt` within the trailing 90 days. `growthRate = seatCount/seatCount90DaysAgo - 1`. Without this definition, "growing accounts" in the source requirement is unimplementable.

**Low-volume guard — an absolute count, not a rate.** Revision 1 required `baselineRate >= 0.5` logins/day, i.e. 11.5 logins in 23 days, while justifying it with a two-logins-per-month example (≈0.07/day). Everything in between — including the ordinary 2–3×/week B2B user at 0.3–0.43/day — was permanently excluded from a **high-priority** rule. The guard is now `loginsTrailing30To7Days >= 4`: enough history for a ratio to mean something, without silencing weekly users.

**Sudden versus gradual.** Requirement line 28 asks for "login pattern analysis for gradual vs sudden engagement drops". `ENGAGEMENT_CLIFF` covers sudden; `ENGAGEMENT_DECLINE_TREND` covers gradual, at medium priority because a slow slide is a monitor-closely signal rather than an interrupt. The trend rule is explicitly suppressed when the cliff rule fires, so one deteriorating account never produces two engagement alerts.

**Titles name the clause that fired.** `PAYMENT_RISK` triggered by the health-drop clause must not be titled "Payment Risk" — a customer current on payments who dropped 25 health points would send the CSM into the wrong conversation. `triggeredClause` drives the title (e.g. "Health score dropped 25 points in 7 days") and appears in `evidence`.

**Compound risk.** `MARKET_SENTIMENT_RISK` is medium on its own: mock news sentiment is weak evidence and does not justify interrupting anyone. When it co-occurs with at least one `high` alert for the same customer, `alertEngine` sets `escalated: true` **and rewrites `priority` to `'high'`**. Revision 1 left it `'medium'` while scoring it at the high base, so the top-ranked alert disappeared when the user filtered to High, and `summary` miscounted it. Ranking, summary, and filter must agree on one field. Escalation is a flag plus a priority change on the existing alert, never a synthesized extra alert.

#### Priority Scoring

```
priorityScore = tierBase + valuePoints + urgencyPoints + recencyPoints     // integer, 20..100

tierBase      = 50 for high (including an escalated market alert), 20 for medium
valuePoints   = round(20 * min(1, arrCents / 25_000_000))        // saturates at $250k ARR
urgencyPoints = round(20 * severity)
recencyPoints = round(10 * max(0, 1 - hoursSinceFirstDetected / 168))   // decays to 0 over 7 days
```

The attainable range is **20–100**, not 0–100: a medium alert with no ARR, zero severity, and a week of age still scores 20. State the real range so tests assert something meaningful.

- Sorted descending. **Ties break deterministically** on `priorityScore desc`, then `ruleId` ascending, then `customerId` ascending — never on `Array.prototype.sort` stability or object key order, so the same input always renders the same list.
- `recencyPoints` uses `firstDetectedAt` from `priorState`, not `triggeredAt` of the current evaluation. Using the current pass would hold every unresolved alert at a permanent 10 and freeze the ranking.
- **Scoring and ranking are recomputed on every request**, never cached. `recencyPoints` decays with wall-clock time, so a cached score is stale by construction. Only the *inputs* (signals, market data) are cached — see the service layer.
- **Workload balancing.** The source requirement asks for balancing across workload, but no `Customer` field identifies an owner or CSM, so per-owner balancing is unimplementable and Out of Scope. Interpreted instead as two caps: `maxPerCustomer` (default 3), highest-scoring kept, and `maxAlerts` (default 25). Suppressed alerts are counted in `suppressedByCap` and surfaced as "+N more" rather than silently dropped. With eight mock customers the global cap cannot bind (8 × 3 = 24 < 25), so it is exercised against a synthetic 200-customer set in tests, not against the fixtures.

#### Alert State, Deduplication, Cooldown, and Delivery Timing

**`src/server/alertStateStore.ts`** — process-local, not durable. Header comment must say so.

```ts
export interface AlertStateEntry {
  key: string;                 // `${customerId}:${ruleId}` — the dedup identity
  firstDetectedAt: string;
  lastTriggeredAt: string;
  lastNotifiedAt: string | null;
  status: 'active' | 'dismissed' | 'actioned';
  statusChangedAt: string | null;
  occurrenceCount: number;
}

export interface AuditEntry {
  at: string;
  key: string;
  event: 'triggered' | 'notified' | 'notification_suppressed' | 'dismissed' | 'actioned' | 'reactivated';
  detail?: string;             // template text only, never raw customer data
}

export function getState(): ReadonlyMap<string, AlertStateEntry>;
export function reconcile(alerts: ScoredAlert[], now: number, thresholds: AlertThresholds): void;
export function recordAction(key: string, action: 'dismiss' | 'action', now: number): AlertStateEntry;
export function getAudit(): readonly AuditEntry[];
export function getFatigueMetrics(now: number): FatigueMetrics;
export function reset(): void;   // tests only
```

- **Dedup key is `${customerId}:${ruleId}`.** A re-trigger while an entry exists updates `lastTriggeredAt`, increments `occurrenceCount`, and preserves `firstDetectedAt` — it never creates a second row. Deduplication is by identity, not by message-text comparison, which would break the moment a threshold value changed inside the string.
- **Cooldown suppresses *notification*, not *detection*.** High: 48 hours since `lastNotifiedAt`. Medium: 168 hours. An alert inside its cooldown still appears in the widget list — it just does not re-notify, and the suppression is logged as `notification_suppressed` so fatigue metrics can count it. Suppressing detection would make a risk vanish from the dashboard while it is still live, which is the opposite of the feature's purpose.
- **Dismissal expires on a timer *or* on rule-stop, whichever comes first** (`dismissalTtlHours`, default 168). Revision 1 required the rule to "stop firing for a full evaluation" — unreachable, because signals are deterministic and a firing rule fires forever, which made dismissal permanent and silently hid live risk. That is the exact outcome revision 1's own rationale rejected. On expiry the entry returns to `active`, `occurrenceCount` is preserved, and the transition is logged as `reactivated`.
- **Audit log:** append-only ring buffer, 1000 entries, covering triggers, notifications, suppressions, and user actions (requirement line 71). Not a compliance audit trail — it is process-local and resets on restart.
- **Business hours** (`src/lib/businessHours.ts`): Mon–Fri, 09:00–17:00. **The timezone comes from the client**, sent as an IANA string on the request and validated against `Intl.supportedValuesOf('timeZone')`; the server's own resolved zone is a fallback only. Delivery timing is a user-facing decision, so resolving it in the server's zone — as revision 1 did — is wrong for exactly the non-server-timezone user its own DST note warned about. Compute local parts with `Intl.DateTimeFormat`, never `getHours()` on a UTC-parsed date and never a fixed offset. Outside the window, notification is deferred to the next window open; the list still updates live. Holidays are Out of Scope.

#### Service Layer — `src/services/PredictiveIntelligenceService.ts`

- `getIntelligence(request: IntelligenceRequest): Promise<PredictiveIntelligenceResult>` where the request carries `customerIds`, optional `priority` filter, optional `timezone`, and optional `thresholds` override.
- Owns `toHealthScoreInput(signals, now)` — the unit-converting, delta-computing adapter described in **Health Score Integration**.
- Orchestration order: validate input → load customers → resolve **cached inputs** (signals + health + market) per customer → `alertEngine` with `priorState` from the store → `reconcile` the store → apply cooldown/business-hours to compute `notificationSuppressedUntil` → filter dismissed → rank.
- Constructor takes `{ now?: () => number; ttlMs?: number; delayMs?: () => number; marketService?: MarketIntelligenceService }`, defaulting to `Date.now`, `60_000`, and a 200–600ms simulated delay. Without the injected clock, the TTL, the cooldown windows, the dismissal TTL, and the business-hours logic are all untestable except by waiting.
- **The cache holds inputs, not results.** `Map<string, { signals, health, market, expiresAt }>` keyed by customer id, 60-second TTL, bounded at 200 entries with **true LRU** — on each hit `delete` then re-`set` the entry to move it to the tail, because a plain `Map` preserves insertion order, not access order, and skipping that step silently degrades to FIFO. Expired entries are evicted on access, never served stale. `clearCache()` exposed for tests. Revision 1 cached scored alerts per customer and then asserted that two requests inside the TTL return an identical `evaluatedAt` — unsatisfiable, since `evaluatedAt` is a property of the assembled response and per-customer entries expire independently. `evaluatedAt` is now always the current time, and identity across requests is asserted on the cached *inputs* instead.
- **Market failures degrade, they do not fail.** A rejected or timed-out market fetch yields `market: null` for that customer, sets `marketDataAvailable: false`, and internal rules still evaluate. Never substitute a neutral-positive default — that reads as "no market risk", which is a false negative.
- Market fetches across customers run concurrently via `Promise.allSettled`, not sequentially, and not `Promise.all` (one rejection would discard every other customer's data).
- **Errors:** all failures throw `PredictiveIntelligenceError` (`src/services/errors.ts`) with `code: 'INVALID_INPUT' | 'RATE_LIMITED' | 'INTERNAL'` and a user-safe message.

#### API Layer

**`GET /api/predictive-intelligence`** — the read path.

- Route Handler at `src/app/api/predictive-intelligence/route.ts`. A collection route, not `[customerId]` — the widget needs a ranked list *across* customers, and per-customer requests would make the caps and ranking impossible to compute correctly.
- Query params: `customerIds` (optional comma-separated, defaults to all mock customers, max 50), `priority` (optional `high|medium`), `timezone` (optional IANA string).
- Validation via `src/lib/validateIntelligenceRequest.ts`: ids match `/^[A-Za-z0-9_-]{1,64}$/`; `priority` is one of the two literals; `timezone` is a supported IANA zone. Anything else is `400 / INVALID_INPUT`. Unknown-but-well-formed ids are reported in `unknownIds` rather than failing the whole request.
- Success (200):

```ts
interface PredictiveIntelligenceResponse {
  alerts: Alert[];                 // ranked, capped, dismissed entries excluded
  summary: { high: number; medium: number; suppressedByCap: number; customersEvaluated: number };
  marketDataAvailable: boolean;
  unknownIds: string[];
  skipped: SkippedClause[];
  evaluatedAt: string;             // ISO 8601, always the current time
}

interface Alert {
  id: string;                      // stable: `${customerId}:${ruleId}`
  customerId: string;
  customerName: string;
  company: string;
  ruleId: AlertRuleId;
  priority: AlertPriority;         // 'high' when escalated; filter and summary use this field
  escalated: boolean;
  priorityScore: number;           // 20..100
  severity: number;
  triggeredClause: string;
  title: string;
  message: string;
  recommendedActions: string[];
  evidence: Array<{ label: string; value: string }>;
  firstDetectedAt: string;
  lastTriggeredAt: string;
  occurrenceCount: number;
  notificationSuppressedUntil: string | null;
  status: 'active' | 'actioned';   // 'dismissed' never reaches the client from GET
}
```

**`POST /api/predictive-intelligence/actions`** — the write path, and the reason dismissal works at all.

- Body: `{ alertId: string; action: 'dismiss' | 'action' }`. `alertId` must match `/^[A-Za-z0-9_-]{1,64}:[A-Z_]{1,40}$/` and name a key present in the store; unknown keys return `404` — this is the one place a 404 is reachable, since a client can legitimately reference an alert the server has since dropped.
- Returns `200` with the updated `AlertStateEntry`, and writes an audit entry.
- `Content-Type` must be `application/json`; anything else is `415`.

**Both routes:**
- **In-memory rate limiting** (`src/server/rateLimit.ts`): fixed-window token bucket keyed by `x-forwarded-for` (falling back to a single shared bucket when absent), 60 GET/min and 30 POST/min. Exceeding it returns `429` with a `Retry-After` header. Revision 1 dismissed requirement line 70 as needing a backend, but the route handler *is* server-side and an in-memory limiter is a few lines. It is process-local and trivially bypassed by a distributed client — say so in a comment; only *durable, multi-instance* limiting is Out of Scope.
- Error body: `{ error: string }` — user-safe, no stack trace, no internal path. Log the real error server-side.
- Status mapping: `400` invalid input, `404` unknown `alertId` on POST only, `415` wrong content type on POST, `429` rate limited, `500` everything else.
- `Cache-Control: no-store`, so HTTP caching cannot mask the service-level TTL.

#### UI Components

**`src/components/PredictiveIntelligenceWidget.tsx`** — client component (`'use client'`).

```ts
interface PredictiveIntelligenceWidgetProps {
  customers: Customer[];
  selectedCustomerId?: string;
  onSelectCustomer?: (id: string) => void;
  pollIntervalMs?: number;        // default 60_000
  className?: string;
}
```

- Sends `Intl.DateTimeFormat().resolvedOptions().timeZone` with each request so business-hours gating uses the viewer's zone.
- Renders: heading "Predictive Intelligence" with a **"Sample data"** badge; a summary row (high / medium counts, "Market data unavailable" chip when `marketDataAvailable` is false); a priority filter; the ranked alert list; a "+N more" affordance when `suppressedByCap > 0`.
- Each row shows a colour-coded priority badge **with its text label** (red "High" / yellow "Medium"), an "Escalated" chip when `escalated`, the customer and company, the alert title, relative age, and an occurrence count when `> 1`. Colour is never the only channel. Because escalation rewrites `priority`, an escalated alert appears under the High filter where its ranking says it belongs.
- `selectedCustomerId` **filters emphasis, not content**: the selected customer's alerts are pinned to the top and visually highlighted, while the full list stays visible. Hard-filtering to the selection would hide a burning high-priority alert for another customer, which defeats a monitoring widget.
- **Polling:** every `pollIntervalMs`, paused when `document.visibilityState === 'hidden'` and refetched immediately on becoming visible. An unconditional interval keeps a backgrounded tab generating work forever.
- **Supersession and timeout are separate concerns and both are required.** Hold one `AbortController` and abort it when a newer request starts, so a slow response can never overwrite fresh data. Independently apply an 8-second timeout surfacing a retryable "Request timed out" error. An abort caused by supersession must render **no** error.
- A `429` renders a "Refreshing too quickly — retrying shortly" notice and backs the poll off to the `Retry-After` value; it is not an error state.
- Poll failures do not discard good data: keep the last successful list on screen with a subdued "Last updated HH:MM · retrying" indicator, and only show the full error state when there has never been a successful load.
- States: `idle | loading | success | error`. Zero alerts is a positive confirmation ("No active alerts across N customers"), not a spinner and not an error.
- Dismiss / Mark actioned `POST` to the action route and optimistically remove the row, rolling back and surfacing a message if the request fails.
- Accessibility: the list region is `aria-live="polite"` and `aria-atomic="false"` so a new alert is announced without re-reading the whole list; rows are keyboard-focusable and open the detail panel on Enter/Space; the filter is a labelled control.

**`src/components/AlertDetailPanel.tsx`** — full message, `triggeredClause`, evidence table (including the supporting-signal annotations: payment-delay drift, satisfaction trend, usage-depth trend), recommended actions, detection history (`firstDetectedAt`, `occurrenceCount`, cooldown state), the health-factor breakdown when `calculateHealthScore` is available, and Dismiss / Mark actioned controls. Focus is trapped while open, Escape closes, and focus returns to the originating row.

**`src/components/AlertHistoryView.tsx`** — the audit log from `GET /api/predictive-intelligence/history`: dismissed, actioned, and reactivated alerts with timestamps, filterable by customer and rule, plus JSON and CSV export.

**`src/components/AlertFatiguePanel.tsx`** — requirement line 97, "alert fatigue monitoring and optimization recommendations", which revision 1 neither specified nor excluded despite it being computable from local data. Renders `FatigueMetrics`:

```ts
interface FatigueMetrics {
  notificationsSuppressedByCooldown: number;
  dismissalRateByRule: Array<{ ruleId: AlertRuleId; triggered: number; dismissed: number; rate: number }>;
  medianHoursToAction: number | null;
  reactivationsAfterDismissal: number;
  recommendations: string[];        // template text, e.g. "SUPPORT_TICKET_SPIKE is dismissed 80% of the time — consider raising ticketCount"
}
```

Recommendations are generated from fixed templates against a stated rule (dismissal rate above 60% over at least 5 triggers), not free text, and are labelled as suggestions rather than automatic changes. Thresholds are never self-modified.

#### Dashboard Integration

- Rendered by `Dashboard` in the responsive grid alongside sibling widgets, using the shared card wrapper, spacing, and typography. It is a full-width or two-column-spanning card: a ranked list needs more horizontal room than a single-metric widget.
- Receives `customers` and the Dashboard's `selectedCustomerId`; calls `onSelectCustomer` when a row is activated, so clicking an alert selects that customer and the other widgets follow. The Dashboard owns selection — no new global state, no fetching in the parent.
- Wrapped in `ErrorBoundary` so a widget crash degrades to a fallback card instead of blanking the dashboard.

## Constraints

### Technical Stack
- Next.js 15 App Router with Route Handlers; `params`/`searchParams` are `Promise`-based in Next 15
- React 19 function components and hooks
- TypeScript strict mode; all exported interfaces explicitly typed; no `any`
- Tailwind CSS v4 with the existing design-system colours
- No new **runtime** dependencies. Vitest is added as a devDependency (see Testing)

### File Structure
- `src/types/alerts.ts` — shared alert types, imported by lib, server, service, route, and components
- `src/lib/alerts.ts` — rules engine and priority scoring (pure)
- `src/lib/alertThresholds.ts` — `AlertThresholds`, `DEFAULT_THRESHOLDS`, `validateThresholds`
- `src/lib/businessHours.ts` — delivery-window helpers (pure)
- `src/lib/validateIntelligenceRequest.ts` — single validation source of truth for the routes and the widget
- `src/server/alertStateStore.ts` — process-local alert state, audit log, fatigue metrics
- `src/server/rateLimit.ts` — in-memory fixed-window limiter
- `src/services/PredictiveIntelligenceService.ts`
- `src/services/errors.ts` — `PredictiveIntelligenceError` (extend the file if the market spec already created it)
- `src/app/api/predictive-intelligence/route.ts` — `GET`
- `src/app/api/predictive-intelligence/actions/route.ts` — `POST`
- `src/app/api/predictive-intelligence/history/route.ts` — `GET` audit log and fatigue metrics
- `src/components/PredictiveIntelligenceWidget.tsx`, `AlertDetailPanel.tsx`, `AlertHistoryView.tsx`, `AlertFatiguePanel.tsx`, `ErrorBoundary.tsx`
- `src/data/mock-customer-signals.ts` — new; **do not modify `mock-customers.ts`**
- `src/data/mock-market-intelligence.ts` — exists; extend per M1–M4 of the market spec **and pin the two sentiment profiles** named in Market Signal Preconditions

There is deliberately **no** `src/lib/alertStore.ts`. Revision 1 had one, in `localStorage`, which created a second source of truth the server could not read.

### Testing

The repository has no test runner, so every threshold, cooldown, and cache criterion below is otherwise unverifiable. Add Vitest as a devDependency with `"test": "vitest run"`, plus:

- `src/lib/alerts.test.ts` — each of the seven rules at threshold, threshold−1, threshold+1; skipped-clause cases, including a rule that fires *and* skips; the low-volume guard at 3 and 4 baseline logins; cliff-suppresses-trend; supporting signals never triggering alone; compound escalation rewriting `priority`; priority ordering and tie-breaks; caps
- `src/lib/alertThresholds.test.ts` — partial overrides deep-merge, invalid values throw, whole-object validation catches bad combinations
- `src/lib/businessHours.test.ts` — inside and outside the window, weekend, a DST transition day, and an explicitly passed non-server timezone
- `src/server/alertStateStore.test.ts` — dedup key stability, `occurrenceCount` increments without duplicating rows, dismissal round-trip, dismissal-TTL expiry restoring `active` with the count preserved, cooldown suppression logged, ring-buffer cap, fatigue-metric arithmetic
- `src/server/rateLimit.test.ts` — window boundary, per-key isolation, `Retry-After` value
- `src/services/PredictiveIntelligenceService.test.ts` — `toHealthScoreInput` cents-to-currency conversion and clock-derived deltas, input-cache hit/miss, TTL expiry via the injected clock, LRU eviction at the 200-entry cap, scores recomputed (not cached) as the clock advances, market-fetch failure degrading to `market: null` with internal alerts intact, thrown error types
- `src/data/mock-customer-signals.test.ts` — determinism per id, newest health snapshot equals `customer.healthScore`, and every row of the pinned fixture table producing exactly its intended outcome
- `src/lib/alerts.caps.test.ts` — the global cap against a synthetic 200-customer set, since eight fixtures cannot reach it

Assert all time behaviour by advancing the injected clock. Never `sleep`, and never compare wall-clock durations.

### Performance
- Rule evaluation is O(customers × rules) with no nested customer scans and no per-customer market refetch inside the loop. Assert the **algorithmic shape** — evaluating 500 customers performs exactly 500 × 7 rule invocations and one market lookup per distinct company — rather than a millisecond figure, which varies by machine and makes CI flaky. If a wall-clock guard is wanted, use a deliberately loose ceiling (1s for 500 customers) and label it a smoke test.
- Cache hits return without the simulated delay; input cache bounded at 200 entries, LRU by access order
- Polling pauses on a hidden tab; the widget does not refetch when its inputs are unchanged between renders
- Alert rows are memoized on `id` plus `lastTriggeredAt` plus `priorityScore`, so a poll returning identical data causes no list re-render

### Security
- Validation and normalization happen on the server; client-side validation is a convenience, never the enforcement point
- Rule parameters are validated too, via `validateThresholds`, satisfying requirement line 68's "customer data **and rule parameters**"
- **No PII in alert content.** `message`, `title`, and `evidence` are built from fixed templates plus numeric values, with an explicit allowlist of permitted fields: customer name, company, rule name, threshold values, day counts, health-score values, ARR band. Explicitly forbidden: `email`, `domains`, exact overdue amounts, ticket bodies, and any raw upstream text. Free-text interpolation from a data field into a message is prohibited — that is how PII and markup leak. `AuditEntry.detail` is under the same rule.
- All alert text renders as React children; never `dangerouslySetInnerHTML`
- Market headline URLs, when surfaced in the detail panel, render with `rel="noopener noreferrer"` and `target="_blank"`, and only `https:` URLs are rendered as links
- **CSV export escapes formula injection.** A cell beginning with `=`, `+`, `-`, `@`, tab, or CR is prefixed with `'`, and quotes are doubled. Without this, exported alert data executes on open in Excel and Sheets.
- Error messages returned to the client are generic — no internal paths, stack traces, or upstream detail
- Rate limiting is enforced server-side but is process-local and defeatable by a distributed client; the per-customer and global alert caps are **fatigue controls, not security controls**, and must be commented as such. The audit log is not a compliance audit trail.
- Mock-only generation means no API keys, no outbound requests, and no third-party trust boundary

### Out of Scope

Each of these appears in the source requirements and is excluded with a reason, so the omission is not read as an oversight:

- **Durable and multi-instance alert state** — the store is a module-level `Map`, so state resets on server restart and is not shared between server instances. Cross-*session* sync (requirement line 85) **is** supported, because all sessions read one server-side store; cross-*deployment* durability is not.
- **Alert-effectiveness correlation with actual customer outcomes** — requires longitudinal real outcome data. Mock data has no ground truth to correlate against, so any number produced would be fabricated. Fatigue metrics, which need no ground truth, *are* in scope.
- **A/B testing framework for threshold tuning** — needs cohort assignment, durable persistence, and statistical power a single-process mock app cannot supply. Thresholds are configurable and fatigue metrics recommend changes, but nothing self-tunes.
- **Real external data sources** (payment processor, product analytics, support desk) — the feature is mock-only by design.
- **True real-time push** (WebSocket/SSE) — a 60-second poll is the stated mechanism; the UI must not claim more.
- **Owner/CSM-based workload balancing** — no owner field exists on `Customer`.
- **Holiday calendars** in business-hours logic.
- **Resource-usage/system-performance telemetry** (requirement line 98) — meaningful only against a real deployment with a metrics backend.

## Acceptance Criteria

### Rules Engine
- [ ] Each of the seven rules is a separately exported pure function returning `RuleResult | null`, with no clock, network, or storage access inside `src/lib/alerts.ts`
- [ ] `PAYMENT_RISK` fires at 31 days overdue and not at 30; fires on a 21-point 7-day drop and not on 20
- [ ] A rule that fires on one clause while another clause is unevaluable returns the alert **and** a `SkippedClause` for the second — verified with a 40-days-overdue customer holding a single health snapshot
- [ ] A health-drop-triggered `PAYMENT_RISK` carries `triggeredClause: 'healthDrop'` and a title naming the health drop, not "Payment Risk"
- [ ] `ENGAGEMENT_CLIFF` fires at 4 baseline logins and is skipped at 3, however large the percentage drop
- [ ] `ENGAGEMENT_DECLINE_TREND` fires on `[12, 8, 5]` and does not fire when `ENGAGEMENT_CLIFF` fired for the same customer
- [ ] `CONTRACT_EXPIRATION_RISK` fires at 89 days with health 49, and not at 90 days, not at health 50, and not when already expired
- [ ] `SUPPORT_TICKET_SPIKE` fires on 4 tickets and on any escalated ticket, and not on 3 unescalated tickets
- [ ] `FEATURE_ADOPTION_STALL` fires only for accounts meeting the growing definition, and never for an account under 30 days old
- [ ] `MARKET_SENTIMENT_RISK` fires only on `negative` with confidence ≥ 0.6 and health < 70, and never when `market` is `null`
- [ ] No supporting signal (payment-delay drift, satisfaction trend, usage-depth trend) can produce an alert on its own; each only adjusts `severity` and `evidence` on an already-firing rule
- [ ] `market: null` produces no market alert and does not suppress any internal alert
- [ ] Co-occurrence with a high alert sets `escalated: true` **and** `priority: 'high'`, so the alert appears under the High filter and in `summary.high`, without creating an extra alert
- [ ] `priorityScore` is an integer within **20–100**; identical input yields byte-identical ordering across runs, including ties
- [ ] `AlertEngineOptions`, `AlertEngineInput`, and `AlertEngineResult` are all explicitly defined and exported; the engine computes recency from `priorState` with no ambient state access
- [ ] More than 3 alerts for one customer keeps the top 3 and counts the rest in `suppressedByCap`; the global cap is exercised against a 200-customer synthetic set

### Thresholds
- [ ] Every threshold in the rule table is reachable through `AlertThresholds`; none is a literal inside a rule function
- [ ] A partial override deep-merges over `DEFAULT_THRESHOLDS` and is validated as a whole object
- [ ] `validateThresholds` rejects non-finite numbers, non-integer day counts, ratios outside `(0, 1]`, and out-of-range health ceilings

### State, Cooldown, and Timing
- [ ] Re-triggering the same customer/rule updates `lastTriggeredAt` and increments `occurrenceCount` without creating a second alert or resetting `firstDetectedAt`
- [ ] An alert inside its cooldown still appears in the list, does not re-notify, and logs `notification_suppressed`; high uses 48h, medium 168h
- [ ] A dismissed alert is excluded from `GET`, and returns as `active` with `occurrenceCount` preserved once `dismissalTtlHours` elapses — verified by advancing the injected clock, without requiring the rule to stop firing
- [ ] Business-hours gating defers notification only, uses the **client-supplied** timezone, and is correct on a DST transition day and for a zone different from the server's
- [ ] An invalid `timezone` value returns 400 rather than silently falling back
- [ ] The audit log records triggers, notifications, suppressions, dismissals, actions, and reactivations, and is capped at 1000 entries
- [ ] Every session sees the same alert state — two concurrent `GET`s after a dismissal both omit the dismissed alert

### Service and API
- [ ] `GET /api/predictive-intelligence` returns 200 with `alerts`, `summary`, `marketDataAvailable`, `unknownIds`, `skipped`, and `evaluatedAt`
- [ ] Every state field in the response (`firstDetectedAt`, `lastTriggeredAt`, `occurrenceCount`, `notificationSuppressedUntil`, `status`) is populated from the server store — no field is a placeholder
- [ ] A malformed `customerIds` or `priority` value returns 400 with a sanitized `{ error }` body and generates no data; a well-formed unknown id returns 200 and appears in `unknownIds`
- [ ] More than 50 ids returns 400
- [ ] `POST /api/predictive-intelligence/actions` records a dismissal and returns the updated entry; an unknown `alertId` returns 404; a non-JSON content type returns 415
- [ ] Exceeding 60 GET/min or 30 POST/min returns 429 with `Retry-After`, and buckets are isolated per client key
- [ ] Internal failures return 500 with a generic message; no stack trace or internal path appears in the body
- [ ] Responses carry `Cache-Control: no-store`
- [ ] Two requests inside the 60s TTL reuse the cached signals and market data — asserted by counting generator and market-service invocations — while `evaluatedAt` and `priorityScore` are recomputed each time
- [ ] Advancing the injected clock past the TTL regenerates the inputs; advancing it 3 days lowers `recencyPoints` for an unchanged alert, proving scores are not cached
- [ ] Inserting 201 distinct customers evicts the least-recently-*accessed* entry, not the oldest-inserted — verified by reading an early entry before overflowing the cache
- [ ] A market fetch that rejects for one customer leaves every other customer's market data intact and internal alerts unaffected
- [ ] The service throws `PredictiveIntelligenceError`, not a bare `Error`, and the route maps `INVALID_INPUT` to 400 and `RATE_LIMITED` to 429

### Health Score Integration
- [ ] No rule reads a computed `calculateHealthScore` total; all three health-gated rules read `customer.healthScore`
- [ ] `toHealthScoreInput` converts `overdueAmountCents` and `arrCents` to currency units — asserted with a fixture whose cents value would otherwise inflate overdue severity 100×
- [ ] Every day-delta passed to `calculateHealthScore` is derived from the service's injected `now`; `healthCalculator.ts` gains no clock access
- [ ] When the recalculated total differs from `customer.healthScore`, the detail panel shows both and labels the computed one "recalculated"

### Mock Data
- [ ] The same customer id yields identical signals across repeated calls and process restarts; no `Math.random()` remains in the module
- [ ] The newest `healthHistory` entry equals `customer.healthScore` for every one of the eight `mockCustomers`
- [ ] Each row of the pinned fixture table produces exactly its stated outcome, asserted per row: `1` and `7` fire nothing, `1` at 29 days overdue stays silent, `2` yields a compound escalation, `3` fires at 89 days to renewal, `6` trips only the trend rule, `8` fires nothing despite absent data
- [ ] All seven rules fire at least once across the fixture set
- [ ] `arrCents` ordering is consistent with `subscriptionTier`
- [ ] `src/data/mock-customers.ts` is unmodified

### Widget
- [ ] Loading state on first load, ranked list on success, sanitized error with retry when there has never been a successful load
- [ ] Priority badges pair colour with a text label; red for high, yellow for medium; escalated alerts carry an "Escalated" chip and appear under the High filter
- [ ] Zero alerts renders a positive confirmation naming the number of customers evaluated — not a spinner, not an error
- [ ] A "Sample data" badge is visible whenever alerts are displayed
- [ ] `marketDataAvailable: false` shows an explicit "Market data unavailable" chip and the internal alerts still render
- [ ] Selecting a customer pins and highlights their alerts while the full list stays visible; activating a row calls `onSelectCustomer`
- [ ] The request carries the browser's resolved IANA timezone
- [ ] Polling stops while the tab is hidden and refetches immediately on becoming visible
- [ ] Rapid successive polls never leave stale data on screen — the last request wins, and a superseded request renders no error
- [ ] A request exceeding 8 seconds surfaces a retryable timeout error rather than an indefinite spinner
- [ ] A 429 backs off to `Retry-After` and shows a throttling notice rather than an error state
- [ ] A failed poll after a successful one keeps the previous list visible with a retry indicator instead of blanking or erroring
- [ ] A poll returning identical data causes no visible list re-render
- [ ] Dismissing a row removes it optimistically and rolls back with a message when the POST fails
- [ ] Suppressed alerts appear as "+N more", never silently dropped
- [ ] No alert message, title, evidence field, or audit detail contains an email address, a domain, or any exact monetary amount — asserted programmatically over every generated alert for all `mockCustomers`
- [ ] The detail panel shows `triggeredClause` and the supporting-signal evidence, traps focus, closes on Escape, and returns focus to the originating row
- [ ] The fatigue panel reports suppressed-notification counts, per-rule dismissal rates, median hours-to-action, and template-generated recommendations; no threshold is ever changed automatically
- [ ] CSV export prefixes cells beginning with `=`, `+`, `-`, `@`, tab, or CR with `'`
- [ ] A thrown render error is caught by `ErrorBoundary` and shows a fallback card without blanking the dashboard
- [ ] The widget matches sibling widgets at mobile, tablet, and desktop widths — or, if no sibling exists yet, uses the fallback card shell from Prerequisites

### Build
- [ ] `npm run type-check`, `npm run lint`, and `npm test` all pass with no errors or warnings

## Appendix: Review Response

Findings from the adversarial review against `@requirements/predictive-alerts.md`, and where revision 2 addresses each.

| # | Finding | Resolution |
|---|---|---|
| 1 | Server cannot read `localStorage`, so response state fields were unpopulatable | **State Ownership**; `src/server/alertStateStore.ts`; `POST /actions`; `src/lib/alertStore.ts` deleted |
| 2 | Pure `alertEngine` lacked inputs for its own ranking; `AlertEngineOptions`/`Result` undefined | `AlertEngineInput.priorState`; all three interfaces defined |
| 3 | Per-customer cache could not satisfy the cross-customer TTL criteria; cached scores go stale | Cache holds **inputs**; scoring and ranking recomputed per request; TTL criterion rewritten to count generator invocations |
| 4 | "Configurable thresholds" (req. 13) and "rule parameters" validation (req. 68) unmet | `src/lib/alertThresholds.ts` with `validateThresholds` |
| 5 | "Gradual vs sudden engagement drops" (req. 28) — only sudden specified | New `ENGAGEMENT_DECLINE_TREND` rule, suppressed when the cliff fires |
| 6 | Three signal fields dead, masking Data Monitoring reqs. 29–31 | Supporting-signal annotations on payment, support, and adoption rules, with prior-period fields added; they annotate but never trigger |
| 7 | Alert-fatigue monitoring (req. 97) neither specified nor excluded | `AlertFatiguePanel` + `getFatigueMetrics` |
| 8 | Rate limiting (req. 70) waved off as needing a backend | `src/server/rateLimit.ts`, 429 + `Retry-After`, with the process-local limit stated |
| 9 | Escalated alert kept `priority: 'medium'`, so the High filter hid the top-ranked alert | Escalation rewrites `priority` to `'high'`; `escalated` retained as provenance |
| 10 | Dismissal could never re-surface under deterministic signals | `dismissalTtlHours` (default 168) or rule-stop, whichever comes first |
| 11 | Engagement guard at 0.5 logins/day silenced ordinary weekly users | Guard is now an absolute `loginsTrailing30To7Days >= 4` |
| 12 | `PAYMENT_RISK` title wrong when the health-drop clause fired | `triggeredClause` drives the title and evidence |
| 13 | "Fires XOR skipped" invariant broken by `PAYMENT_RISK` | `SkippedClause` is per-clause; a rule may fire and skip |
| 14 | Fixture guarantees crossed the market module's seed boundary | Pinned fixture table + two pinned sentiment profiles in the market spec |
| 15 | Business hours resolved in the server's timezone for a user-facing decision | Client sends its IANA zone; server zone is a fallback; invalid zone is a 400 |
| 16 | `priorityScore` floor was 20 not 0; 50ms budget self-contradictory; `maxAlerts` unreachable | Range documented as 20–100; performance asserted on invocation counts; global cap tested against 200 synthetic customers |
