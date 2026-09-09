# Feature: CustomerSelector Component

## Context
- Primary customer selection interface for the Customer Intelligence Dashboard
- Container component: owns the search query and the current selection, and lays `CustomerCard`
  instances out in a responsive grid
- Business analysts use it to locate a customer among many and select them; downstream widgets
  (health score, domain health, predictive alerts) read the selected customer
- The selection it owns is the dashboard's single source of truth for "who is being looked at",
  so its state shape is deliberately parent-controllable rather than private
- Occupies the placeholder at `src/app/page.tsx:63` ("Exercise 4: CustomerSelector integration")

### Dependency Order
This component composes `CustomerCard` and cannot be completed before it. Specifically it requires
the **click/selected-state enhancement** described in `requirements/customer-card-enhancement.md`
— a presentational-only card cannot express selection. If `CustomerCard` does not yet accept
`isSelected` and `onSelect`, that enhancement is a prerequisite, not something `CustomerSelector`
should work around by wrapping cards in its own click handlers (that would produce nested
interactive elements and a card that renders its own non-selected styling while its wrapper claims
otherwise).

## Requirements

### Functional Requirements
- Render one `CustomerCard` per customer, in a grid
- Provide a text input that filters the rendered customers by name or company
- Indicate the selected customer visually, via `CustomerCard`'s selected state
- Support exactly one selected customer at a time, and support deselecting (toggle off → no
  selection)
- Retain the selection across page interactions — see **Selection Persistence** below
- Remain responsive with 100+ customers — see **Performance** below
- Render a distinct empty state for "no customers supplied" and for "no customers match the search"

### Search and Filter Semantics

The requirement says "search/filter customers by name or company". That leaves multi-word queries
undefined, and the naive reading (substring match against `name`, or substring match against
`company`) fails the common case: typing `john acme` matches nothing even though John Smith works
at Acme Corp. Resolved semantics:

1. Normalize the query: trim, lowercase, collapse internal whitespace runs to single spaces.
2. If the normalized query is empty, all customers match — no filtering is applied.
3. Otherwise split the query on spaces into **terms**.
4. Build each customer's haystack as `` `${name} ${company}`.toLowerCase() ``.
5. A customer matches when **every** term is a substring of that haystack (AND across terms,
   substring within a term).

Consequences that are intended, not accidental:
- `acme` matches on company; `smith` matches on name; `john acme` matches across both fields.
- Matching is case-insensitive and diacritic-sensitive (`josé` does not match `jose`). Locale-aware
  normalization is out of scope; `String.prototype.normalize` is not used.
- No fuzzy matching, no typo tolerance, no ranking. Results preserve the input array's order.
- `email` and `domains` are **not** searched, even though they contain company-like text. Searching
  them would surface matches the card does not display, leaving the user unable to see why a result
  appeared.

### Selection Persistence

"Persist selection across page interactions" is ambiguous between two very different features, and
the difference is worth stating explicitly because it determines whether `localStorage` appears in
the implementation.

**In scope — interaction-durable selection.** The selection survives every interaction within the
mounted page: typing, clearing, and re-typing the search; the selected customer being filtered out
of view and coming back; re-renders caused by parent state changes; and changes to the `customers`
prop that still contain the selected id.

**Explicitly out of scope — reload-durable selection.** No `localStorage`, `sessionStorage`,
cookie, or URL query-parameter persistence in this iteration. Reasons: nothing in the requirements
asks for it; reading browser storage during render produces a hydration mismatch under the App
Router and needs an effect-and-flash workaround; and a persisted id can dangle when the customer
list changes. If reload durability is later required, the right seam already exists — a parent can
own `selectedCustomerId` (below) and add persistence there without changing this component.

**Behaviour when the selected customer is filtered out:** the selection is **retained**, not
cleared. A search is a view operation, not a selection operation, and silently clearing the
dashboard's selected customer because the user typed a letter is the wrong default. The selected
card reappears with its selected styling intact when it matches again.

**Behaviour when the selected id disappears from `customers`:** the component does not mutate its
own state to "fix" this. It renders no selected card (nothing matches the id) and leaves the id in
place. In controlled mode, reconciling a stale id is the parent's responsibility.

### Controlled and Uncontrolled Modes

`CustomerSelector` supports both, because the dashboard needs to read the selection while the
standalone demo does not need to manage it:

- **Uncontrolled** (`selectedCustomerId` omitted): the component holds selection in local state.
  `onSelectCustomer` is still called if provided, so a parent can observe without owning.
- **Controlled** (`selectedCustomerId` provided, may be `null`): the prop is the sole source of
  truth. The component never writes local selection state; it calls `onSelectCustomer` and renders
  whatever the parent passes back.
- Mode is determined once by whether `selectedCustomerId` is `undefined`; switching modes across
  the component's lifetime is unsupported and out of scope.
- `onSelectCustomer` receives the newly selected `Customer`, or `null` when the selection is being
  cleared by re-clicking the selected card. Passing the whole customer, not just the id, spares
  every consumer a lookup.

### Performance

"Must handle 100+ customers efficiently" needs a definition, because `mockCustomers` contains
**eight** customers — the requirement cannot be observed against the existing data at all. Two
deliverables follow.

**A measurable target.** With 250 customers rendered:
- Filtering is O(n) per query against a precomputed lowercase haystack per customer, memoized with
  `useMemo` keyed on the `customers` array identity, so keystrokes do not re-lowercase every field.
- The filtered list is memoized on `(customers, normalizedQuery)`.
- Typing in the search input stays responsive with no perceptible input lag, and no dropped
  characters, in a development build.
- React keys are `customer.id` — never the array index — so filtering does not remount or
  mis-associate cards.

**What is deliberately not done.** No virtualization or windowing: every library that provides it
is an additional runtime dependency, which the technical constraints forbid, and 250 DOM cards do
not require it. No debounce on filtering — synchronous O(n) filtering is faster than the delay a
debounce introduces, so debouncing would make the component feel slower, not faster. (The
`aria-live` announcement *is* debounced; see Accessibility.) If a list an order of magnitude larger
is ever required, revisit with a measurement first.

### Required Test Fixtures

`mockCustomers` cannot exercise this component: eight customers do not test the 100+ requirement,
every name and company is short and ASCII, and no two customers share a name or company token.
Deliverable, in `src/data/customer-selector-fixtures.ts`:

- **Volume:** a deterministic generator producing 250 valid `Customer` objects with unique ids.
  Deterministic means no `Math.random()` and no `Date.now()` — the same fixture set every run, so
  observations are reproducible.
- **Shared tokens:** several customers sharing a company (multiple matches for one query) and
  several sharing a first name.
- **Cross-field match:** at least one customer whose name and company together satisfy a two-term
  query (`john acme`) that neither field satisfies alone.
- **No-match query material:** a token guaranteed absent from every fixture, for the empty-results
  state.
- **Casing and whitespace:** mixed-case names, a name with a leading/trailing space, and a company
  with a double space, to verify normalization.
- **Diacritics:** one customer with an accented name, documenting the known non-matching behaviour.
- **Overflow:** one customer with a very long name and company, to verify grid cells do not break.
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
- `id` is assumed unique. Duplicate ids are not defended against; they would break both React keys
  and single-selection, and the fixtures must not contain any.

### User Interface Requirements
- Search input sits above the grid, full-width on mobile, with a visible label or an adjacent
  search affordance — a placeholder alone is not a label
- Clear-search control, shown only when the query is non-empty, that empties the query and returns
  focus to the input. Clearing the search does **not** clear the selection.
- Result count visible when a query is active (for example "3 of 250 customers")
- Responsive grid: single column on mobile, multiple columns at wider viewports, using Tailwind's
  responsive utilities. Readable and structurally intact from 320px upward; 768px and 1024px used
  as additional check widths.
- Cards keep a consistent height per row rather than ragged cells caused by varying domain counts
- Empty states are distinguishable and actionable:
  - `customers` empty → "No customers available"
  - query matches nothing → text naming the query, plus the clear-search control
- Grid does not shift horizontally or reflow the search input as results change

### Integration Requirements
- Renders `CustomerCard`, passing the customer, `isSelected`, and the selection callback
- Passes `headingLevel` to `CustomerCard` so the page heading hierarchy stays correct — the grid
  sits under a section heading, so cards are one level below it
- Props interface `CustomerSelectorProps` is defined and exported alongside the component
- Imports the `Customer` type via the configured `@/*` path alias (`@/data/mock-customers`)
- `'use client'` is required — the component owns interactive state. This also places the client
  boundary above `CustomerCard`, so cards rendered here run as Client Components regardless of
  their own default.
- **Known conflict with the demo harness:** `src/app/page.tsx:9` loads `CustomerCard` via
  `require('../components/CustomerCard')?.default`, i.e. it expects a *default* export, while
  `requirements/code-quality.md` mandates named exports. Resolution: export `CustomerSelector` as a
  named export, and update the demo block around `src/app/page.tsx:63` to import it by name.
  Adding a default-export alias purely to satisfy the existing `require` is rejected — it
  entrenches the pattern the code-quality rules are trying to remove.

### Accessibility Requirements
- Search input has a programmatic label (`<label>` or `aria-label`) and `type="search"`
- Result count is exposed in an `aria-live="polite"` region. The announcement is **debounced by
  roughly 500ms** so that typing a multi-character query produces one announcement rather than one
  per keystroke. The visible count may update immediately; only the announcement is delayed.
- The grid is a semantic list (`<ul>`/`<li>`, one `<li>` per card) so screen readers announce the
  number of results. `list-style` removal via Tailwind must not remove the list semantics — do not
  set `role="none"`/`role="presentation"` on the `<ul>`.
- The ARIA `listbox`/`option` pattern is **not** used, despite the component's name. `option`
  children may only contain text; these cards contain a heading, a list of domains, and a health
  indicator, all of which a listbox would hide from assistive technology. A list of toggle buttons
  conveys the same state via `aria-pressed` without discarding content.
- Every card's clickable region is a real `<button>` (owned by `CustomerCard`), so keyboard
  activation, focus order, and `Enter`/`Space` behaviour come from the platform. No `div` with
  `onClick`, no manual `tabIndex` management, no custom arrow-key roving focus in this iteration.
- Visible focus indicator on the search input, the clear control, and every card, meeting the 3:1
  contrast requirement for non-text UI
- Selection state is announced, not conveyed by colour alone — `aria-pressed` on the card button
  plus `CustomerCard`'s existing non-colour selected affordance
- Text and UI colours meet WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text and meaningful
  non-text elements
- Filtering must not move focus. Typing keeps focus in the input even as the grid beneath re-renders.

## Constraints

### Technical Stack
- Next.js 15.5 (App Router)
- React 19.1
- TypeScript 5 with `strict: true`
- Tailwind CSS v4
- No additional runtime dependencies — no search library, no virtualization library, no state
  management library

### Code Quality
- Named export for the component — no default export
- TypeScript interfaces for all props; no `any`
- Descriptive identifiers; no abbreviations such as `btn`, `usr`, `q`
- Query normalization and the match predicate live in a small pure function, separate from the
  component, and carry a JSDoc comment. Pure means: no React, no props, testable by calling it.
- Match thresholds and tunables (the announcement debounce interval) are named constants defined
  once
- `useMemo` used where the memoized work is real (haystack construction, filtering) and not
  sprinkled over trivial expressions

### File Structure and Naming
- Component: `src/components/CustomerSelector.tsx` (the `src/components` directory does not exist
  yet; `CustomerCard.tsx` lands there first)
- Fixtures: `src/data/customer-selector-fixtures.ts`
- Component name `CustomerSelector`, props interface `CustomerSelectorProps`
- PascalCase for components, camelCase for variables and functions

### Security Considerations
- Search query and all customer strings render as JSX text content, relying on React's escaping.
  No `dangerouslySetInnerHTML` — this matters specifically because a "no results for X" message is
  the obvious place to interpolate user input.
- The query is used only for in-memory substring matching. It is never passed to `new RegExp()`,
  which would let input like `(` throw and `(a+)+$` degrade catastrophically.
- No customer data written to client-side logs

### Out of Scope
- Adding, editing, or deleting customers, and the customer API — `requirements/customer-management-integration.md`
- Computing health scores — `requirements/health-score-calculator.md`
- Live domain health checking, alerts, and market intelligence widgets
- Multi-select, bulk actions, sorting controls, and filtering by tier or score range
- Pagination, infinite scroll, and virtualization
- Server-side or debounced remote search
- Reload-durable selection (`localStorage`, URL state) — see Selection Persistence
- Navigation to a customer detail view

## Acceptance Criteria

This repository has **no test runner, no testing-library, and no accessibility tooling**; the only
executable checks are `npm run lint` and `npm run type-check`. Criteria are therefore tagged by how
they are verified. Adding a test runner would move most Manual items to Automated — notably the
pure match predicate, which is written to be unit-testable — but that is not assumed here.

### Automated — must pass before the component is considered done
- [ ] `npm run type-check` passes with no errors
- [ ] `npm run lint` passes with no errors or warnings

### Manual — verified by rendering the 250-customer fixture set and inspecting
- [ ] Renders one card per customer in a responsive grid; single column at 320px, multiple columns at 1024px
- [ ] Typing `acme` filters to customers matching on company; `smith` filters on name
- [ ] Typing `john acme` matches the cross-field fixture, which neither field matches alone
- [ ] Search is case-insensitive, and leading/trailing/repeated whitespace in the query is ignored
- [ ] An empty or whitespace-only query shows all customers
- [ ] Results preserve the input array order; the `customers` prop is never mutated or sorted
- [ ] A query with no matches shows the no-results state naming the query, plus a clear control
- [ ] An empty `customers` array shows the distinct "no customers available" state
- [ ] The clear control appears only when the query is non-empty, empties the query, and returns focus to the input
- [ ] Result count is displayed when a query is active and matches the number of rendered cards
- [ ] Clicking a card selects it and renders `CustomerCard`'s selected state; clicking it again deselects
- [ ] Selecting a second card deselects the first — never two selected cards
- [ ] Selection survives typing a query, clearing it, and re-typing
- [ ] Selecting a customer, then filtering it out of view, then clearing the search: the same customer is still selected
- [ ] In controlled mode the component renders the parent's `selectedCustomerId` and never diverges from it
- [ ] `onSelectCustomer` fires with the full `Customer` on select and with `null` on deselect
- [ ] No `localStorage`, `sessionStorage`, cookie, or URL writes anywhere in the component
- [ ] Typing with 250 customers rendered has no perceptible lag and drops no characters
- [ ] React keys are `customer.id`; no array indices used as keys
- [ ] Focus stays in the search input throughout filtering
- [ ] The grid is a `<ul>` with one `<li>` per card, and list semantics are not suppressed
- [ ] No `listbox`/`option` roles; card buttons expose `aria-pressed`
- [ ] Every card is keyboard reachable by `Tab` and activatable with both `Enter` and `Space`
- [ ] Visible focus indicators on the input, clear control, and cards
- [ ] Search input has a programmatic label, verified in the accessibility tree — not a placeholder alone
- [ ] The result-count live region announces once per settled query, not once per keystroke
- [ ] Text and UI colours meet WCAG 2.1 AA contrast, checked with a contrast tool
- [ ] Cards receive `headingLevel` such that the page heading hierarchy has no skipped levels
- [ ] The long-name/long-company fixture does not break the grid or cause horizontal scrolling
- [ ] The diacritics fixture behaves as documented — `jose` does not match `José`
- [ ] Query normalization and matching live in an exported pure function with a JSDoc comment
- [ ] `CustomerSelectorProps` is defined and exported; the component uses a named export
- [ ] `src/app/page.tsx` imports `CustomerSelector` by name, and the placeholder at the old line 63 is replaced
- [ ] No `dangerouslySetInnerHTML`, no `new RegExp` built from the query, and no customer data in `console` calls
- [ ] No console errors or warnings when rendering `mockCustomers`, the empty array, and the full 250-customer fixture set
