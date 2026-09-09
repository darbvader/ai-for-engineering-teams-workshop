# Feature: Market Intelligence Widget

## Context
- Market sentiment and news widget for the Customer Intelligence Dashboard
- Gives business analysts a quick read on what the press is saying about a customer's company, alongside the health score they already see on `CustomerCard`
- Composed of four layers: a mock data module (already present), a service, an API route, and a React widget rendered by the Dashboard
- Data is **entirely mock** — `src/data/mock-market-intelligence.ts` already exports `generateMockMarketData(company)` and `calculateMockSentiment(headlines)`. No external news or sentiment API is called, so the widget is deterministic enough for demos and carries no third-party API risk or key handling
- Reuses the same color-coded status language as `CustomerCard` health scores (green / yellow / red), so a dashboard of several widgets reads as one system
- The widget receives the company name from the customer currently selected in `CustomerSelector`, and can also be driven manually via its own input field

## Requirements

### Functional Requirements

#### Data Layer (existing)
- Use `generateMockMarketData(company: string): MockMarketData` for headlines and article count
- Use `calculateMockSentiment(headlines: MockHeadline[])` for `{ score, label, confidence }`
- Do not modify the mock module's public API; the service layer adapts its output to the response shape below

#### Service Layer — `MarketIntelligenceService`
- Class `MarketIntelligenceService` in `src/services/MarketIntelligenceService.ts`, following the same shape as `CustomerService` (class wrapping pure helpers, no framework imports)
- Public method: `getMarketIntelligence(company: string): Promise<MarketIntelligence>`
- Validates and normalizes the company name before any data generation (see Validation Rules)
- **Caching:** in-memory `Map<string, { data: MarketIntelligence; expiresAt: number }>` with a 10-minute TTL
  - Cache key is the normalized, lowercased company name — `"Acme Corp"` and `"acme corp"` are one entry
  - An entry whose `expiresAt` is in the past is treated as a miss and evicted, never served stale
  - Cached responses are returned without re-simulating API delay
  - Expose `clearCache()` for tests
- **Delay simulation:** on a cache miss, await 300–800ms before returning, so loading states are visible in the UI
- **Errors:** all failures throw `MarketIntelligenceError` (custom `Error` subclass in the same module or `src/services/errors.ts`) carrying a `code` (`'INVALID_COMPANY' | 'NOT_FOUND' | 'INTERNAL'`) and a message safe to show a user
- Sentiment score/label/confidence computation stays in pure functions so it can be unit-tested without the class or the cache

#### API Layer — `GET /api/market-intelligence/[company]`
- Next.js 15 App Router Route Handler at `src/app/api/market-intelligence/[company]/route.ts`
- `params` is a `Promise` in Next 15 — `const { company } = await params`
- Decode the path segment (`decodeURIComponent`) before validation
- Delegates all logic to `MarketIntelligenceService`; the route only validates the request shape, calls the service, and maps errors to status codes
- Response format on success (HTTP 200):

```ts
interface MarketIntelligence {
  company: string;              // sanitized company name as echoed back
  sentiment: {
    score: number;              // -1..1
    label: 'positive' | 'neutral' | 'negative';
    confidence: number;         // 0..1
  };
  articleCount: number;
  headlines: Array<{            // at most 3
    title: string;
    source: string;
    publishedAt: string;        // ISO 8601
    url?: string;
  }>;
  lastUpdated: string;          // ISO 8601, when the data was generated (not when served from cache)
}
```

- Error format, matching the customer routes:

```ts
{ error: string }               // human-readable, sanitized
```

- Status mapping: `400` invalid or missing company name, `404` `NOT_FOUND`, `500` anything else. Never leak a stack trace or internal message; log the real error server-side, return a generic message to the client
- Response is JSON with no caching headers that would defeat the service-level TTL (`Cache-Control: no-store`)

#### Validation Rules (shared by route and service)
Company name must satisfy all of the following, or the request is rejected with `400` / `INVALID_COMPANY`:
- Present and a non-empty string after trimming
- Length between 1 and 100 characters after trimming
- Matches `/^[\p{L}\p{N} .,&'()-]+$/u` — letters, digits, spaces, and a small punctuation set. This rejects `<`, `>`, `/`, `\`, backticks, and control characters
- Normalized before use: trim, collapse internal whitespace runs to a single space
- The normalized value — never the raw input — is what gets interpolated into mock headlines and echoed in the response

#### UI Component — `MarketIntelligenceWidget`
- `src/components/MarketIntelligenceWidget.tsx`, a client component (`'use client'`)
- Props:

```ts
interface MarketIntelligenceWidgetProps {
  company?: string;             // from the selected customer; drives an automatic fetch
  className?: string;
}
```

- Renders, in this order:
  - A heading ("Market Intelligence")
  - A text input for a company name plus an analyze button, following the same input/button styling as the customer management forms
  - A sentiment indicator: colored dot/badge plus the label and the score, color-coded green (`positive`) / yellow (`neutral`) / red (`negative`)
  - Article count and a "Last updated" timestamp formatted for humans
  - The top 3 headlines, each with title, source, and publication date
- Behavior:
  - When the `company` prop changes to a new non-empty value, prefill the input and fetch automatically
  - Submitting the form fetches for whatever is in the input; the button is disabled while a request is in flight or the input fails client-side validation
  - Client-side validation mirrors the server rules and shows an inline message before any request is made
  - A newer request supersedes an older one — abort the in-flight request (`AbortController`) or discard its result so a slow response can never overwrite a fresh one
  - Empty state before any company is chosen: a short prompt, not a spinner and not an error
- States: `idle | loading | success | error`, rendered with the same loading skeleton and error-banner patterns as the other widgets. Error state shows the server's sanitized message and a retry affordance
- Accessibility: input has an associated `<label>`; the results region is `aria-live="polite"`; sentiment is never communicated by color alone — the text label is always present; headline links (when `url` exists) get `rel="noopener noreferrer"`

#### Dashboard Integration
- Rendered by the `Dashboard` component in the existing responsive grid, alongside the other widgets, using the same card wrapper, spacing, and typography
- Receives `company={selectedCustomer?.company}` from the dashboard's selected-customer state; no new global state, no data fetching in the parent
- Wrapped in an error boundary so a widget crash degrades to a fallback card instead of blanking the dashboard

## Constraints

### Technical Stack
- Next.js 15 App Router with Route Handlers
- React 19 function components and hooks
- TypeScript strict mode — every exported interface explicitly typed, no `any`
- Tailwind CSS v4 with the existing design-system colors
- No new runtime dependencies

### Pattern Constraints
- Match the existing widget card shell: same padding, border, radius, and heading treatment as `CustomerCard`
- Reuse the green/yellow/red mapping already used for health scores rather than introducing a new palette
- Service layer mirrors `CustomerService`: class facade over pure functions, in-memory state, throws typed errors
- API route mirrors `/api/customers`: validate → delegate → map errors → `NextResponse.json`

### File Structure
- `src/app/api/market-intelligence/[company]/route.ts`
- `src/services/MarketIntelligenceService.ts` (exports the class and `MarketIntelligenceError`)
- `src/components/MarketIntelligenceWidget.tsx` (exports the component and `MarketIntelligenceWidgetProps`)
- `src/types/market-intelligence.ts` for the shared `MarketIntelligence` response types, imported by both the route and the widget
- Data module `src/data/mock-market-intelligence.ts` already exists — consume it, do not duplicate it

### Performance
- Cached reads return without the artificial delay
- Cache bounded: evict expired entries on access; cap at 100 entries with least-recently-used eviction so a long session cannot grow unbounded
- Widget avoids re-fetching when the `company` prop is unchanged between renders

### Security
- Company name validated and normalized on the server; client-side validation is a convenience, never the enforcement point
- Only the sanitized name is interpolated into generated headlines and echoed in the response, so no attacker-controlled markup reaches the UI
- Error messages returned to the client are generic and contain no internal paths, stack traces, or upstream detail
- All headline text is rendered as React children (never `dangerouslySetInnerHTML`)
- Mock-only data generation means no API keys, no outbound requests, and no third-party data trust boundary

## Acceptance Criteria

- [ ] `GET /api/market-intelligence/Acme%20Corp` returns 200 with `company`, `sentiment`, `articleCount`, `headlines` (≤3), and `lastUpdated`
- [ ] A company name containing `<script>` or other disallowed characters returns 400 with a sanitized `{ error }` body and no generated data
- [ ] An empty, whitespace-only, or >100-character company name returns 400
- [ ] Two requests for the same company within 10 minutes hit the cache — the second is measurably faster and returns identical `lastUpdated`
- [ ] A request after the 10-minute TTL regenerates the data and returns a newer `lastUpdated`
- [ ] Cache keys are case-insensitive: `acme corp` and `Acme Corp` share one entry
- [ ] `MarketIntelligenceService` throws `MarketIntelligenceError` (not a bare `Error`) for invalid input, and the route maps it to 400
- [ ] Internal failures return 500 with a generic message; no stack trace or internal detail appears in the response body
- [ ] Widget shows a loading state during fetch, results on success, and an error banner with retry on failure
- [ ] Sentiment indicator colors match: green = positive, yellow = neutral, red = negative, and the text label is always shown alongside the color
- [ ] Widget displays at most 3 headlines, each with title, source, and formatted publication date
- [ ] Selecting a different customer in the dashboard updates the widget to that customer's company automatically
- [ ] Rapidly switching customers never leaves stale data on screen — the last selection always wins
- [ ] Widget renders an empty prompt (not an error) before any company is selected
- [ ] Widget sits in the dashboard grid with spacing and card styling indistinguishable from neighboring widgets at mobile, tablet, and desktop widths
- [ ] Input has an associated label and the results region announces updates to screen readers
- [ ] `npm run type-check` and `npm run lint` pass with no errors or warnings
