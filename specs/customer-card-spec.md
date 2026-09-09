# Feature: CustomerCard Component

## Context
- Individual customer display component for the Customer Intelligence Dashboard
- Rendered by the `CustomerSelector` container, which lays cards out in a grid and owns search, filtering, and selection state
- Gives business analysts at-a-glance customer information for quick identification
- Surfaces customer domains so the card can become the foundation for domain health monitoring
- Presentational only: it receives a customer object and renders it, holding no state of its own

## Requirements

### Functional Requirements
- Display the customer's name, company name, and health score
- Display the customer's domains (websites) to give health-monitoring context
- Render a color-coded health indicator derived from the health score
- Display a domain count only when the customer has more than one domain
- Render correctly on mobile and desktop viewports
- Handle customers with no `domains` value, an empty `domains` array, one domain, or many domains

### Health Score Normalization

`healthScore` is typed as `number`, so the component must not assume it falls in 0–100. Before
rendering or banding, normalize it to a single canonical value used for **both** the displayed
number and the color band, so the two can never disagree:

1. If the value is not a finite number (`NaN`, `Infinity`, `-Infinity`), treat the score as
   **unknown** — see below.
2. Otherwise clamp into `[0, 100]`.
3. Round the clamped value to the nearest integer.

Bands are then defined as open-ended comparisons on that canonical value, leaving no gap for
fractional inputs:

| Condition | Band | Meaning |
|---|---|---|
| `0 <= score <= 30` | Red | Poor |
| `30 < score <= 70` | Yellow | Moderate |
| `70 < score <= 100` | Green | Good |

- **Unknown scores** render a neutral (non-red/yellow/green) indicator with accessible text such as
  "Health score unavailable". The component must not crash and must not fall through to a band.
- Thresholds `30` and `70` are declared once as named constants and referenced everywhere.

### User Interface Requirements
- Health indicator uses the color bands above
- Color must not be the only signal of health: the indicator carries a **visible band label**
  (for example "Poor" / "Moderate" / "Good"). The numeric score alone does not satisfy this,
  because the score is already required independently and communicates no band.
- Typography hierarchy: customer name is most prominent, then company name, then health score and domains
- Clean card-based visual design — bordered or elevated surface, consistent internal padding
- Long names, company names, and domains truncate or wrap rather than breaking the card layout
- Domain count is only rendered for multiple domains; a single-domain customer shows the domain without a count
- When a customer has no domains, the domain section is omitted entirely rather than rendering an empty container or placeholder text

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
- `domains` is optional — the component must not assume it is present or non-empty
- Receives one customer via props; performs no data fetching
- The card displays **only** name, company, health score, and domains. `id`, `email`,
  `subscriptionTier`, `createdAt`, and `updatedAt` are deliberately not rendered.
- `domains` entries in the existing mock data are bare hostnames (`acmecorp.com`), not fully
  qualified URLs, despite the requirement's wording. Do not pass them to `new URL()` or prepend a
  scheme.

### Required Test Fixtures

`mockCustomers` is insufficient for verification: its scores are 15, 35, 45, 60, 73, 85, 88, and 92
— **no band boundary is represented** — and all eight customers have a non-empty `domains` array,
so the empty and undefined paths are never exercised. The following fixtures are a deliverable of
this component, in `src/data/customer-card-fixtures.ts`:

- **Band boundaries:** scores `-1`, `0`, `30`, `31`, `70`, `71`, `100`, `101`
- **Fractional scores:** `30.5`, `70.5`
- **Non-finite score:** `NaN`
- **Domain shapes:** `domains` undefined, `domains: []`, exactly one domain, three domains
- **Overflow:** a customer with a very long name, company, and domain string

Fixtures reuse the exported `Customer` type so they stay in sync with the data model.

### Integration Requirements
- Used inside the `CustomerSelector` container component
- Props-based one-way data flow from parent to card
- Props interface `CustomerCardProps` is defined and exported alongside the component
- Import the `Customer` type from `@/data/mock-customers` using the configured `@/*` path alias

### Accessibility Requirements
- Customer name renders as an `<h3>` by default. Because the card cannot know its surrounding
  document structure, `CustomerCardProps` exposes an optional `headingLevel` prop
  (`2 | 3 | 4`, default `3`) so the container can keep the page hierarchy correct.
- Health indicator carries an accessible text equivalent, for example
  `aria-label="Health score 85 out of 100 — good"`. For unknown scores it announces that the score
  is unavailable rather than naming a band.
- All text and the health indicator meet WCAG 2.1 AA contrast — 4.5:1 for normal text, 3:1 for
  large text and meaningful non-text elements
- The yellow band in particular must be darkened or paired with a dark foreground to clear 4.5:1;
  do not use a light yellow on white
- Domains render as a `<ul>`/`<li>` list so screen readers announce the number of items

## Constraints

### Technical Stack
- Next.js 15.5 (App Router)
- React 19.1
- TypeScript 5 with `strict: true`
- Tailwind CSS v4
- No additional runtime dependencies

### Code Quality
- Named export for the component — no default export
- Descriptive identifiers; no abbreviations such as `btn` or `usr`
- TypeScript interfaces for all props; no `any`
- JSDoc comment on the score normalization and banding function
- Health band thresholds defined once as named constants rather than repeated inline
- Server Component by default — add `'use client'` only if a later requirement makes it necessary

### Design Constraints

`requirements/customer-card.md` asks only for "basic responsive design for mobile and desktop".
The specific numbers below are **defaults carried over from `specs/customer-card-example.md`, not
derived requirements** — treat them as sensible starting values, adjustable without renegotiating
the spec:

- Maximum card width 400px; minimum card height 120px
- Spacing drawn from the Tailwind spacing scale, applied consistently

Binding: the card must be readable and structurally intact from 320px upward. 768px and 1024px are
used as additional check widths.

### File Structure and Naming
- Component file: `src/components/CustomerCard.tsx` (the `src/components` directory does not exist yet)
- Fixtures: `src/data/customer-card-fixtures.ts`
- Component name `CustomerCard`, props interface `CustomerCardProps`
- PascalCase for components, camelCase for variables and functions

### Security Considerations
- Render customer-supplied strings as JSX text content, relying on React's default escaping; never
  via `dangerouslySetInnerHTML`
- Domains are rendered as inert text, not anchors, in this iteration. This is a scoping decision,
  not a security boundary — revisit it when domain health monitoring lands.
- No customer data written to client-side logs

### Out of Scope
- Click handling, selection state, and selected-state styling — specified separately in `requirements/customer-card-enhancement.md`
- Search and filtering — owned by `CustomerSelector`
- Live domain health checking — the card only displays domains as context
- Navigation to a customer detail view

## Acceptance Criteria

This repository has **no test runner, no testing-library, and no accessibility tooling**; the only
executable checks are `npm run lint` and `npm run type-check`. Each criterion below is therefore
tagged with how it is verified. Adding a test runner would let the `Manual` items become
`Automated`, but that is not assumed here.

### Automated — must pass before the component is considered done
- [ ] `npm run type-check` passes with no errors
- [ ] `npm run lint` passes with no errors or warnings

### Manual — verified by rendering the fixture set on a scratch page and inspecting
- [ ] Renders customer name, company name, and health score from the `customer` prop
- [ ] Scores `0`, `30` render red; `31`, `70` render yellow; `71`, `100` render green
- [ ] Out-of-range scores `-1` and `101` clamp to `0` and `100` and render red and green respectively
- [ ] Fractional scores `30.5` and `70.5` land in exactly one band, and the displayed number matches the band shown
- [ ] A `NaN` score renders the neutral unknown state without crashing and claims no band
- [ ] Band thresholds appear as named constants in the source, defined once
- [ ] Visible band label ("Poor" / "Moderate" / "Good") accompanies the color indicator
- [ ] Domains render as a `<ul>` list when present
- [ ] Domain count is shown only when the customer has more than one domain
- [ ] The domain section is omitted entirely when `domains` is undefined or `[]`
- [ ] The long-name/long-domain fixture does not overflow or break the card layout
- [ ] Layout is readable and intact at 320px, 768px, and 1024px widths
- [ ] Customer name renders as `<h3>` by default and honors `headingLevel` when passed
- [ ] Health indicator exposes an accessible label; the unknown state announces unavailability
- [ ] Text and indicator colors meet WCAG 2.1 AA contrast, checked with a contrast tool — yellow band included
- [ ] `email`, `subscriptionTier`, `id`, and timestamps are absent from the rendered output
- [ ] No `dangerouslySetInnerHTML` and no customer data in `console` calls anywhere in the component
- [ ] `CustomerCardProps` is defined and exported; component uses a named export
- [ ] Score normalization and banding logic carries a JSDoc comment
- [ ] Visual hierarchy reads name > company > score > domains
- [ ] Component performs no data fetching and holds no state
- [ ] No console errors or warnings when rendering all of `mockCustomers` plus the full fixture set
