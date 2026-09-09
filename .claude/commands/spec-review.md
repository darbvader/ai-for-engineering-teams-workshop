---
description: Validate a spec's required sections and run a light adversarial review against its source requirement artifact
argument-hint: <path-to-spec.md> [path-to-requirement.md]
allowed-tools: Read, Grep, Glob, Bash(ls:*), Bash(test:*), Bash(wc:*), Bash(cat:*), Bash(sed:*), Bash(grep:*), Bash(git show:*), Bash(git log:*), Bash(npx tsc:*), Bash(npm run type-check:*), Bash(npm run lint:*), Bash(mktemp:*), Bash(printf:*)
---

# Spec Review

Review the specification at `$1` for structural completeness and fidelity to its source
requirement artifact. This is a **read-only review** — do not edit the spec, the requirements,
or any source file. Produce feedback only.

## Inputs

- **Spec under review:** `$1` (required). If `$1` is empty, list `specs/*.md` and ask which
  spec to review, then stop.
- **Requirement artifact:** `$2` if provided. Otherwise resolve it in this order:
  1. A `requirements/*.md` path named inside the spec itself (specs frequently cite their
     source, e.g. `requirements/customer-card.md`).
  2. Convention: `specs/<name>-spec.md` → `requirements/<name>.md`.
  3. Fuzzy match on `<name>` against `ls requirements/` (e.g. `predictive-intelligence-spec.md`
     → `requirements/predictive-alerts.md`).

  Report which artifact you resolved and by which tier. If two or more artifacts plausibly
  match — `customer-health-monitoring-spec.md` could map to `health-score-calculator.md` or
  `predictive-alerts.md` — read all of them rather than picking one, and say which you used. A
  silently wrong pick produces a whole review of phantom "dropped requirement" findings, which
  is worse than no review.

  If no artifact can be resolved, say so explicitly, skip Step 2, and run Step 1 only.

Read both files in full before judging anything. For a spec over ~600 lines
(`dashboard-orchestrator-spec.md` is ~1300), read the Context, Constraints, and Acceptance
Criteria in full, prioritize the requirement sections that other specs in `specs/` depend on,
and state in the output which parts you only skimmed — an unstated sampling boundary reads as
coverage you did not have. Also read the cross-cutting requirements
`requirements/code-quality.md` and `requirements/accessibility.md` — they apply to every spec in
this repo, so their content counts as part of the source requirements.

## Step 1 — Section validation

The four required top-level sections are **Context**, **Requirements**, **Constraints**, and
**Acceptance Criteria**. Match on heading text, not exact level or wording — `## Acceptance
Criteria` and `## Acceptance criteria` both count, and a section may legitimately be split
across sub-headings.

Grade each section as one of:

- **Present & complete** — meets the bar below.
- **Incomplete** — the heading exists but the content is thin, generic, or placeholder-only.
- **Missing** — no heading and no equivalent content anywhere in the spec.

Bar for each section:

| Section | Complete means |
|---|---|
| Context | States what is being built, who or what consumes it, and where it sits relative to existing code. Not just a restated title. |
| Requirements | Concrete and testable. Behavior is specified for edge cases and missing/invalid data, not only the happy path. Named files, types, and function signatures where the spec commits to them. |
| Constraints | Covers tech stack, file structure/naming, code quality, security, and an explicit out-of-scope list. Notes which numbers are binding vs. sensible defaults. |
| Acceptance Criteria | Checkable statements, each traceable to a requirement, and clear about which are executable in this repo (`npm run lint` and `npm run type-check`; there is no test runner unless the spec introduces one). Vague criteria like "works correctly" do not count. Sibling specs tag criteria Automated vs. Manual — that convention is worth a minor finding when absent, but its absence alone does not make the section incomplete. |

Content placed under a differently-named heading still counts — credit the substance and note the
naming deviation as a minor finding rather than calling the section missing.

## Step 2 — Light adversarial review

Compare the spec against the requirement artifact. **Light** means: report the findings that would most
change the implementation, not exhaustive coverage. Three substantiated findings is a good
review; there is no quota, and padding to hit a count is worse than a short list because the
verdict rule reads the tally. Prefer one well-evidenced finding over three speculative ones. Look for:

1. **Dropped requirements** — something in the artifact with no corresponding coverage in the
   spec, and no explicit deferral or out-of-scope entry.
2. **Silent scope expansion** — spec requirements with no basis in the artifact and no stated
   rationale. Expansion is fine when labeled as a decision; unlabeled invention is a finding.
3. **Contradictions** — the spec conflicts with the artifact, with another section of itself,
   or with a spec it depends on (check `specs/` for the components it names).
4. **Ambiguity that blocks implementation** — a requirement two competent engineers would
   implement incompatibly.
5. **Unverifiable acceptance criteria** — criteria asserting a property no listed check could
   detect, or assuming tooling this repo does not have.
6. **Boundary and failure gaps** — thresholds with gaps or overlaps, undefined behavior for
   empty/absent/malformed input, unhandled error paths.
7. **Expired claims about the repository** — these specs were written against an earlier tree.
   A spec asserting a file does not exist, that `page.tsx` uses a `require()` placeholder, or
   that some path is unimplemented may simply be out of date. Check the current tree, and
   `git show HEAD:<path>` when you need to see what changed.

Before reporting a finding, verify it against the actual file text and quote the line. **When a
spec makes a claim about what the toolchain does — that a target setting breaks a syntax, that a
lint rule fires, that a type-check fails — run it rather than reasoning about it.** A one-line
probe through `npx tsc` settles in seconds what is otherwise a guess, and these claims are
load-bearing: they get encoded as binding constraints and acceptance criteria. Write probes to a
`mktemp` path under `/tmp`, never into the repository, and pair every probe with a control that
you expect to behave differently — a probe that passes tells you nothing unless you have shown
the check was live. (Probing `\p{...}` at `target: ES2017` looks like a clean pass until a
`/(?<name>a)/u` control proves tsc was inspecting the regex all along.) Drop anything you
cannot substantiate — a false finding costs more review time than a missed one.

Severities, so the verdict is reproducible:

- **blocker** — implementing as written produces wrong behavior, or the spec cannot be
  implemented at all without a decision it does not make.
- **major** — implementable, but a competent implementer is likely to build the wrong thing, or
  a stated requirement goes uncovered. Also: a factual claim about the code or toolchain that is
  false and load-bearing.
- **minor** — accuracy, completeness, or consistency issue that costs a reader time but not
  correctness. Stale-but-harmless claims, missing house-style conventions, unexercisable
  criteria.

**Findings and section grades must be disjoint.** If an observation is already the reason a
section graded Incomplete, note it there and do not also list it as a finding — double-counting
inflates the finding tally that the verdict rule reads.

## Output

Report in this format. Nothing else, except that you may add one closing line noting how many
candidate findings you dropped as unsubstantiated or as labeled-and-justified expansion —
that number tells the reader how hard the review pushed:

```
## Spec Review: <spec filename>
Requirement artifact: <path> (resolved via tier <1|2|3>)<, or "not resolved">
Also read: <cross-cutting and dependency artifacts>
Coverage: <"full read", or which sections were skimmed on a large spec>

### Section validation
| Section | Status | Notes |
|---|---|---|
| Context | ✅ Complete / ⚠️ Incomplete / ❌ Missing | <one line> |
| Requirements | ... | ... |
| Constraints | ... | ... |
| Acceptance Criteria | ... | ... |

### Findings
For each, in descending order of impact:

**<n>. <short title>** — `<severity: blocker | major | minor>`
- **Where:** <spec section, and line reference where useful>
- **Issue:** <what is wrong, quoting the spec or artifact>
- **Fix:** <the specific change to make — concrete enough to act on without re-reading the spec>

(If there are no substantiated findings, write "No substantiated findings.")

### Summary
- Sections: <n>/4 complete, <n> incomplete, <n> missing
- Findings: <n> blocker, <n> major, <n> minor
- Verdict: one of the three in the verdict rule below, verbatim
- Next actions: <ordered list of the 1–3 highest-value fixes>
```

Verdict rule, applied top-down — the first matching row wins:

| Condition | Verdict |
|---|---|
| Any blocker, any missing section, or 3+ majors | **Needs revision before implementation** |
| Any major, or any incomplete section | **Implementable, but fix these first** |
| Only minor findings, all four sections complete | **Ready to implement** |

Do not soften the verdict because the spec is long or clearly well-researched — a thorough spec
with four major findings still needs those four fixes before someone builds from it.
