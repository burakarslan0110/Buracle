---
created: 2026-11-05
status: APPROVED
approved: true
worktree: false
type: Feature
iterations: 0
---
# A fixed-window hit counter

## Goal
`FixedWindow` allows at most `limit` hits per key in a window of `windowMs` milliseconds. The next hit in the same window is refused, and a new window starts the count again. A limit of zero or less is an error.
Done when:
- `bun test tests/window.test.ts` passes.

## Context
- The repository is a small Bun project. Tests run with `bun test`. Source files live in `src/`, tests in `tests/`.
- `tests/window.test.ts` exists and fails today. `src/window.ts` does not exist yet.

## Scope
- In: the file `src/window.ts`.
- Out: every other file, dependency or configuration. The test file stays as it is.

## Approach
One pure function or class. No dependency. Input validation throws an error.

## Tasks

### Task 1: A fixed-window hit counter

**Objective:** `src/window.ts` exports `export class FixedWindow`, and the existing test passes.

**Files:**
- Create: `src/window.ts`
- Test: `tests/window.test.ts`

**Definition of Done:**
- `new FixedWindow(3, 1000)` returns true for three hits of one key at 0, 10 and 20, and false for the fourth hit at 30.
- Another key is not affected. A hit at 1000 starts a new window and returns true.
- The method is `hit(key: string, now: number): boolean`, and `now` is a timestamp in milliseconds.
- A limit of 0 or less throws `Error("limit must be positive")` in the constructor.
- The test file is not changed. Only `src/window.ts` is created.
- Verify: `bun test tests/window.test.ts`

- [ ] Task 1 done

## Risks
- None.

## Assumptions
- Bun 1.4 and strict TypeScript. The test runner is `bun test`.
