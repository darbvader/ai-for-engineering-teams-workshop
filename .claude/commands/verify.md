---
description: Verify a component compiles, renders against mock-customers, and holds up across breakpoints, then report pass/fail with specific issues
argument-hint: <path-to-component.tsx>
allowed-tools: Read, Grep, Glob, Bash(ls:*), Bash(test:*), Bash(cat:*), Bash(sed:*), Bash(grep:*), Bash(mkdir:*), Bash(rm:*), Bash(cp:*), Bash(curl:*), Bash(kill:*), Bash(pkill:*), Bash(npm run type-check:*), Bash(npm run lint:*), Bash(npx tsc:*), Bash(npx next dev:*), Bash(npx next build:*), Bash(git stash list:*), Bash(git status:*)
---

# Verify Component

Verify the component at `$1`. This is a **read-only verification** — report problems, do not
fix them. The one exception is the throwaway render harness in Step 3, which you create and
then must delete.

## Input resolution

`$1` may be written as `components/CustomerCard.tsx`, `src/components/CustomerCard.tsx`, or
`@components/CustomerCard.tsx`. Components in this repo live under `src/components/`, so strip
any leading `@`, and if the path does not exist, retry with `src/` prefixed. If it still does
not resolve, list `src/components/` and stop — do not guess at a similarly-named file.

If `$1` is empty, list `src/components/` and ask which component to verify, then stop.

Read the component in full first. Note, because every later step depends on them:

- the exported component name and whether it is a default or named export;
- its props interface — which props are required, and their types;
- whether it is a Server or Client Component (`'use client'`);
- whether it imports from `@/data/mock-customers`.

## Step 1 — TypeScript

Run `npm run type-check` (`tsc --noEmit` over the whole project) and `npm run lint`.

Both are project-wide, so **a failing run does not by itself mean the component is broken.**
Split the output:

- errors whose file path is the component under verification → attributable, and they are
  findings;
- errors in files the component imports → attributable, report them as such;
- everything else → report as a one-line "pre-existing project errors, not attributable to this
  component" note. Never fold them into the verdict.

Beyond a clean compile, check by reading — `tsc` passing is a floor, not the goal:

- Props typed against the real `Customer` interface from `@/data/mock-customers`, not a
  redeclared local copy that can silently drift from it.
- No `any`, no `as` casts that discard a union, no non-null `!` on a value the type says is
  optional. `Customer` marks `email`, `subscriptionTier`, `domains`, `createdAt`, and
  `updatedAt` optional — a component that reads `customer.domains.length` without a guard
  type-checks only if it cast, and crashes on the records that omit the field.
- Exported prop interfaces for anything a parent must construct.

## Step 2 — Renders with real mock data

Render the component for every record in `@/data/mock-customers` plus the edge cases below,
using a temporary Next.js route. This runs the real Next toolchain, so `@/` aliases, Server
Component rules, and Tailwind all resolve exactly as they do in the app.

1. Create `src/app/verify-harness/page.tsx` importing the component and `mockCustomers`, and
   mapping over `[...mockCustomers, ...edgeCases]`. Do **not** name the folder with a leading
   underscore — Next treats `_`-prefixed folders as private and will not route them, and the
   page will silently 404 while looking like a render failure.

   If `src/data/customer-card-fixtures.ts` (or a fixtures file matching the component) exists,
   spread those in instead of hand-writing edge cases — they are the maintained versions.
   Otherwise cover, as `Customer`-shaped objects: empty `domains: []`, absent `domains`, a
   single domain, many domains, `healthScore` at 0 / 30 / 31 / 70 / 71 / 100, out-of-range
   (`-10`, `150`), fractional (`70.5`), `Number.NaN`, an empty-string `name`, a very long
   unbroken name and a very long domain (overflow probes that Step 4 reads), and absent
   optional fields.

2. Start the dev server on a port unlikely to be in use and capture its log:

   ```bash
   npx next dev -p 3111 > /tmp/verify-dev.log 2>&1 &
   for i in $(seq 1 40); do curl -sf -o /tmp/verify.html http://localhost:3111/verify-harness && break; sleep 1; done
   ```

   Use `run_in_background` for the server rather than blocking on it.

3. A non-zero exit from the `curl` loop means the page never served — read `/tmp/verify-dev.log`
   for the compile or runtime error and report that verbatim as the finding.

4. On success, grep `/tmp/verify.html` and confirm, for each record: the customer name and
   company appear; the health score renders the value you expect after the component's own
   clamping/rounding rules; the `NaN` and out-of-range records produce a defined output rather
   than a literal `NaN`, `undefined`, `Infinity`, or an empty element in the markup. Count
   rendered root elements and check the count matches the number of records — a record that
   silently renders nothing passes a naive grep.

5. Also read `/tmp/verify-dev.log` on success. React hydration warnings, key warnings, and
   `console.error` output land there and do not fail the request.

**Cleanup is mandatory and must happen even when a check fails or you hit an error:**
`kill` the dev server and `rm -rf src/app/verify-harness`. Then run `git status --porcelain`
and confirm the tree is back to what it was — leaving a stray route behind turns a read-only
verification into a repo change. Report the cleanup as done in your output.

## Step 3 — Responsive design

This repo has no browser automation and no test runner — no Playwright, no Puppeteer, no Jest
or Vitest in `node_modules`. **You therefore cannot measure rendered layout, and must not claim
you did.** Label this section "static analysis" in the output and say plainly that it did not
run a browser.

Audit the component's Tailwind classes against the v4 default breakpoints (`sm` 640px, `md`
768px, `lg` 1024px, `xl` 1280px, `2xl` 1536px), reasoning about a 320px viewport as the narrow
bound. Findings to look for, each reported with the offending class and line:

- **Fixed or minimum widths that exceed the narrow bound** — `w-[400px]`, `min-w-[360px]`, and
  the like overflow a 320px viewport. `max-w-[400px]` is fine: it caps without forcing.
- **Horizontal rows that cannot wrap** — a `flex` row of badges or metadata without
  `flex-wrap`, so items compress or overflow instead of stacking.
- **Unbreakable content** — long names, emails, and domains need `break-words` or `break-all`.
  Compare against the long-name and long-domain probes from Step 2.
- **Grids with no responsive column count** — a fixed `grid-cols-3` with no `sm:`/`md:` variant.
- **Breakpoint prefixes that never fire or contradict each other** — e.g. an `md:` override
  restating the base value, or `sm:` and `md:` setting the same property in a way that makes one
  dead.
- **Tap targets under ~44px** on interactive elements at small sizes.
- **Text that only shrinks** — `text-xs` at every breakpoint on primary content.
- **Dark-mode pairs** — every color class should have its `dark:` counterpart, since this repo's
  components carry them throughout.

If the component is presentational and intentionally sized by its container (`CustomerCard` is:
`max-w-[400px]` with no fixed width), say so rather than manufacturing a finding — a component
that defers sizing to its parent is correct, and the responsive risk belongs to the grid that
holds it.

Offer, as a closing line rather than an action, the manual check: re-create the harness, run
`npx next dev`, and resize — the only way to actually observe layout here.

## Output

Report in this format. Nothing else.

```
## Verify: <component path>
Export: <name> (<default | named>) · <Server | Client> Component
Checks run: type-check, lint, render (<n> records), responsive (static)

| Check | Result | Detail |
|---|---|---|
| TypeScript (`npm run type-check`) | ✅ Pass / ❌ Fail | <n errors attributable, n pre-existing elsewhere> |
| Lint (`npm run lint`) | ✅ Pass / ❌ Fail | <one line> |
| Type quality (read) | ✅ Pass / ⚠️ Concerns / ❌ Fail | <one line> |
| Renders with mock-customers | ✅ Pass / ❌ Fail | <n/n records rendered, n console warnings> |
| Edge-case data | ✅ Pass / ⚠️ Concerns / ❌ Fail | <one line> |
| Responsive (static analysis) | ✅ Pass / ⚠️ Concerns / ❌ Fail | <one line> |

### Issues
For each, in descending order of impact:

**<n>. <short title>** — `<blocker | major | minor>`
- **Where:** `<file>:<line>` — <quote the offending line>
- **Issue:** <what breaks, and the input or viewport that triggers it>
- **Fix:** <the specific change, concrete enough to apply without re-reading the file>

(If there are none, write "No issues found.")

### Summary
- Verdict: <one of the three below, verbatim>
- Issues: <n> blocker, <n> major, <n> minor
- Not verified: <what this run could not check — always includes measured layout; add anything
  you skipped and why>
- Harness cleanup: <removed, tree clean | what is still present>
```

Severities:

- **blocker** — fails to compile, fails to render, or crashes/renders wrong data on a record in
  `mock-customers` or a listed edge case.
- **major** — renders, but is wrong or breaks for a realistic input or viewport: overflow at
  320px, an unguarded optional field, a swallowed type error.
- **minor** — style, consistency, or robustness that costs nothing today.

Verdict rule, applied top-down — first matching row wins:

| Condition | Verdict |
|---|---|
| Any blocker | **Fail — component does not work as written** |
| Any major | **Fail — works, but fix these before shipping** |
| Only minor issues, or none | **Pass** |

Do not pass a component because the checks that ran were green when a check did not run — an
unverified property is listed under "Not verified", never counted as a pass.
