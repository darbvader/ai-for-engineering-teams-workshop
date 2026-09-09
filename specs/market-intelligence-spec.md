# Feature: Market Intelligence Widget

## Context
- Market sentiment and news widget for the Customer Intelligence Dashboard
- Gives business analysts a quick read on what the press is saying about a customer's company, alongside the customer health score
- Composed of five layers: a mock data module (exists, needs extension), a shared validator, a service, an API route, and a React widget rendered by the Dashboard
- Data is **entirely mock**. `src/data/mock-market-intelligence.ts` already exports `generateMockMarketData(company)` and `calculateMockSentiment(headlines)`. No external news or sentiment API is called, so there is no API key handling and no third-party trust boundary
- The requirements call this "real-time market sentiment". It is not real-time and must not be presented as such: the UI labels the data as sample/mock so a demo audience is never misled about where it came from
- The Dashboard owns customer selection and passes the selected customer's company down; the widget can also be driven manually via its own input

## Prerequisites and Pattern Sources

**This spec forward-references components that do not exist in the repository yet.** At the time of writing, `src/` contains only `app/{layout,page,globals.css}` and `data/{mock-customers,mock-market-intelligence}.ts`. There is no `src/components/`, no `src/services/`, and no `/api/customers` route. `src/app/page.tsx` loads `CustomerCard` through a `require()` placeholder precisely because it is built in a later exercise.

So every "match the existing pattern" instruction below is conditional. For each one:

| Pattern source | If it exists when you implement | If it does not exist |
|---|---|---|
| `CustomerCard` card shell | Copy its padding, border, radius, and heading treatment verbatim | Use the fallback card shell defined below, and treat this widget as the pattern other widgets copy |
| `CustomerService` | Mirror its class/pure-function split and error style | Use the service shape defined below as written |
| `/api/customers` route handlers | Mirror its validate → delegate → map-errors flow and its error body shape | Use the flow and `{ error }` body defined below |
| Sibling widget loading/error states | Reuse the same skeleton and error banner | Build the states defined below |

**Fallback card shell** (used when there is no sibling widget to copy): `rounded-lg border border-gray-200 bg-white p-4 shadow-sm`, heading `text-lg font-semibold text-gray-900 mb-3`, body text `text-sm text-gray-600`. Health-score color banding in `CustomerCard` is red 0–30 / yellow 31–70 / green 71–100; the sentiment bands below deliberately mirror that three-band red/yellow/green language on a different scale.

Do not claim conformance to a pattern you did not actually open and read.

## Required Changes to the Mock Data Module

The module as shipped cannot satisfy the UI requirements. Running it against four company names produces:

```
Acme Corp          articleCount=3 headlines=3 label=positive score=1.000 urls=0
TechStart Inc      articleCount=4 headlines=3 label=positive score=1.000 urls=0
Tesla Motors       articleCount=4 headlines=3 label=positive score=1.000 urls=0
Global Retail Co   articleCount=4 headlines=3 label=positive score=1.000 urls=0
```

Three defects follow from that, and all three must be fixed in `src/data/mock-market-intelligence.ts`. **Exported function signatures stay exactly as they are** (`generateMockMarketData(company: string): MockMarketData`, `calculateMockSentiment(headlines: MockHeadline[])`); only the internals and the template data change, so nothing downstream of the module breaks.

### M1 — Negative and neutral headline templates
Every current template is positive-leaning and not one negative keyword from `sentimentKeywords.negative` appears in any of them, so `label` is always `positive` and the yellow and red indicator states are unreachable. Add template sets that produce neutral and negative outcomes (layoffs, lawsuit, breach, declining revenue, regulatory investigation, delayed launch), drawing vocabulary from the existing `sentimentKeywords.negative` list.

### M2 — Deterministic, company-derived selection
Replace the `Math.random()` calls with a seeded pseudo-random generator keyed by a hash (FNV-1a is sufficient) of the normalized lowercase company name. This makes the same company always yield the same headlines, timestamps, and sentiment — required for a predictable workshop demo and for any test that asserts on output. Use the seed to pick one of three sentiment profiles (`positive`, `mixed`, `negative`) so that a realistic spread appears across `mockCustomers`.

### M3 — Non-saturating sentiment score
`totalScore / totalWords * 10` clamps to exactly `1.000` for every input, so the score carries no information. Replace the normalization with:

```
net   = positiveKeywordHits - negativeKeywordHits
score = clamp(net / (2 * headlines.length), -1, 1)
```

With three headlines and three positive hits this yields `0.5`, not a saturated `1.0`. Bands and confidence, which must be the single source of truth for both the label and the UI color:

| score | label | color |
|---|---|---|
| `> 0.15` | `positive` | green |
| `-0.15 … 0.15` | `neutral` | yellow |
| `< -0.15` | `negative` | red |

`confidence = min(0.95, 0.3 + abs(score) * 0.7)`.

### M4 — Populate `url`
No generated headline sets the optional `url`, so link rendering can never be exercised. Give every template a plausible absolute `https://` URL on the source's domain.

## Requirements

### Functional Requirements

#### Shared Validation — `src/lib/validateCompanyName.ts`
One module, imported by the route, the service, and the widget, so the rule cannot drift between the three:

```ts
export type CompanyNameResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

export function validateCompanyName(input: unknown): CompanyNameResult;
```

Rules — a failure produces `400` / `INVALID_COMPANY`:
- Must be a string, non-empty after trimming
- 1–100 characters after trimming
- Matches `/^[\p{L}\p{N} .,&'()-]+$/u` — letters, digits, spaces, and a small punctuation set, rejecting `<`, `>`, `/`, `\`, backticks, and control characters
- Normalized before use: trim, then collapse internal whitespace runs to a single space
- `value` — never the raw input — is what gets interpolated into headlines and echoed in responses
- `reason` is user-safe text with no internal detail

#### Service Layer — `MarketIntelligenceService`
- Class in `src/services/MarketIntelligenceService.ts`
- Public method: `getMarketIntelligence(company: string): Promise<MarketIntelligence>`
- Validates via `validateCompanyName` before any data generation
- **Injectable clock.** The constructor takes `{ now?: () => number; ttlMs?: number; delayMs?: () => number }`, defaulting to `Date.now`, `600_000` (10 minutes), and a 300–800ms delay. Without this the TTL is untestable except by waiting ten real minutes
- **Caching:** `Map<string, { data: MarketIntelligence; expiresAt: number }>`, 10-minute TTL
  - Key is the normalized, lowercased company name — `"Acme Corp"` and `"acme corp"` are one entry
  - An entry whose `expiresAt` is at or before `now()` is a miss, and is evicted rather than served stale
  - Cache hits skip the simulated delay
  - **Bounded at 100 entries with true LRU.** A plain `Map` preserves *insertion* order, not access order, so on every hit the entry must be `delete`d and re-`set` to move it to the tail; eviction then removes from the head. Without the delete/re-set step this degrades to FIFO
  - `clearCache()` exposed for tests
- **Delay simulation:** on a cache miss only, await `delayMs()` before returning
- **Errors:** every failure throws `MarketIntelligenceError` (in `src/services/errors.ts`) with `code: 'INVALID_COMPANY' | 'INTERNAL'` and a user-safe message. There is deliberately no `NOT_FOUND` — mock generation always succeeds for a valid name, so a 404 path would be unreachable code
- Sentiment banding and score computation stay in pure functions, testable without the class or the cache

#### API Layer — `GET /api/market-intelligence/[company]`
- Route Handler at `src/app/api/market-intelligence/[company]/route.ts`
- `params` is a `Promise` in Next 15 — `const { company } = await params`
- Decode the segment (`decodeURIComponent`) before validation, guarding against a malformed-escape throw and treating that as `400`
- The route only validates the request shape, delegates to the service, and maps errors
- Success (HTTP 200):

```ts
interface MarketIntelligence {
  company: string;              // normalized name echoed back
  sentiment: {
    score: number;              // -1..1, non-saturating (see M3)
    label: 'positive' | 'neutral' | 'negative';
    confidence: number;         // 0..1
  };
  articleCount: number;         // total articles found; may exceed headlines.length
  headlines: Array<{            // the top 3 of articleCount
    title: string;
    source: string;
    publishedAt: string;        // ISO 8601
    url?: string;
  }>;
  lastUpdated: string;          // ISO 8601, when generated — not when served from cache
}
```

- Error body: `{ error: string }` — user-safe, no stack trace, no internal path, no upstream detail. Log the real error server-side
- Status mapping: `400` invalid, missing, or undecodable company name; `500` everything else
- `Cache-Control: no-store`, so HTTP caching cannot mask the service-level TTL

**Path-segment caveat.** A company name containing `/` changes the URL path and yields Next's own 404 before any handler runs — it never reaches the 400 validator. The widget must therefore `encodeURIComponent` the name before building the request URL, and the validator rejects `/` as a defence in depth for callers that do not.

#### UI Component — `MarketIntelligenceWidget`
- `src/components/MarketIntelligenceWidget.tsx`, a client component (`'use client'`)

```ts
interface MarketIntelligenceWidgetProps {
  company?: string;             // from the Dashboard's selected customer
  className?: string;
}
```

- Renders, in order:
  - Heading "Market Intelligence", with a "Sample data" badge so mock data is never mistaken for live data
  - A labelled text input plus an analyze button, following the sibling form pattern (or the fallback shell)
  - A sentiment indicator: colored dot/badge, the text label, and the score formatted to two decimals with its confidence as a percentage
  - **Article count reconciled with what is shown** — when `articleCount > headlines.length`, render "N articles found · showing top 3", never a bare "4 articles" above three rows
  - A human-formatted "Last updated" timestamp
  - Up to 3 headlines, each with title, source, and formatted publication date; a headline with a `url` renders as a link with `rel="noopener noreferrer"` and `target="_blank"`, and one without renders as plain text
- Behavior:
  - When `company` changes to a new non-empty value, prefill the input and fetch automatically; do not refetch when it is unchanged between renders
  - Submitting fetches for the input's current value; the button is disabled while a request is in flight or client-side validation fails
  - Client-side validation calls the shared `validateCompanyName` — the same module the server uses — and shows `reason` inline before any request goes out
  - **Supersession and timeout are separate concerns and both are required.** Hold one `AbortController` for the in-flight request and abort it when a newer request starts, so a slow response can never overwrite a fresh one. Independently, apply an 8-second timeout so a hung request surfaces a retryable "Request timed out" error instead of leaving the widget in `loading` forever. Distinguish the two: an abort caused by supersession must not render an error
  - Empty state before any company is chosen: a short prompt — not a spinner, not an error
- States: `idle | loading | success | error`. The error state shows the server's sanitized message and a retry control
- Accessibility: the input has an associated `<label>`; the results region is `aria-live="polite"`; sentiment always carries its text label so color is never the sole channel

#### Dashboard Integration
- Rendered by the `Dashboard` component in the responsive grid alongside sibling widgets, using the shared card wrapper, spacing, and typography
- Receives `company={selectedCustomer?.company}` from the Dashboard's selected-customer state — the Dashboard owns selection; no new global state and no fetching in the parent
- Wrapped in `ErrorBoundary` so a widget crash degrades to a fallback card instead of blanking the dashboard

## Constraints

### Technical Stack
- Next.js 15 App Router with Route Handlers
- React 19 function components and hooks
- TypeScript strict mode — all exported interfaces explicitly typed, no `any`
- Tailwind CSS v4 with the existing design-system colors
- No new **runtime** dependencies; Vitest is added as a devDependency (see Testing)

### File Structure
- `src/app/api/market-intelligence/[company]/route.ts`
- `src/services/MarketIntelligenceService.ts`
- `src/services/errors.ts` — `MarketIntelligenceError`
- `src/lib/validateCompanyName.ts` — the single validation source of truth
- `src/components/MarketIntelligenceWidget.tsx` — exports the component and its props interface
- `src/components/ErrorBoundary.tsx` — a reusable class-based boundary; none exists in the repo yet, so this widget introduces it for the Dashboard to reuse
- `src/types/market-intelligence.ts` — the shared `MarketIntelligence` response types, imported by route, service, and widget
- `src/data/mock-market-intelligence.ts` — exists; extend per M1–M4, do not duplicate

### Testing
The repository has no test runner, so the cache and sentiment criteria below are otherwise unverifiable. Add Vitest as a devDependency with a `"test": "vitest run"` script, plus:
- `src/lib/validateCompanyName.test.ts` — accepted and rejected names, normalization
- `src/services/MarketIntelligenceService.test.ts` — cache hit/miss, TTL expiry via the injected clock, LRU eviction at the 100-entry cap, case-insensitive keys, thrown error types
- `src/data/mock-market-intelligence.test.ts` — determinism for a fixed company, all three sentiment bands reachable, score never saturating at ±1 for ordinary input

Assert TTL behavior by advancing the injected clock, never by sleeping, and never by comparing wall-clock durations.

### Performance
- Cache hits return without the simulated delay
- Cache bounded at 100 entries, LRU by access order, with expired entries evicted on access
- The widget does not refetch when `company` is unchanged between renders

### Security
- Validation and normalization happen on the server; client-side validation is a convenience, never the enforcement point
- Only the normalized name is interpolated into generated headlines and echoed back, so no attacker-controlled markup reaches the UI
- Client-side error messages are generic — no internal paths, stack traces, or upstream detail
- Headline text renders as React children; never `dangerouslySetInnerHTML`
- Headline URLs come from the mock module only and render with `rel="noopener noreferrer"`
- Mock-only generation means no API keys, no outbound requests, no third-party trust boundary

## Acceptance Criteria

### API
- [ ] `GET /api/market-intelligence/Acme%20Corp` returns 200 with `company`, `sentiment`, `articleCount`, `headlines` (≤3), and `lastUpdated`
- [ ] A URL-encoded `<script>` payload returns 400 with a sanitized `{ error }` body and generates no data
- [ ] Empty, whitespace-only, and >100-character names each return 400
- [ ] A malformed percent-escape returns 400 rather than throwing a 500
- [ ] Internal failures return 500 with a generic message; no stack trace or internal detail appears in the body
- [ ] Responses carry `Cache-Control: no-store`

### Service
- [ ] `MarketIntelligenceService` throws `MarketIntelligenceError` (not a bare `Error`) for invalid input, and the route maps it to 400
- [ ] No code path can produce a 404 — `NOT_FOUND` does not exist in the error union
- [ ] Two requests for the same company inside the TTL return byte-identical payloads, including the same `lastUpdated`; the second performs no delay
- [ ] Advancing the injected clock past 10 minutes causes regeneration with a newer `lastUpdated`
- [ ] `acme corp` and `Acme Corp` resolve to one cache entry
- [ ] Inserting 101 distinct companies evicts the least-recently-*accessed* entry, not the oldest-inserted — verified by reading an early entry before overflowing the cache

### Mock Data
- [ ] The same company name yields identical headlines, timestamps, and sentiment across repeated calls and across process restarts
- [ ] Across `mockCustomers`, all three sentiment labels occur — `positive`, `neutral`, and `negative` are each produced by at least one company
- [ ] `sentiment.score` is not saturated at ±1 for ordinary headline sets
- [ ] Every generated headline has a populated `url`

### Widget
- [ ] Loading state during fetch, results on success, sanitized error with retry on failure
- [ ] Indicator colors match the bands: green `> 0.15`, yellow `-0.15…0.15`, red `< -0.15`, with the text label always shown alongside the color
- [ ] When `articleCount` exceeds the headlines shown, the UI states both numbers rather than showing a bare count that contradicts the list
- [ ] A "Sample data" badge is visible whenever results are displayed
- [ ] At most 3 headlines, each with title, source, and formatted publication date; those with a `url` are links carrying `rel="noopener noreferrer"`
- [ ] Selecting a different customer updates the widget automatically; selecting the same one twice triggers no second fetch
- [ ] Rapidly switching customers never leaves stale data on screen — the last selection wins, and a superseded request renders no error
- [ ] A request exceeding 8 seconds surfaces a retryable timeout error rather than an indefinite spinner
- [ ] Company names are `encodeURIComponent`-encoded before the request URL is built
- [ ] An empty prompt renders before any company is selected — not a spinner, not an error
- [ ] A thrown render error is caught by `ErrorBoundary` and shows a fallback card without blanking the dashboard
- [ ] The widget matches sibling widgets at mobile, tablet, and desktop widths — or, if no sibling exists yet, uses the fallback card shell from Prerequisites
- [ ] The input has an associated label and the results region announces updates to screen readers

### Build
- [ ] `npm run type-check`, `npm run lint`, and `npm test` all pass with no errors or warnings
