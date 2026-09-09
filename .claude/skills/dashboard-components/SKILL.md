---
name: dashboard-components
description: Conventions for building and editing Customer Intelligence Dashboard UI. Use whenever creating or modifying a dashboard component, a health score display or badge, or any customer-data UI (cards, lists, tables, panels, selectors) in this repo — including React 19 + TypeScript components, Tailwind styling, Next.js App Router server/client boundaries, and health score colour banding.
---

# Customer Intelligence Dashboard components

## Where components live

`src/components/[ComponentName].tsx` — PascalCase filename matching the exported
component name, one primary component per file. Import with the `@/` alias
(`@/components/HealthIndicator`, `@/data/mock-customers`, `@/lib/healthCalculator`),
never with relative `../` paths.

Named exports only — `export function CustomerCard(...)`. No default exports for
components. Export the props interface too, as `[ComponentName]Props`.

Fixtures for a component go in `src/data/[component-name]-fixtures.ts`
(kebab-case), alongside `mock-customers.ts`.

## React 19 + TypeScript

- Function components. No `React.FC`, no class components.
- Props are a named exported `interface`, not an inline type literal.
- Type customer data with the shared `Customer` type from `@/data/mock-customers`
  (`import type { Customer }`) rather than redeclaring fields.
- Use `import type` for type-only imports.
- No `any`. Model absent data as `null | undefined` in the prop type and handle
  it explicitly in the render path.
- `npm run type-check` and `npm run lint` must both pass.

## Next.js App Router

Server Components are the default: **do not** add `'use client'` unless the
component needs one of

- `useState` / `useReducer` / `useEffect` / `useRef` or any other hook,
- an event handler prop (`onClick`, `onChange`, …),
- browser-only APIs (`window`, `document`, `localStorage`),
- a context provider.

Presentational components — cards, badges, indicators, read-only tables — stay
Server Components. When interactivity is needed, push `'use client'` down to the
smallest leaf that needs it rather than marking a whole page or container.

`'use client'` goes on line 1, before all imports.

## Tailwind styling

Tailwind v4 (via `@tailwindcss/postcss`), utility classes in `className`. No CSS
modules, no inline `style` objects, no styled-components.

- Provide a dark-mode variant for any colour utility (`bg-red-700 dark:bg-red-300`).
- Keep contrast accessible: pair a dark surface with light text and vice versa.
- For variant sets (sizes, bands), define a `Record`-typed lookup object of class
  strings at module scope and index into it — see the `BAND_PRESENTATION` and
  size maps in `src/components/HealthIndicator.tsx`. Do not build class names by
  string concatenation or interpolation.
- Accessibility is part of the component: `aria-hidden` on decorative glyphs, a
  real accessible label for the score, and a configurable `headingLevel` prop
  rather than a hardcoded `<h3>` (see `CustomerCard`).

## Health score colour rules

Scores are `0-100`. Bands, lowest to highest:

| Score | Colour | Meaning (`RiskLevel`) |
| --- | --- | --- |
| 0-30 | red | `critical` |
| 31-70 | yellow | `warning` |
| 71-100 | green | `healthy` |
| no/insufficient data | slate/grey | `unknown` |

These boundaries come from `requirements/customer-card.md:13-15` and
`requirements/health-score-calculator.md:15`. Quote them in prose only; the
numbers above must never appear as literals in a component.

**Never re-derive a band or a colour in a component.** There is exactly one
source of truth for each half of this:

- **Thresholds** live in `src/lib/healthCalculator.ts` as `CRITICAL_MAX` and
  `WARNING_MAX`. Get the band by calling `getRiskLevel(score)`; never compare a
  score against a literal number in a component. Normalize a raw score with
  `normalizeHealthScore(score)` before displaying it, so the number shown and the
  colour shown can never disagree.
- **Colours** live in `BAND_PRESENTATION` in `src/components/HealthIndicator.tsx`.
  Any component that needs to show a score renders `<HealthIndicator />` instead
  of writing its own red/yellow/green classes.

`HealthIndicator` accepts a `riskLevel` override prop for the case where the
calculator classified the score itself (low confidence → `riskLevel: 'unknown'`
with a non-null score). Pass `result.riskLevel` through when you have a
calculator result; otherwise let the component band the score.

Boundaries are inclusive upper bounds compared with `<=`, so fractional scores
band correctly (`getRiskLevel(30.5)` → `warning`). Never use the exclusive
range form (`score >= 0 && score <= 30`) — it leaves gaps between bands.

Changing a band boundary means editing `CRITICAL_MAX` / `WARNING_MAX` in
`healthCalculator.ts` and nothing else, and it is a requirements change: update
`requirements/customer-card.md` and `requirements/health-score-calculator.md`
first, since both specs cite those numbers. Never add a threshold to a component.

## Related

`src/lib/healthCalculator.ts` is a partial implementation — only the banding
surface (`normalizeHealthScore`, `getRiskLevel`, the constants, `RiskLevel`)
exists. `calculateHealthScore` and the factor functions are still TODO per
`specs/health-score-calculator-spec.md`. Don't assume they are callable.
