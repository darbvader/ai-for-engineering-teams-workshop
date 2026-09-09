# Feature: PredictiveIntelligence

## Context
- Proactive risk-monitoring feature for the Customer Intelligence Dashboard. It fuses two evidence streams into one ranked alert list:
  - **Internal signals** — payment behaviour, login engagement, contract runway, support tickets, feature adoption (`@requirements/predictive-alerts.md`)
  - **External market signals** — news sentiment for the customer's company (`@requirements/market-intelligence.md`)
- The value of combining them is that neither stream alone is decisive. A health-score dip plus negative press is a stronger churn indicator than either signal in isolation, and this spec makes that compounding explicit rather than leaving it to the reader of two separate widgets.
- Composed of six layers: a deterministic mock signals module (new), a pure rules engine (`src/lib/alerts.ts`), a service that orchestrates signals + health + market data, an API route, a dashboard widget with detail/history panels, and client-side dismissal/audit state.
- **All data is mock.** Internal signals are generated deterministically from the customer id; market data comes from `src/data/mock-market-intelligence.ts`. There are no external APIs, no API keys, and no third-party trust boundary.
- The source requirements call this "real-time monitoring". It is not real-time and must not be presented as such. It is a 60-second poll over locally generated data. The UI labels it as sample data so a demo audience is never misled.

## Prerequisites and Pattern Sources

**This spec forward-references modules that do not exist in the repository yet.** At the time of writing, `src/` contains only `app/{layout,page,globals.css,favicon.ico}` and `data/{mock-customers,mock-market-intelligence}.ts`. There is no `src/components/`, no `src/lib/`, no `src/services/`, and no API route of any kind. `src/app/page.tsx` loads `CustomerCard` through a `require()` placeholder because it is built in a later exercise.

Every "match the existing pattern" instruction below is therefore conditional. For each dependency:

| Dependency | If it exists when you implement | If it does not exist |
|---|---|---|
| `calculateHealthScore` (`src/lib/healthCalculator.ts`, per `@requirements/health-score-calculator.md`) | Call it to derive the current score and per-factor breakdown; surface the breakdown in the alert detail panel | Use the static `customer.healthScore` field and omit the factor breakdown from the detail panel |
| `MarketIntelligenceService` (`@specs/market-intelligence-spec.md`) | Call `getMarketIntelligence(company)` and reuse its cache | Call `generateMockMarketData` / `calculateMockSentiment` directly, and see **Market Signal Preconditions** below |
| `CustomerSelector` / `Dashboard` | Receive `selectedCustomer` via props from the Dashboard's existing selection state | Render standalone against `mockCustomers` with an internal selector stub |
| Sibling widget card shell, loading and error states | Copy padding, border, radius, heading treatment, skeleton and error banner verbatim | Use the fallback card shell below |
| `ErrorBoundary` (`src/components/ErrorBoundary.tsx`) | Wrap the widget in it | Introduce it here; it is a plain class-based boundary |

**Fallback card shell:** `rounded-lg border border-gray-200 bg-white p-4 shadow-sm`, heading `text-lg font-semibold text-gray-900 mb-3`, body `text-sm text-gray-600`. Priority colour language mirrors the health-score banding used elsewhere in the dashboard (red 0–30 / yellow 31–70 / green 71–100): red = high priority, yellow = medium priority, green = no alerts.

Do not claim conformance to a pattern you did not actually open and read.

### Market Signal Preconditions

`src/data/mock-market-intelligence.ts` as shipped **cannot** drive the market dimension of this feature. Verified by running it against the eight `mockCustomers` companies: every company returns `label: 'positive'` with `score` saturated at exactly `1.000`, because no template contains a negative keyword and `totalScore / totalWords * 10` clamps to 1 for any input. A negative-sentiment alert is therefore unreachable.

The fixes are specified as M1–M4 in `@specs/market-intelligence-spec.md` (negative/neutral templates, deterministic seeding, non-saturating score, populated `url`). **Implement those first.** If they are not yet in place, `MARKET_SENTIMENT_RISK` must be built and unit-tested against injected sentiment values, and the market dimension reported as unavailable at runtime rather than silently returning "all positive".

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
  daysOverdue: number;              // 0 when current
  overdueAmountCents: number;
  averagePaymentDelayDays: number;
  lastPaymentAt: string | null;     // null for a customer who has never paid
}
export interface EngagementSignals {
  loginsLast7Days: number;
  loginsTrailing30To7Days: number;  // 23-day window ending 7 days ago; see baseline note
  distinctFeaturesUsedLast30Days: number;
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
  averageSatisfaction: number | null;   // 1..5, null when no rated tickets
}
export interface CustomerSignals {
  customerId: string;
  healthHistory: HealthSnapshot[];      // ascending by date, >= 1 entry, <= 30 entries
  payment: PaymentSignals;
  engagement: EngagementSignals;
  contract: ContractSignals;
  support: SupportSignals;
  generatedAt: string;
}

export function generateMockSignals(customerId: string, now?: number): CustomerSignals;
```

- **Deterministic.** Seed a pseudo-random generator with an FNV-1a hash of `customerId` — the same approach M2 prescribes for market data. The same customer must yield the same signals across repeated calls and across process restarts. `Math.random()` is prohibited: it makes every alert unreproducible and every assertion flaky.
- **Clock-injectable.** All relative dates derive from the `now` argument (default `Date.now()`), never from a bare `new Date()` inside the generator, so tests can place a customer 89 or 91 days from renewal without waiting.
- **Consistent with the displayed score.** The newest `healthHistory` entry must equal `customer.healthScore` exactly. Otherwise the widget shows one number while the alert reasons about another, and the alert looks like a bug.
- **Fixture coverage is a requirement, not a coincidence.** Across the eight `mockCustomers`, the generated signals must satisfy:
  - each of the six rules in **Alert Rules** fires for at least one customer
  - at least two customers produce **zero** alerts, so the empty state is reachable
  - at least one customer produces a compound-risk escalation (see below)
  - at least one customer sits within 2 units of a threshold on either side, exercising the boundary
  - at least one customer has deliberately missing data (`lastPaymentAt: null`, single-entry `healthHistory`, `renewalDate: null`) to prove absent data does not fire an alert

  These are asserted in `mock-customer-signals.test.ts`, not left to inspection.
- **ARR.** `@requirements/predictive-alerts.md` requires prioritisation by customer value, and no ARR field exists anywhere in the repo. `arrCents` lives here, and must correlate with `subscriptionTier` (enterprise > premium > basic) so the ranking looks defensible in a demo rather than arbitrary.

**Baseline window note.** The requirement says login frequency versus "the 30-day average", but the trailing 30 days *includes* the 7-day drop being measured, which dampens the very signal being detected. `loginsTrailing30To7Days` therefore covers the 23 days ending 7 days ago, giving a clean pre-drop baseline. This is a deliberate deviation from the literal wording; keep the field name explicit so it cannot be misread as a plain 30-day count.

### Functional Requirements

#### Rules Engine — `src/lib/alerts.ts`

Pure functions only. No `Date.now()`, no `fetch`, no `localStorage`, no logging inside this module — every time-dependent value arrives through the input.

```ts
export type AlertPriority = 'high' | 'medium';
export type AlertRuleId =
  | 'PAYMENT_RISK' | 'ENGAGEMENT_CLIFF' | 'CONTRACT_EXPIRATION_RISK'
  | 'SUPPORT_TICKET_SPIKE' | 'FEATURE_ADOPTION_STALL' | 'MARKET_SENTIMENT_RISK';

export interface RuleInput {
  customer: Pick<Customer, 'id' | 'name' | 'company' | 'healthScore' | 'subscriptionTier'>;
  signals: CustomerSignals;
  market: MarketSignal | null;      // null = unavailable, never treated as neutral-good
  now: number;                      // epoch ms, injected
}
export interface MarketSignal {
  score: number;                    // -1..1
  label: 'positive' | 'neutral' | 'negative';
  confidence: number;               // 0..1
  articleCount: number;
  lastUpdated: string;
}
export interface RuleResult {
  ruleId: AlertRuleId;
  priority: AlertPriority;
  severity: number;                 // 0..1, normalized breach magnitude
  title: string;
  message: string;                  // built from a template; see Security
  recommendedActions: string[];     // 2-3 concrete steps
  evidence: Array<{ label: string; value: string }>;
  triggeredAt: string;              // ISO 8601, derived from `now`
}

// One exported pure function per rule, each returning null when it does not fire.
export function evaluatePaymentRisk(input: RuleInput): RuleResult | null;
export function evaluateEngagementCliff(input: RuleInput): RuleResult | null;
export function evaluateContractExpirationRisk(input: RuleInput): RuleResult | null;
export function evaluateSupportTicketSpike(input: RuleInput): RuleResult | null;
export function evaluateFeatureAdoptionStall(input: RuleInput): RuleResult | null;
export function evaluateMarketSentimentRisk(input: RuleInput): RuleResult | null;

export function alertEngine(inputs: RuleInput[], options?: AlertEngineOptions): AlertEngineResult;
```

**Universal rule invariants, applied to every rule:**
- **Missing data never triggers an alert.** A rule whose inputs are absent, `null`, or insufficient returns `null` and contributes an entry to `AlertEngineResult.skipped` with a reason. Treating "unknown" as "bad" would fire a payment alert at every new customer.
- **Thresholds are exclusive exactly as written.** `>30 days` means 31 triggers and 30 does not. Every boundary has a test at threshold, threshold−1, and threshold+1.
- Rules are independent: no rule reads another's output. Compounding happens only in `alertEngine`.

#### Alert Rules

| Rule | Priority | Trigger | Severity | Skip when |
|---|---|---|---|---|
| `PAYMENT_RISK` | high | `payment.daysOverdue > 30` **OR** health drop `> 20` points over the trailing 7 days | `max` of `min(1, (daysOverdue-30)/60)` and `min(1, (drop-20)/40)` | `healthHistory` has fewer than 2 entries inside the 7-day window (drop clause only; the overdue clause still evaluates) |
| `ENGAGEMENT_CLIFF` | high | `recentRate < 0.5 * baselineRate`, where `recentRate = loginsLast7Days/7` and `baselineRate = loginsTrailing30To7Days/23` | `min(1, (1 - recentRate/baselineRate - 0.5) / 0.5)` | `baselineRate < 0.5` logins/day — see the low-volume guard |
| `CONTRACT_EXPIRATION_RISK` | high | `0 < daysUntilRenewal < 90` **AND** `healthScore < 50` | `min(1, (90-daysUntilRenewal)/90)` | `renewalDate` is null, or `daysUntilRenewal <= 0` (already expired is a billing state, not a prediction) |
| `SUPPORT_TICKET_SPIKE` | medium | `support.ticketsLast7Days > 3` **OR** `support.escalatedTicketLast7Days` | `min(1, (tickets-3)/6)`, floored at `0.5` when escalated | never — zero tickets is valid data, not missing data |
| `FEATURE_ADOPTION_STALL` | medium | account is **growing** **AND** no new-feature first-use in the trailing 30 days | `min(1, growthRate)` | not growing, or the account is under 30 days old per `createdAt` (a new account has not had time to stall) |
| `MARKET_SENTIMENT_RISK` | medium | `market.label === 'negative'` **AND** `market.confidence >= 0.6` **AND** `healthScore < 70` | `min(1, abs(score) * confidence)` | `market` is null, or `articleCount === 0` |

**Growing account** is defined as `seatCount >= seatCount90DaysAgo * 1.1` **OR** `upgradedAt` within the trailing 90 days. `growthRate = seatCount/seatCount90DaysAgo - 1`. Without this definition "growing accounts" in the source requirement is unimplementable.

**Low-volume guard (`ENGAGEMENT_CLIFF`).** A customer who logs in twice a month and then not at all is a 100% drop on a base of noise. Requiring `baselineRate >= 0.5` logins/day means the rule only speaks about accounts with enough history for a drop to mean anything. Without the guard, the lowest-engagement customers generate perpetual alerts and train users to ignore the widget.

**Compound risk.** `MARKET_SENTIMENT_RISK` is medium on its own: mock news sentiment is weak evidence and does not justify interrupting anyone. When it co-occurs with at least one `high` alert for the same customer, `alertEngine` sets `escalated: true` on the market alert and scores it at the high-priority base. Negative press *while* internal metrics are deteriorating is the corroboration the two-stream design exists to surface. Escalation is a flag on the existing alert, never a seventh synthesized alert.

#### Priority Scoring

`priorityScore` is an integer 0–100:

```
priorityScore = tierBase + valuePoints + urgencyPoints + recencyPoints

tierBase      = 50 for high (or an escalated market alert), 20 for medium
valuePoints   = round(20 * min(1, arrCents / 25_000_000))        // saturates at $250k ARR
urgencyPoints = round(20 * severity)
recencyPoints = round(10 * max(0, 1 - hoursSinceFirstDetected / 168))   // decays to 0 over 7 days
```

- Sorted descending. **Ties break deterministically** on `priorityScore desc`, then `ruleId` ascending, then `customerId` ascending — never on `Array.prototype.sort` stability or object key order, so the same input always renders the same list.
- `recencyPoints` uses `firstDetectedAt` from persisted alert state, not `triggeredAt` of the current evaluation. Using the current pass would hold every unresolved alert at a permanent 10 and freeze the ranking.
- **Workload balancing.** The source requirement asks for balancing across workload, but no `Customer` field identifies an owner or CSM, so per-owner balancing is unimplementable and out of scope. Interpreted instead as two caps: at most `maxPerCustomer` (default 3) alerts per customer, highest-scoring kept, and at most `maxAlerts` (default 25) in the returned list. Suppressed alerts are counted in `AlertEngineResult.suppressed` and surfaced as "+N more" rather than silently dropped.

#### Deduplication, Cooldown, and Delivery Timing

```ts
export interface AlertStateEntry {
  key: string;                 // `${customerId}:${ruleId}` — the dedup identity
  firstDetectedAt: string;
  lastTriggeredAt: string;
  lastNotifiedAt: string | null;
  status: 'active' | 'dismissed' | 'actioned';
  occurrenceCount: number;
}
```

- **Dedup key is `${customerId}:${ruleId}`.** A re-trigger while an entry exists updates `lastTriggeredAt`, increments `occurrenceCount`, and preserves `firstDetectedAt` — it never creates a second row. Deduplication is by identity, not by message-text comparison, which would break the moment a threshold value changed inside the string.
- **Cooldown suppresses *notification*, not *detection*.** High-priority: 48 hours since `lastNotifiedAt`. Medium: 168 hours. An alert inside its cooldown still appears in the widget list — it just does not re-notify. Suppressing detection would make a risk vanish from the dashboard while it is still live, which is the opposite of the feature's purpose.
- A `dismissed` entry stays dismissed until the rule stops firing for a full evaluation and then fires again; at that point it returns as `active` with `occurrenceCount` preserved. Without the stop-then-restart requirement, dismissal is either permanent (risk hidden forever) or useless (alert reappears in 60 seconds).
- **Business hours** (`src/lib/businessHours.ts`): Mon–Fri, 09:00–17:00 in a configured IANA timezone, defaulting to `Intl.DateTimeFormat().resolvedOptions().timeZone`. Outside the window, notification is deferred to the next window open; the list still updates live. Compute the local hour with `Intl.DateTimeFormat` parts — **not** `getHours()` on a UTC-parsed date and not a fixed UTC offset, both of which are wrong across DST and for any non-server-timezone user. Holidays are out of scope and stated as such.

#### Service Layer — `src/services/PredictiveIntelligenceService.ts`

- `getIntelligence(customerIds: string[]): Promise<PredictiveIntelligenceResult>` — orchestrates: validate ids → load customers → generate signals → resolve health → fetch market signal per company → `alertEngine` → merge persisted alert state → rank.
- Constructor takes `{ now?: () => number; ttlMs?: number; delayMs?: () => number; marketService?: MarketIntelligenceService; timezone?: string }`, defaulting to `Date.now`, `60_000`, a 200–600ms simulated delay, and the resolved local timezone. Without the injected clock, the 60s TTL, the cooldown windows, and the business-hours logic are all untestable except by waiting.
- **Cache:** `Map<string, { data; expiresAt }>` keyed by customer id, 60-second TTL, bounded at 200 entries with **true LRU** — on each hit `delete` then re-`set` the entry to move it to the tail, because a plain `Map` preserves insertion order, not access order, and skipping that step silently degrades to FIFO. Expired entries are evicted on access, never served stale. `clearCache()` exposed for tests.
- **Market failures degrade, they do not fail.** A rejected or timed-out market fetch yields `market: null` for that customer, sets `marketDataAvailable: false` on the result, and internal rules still evaluate. Market data is one input of five; losing it must never blank the alert list. Never substitute a neutral-positive default for a failed fetch — that reads as "no market risk", which is a false negative.
- Market fetches across customers run concurrently via `Promise.allSettled`, not sequentially, and not `Promise.all` (one rejection would discard every other customer's data).
- **Errors:** all failures throw `PredictiveIntelligenceError` (`src/services/errors.ts`) with `code: 'INVALID_INPUT' | 'INTERNAL'` and a user-safe message.

#### API Layer — `GET /api/predictive-intelligence`

- Route Handler at `src/app/api/predictive-intelligence/route.ts`. A collection route, not `[customerId]` — the widget needs a ranked list *across* customers, and per-customer requests would make the global cap and ranking impossible to compute correctly.
- Query params: `customerIds` (optional comma-separated list, defaults to all mock customers, max 50 ids) and `priority` (optional `high|medium`).
- Validation via `src/lib/validateCustomerIds.ts`: each id matches `/^[A-Za-z0-9_-]{1,64}$/`; anything else is `400 / INVALID_INPUT`. Unknown-but-well-formed ids are reported in `unknownIds` rather than failing the whole request.
- Success (200):

```ts
interface PredictiveIntelligenceResponse {
  alerts: Alert[];                 // ranked, capped
  summary: { high: number; medium: number; suppressed: number; customersEvaluated: number };
  marketDataAvailable: boolean;
  unknownIds: string[];
  evaluatedAt: string;             // ISO 8601
}
interface Alert {
  id: string;                      // stable: `${customerId}:${ruleId}`
  customerId: string;
  customerName: string;
  company: string;
  ruleId: AlertRuleId;
  priority: AlertPriority;
  escalated: boolean;
  priorityScore: number;
  title: string;
  message: string;
  recommendedActions: string[];
  evidence: Array<{ label: string; value: string }>;
  firstDetectedAt: string;
  lastTriggeredAt: string;
  occurrenceCount: number;
  notificationSuppressedUntil: string | null;
  status: 'active' | 'dismissed' | 'actioned';
}
```

- Error body: `{ error: string }` — user-safe, no stack trace, no internal path. Log the real error server-side.
- Status mapping: `400` invalid input; `500` everything else. There is deliberately no `404`: mock generation always succeeds for a well-formed id, so a 404 path would be unreachable code.
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

- Renders: heading "Predictive Intelligence" with a **"Sample data"** badge; a summary row (high / medium counts, "Market data unavailable" chip when `marketDataAvailable` is false); a priority filter; the ranked alert list; a "+N more" affordance when alerts were suppressed by the caps.
- Each row shows a colour-coded priority badge **with its text label** (red "High" / yellow "Medium"), the customer and company, the alert title, relative age, and an occurrence count when `> 1`. Colour is never the only channel.
- `selectedCustomerId` **filters emphasis, not content**: the selected customer's alerts are pinned to the top and visually highlighted, while the full list stays visible. Hard-filtering to the selection would hide a burning high-priority alert for another customer, which defeats a monitoring widget.
- **Polling:** every `pollIntervalMs`, paused when `document.visibilityState === 'hidden'` and refetched immediately on becoming visible. An unconditional interval keeps a backgrounded tab generating work forever.
- **Supersession and timeout are separate concerns and both are required.** Hold one `AbortController` and abort it when a newer request starts, so a slow response can never overwrite fresh data. Independently apply an 8-second timeout surfacing a retryable "Request timed out" error. An abort caused by supersession must render **no** error.
- Poll failures do not discard good data: keep the last successful list on screen with a subdued "Last updated HH:MM · retrying" indicator, and only show the full error state when there has never been a successful load.
- States: `idle | loading | success | error`. Empty state when there are zero alerts is a positive confirmation ("No active alerts across N customers"), not a spinner and not an error.
- Accessibility: the list region is `aria-live="polite"` and `aria-atomic="false"` so a new alert is announced without re-reading the whole list; rows are keyboard-focusable and open the detail panel on Enter/Space; the filter is a labelled control.

**`src/components/AlertDetailPanel.tsx`** — the alert's full message, evidence table, recommended actions, detection history (`firstDetectedAt`, `occurrenceCount`, cooldown state), the health-factor breakdown when `calculateHealthScore` is available, and Dismiss / Mark actioned controls. Focus is trapped while open, Escape closes, and focus returns to the originating row.

**`src/components/AlertHistoryView.tsx`** — the audit log: dismissed and actioned alerts with timestamps, filterable by customer and rule, plus JSON and CSV export.

**`src/lib/alertStore.ts`** — persistence for `AlertStateEntry` records and the audit log in `localStorage` under a versioned key (`pi.alertState.v1`), with an append-only ring buffer capped at 500 audit entries. Reads must tolerate absent, malformed, and schema-mismatched payloads by resetting to empty rather than throwing — a corrupt `localStorage` value must not brick the dashboard. Emit changes over `BroadcastChannel` so two tabs in the same browser stay consistent.

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
- `src/types/alerts.ts` — shared alert types, imported by lib, service, route, and components
- `src/lib/alerts.ts` — rules engine and priority scoring (pure)
- `src/lib/businessHours.ts` — delivery-window helpers (pure)
- `src/lib/validateCustomerIds.ts` — single validation source of truth for lib, route, and widget
- `src/lib/alertStore.ts` — client-side alert state and audit log
- `src/services/PredictiveIntelligenceService.ts`
- `src/services/errors.ts` — `PredictiveIntelligenceError` (extend the file if the market spec already created it)
- `src/app/api/predictive-intelligence/route.ts`
- `src/components/PredictiveIntelligenceWidget.tsx`, `AlertDetailPanel.tsx`, `AlertHistoryView.tsx`, `ErrorBoundary.tsx`
- `src/data/mock-customer-signals.ts` — new; **do not modify `mock-customers.ts`**
- `src/data/mock-market-intelligence.ts` — exists; extend per M1–M4 of the market spec, do not duplicate

### Testing

The repository has no test runner, so every threshold, cooldown, and cache criterion below is otherwise unverifiable. Add Vitest as a devDependency with `"test": "vitest run"`, plus:

- `src/lib/alerts.test.ts` — each rule at threshold, threshold−1, threshold+1; missing-data cases return `null` and populate `skipped`; the low-volume engagement guard; compound-risk escalation; priority ordering including tie-breaks; the per-customer and global caps
- `src/lib/businessHours.test.ts` — inside and outside the window, weekend, a DST transition day, and a non-server timezone
- `src/lib/alertStore.test.ts` — dedup key stability, dismissal round-trip, stop-then-refire returning to `active`, ring-buffer cap, recovery from a malformed stored payload
- `src/services/PredictiveIntelligenceService.test.ts` — cache hit/miss, TTL expiry via the injected clock, LRU eviction at the 200-entry cap, market-fetch failure degrading to `market: null` with internal alerts intact, thrown error types
- `src/data/mock-customer-signals.test.ts` — determinism for a fixed id, newest health snapshot equals `customer.healthScore`, and every fixture-coverage guarantee listed under Data Requirements

Assert all time behaviour by advancing the injected clock. Never `sleep`, and never compare wall-clock durations.

### Performance
- Rule evaluation is O(rules × customers) with no nested customer scans; 500 customers × 6 rules must evaluate in well under 50ms, asserted as an upper bound rather than a benchmark number that will drift across machines
- Cache hits return without the simulated delay; cache bounded at 200 entries, LRU by access order
- Polling pauses on a hidden tab; the widget does not refetch when its inputs are unchanged between renders
- Alert rows are memoized on alert identity so a poll returning identical data causes no list re-render

### Security
- Validation and normalization happen on the server; client-side validation is a convenience, never the enforcement point
- **No PII in alert content.** `message`, `title`, and `evidence` are built from fixed templates plus numeric values, with an explicit allowlist of permitted fields: customer name, company, rule name, threshold values, day counts, health-score values, ARR band. Explicitly forbidden: `email`, `domains`, exact overdue amounts, ticket bodies, and any raw upstream text. Free-text interpolation from a data field into a message is prohibited — that is how PII and markup leak.
- All alert text renders as React children; never `dangerouslySetInnerHTML`
- Market headline URLs, when surfaced in the detail panel, render with `rel="noopener noreferrer"` and `target="_blank"`, and only `https:` URLs are rendered as links
- **CSV export escapes formula injection.** A cell beginning with `=`, `+`, `-`, `@`, tab, or CR is prefixed with `'`, and quotes are doubled. Without this, exported alert data executes on open in Excel and Sheets.
- Error messages returned to the client are generic — no internal paths, stack traces, or upstream detail
- **The client-side caps are alert-fatigue controls, not security controls,** and must be described as such in code comments. `localStorage` state and any client rate limit are user-modifiable; genuine rate limiting and a genuine audit trail require server-side enforcement and server-side storage, neither of which exists here. Do not label the `localStorage` log a compliance audit trail.
- Mock-only generation means no API keys, no outbound requests, and no third-party trust boundary

### Out of Scope

Each of these appears in the source requirements and is excluded with a reason, so the omission is not read as an oversight:

- **Cross-session/cross-device alert synchronization** — requires a server-side store and a push channel. `BroadcastChannel` covers tabs in one browser only; the requirement's "multiple dashboard sessions" is not achievable client-side.
- **Alert-effectiveness correlation with actual customer outcomes** — requires longitudinal real outcome data. Mock data has no ground truth to correlate against, so any number produced would be fabricated.
- **A/B testing framework for threshold tuning** — needs cohort assignment, persistence, and statistical power that a single-browser mock dashboard cannot supply.
- **Real external data sources** (payment processor, product analytics, support desk) — the feature is mock-only by design.
- **True real-time push** (WebSocket/SSE) — a 60-second poll is the stated mechanism; the UI must not claim more.
- **Owner/CSM-based workload balancing** — no owner field exists on `Customer`.
- **Holiday calendars** in business-hours logic.
- **Server-side rate limiting and durable audit storage** — no backend persistence layer exists.

## Acceptance Criteria

### Rules Engine
- [ ] Each of the six rules is a separately exported pure function returning `RuleResult | null`, with no clock, network, or storage access inside `src/lib/alerts.ts`
- [ ] `PAYMENT_RISK` fires at 31 days overdue and not at 30; fires on a 21-point 7-day drop and not on 20
- [ ] A `healthHistory` with a single entry produces no drop-based alert and one `skipped` entry with a reason
- [ ] `ENGAGEMENT_CLIFF` does not fire when `baselineRate < 0.5` logins/day, however large the percentage drop
- [ ] `CONTRACT_EXPIRATION_RISK` fires at 89 days with health 49, and not at 90 days, not at health 50, and not when already expired
- [ ] `SUPPORT_TICKET_SPIKE` fires on 4 tickets and on any escalated ticket, and not on 3 unescalated tickets
- [ ] `FEATURE_ADOPTION_STALL` fires only for accounts meeting the growing definition, and never for an account under 30 days old
- [ ] `MARKET_SENTIMENT_RISK` fires only on `negative` with confidence ≥ 0.6 and health < 70, and never when `market` is `null`
- [ ] `market: null` produces no market alert and does not suppress any internal alert
- [ ] Co-occurrence with a high alert sets `escalated: true` on the market alert and scores it at the high base, without creating an extra alert
- [ ] `priorityScore` is an integer 0–100; identical input yields byte-identical ordering across runs, including ties
- [ ] More than 3 alerts for one customer keeps the top 3 and counts the rest in `suppressed`; the list never exceeds `maxAlerts`

### State, Cooldown, and Timing
- [ ] Re-triggering the same customer/rule updates `lastTriggeredAt` and increments `occurrenceCount` without creating a second alert or resetting `firstDetectedAt`
- [ ] An alert inside its cooldown still appears in the list but does not re-notify; high uses 48h, medium 168h
- [ ] A dismissed alert stays hidden from the active list until the rule stops firing for a full evaluation and fires again, at which point `occurrenceCount` is preserved
- [ ] Business-hours gating defers notification only, computed via `Intl.DateTimeFormat` parts, and is correct on a DST transition day and in a non-server timezone
- [ ] A malformed or schema-mismatched `localStorage` payload resets to empty state without throwing

### Service and API
- [ ] `GET /api/predictive-intelligence` returns 200 with `alerts`, `summary`, `marketDataAvailable`, `unknownIds`, and `evaluatedAt`
- [ ] A malformed `customerIds` value returns 400 with a sanitized `{ error }` body and generates no data; a well-formed unknown id returns 200 and appears in `unknownIds`
- [ ] More than 50 ids returns 400
- [ ] Internal failures return 500 with a generic message; no stack trace or internal path appears in the body
- [ ] Responses carry `Cache-Control: no-store`
- [ ] No code path can produce a 404 — `NOT_FOUND` does not exist in the error union
- [ ] Two requests inside the 60s TTL return identical payloads including `evaluatedAt`, and the second performs no simulated delay; advancing the injected clock past the TTL regenerates
- [ ] Inserting 201 distinct customers evicts the least-recently-*accessed* entry, not the oldest-inserted — verified by reading an early entry before overflowing the cache
- [ ] A market fetch that rejects for one customer leaves every other customer's market data intact and internal alerts unaffected
- [ ] The service throws `PredictiveIntelligenceError`, not a bare `Error`, and the route maps `INVALID_INPUT` to 400

### Mock Data
- [ ] The same customer id yields identical signals across repeated calls and process restarts; no `Math.random()` remains in the module
- [ ] The newest `healthHistory` entry equals `customer.healthScore` for every one of the eight `mockCustomers`
- [ ] Across `mockCustomers`: all six rules fire at least once, at least two customers produce zero alerts, at least one compound escalation occurs, at least one customer sits within 2 units of a threshold, and at least one has deliberately missing data that fires nothing
- [ ] `arrCents` ordering is consistent with `subscriptionTier`
- [ ] `src/data/mock-customers.ts` is unmodified

### Widget
- [ ] Loading state on first load, ranked list on success, sanitized error with retry when there has never been a successful load
- [ ] Priority badges pair colour with a text label; red for high, yellow for medium; no state is colour-only
- [ ] Zero alerts renders a positive confirmation naming the number of customers evaluated — not a spinner, not an error
- [ ] A "Sample data" badge is visible whenever alerts are displayed
- [ ] `marketDataAvailable: false` shows an explicit "Market data unavailable" chip and the internal alerts still render
- [ ] Selecting a customer pins and highlights their alerts while the full list stays visible; activating a row calls `onSelectCustomer`
- [ ] Polling stops while the tab is hidden and refetches immediately on becoming visible
- [ ] Rapid successive polls never leave stale data on screen — the last request wins, and a superseded request renders no error
- [ ] A request exceeding 8 seconds surfaces a retryable timeout error rather than an indefinite spinner
- [ ] A failed poll after a successful one keeps the previous list visible with a retry indicator instead of blanking or erroring
- [ ] A poll returning identical data causes no visible list re-render
- [ ] Suppressed alerts appear as "+N more", never silently dropped
- [ ] No alert message, title, or evidence field contains an email address, a domain, or any exact monetary amount — asserted programmatically over every generated alert for all `mockCustomers`
- [ ] The detail panel traps focus, closes on Escape, and returns focus to the originating row; the list region announces new alerts via `aria-live`
- [ ] CSV export prefixes cells beginning with `=`, `+`, `-`, `@`, tab, or CR with `'`
- [ ] A thrown render error is caught by `ErrorBoundary` and shows a fallback card without blanking the dashboard
- [ ] The widget matches sibling widgets at mobile, tablet, and desktop widths — or, if no sibling exists yet, uses the fallback card shell from Prerequisites

### Build
- [ ] `npm run type-check`, `npm run lint`, and `npm test` all pass with no errors or warnings
