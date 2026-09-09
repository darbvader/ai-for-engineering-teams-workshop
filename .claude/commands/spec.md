---
description: Generate a Context/Requirements/Constraints/Acceptance Criteria spec for a component from its requirements artifact
argument-hint: <ComponentName> [path-to-requirement.md]
allowed-tools: Read, Write, Grep, Glob, Bash(ls:*), Bash(test:*), Bash(cat:*), Bash(sed:*), Bash(grep:*), Bash(wc:*), Bash(mkdir:*), Bash(git log:*), Bash(git show:*)
---

# Spec

Write a specification for the component named `$1` and save it to
`specs/<kebab-name>-spec.md`.

This command **writes one file: the spec**. It does not write component code, does not
edit `requirements/`, and does not modify existing specs. If the requirement artifact is
thin — several in this repo are under 25 lines — the job is to turn it into something
implementable, not to pad it. Every decision you add beyond the artifact must be labeled
as a decision (see Step 3).

## Step 0 — Resolve the inputs

- **Component name:** `$1` (required), in whatever case the user typed. If `$1` is empty,
  list `requirements/*.md`, ask which component to spec, and stop.
  - Canonical name: PascalCase (`CustomerCard`, `HealthScoreCalculator`).
  - Kebab name: kebab-case of the same (`customer-card`, `health-score-calculator`).
- **Requirement artifact:** `$2` if provided. Otherwise resolve in this order and report
  which tier you used:
  1. `requirements/<kebab-name>.md`.
  2. Fuzzy match on `<kebab-name>` against `ls requirements/` — the names do not always
     line up (`PredictiveIntelligence` → `requirements/predictive-alerts.md`).
  3. Related artifacts that mention the component by name
     (`grep -rl "<ComponentName>" requirements/`).

  Read **every** artifact that plausibly applies rather than picking one. A component is
  routinely covered by a base artifact plus an enhancement
  (`customer-card.md` **and** `customer-card-enhancement.md`) or named as a dependency
  inside a larger artifact (`customer-management-integration.md`,
  `production-ready-dashboard.md`). List all of them in the output.

  If nothing resolves, say so and stop — do not invent a requirements source. Offer to
  proceed from a description the user supplies inline instead.

- **Always read**, because they apply to every component here:
  - `requirements/code-quality.md` and `requirements/accessibility.md`
  - The types the component will touch — typically `src/data/mock-customers.ts`. Match
    the real field names and optionality; do not invent fields.
  - Sibling specs in `specs/` for components this one renders, consumes, or is rendered
    by. Their Props and contracts are binding on this spec.
  - `specs/customer-card-spec.md` as the house-style reference for section shape.

- **Check for an existing spec** at the target path (`ls specs/`). If one exists, read it
  and ask whether to revise it in place or stop — do not silently overwrite work.

## Step 1 — Build a traceability table before writing prose

List every discrete requirement in the artifacts, each with the section of the spec that
will cover it. This table goes into the spec's Context section (sibling specs carry one
under `### Requirement Traceability`). Anything you decide **not** to carry forward goes
in `### Out of Scope` with a reason — an unexplained drop is the single most common defect
`/spec-review` reports.

## Step 2 — Write the four required sections

The spec must have top-level `## Context`, `## Requirements`, `## Constraints`, and
`## Acceptance Criteria`, in that order, under a `# Feature: <ComponentName> Component`
title. Sub-headings are encouraged; the four top-level names are fixed, since
`/spec-review` grades against exactly those.

| Section | Must contain |
|---|---|
| Context | What is being built, who or what consumes it, where it sits relative to existing code (name real paths), its dependency order against sibling specs, and the requirement traceability table. |
| Requirements | Concrete and testable behavior: props with an exported interface, data shape, rendering rules, interaction, states, accessibility. Specify edge cases and missing/invalid data — empty collections, `undefined` optional fields, out-of-range or non-finite numbers, very long strings — not just the happy path. Name the files, types, and signatures the spec commits to, and the fixtures that exercise the edge cases. |
| Constraints | Tech stack, file structure and naming (the exact output path), code quality, security, performance, and an explicit out-of-scope list. Mark which numbers are **binding** versus **sensible default** — an unmarked number gets implemented as law. |
| Acceptance Criteria | Checkable statements, each traceable to a requirement, split under `### Automated` and `### Manual` headings per house convention. |

Thresholds, breakpoints, and colour bands must be stated once, as named constants the
implementation will define once. Bands must tile the range with no gap and no overlap —
`0-30 / 31-70 / 71-100` is correct for integers; say what happens to a non-integer or an
out-of-range score.

## Step 3 — Label every decision you invent

The artifacts leave real gaps: `customer-selector.md` is 11 lines and says "persist
selection across page interactions" without saying where. Fill gaps rather than
deferring, but mark each addition inline as **Decision:** with a one-line rationale, so a
reviewer can tell your judgement from the source requirement. Unlabeled invention reads
as a dropped-or-invented requirement in review; labeled expansion is fine.

Where two readings would produce incompatible implementations and neither is safe to pick
— a persistence mechanism with user-visible consequences, an ownership boundary between
this component and its parent — state the options, recommend one, and flag it in the
output as a question for the user.

## Step 4 — Ground the criteria in what this repo can actually run

This repo has **no test runner, no testing-library, and no accessibility tooling**. The
executable checks are `npm run type-check` and `npm run lint`. Verify that before relying
on it (`cat package.json`); if a script is missing, say so rather than writing a criterion
against it.

- **Automated** — closable by `npm run type-check` / `npm run lint`, or by reading back the
  written source (named export, no `any`, JSDoc present, constants defined once, no
  `dangerouslySetInnerHTML`, excluded fields not rendered).
- **Manual** — needs a browser, a contrast checker, or a human eye. Name the fixture and
  the viewport to check at, so the manual step is reproducible.

Do not write a criterion that no listed check could detect. "Works correctly" and
"performs well" are not criteria; "renders 500 fixture customers without a visible frame
drop when scrolling at 1280px" is.

## Step 5 — Write the file

Save to `specs/<kebab-name>-spec.md`. Use the path from the spec's own File Structure
constraint for the component, and keep it consistent with the repo convention:
`src/components/<ComponentName>.tsx`, fixtures at `src/data/<kebab-name>-fixtures.ts`.

Then read the file back and confirm all four top-level sections are present and non-empty
before reporting. Consider running `/spec-review specs/<kebab-name>-spec.md` afterwards.

## Output

```
## Spec: <ComponentName>
Written to: specs/<kebab-name>-spec.md (<created | revised>)
Requirement artifacts: <paths> (primary resolved via tier <1|2|3>)
Also read: <cross-cutting artifacts, sibling specs, types>
Length: <n> lines

### Coverage
| Requirement (source) | Covered in | Status |
|---|---|---|
| <artifact line, abbreviated> | <spec section> | ✅ specified / 📌 out of scope (<reason>) |

### Decisions made
Each gap you filled that the artifacts did not decide, with the rationale. Write "None."
if the artifacts covered everything.

### Open questions
Choices where you picked an option but a human should confirm. Write "None." if there
are none.

### Summary
- Sections: Context ✅ / Requirements ✅ / Constraints ✅ / Acceptance Criteria ✅
- Criteria: <n> automated, <n> manual
- Requirements: <n> specified, <n> out of scope
- Next actions: /spec-review specs/<kebab-name>-spec.md, then /implement specs/<kebab-name>-spec.md
```

Report honestly. A spec that quietly drops half its artifact and reports four green
sections is worse than a shorter one that names what it left out.
