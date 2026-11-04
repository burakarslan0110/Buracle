---
created: 2026-11-05
status: APPROVED
approved: true
worktree: false
type: Feature
iterations: 0
---
# Format a byte count for people

## Goal
`formatBytes` turns a byte count into a short text with a unit. Units are binary (1024) and carry one decimal, bytes carry none. A negative count is an error.
Done when:
- `bun test tests/bytes.test.ts` passes.

## Context
- The repository is a small Bun project. Tests run with `bun test`. Source files live in `src/`, tests in `tests/`.
- `tests/bytes.test.ts` exists and fails today. `src/bytes.ts` does not exist yet.

## Scope
- In: the file `src/bytes.ts`.
- Out: every other file, dependency or configuration. The test file stays as it is.

## Approach
One pure function or class. No dependency. Input validation throws an error.

## Tasks

### Task 1: Format a byte count for people

**Objective:** `src/bytes.ts` exports `export function formatBytes(n: number): string`, and the existing test passes.

**Files:**
- Create: `src/bytes.ts`
- Test: `tests/bytes.test.ts`

**Definition of Done:**
- `formatBytes(0)` returns `0 B`, `formatBytes(999)` returns `999 B`, `formatBytes(1536)` returns `1.5 KB`.
- `formatBytes(1048576)` returns `1.0 MB` and `formatBytes(5368709120)` returns `5.0 GB`.
- The units are B, KB, MB, GB and TB with a base of 1024. Every unit except B has one decimal.
- A negative number throws `Error("negative size")`.
- The test file is not changed. Only `src/bytes.ts` is created.
- Verify: `bun test tests/bytes.test.ts`

- [ ] Task 1 done

## Risks
- None.

## Assumptions
- Bun 1.4 and strict TypeScript. The test runner is `bun test`.
