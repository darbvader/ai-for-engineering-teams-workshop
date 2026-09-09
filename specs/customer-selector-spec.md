# Feature: CustomerSelector Component

## Context
- Primary customer selection interface for the Customer Intelligence Dashboard
- Presentation and interaction layer: renders a searchable grid of `CustomerCard` instances and
  reports selection changes upward. It owns the **search query** but deliberately does **not** own
  the selection — see Selection Ownership and Persistence.
- Business analysts use it to locate a customer among many and select them; downstream widgets
  (health score, domain health, predictive alerts) read the selected customer
- Replaces the Exercise 4 placeholder in `src/app/page.tsx` — the `<p>` reading
  "⏳ Exercise 4: CustomerSelector integration" (line 63 as of this writing; locate it by that
  text, not by line number)

### Dependency Order
This component composes `CustomerCard` and cannot be completed before it. It also requires the
click/selected-state enhancement from `requirements/customer-card-enhancement.md` — a
presentational-only card cannot express selection. The exact additions `CustomerCard` must gain are
listed in one place under **Required CustomerCard Contract**; treat that as a prerequisite, not
something `CustomerSelector` works around by wrapping cards in its own click handlers (which would
nest interactive elements and let a card render non-selected styling while its wrapper claims
otherwise).

### Requirement Traceability

Every bullet in `requirements/customer-selector.md` maps to a section and to at least one
acceptance criterion. This table is the checklist for "did the spec actually cover the ask".

| Requirement | Specified in | Verified by |
|---|---|---|
| Main customer selection interface for the dashboard | Context; Integration Requirements | AC-1, AC-38 |
| Users need to quickly find and select customers | Search and Filter Semantics | AC-2 … AC-7 |
| Must handle 100+ customers efficiently | Performance | AC-27 … AC-29 |
| Display customer cards with name, company, health score | Card Content Requirements | AC-8, AC-9 |
| Search/filter customers by name or company | Search and Filter Semantics | AC-2 … AC-7 |
| Visual selection state (highlight selected customer) | Selected-State Appearance | AC-14 … AC-17 |
| Persist selection across page interactions | Selection Ownership and Persistence | AC-18 … AC-26 |

## Requirements

### Functional Requirements
- Render one `CustomerCard` per customer, in a responsive grid
- Each card displays the customer's name, company, and health score — see Card Content Requirements
- Provide a text input that filters the rendered customers by name or company
- Highlight the selected customer — see Selected-State Appearance
- Support exactly one selected customer at a time, and support deselecting (toggle off → no
  selection)
- Preserve the selection across search, re-render, unmount/remount, view navigation, and page
  reload — see Selection Ownership and Persistence
- Remain responsive with 100+ customers — see Performance
- Render distinct empty states for "no customers supplied" and "no customers match the search"

### Card Content Requirements

The source requirement "display customer cards with name, company, health score" is satisfied by
`CustomerCard`, but it is this component's job to make sure it happens, so it is stated here rather
than assumed:

- Every rendered card shows the customer's **name**, **company**, and **health score**, sourced
  from the `Customer` object and rendered by `CustomerCard` per `specs/customer-card-spec.md`
- `CustomerSelector` passes the whole `Customer` object; it does not pick fields, reformat the
  health score, or re-band it. Health score banding lives in `CustomerCard` and is not duplicated
  here.
- If a card fails to render these three fields, this component is non-conforming even though the
  defect is in `CustomerCard`. AC-8 is checked against rendered output, not against props.

### Search and Filter Semantics

The requirement says "search/filter customers by name or company". That leaves multi-word queries
undefined, and the naive reading (substring match against `name`, or substring match against
`company`) fails the common case: typing `john acme` matches nothing even though John Smith works
at Acme Corp. Resolved semantics:

1. Normalize both the query and each customer's searchable text with the same function,
   `normalizeSearchText` (below).
2. If the normalized query is empty, all customers match — no filtering is applied.
3. Otherwise split the normalized query on spaces into **terms**.
4. Build each customer's haystack as the normalized form of `` `${name} ${company}` ``.
5. A customer matches when **every** term is a substring of that haystack (AND across terms,
   substring within a term).

**`normalizeSearchText(value: string): string`** performs, in order: `trim`, lowercase, collapse
internal whitespace runs to single spaces, Unicode NFD decomposition, then removal of combining
diacritical marks.

Two implementation notes that are binding, not incidental:

- Strip the marks with the explicit range `/[\u0300-\u036f]/g`, **not** `/\p{Diacritic}/gu`.
  Unicode property escapes require an ES2018 target, and `tsconfig.json` sets
  `"target": "ES2017"`, so the property-escape form fails `npm run type-check`. Raising the target
  is out of scope for this component.
- Applying the same function to both sides is what makes the behaviour symmetric; two separate
  normalization paths are the classic source of "it matches one way but not the other".

Consequences that are intended, not accidental:
- `acme` matches on company; `smith` matches on name; `john acme` matches across both fields.
- Matching is case-insensitive **and diacritic-insensitive**: `jose` matches `José`, and `josé`
  matches `Jose`. This serves "users need to quickly find customers" and costs one line.
- Normalization is not full locale collation. `ß`/`ss`, `æ`/`ae`, and Turkish dotless `ı` are not
  folded, and no `localeCompare` or `Intl.Collator` is used. That limit is acknowledged, not tested
  for — no acceptance criterion locks it in, so a later fix needs no spec change.
- No fuzzy matching, no typo tolerance, no ranking. Results preserve the input array's order.
- `email` and `domains` are **not** searched, even though they contain company-like text. Searching
  them would surface matches the card does not display, leaving the user unable to see why a result
  appeared.

### Selection Ownership and Persistence

"Persist selection across page interactions" is the requirement with real implementation cost, and
the reading that limits it to "survives a re-render" is wrong: that is what `useState` does for
free, and a requirements document does not spend a line on the free thing. It is also inadequate
in practice — `requirements/customer-management-integration.md` calls for navigation between the
dashboard and customer management with a "seamless transition between customer browsing (existing
CustomerCard selection) and customer management", which unmounts the selector. Selection held in
the selector's local state would be silently lost exactly when the requirement matters most.

Therefore the selection **does not live in `CustomerSelector`**.

**`CustomerSelector` is controlled-only.** `selectedCustomerId` and `onSelectCustomer` are
required props, not optional ones. There is no uncontrolled mode and no internal selection state.
This removes the dual-mode state surface, makes "who owns the selection" unambiguous, and puts
persistence at the only layer that outlives the component.

**The selection lives in a hook, `src/hooks/useSelectedCustomer.ts`** — a deliverable of this
feature, and the mechanism by which the persistence requirement is actually met.
(`requirements/code-quality.md` asks for custom hooks for reusable logic; this is that.)

```ts
function useSelectedCustomer(customers: Customer[]): {
  selectedCustomerId: string | null;
  selectedCustomer: Customer | null;
  selectCustomer: (customer: Customer | null) => void;
};
```

- **Storage:** `sessionStorage`, under a key declared once as a named constant
  (`SELECTED_CUSTOMER_STORAGE_KEY`). `sessionStorage` over `localStorage` deliberately: "which
  customer am I looking at" is a per-tab working context, and it should not resurrect weeks later
  in a different tab.
- **Hydration safety:** state initializes to `null` on both server and client — never read storage
  during render or in a `useState` initializer, which would desynchronize the server-rendered HTML
  from the first client render. A mount effect reads storage once and applies the stored id. The
  first paint therefore shows no selection even when one is stored; that flash is accepted as the
  cost of correct hydration, and it is brief because the effect runs before paint-visible work
  settles.
- **Stale-id reconciliation:** if the stored or current id matches no customer in `customers`, the
  hook clears it — it does not keep a dangling id, and `selectedCustomer` is `null`. Reconciliation
  runs when `customers` changes, so a customer being deleted upstream clears the selection rather
  than leaving the dashboard pointing at nothing.
- **Availability:** every storage access is wrapped so that a `SecurityError` or quota failure
  (private browsing, blocked storage) degrades to in-memory-only selection instead of throwing. A
  broken selection is a bug; a broken dashboard is worse.

**What the selection survives, and why:**

| Interaction | Survives | Mechanism |
|---|---|---|
| Typing / clearing / re-typing the search | Yes | Selection is not derived from the query |
| Selected customer filtered out of view and back | Yes | Retained, not cleared — see below |
| Re-render from parent state change | Yes | Controlled prop |
| Selector unmount/remount, view navigation | Yes | State lives in the hook, above the selector |
| Full page reload, same tab | Yes | `sessionStorage` |
| New tab, or tab closed and reopened | No | `sessionStorage` scope — intended |

**When the selected customer is filtered out:** the selection is **retained**, not cleared. A
search is a view operation, not a selection operation, and silently clearing the dashboard's
selected customer because the user typed a letter is the wrong default. The card reappears with
its selected styling intact when it matches again.

**When the user re-clicks the selected card:** `onSelectCustomer(null)` is called, the hook clears
both state and storage, and no card is selected.

### Selected-State Appearance

`specs/customer-card-spec.md` puts selected-state styling out of scope and defers to
`requirements/customer-card-enhancement.md`, which is a requirements file, not a spec. Nothing
currently defines what "highlight selected customer" looks like, so this spec is the authority
until the card enhancement gets its own. Taking `requirements/customer-card-enhancement.md`'s
"border highlight, background change" as the source:

- The selected card carries **both** a border/ring treatment (2px, accent colour) and a background
  tint, so the cue survives at a glance and in a dense grid
- The border/ring colour meets **3:1** contrast against both the card surface and the page
  background — it is a meaningful non-text indicator under WCAG 2.1 AA
- Selection is not conveyed by colour alone: `aria-pressed="true"` on the card button is the
  programmatic signal, and the visual treatment combines border *and* background rather than a hue
  change on the same shape
- The selected treatment must be visually distinct from **hover** and from the **focus ring**. All
  three can coexist on one card (focused, hovered, selected) without any of them becoming
  ambiguous — in particular, do not reuse the accent ring as the focus indicator.
- Selection styling must not change the card's box dimensions. Use `ring`/`outline` or an inset
  border rather than adding a border that grows the element and reflows the grid.

### Performance

The requirement is "must handle 100+ customers efficiently". `mockCustomers` contains **eight**
customers, so the requirement cannot be observed against existing data at all — hence the fixture
deliverable below. "Efficiently" is given a number rather than left to taste:

**Conformance is checked at 100 customers** (the requirement's floor) **and at 500** (headroom, to
confirm the approach does not fall off a cliff just past the stated threshold). Both sizes are
exported from the fixture module.

**Budget:** from keystroke to committed repaint, **under 100ms** at both sizes — the threshold
below which an interaction reads as instantaneous. Measured on a production build
(`npm run build && npm start`), because a development build carries StrictMode double-rendering
and unminified React and cannot support a latency claim. Method: React DevTools Profiler commit
duration for the input change, cross-checked against a Performance-panel recording of sustained
typing. The development build is used for correctness checks only.

**How the budget is met:**
- Each customer's normalized haystack is computed once and memoized with `useMemo` keyed on the
  `customers` array identity, so a keystroke never re-normalizes every field.
- The filtered list is memoized on `(customers, normalizedQuery)`.
- React keys are `customer.id` — never the array index — so filtering does not remount or
  mis-associate cards.
- The search input's value is React state updated synchronously; no keystroke is dropped or
  reordered.

**Deliberately not done:** no virtualization or windowing — every library providing it is an
additional runtime dependency, which the technical constraints forbid, and 500 cards do not
require it. No debounce on filtering: synchronous O(n) filtering is faster than the delay a
debounce introduces, so debouncing would make the component feel slower. (The `aria-live`
announcement *is* debounced; see Accessibility.) If the budget is ever missed, measure before
optimizing, and revisit virtualization only with a number in hand.

### Required CustomerCard Contract

`CustomerSelector` depends on additions to a component it does not own. They are collected here so
that whoever implements `CustomerCard` sees the whole contract in one place instead of
reverse-engineering it from this spec's accessibility section.

| Addition | Status | Needed for |
|---|---|---|
| `customer: Customer` | Exists | Card content |
| `headingLevel?: 2 \| 3 \| 4` | Exists in `specs/customer-card-spec.md` | Heading hierarchy |
| `isSelected: boolean` | **New** | Selected-state rendering |
| `onSelect: (customer: Customer) => void` | **New** | Reporting clicks upward |
| Root clickable region is a real `<button>` | **New** | Keyboard activation, focus order |
| `aria-pressed={isSelected}` on that button | **New** | Non-colour selection signal |
| Selected styling per Selected-State Appearance | **New** | "Highlight selected customer" |

`aria-pressed` and the `<button>` element are not mentioned in `specs/customer-card-spec.md` or
`requirements/customer-card-enhancement.md`; they originate here and must be added to the card's
spec when that enhancement is specified. The toggle-button pattern is chosen over a
checkbox/radio because the card is a single control whose pressed state is its selection.

### Required Test Fixtures

`mockCustomers` is partially sufficient and it is worth being precise about which parts, so nobody
rebuilds coverage that already exists:

- **Already covered by `mockCustomers`:** multi-match queries — `solutions` matches both `Global
  Solutions` and `CloudFirst Solutions`, and `john` matches both `John Smith` and `Sarah Johnson`
  by substring. Also single- and multi-domain customers, and a spread of health scores.
- **Not covered, hence the fixture module:** volume (eight customers cannot test 100+), a two-term
  cross-field query, casing/whitespace edge cases, diacritics, overflow text, and the empty list.

Deliverable, `src/data/customer-selector-fixtures.ts`:

- **Volume:** `generateCustomerFixtures(count: number): Customer[]`, plus exported `100`- and
  `500`-customer sets for the two conformance sizes. Deterministic — no `Math.random()`, no
  `Date.now()` — so observations are reproducible run to run. Ids are unique.
- **Cross-field match:** a customer whose name and company together satisfy the two-term query
  `john acme` that neither field satisfies alone.
- **No-match query material:** a token guaranteed absent from every fixture, for the empty-results
  state.
- **Casing and whitespace:** a mixed-case name, a name with leading/trailing spaces, and a company
  containing a double space.
- **Diacritics:** a customer named `José Álvarez`, to verify that `jose alvarez` matches.
- **Overflow:** a customer with a very long name and company, to verify grid cells do not break.
- **Empty:** an exported empty array for the no-customers state.

Fixtures import and reuse the exported `Customer` type from `src/data/mock-customers.ts` so they
stay in sync with the data model.

### Data Requirements
- Consumes the `Customer` interface exported from `src/data/mock-customers.ts`:
  ```ts
  interface Customer {
    id: string;
    name: string;
    company: string;
    healthScore: number;
    email?: string;
    subscriptionTier?: 'basic' | 'premium' | 'enterprise';
    domains?: string[];
    createdAt?: string;
    updatedAt?: string;
  }
  ```
- Customers arrive via the `customers` prop. The component performs **no data fetching** and does
  not import `mockCustomers` itself — the caller chooses between mock data, fixtures, and (later)
  the API from `requirements/customer-management-integration.md`.
- `customers` is treated as immutable: never sorted, spliced, or mutated in place.
- `id` is assumed unique. Duplicate ids are not defended against — they would break both React keys
  and single-selection — and the fixtures must not contain any.

### Props

```ts
interface CustomerSelectorProps {
  customers: Customer[];
  selectedCustomerId: string | null;
  onSelectCustomer: (customer: Customer | null) => void;
  headingLevel?: 2 | 3 | 4;
}
```

`onSelectCustomer` receives the whole `Customer` on select and `null` on deselect. The asymmetry
with `selectedCustomerId` is intentional: the id is the minimal thing to persist, while the full
object is what every consumer of a selection event actually wants, and passing it spares them a
lookup. `useSelectedCustomer` is the intended source of both props.

### User Interface Requirements
- Search input sits above the grid, full-width on mobile, with a visible label or an adjacent
  search affordance — a placeholder alone is not a label
- Responsive grid: single column on mobile, multiple columns at wider viewports, via Tailwind's
  responsive utilities. Readable and structurally intact from 320px upward; 768px and 1024px used
  as additional check widths.
- Empty states are distinguishable and actionable:
  - `customers` empty → "No customers available"
  - query matches nothing → text naming the query, plus the clear-search control
- Grid does not shift horizontally or reflow the search input as results change

**UX defaults.** The following are sensible starting values rather than derived requirements —
nothing in `requirements/customer-selector.md` asks for them. They may be adjusted without
renegotiating the spec, and dropping one is not a conformance failure:

- Clear-search control, shown only when the query is non-empty, which empties the query and
  returns focus to the input. Clearing the search does **not** clear the selection.
- Result count while a query is active, for example "3 of 500 customers"
- Consistent card height per row, rather than ragged cells caused by varying domain counts

### Integration Requirements
- Renders `CustomerCard`, passing `customer`, `isSelected`, `onSelect`, and `headingLevel` — see
  Required CustomerCard Contract
- `headingLevel` is forwarded so the page heading hierarchy stays correct: the grid sits under a
  section heading, so cards are one level below it
- `CustomerSelectorProps` is defined and exported alongside the component
- Imports the `Customer` type via the configured `@/*` path alias (`@/data/mock-customers`)
- `'use client'` is required — the component owns interactive state. This places the client
  boundary above `CustomerCard`, so cards rendered here run as Client Components regardless of
  their own default. `useSelectedCustomer` is likewise client-only.
- **Known conflict with the demo harness:** `src/app/page.tsx` loads `CustomerCard` via
  `require('../components/CustomerCard')?.default` (in `CustomerCardDemo`, line 9 as of this
  writing), i.e. it expects a *default* export, while `requirements/code-quality.md` mandates named
  exports. Resolution: export `CustomerSelector` as a named export and update the Exercise 4
  placeholder block to import it by name. Adding a default-export alias purely to satisfy the
  existing `require` is rejected — it entrenches the pattern the code-quality rules exist to remove.

### Accessibility Requirements
- Search input has a programmatic label (`<label>` or `aria-label`) and `type="search"`
- Result count is exposed in an `aria-live="polite"` region, with the announcement **debounced by
  `SEARCH_ANNOUNCEMENT_DEBOUNCE_MS` (500ms)** so a multi-character query produces one announcement
  rather than one per keystroke. The visible count may update immediately; only the announcement is
  delayed.
- The grid is a semantic list (`<ul>`/`<li>`, one `<li>` per card) so screen readers announce the
  number of results. Removing list styling via Tailwind must not remove list semantics — do not set
  `role="none"`/`role="presentation"` on the `<ul>`.
- The ARIA `listbox`/`option` pattern is **not** used, despite the component's name. `option` has
  presentational children in ARIA, so the heading, domain list, and health indicator inside each
  card would be hidden from assistive technology. A list of toggle buttons conveys the same state
  via `aria-pressed` without discarding content.
- Every card's clickable region is a real `<button>`, so keyboard activation, focus order, and
  `Enter`/`Space` behaviour come from the platform. No `div` with `onClick`, no manual `tabIndex`
  management, no custom arrow-key roving focus in this iteration.
- **Focus must never be orphaned.** Two cases:
  - Typing in the search input keeps focus in the input while the grid re-renders beneath it.
  - If the element holding focus is unmounted — a focused card filtered out by a `customers`
    change, or the clear-search control disappearing after it is activated — focus moves to a
    declared fallback (the search input for the clear control; a `tabIndex={-1}` grid container for
    a card), never to `<body>`. Focus landing on `<body>` is a conformance failure, not a cosmetic
    one: it drops the keyboard user to the top of the document.
- Visible focus indicator on the search input, the clear control, and every card, meeting the 3:1
  contrast requirement for non-text UI, and visually distinct from the selected treatment
- Text and UI colours meet WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text and meaningful
  non-text elements

## Constraints

### Technical Stack
- Next.js 15.5 (App Router)
- React 19.1
- TypeScript 5 with `strict: true`, `target: ES2017`
- Tailwind CSS v4
- No additional runtime dependencies — no search library, no virtualization library, no state
  management library

### Code Quality
- Named export for the component — no default export
- TypeScript interfaces for all props; no `any`
- Descriptive identifiers; no abbreviations such as `btn`, `usr`, `q`
- `normalizeSearchText` and the match predicate are pure functions in their own module, separate
  from the component, each with a JSDoc comment. Pure means no React and no props — callable and
  assertable in isolation, which is what makes them the first things to gain real tests when a test
  runner arrives.
- Tunables are named constants defined once: `SEARCH_ANNOUNCEMENT_DEBOUNCE_MS`,
  `SELECTED_CUSTOMER_STORAGE_KEY`
- `useMemo` used where the memoized work is real (haystack construction, filtering), not sprinkled
  over trivial expressions

### File Structure and Naming
- Component: `src/components/CustomerSelector.tsx` (the `src/components` directory does not exist
  yet; `CustomerCard.tsx` lands there first)
- Selection hook: `src/hooks/useSelectedCustomer.ts`
- Search helpers: colocated pure module, for example `src/lib/customer-search.ts`
- Fixtures: `src/data/customer-selector-fixtures.ts`
- Component name `CustomerSelector`, props interface `CustomerSelectorProps`
- PascalCase for components, camelCase for variables and functions

### Security Considerations
- The search query and all customer strings render as JSX text content, relying on React's
  escaping. No `dangerouslySetInnerHTML` — this matters specifically because a "no results for X"
  message is the obvious place to interpolate user input.
- The query is used only for in-memory substring matching. It is never passed to `new RegExp()`,
  which would let input like `(` throw and `(a+)+$` degrade catastrophically.
- Only the selected customer **id** is written to `sessionStorage` — never names, emails, or whole
  customer objects. Storage is readable by any script on the origin, so it holds the least
  identifying thing that satisfies the requirement.
- No customer data written to client-side logs

### Out of Scope
- Adding, editing, or deleting customers, and the customer API — `requirements/customer-management-integration.md`
- Computing health scores — `requirements/health-score-calculator.md`
- Live domain health checking, alerts, and market intelligence widgets
- Multi-select, bulk actions, sorting controls, and filtering by tier or score range
- Pagination, infinite scroll, and virtualization
- Server-side or debounced remote search
- Cross-tab and cross-session selection sharing (a `localStorage` or URL-state concern)
- Navigation to a customer detail view
- **Loading and error states.** `requirements/code-quality.md` asks for loading/error states for
  async operations and error boundaries; this component has no async operations — it receives
  `customers` synchronously. Fetch status therefore belongs to the parent that fetches, and the
  error boundary wraps the dashboard section rather than living inside the selector. Recorded here
  as a decision, so its absence is not read as an oversight: when the customer API lands, the
  parent gains `isLoading`/`error`, not this component.

## Acceptance Criteria

This repository has **no test runner, no testing-library, and no accessibility tooling**; the only
executable checks are `npm run lint` and `npm run type-check`. Criteria are tagged by how they are
verified. `normalizeSearchText` and the match predicate are written to be unit-testable, so most
search criteria convert to automated tests the moment a runner is added — but that is not assumed
here.

### Automated — must pass before the component is considered done
- [ ] **AC-A1** `npm run type-check` passes with no errors
- [ ] **AC-A2** `npm run lint` passes with no errors or warnings

### Manual — verified against the 100- and 500-customer fixture sets unless noted

Rendering and content
- [ ] **AC-1** Renders one card per customer in a responsive grid; single column at 320px, multiple columns at 1024px
- [ ] **AC-8** Every rendered card visibly shows the customer's name, company, and health score
- [ ] **AC-9** The health score shown matches the `Customer` object's value, and `CustomerSelector` does not reformat or re-band it

Search
- [ ] **AC-2** Typing `acme` filters to customers matching on company; `smith` filters on name
- [ ] **AC-3** Typing `john acme` matches the cross-field fixture that neither field matches alone
- [ ] **AC-4** Search is case-insensitive, and leading/trailing/repeated whitespace in the query is ignored
- [ ] **AC-5** `jose alvarez` matches the `José Álvarez` fixture, and `josé` matches a plain-ASCII `Jose`
- [ ] **AC-6** An empty or whitespace-only query shows all customers
- [ ] **AC-7** Results preserve the input array order; the `customers` prop is never mutated or sorted
- [ ] **AC-10** A query with no matches shows the no-results state naming the query, plus a clear control
- [ ] **AC-11** An empty `customers` array shows the distinct "no customers available" state
- [ ] **AC-12** The clear control appears only when the query is non-empty, empties the query, and returns focus to the input
- [ ] **AC-13** Result count is displayed while a query is active and equals the number of rendered cards

Selection and highlight
- [ ] **AC-14** Clicking a card selects it; clicking the selected card again deselects it and fires `onSelectCustomer(null)`
- [ ] **AC-15** Selecting a second card deselects the first — never two selected cards
- [ ] **AC-16** The selected card shows both a border/ring treatment and a background tint, with `aria-pressed="true"`
- [ ] **AC-17** Selected, hovered, and focused states are mutually distinguishable, including all three at once on one card, and selecting a card does not change its box dimensions or reflow the grid

Persistence
- [ ] **AC-18** Selection survives typing a query, clearing it, and re-typing
- [ ] **AC-19** Selecting a customer, filtering it out of view, then clearing the search leaves the same customer selected
- [ ] **AC-20** Unmounting and remounting `CustomerSelector` (navigating away from the dashboard section and back) preserves the selection
- [ ] **AC-21** A full page reload in the same tab preserves the selection; opening a new tab starts with none
- [ ] **AC-22** No hydration warning in the console on a reload with a stored selection
- [ ] **AC-23** A stored id matching no customer in `customers` is cleared rather than retained, and `selectedCustomer` is `null`
- [ ] **AC-24** With `sessionStorage` blocked (private-browsing or a manually thrown `SecurityError`), selection still works in-memory and nothing throws
- [ ] **AC-25** Only the customer id appears in `sessionStorage` — no names, emails, or objects
- [ ] **AC-26** `CustomerSelector` contains no selection state of its own; `selectedCustomerId` and `onSelectCustomer` are required props

Performance
- [ ] **AC-27** Keystroke-to-repaint stays under 100ms at 100 customers and at 500, measured on a production build via the React DevTools Profiler
- [ ] **AC-28** Typing sustained input drops no characters and preserves character order at both sizes
- [ ] **AC-29** React keys are `customer.id`; no array indices used as keys, and haystack construction is memoized on the `customers` identity

Accessibility
- [ ] **AC-30** The grid is a `<ul>` with one `<li>` per card, and list semantics are not suppressed
- [ ] **AC-31** No `listbox`/`option` roles; card buttons expose `aria-pressed`
- [ ] **AC-32** Every card is keyboard reachable by `Tab` and activatable with both `Enter` and `Space`
- [ ] **AC-33** Focus stays in the search input throughout filtering
- [ ] **AC-34** When a focused card is unmounted by a `customers` change, focus moves to the declared fallback and never to `<body>`; likewise after the clear control disappears
- [ ] **AC-35** Visible focus indicators on the input, clear control, and cards, distinct from the selected treatment
- [ ] **AC-36** Search input has a programmatic label, verified in the accessibility tree — not a placeholder alone
- [ ] **AC-37** The result-count live region announces once per settled query, not once per keystroke
- [ ] **AC-38** Cards receive `headingLevel` such that the page heading hierarchy has no skipped levels
- [ ] **AC-39** Text, UI, and selected-state colours meet WCAG 2.1 AA contrast, checked with a contrast tool

Code and integration
- [ ] **AC-40** The long-name/long-company fixture does not break the grid or cause horizontal scrolling
- [ ] **AC-41** `normalizeSearchText` and the match predicate live in their own module as exported pure functions with JSDoc comments
- [ ] **AC-42** The diacritic strip uses `/[\u0300-\u036f]/g`, not a `\p{...}` property escape, and AC-A1 passes under `target: ES2017`
- [ ] **AC-43** `CustomerSelectorProps` is defined and exported; the component uses a named export
- [ ] **AC-44** `src/app/page.tsx` imports `CustomerSelector` by name and the Exercise 4 placeholder paragraph is gone
- [ ] **AC-45** No `dangerouslySetInnerHTML`, no `new RegExp` built from the query, and no customer data in `console` calls
- [ ] **AC-46** No console errors or warnings when rendering `mockCustomers`, the empty array, and both fixture sizes
