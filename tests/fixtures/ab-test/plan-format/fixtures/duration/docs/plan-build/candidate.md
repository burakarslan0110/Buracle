---
created: 2026-11-05
status: APPROVED
approved: true
worktree: false
type: Feature
iterations: 0
---
# Parse a duration text into seconds

## Goal
`parseDuration` turns a text such as `1h30m` into a number of seconds. A text that is not a duration is an error.
Done when:
- `bun test tests/duration.test.ts` passes.

## Context
- The repository is a small Bun project. Tests run with `bun test`. Source files live in `src/`, tests in `tests/`.
- `tests/duration.test.ts` exists and fails today. `src/duration.ts` does not exist yet.

## Scope
- In: the file `src/duration.ts`.
- Out: every other file, dependency or configuration. The test file stays as it is.

## Approach
One pure function or class. No dependency. Input validation throws an error.

## Tasks

### Task 1: Parse a duration text into seconds

**Objective:** `src/duration.ts` exports `export function parseDuration(text: string): number`, and the existing test passes.

**Files:**
- Create: `src/duration.ts`
- Test: `tests/duration.test.ts`

**Definition of Done:**
- `parseDuration("1h30m")` returns 5400, `parseDuration("45s")` returns 45, `parseDuration("2h")` returns 7200.
- The units are h, m and s, in that order, each at most once.
- An empty text, a number without a unit, an unknown unit or a trailing number without a unit throws `Error("invalid duration")`.
- The test file is not changed. Only `src/duration.ts` is created.
- Verify: `bun test tests/duration.test.ts`

- [ ] Task 1 done

## Risks
- None.

## Assumptions
- Bun 1.4 and strict TypeScript. The test runner is `bun test`.
