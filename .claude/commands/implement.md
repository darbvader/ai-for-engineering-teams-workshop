---
description: Implement a component from its spec file, then verify and iteratively refine it against the spec's acceptance criteria
argument-hint: <path-to-spec.md>
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(ls:*), Bash(test:*), Bash(cat:*), Bash(sed:*), Bash(grep:*), Bash(mkdir:*), Bash(npm run lint:*), Bash(npm run type-check:*), Bash(npx tsc:*), Bash(npx eslint:*), Bash(git status:*), Bash(git diff:*), Bash(git show:*)
---

# Implement

Build the component specified in `$1`, then verify the result against that spec's
Acceptance Criteria and refine until they are met.

Unlike `/spec-review`, this command **writes code**. It writes only the files the spec
names (the component, its fixtures, and any file the spec explicitly commits to). Do not
touch unrelated source files, and do not edit the spec itself — if the spec is wrong,
report it rather than silently implementing something else.

## Step 0 — Load the spec

- **Spec:** `$1` (required). If `$1` is empty, list `specs/*.md` and ask which spec to
  implement, then stop.
- Read the spec **in full** before writing anything. For a spec over ~600 lines, read
  Context, Requirements, Constraints, and Acceptance Criteria in full and say in the
  output which parts you only skimmed.
- Also read the cross-cutting requirements `requirements/code-quality.md` and
  `requirements/accessibility.md` — they apply to every component in this repo.
- Read the source requirement artifact when the spec names one (or resolve
  `specs/<name>-spec.md` → `requirements/<name>.md`). It resolves ambiguity the spec
  leaves open.
- Read any sibling spec the spec depends on (a container that renders this component, a
  calculator it consumes), plus the types it imports — typically
  `src/data/mock-customers.ts`. Match the real type; do not invent fields.

If the spec has a blocking gap — a requirement two engineers would implement
incompatibly, or a contradiction that makes the component unbuildable — say so, state
the assumption you are proceeding under, and keep building. Only stop outright if no
assumption is safe. Consider running `/spec-review $1` first if the spec looks thin.

## Step 1 — Resolve the target path

Take the output path from the spec's **File Structure and Naming** constraints — that is
authoritative. When the spec does not state one, derive it:

- Component name: the PascalCase name the spec uses (`CustomerCard`), matching the spec
  filename where possible.
- Path: `src/components/<ComponentName>.tsx`. This repo keeps application code under
  `src/`; a bare top-level `components/` directory is not the convention here and should
  not be created.
- Fixtures, when the spec calls for them: `src/data/<kebab-name>-fixtures.ts`.

Before writing, check whether the target already exists (`ls`, `git status`). If it does,
read it and **edit toward the spec** rather than overwriting — a previous run or a human
may have already built part of it. Report that you found an existing file.

## Step 2 — Extract the acceptance criteria

Copy the spec's Acceptance Criteria into a working checklist before writing code, so you
implement against the real bar rather than a remembered paraphrase. Sibling specs tag
each criterion **Automated** or **Manual**; carry those tags through.

For each criterion, decide up front how it will be checked:

| Kind | How it is verified in this repo |
|---|---|
| Automated | `npm run type-check` and `npm run lint` — this repo has **no test runner, no testing-library, and no accessibility tooling** |
| Source-inspectable | Read back the file you wrote and check the claim against its text — named constants defined once, JSDoc present, named export, no `any`, no `dangerouslySetInnerHTML`, no excluded fields rendered |
| Manual | Requires rendering in a browser or a contrast tool — cannot be closed from here |

Do not claim a Manual criterion as verified. Reason through it, make the code satisfy it
as best you can, and report it as unverified with the reason.

## Step 3 — Implement

Write the component to satisfy every Requirement and Constraint, not just the Acceptance
Criteria — the criteria are a sampling of the spec, not a replacement for it.

House rules that hold across this repo unless the spec overrides them:

- Named export, no default export
- Exported props interface, `TypeScript strict`, no `any`
- Server Component by default; add `'use client'` only when a requirement forces it
- Tailwind v4 utilities for styling; no new runtime dependencies
- Descriptive identifiers, no abbreviations
- Render user-supplied strings as JSX text; never `dangerouslySetInnerHTML`; no customer
  data in `console` calls
- Semantic HTML and accessible labels; color must never be the only signal
- Magic numbers the spec names as thresholds become named constants, defined once

Also write the fixtures the spec asks for, covering the edge cases its criteria name
(empty/undefined collections, out-of-range and non-finite numbers, long strings).

## Step 4 — Verify

Run, in order, and paste real output — do not summarize a command you did not run:

1. `npm run type-check`
2. `npm run lint`
3. Read back each file you wrote, in full, and walk the checklist from Step 2.

Grade every criterion as **met**, **not met**, or **unverified (manual)**. A criterion is
met only when you can point at the line that satisfies it or the command output that
proves it.

## Step 5 — Refine

If anything is **not met**, fix it and return to Step 4. Rules for the loop:

- Fix the causes, not the symptoms — re-run the full check each pass, since a fix for one
  criterion routinely breaks another.
- Cap at **3 refinement passes**. If criteria are still unmet after the third, stop and
  report what remains and why, rather than looping further.
- Stop early and report if two consecutive passes produce the same failure — that is a
  spec problem or an environment problem, not something more edits will fix.
- Never close a criterion by weakening it, deleting the code it covers, or suppressing a
  check (`eslint-disable`, `@ts-expect-error`, `any`). If a criterion genuinely cannot be
  met as written, report it as a spec finding.

## Output

```
## Implement: <spec filename>
Spec: <path> (<full read | which sections were skimmed>)
Also read: <requirement artifacts, dependency specs, types>
Files written: <paths, each marked created or edited>
Refinement passes: <n>

### Checks
| Check | Result |
|---|---|
| npm run type-check | ✅ pass / ❌ <first error> |
| npm run lint | ✅ pass / ❌ <first error> |

### Acceptance criteria
| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | <criterion text, abbreviated> | ✅ met / ❌ not met / ⏳ unverified (manual) | <file:line, or command output, or why it cannot be checked here> |

### Refinement log
One line per pass: what failed, what changed. Omit the section if the first pass was clean.

### Spec findings
Anything in the spec that was ambiguous, contradictory, or unimplementable, and the
assumption you proceeded under. Write "None." if there were none.

### Summary
- Criteria: <n> met, <n> not met, <n> unverified (manual)
- Status: **Complete** (all automated and source-inspectable criteria met) /
  **Complete pending manual verification** (same, with manual items outstanding) /
  **Incomplete** (<n> criteria unmet after <n> passes — list them)
- Next actions: <the manual checks a human still owes, or the blockers>
```

Report the status honestly. All-green output on a component that does not build is worth
less than an accurate "Incomplete" with the failing criteria named.
