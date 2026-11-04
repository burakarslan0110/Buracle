---
created: 2026-11-05
status: APPROVED
approved: true
worktree: false
type: Feature
iterations: 0
---
# Make a slug from a title

## Goal
`slugify` turns a title into a lower-case slug with single dashes. Turkish letters fold to their base letter. A blank title is an error.
Done when:
- `bun test tests/slugify.test.ts` passes.

## Context
- The repository is a small Bun project. Tests run with `bun test`. Source files live in `src/`, tests in `tests/`.
- `tests/slugify.test.ts` exists and fails today. `src/slugify.ts` does not exist yet.

## Scope
- In: the file `src/slugify.ts`.
- Out: every other file, dependency or configuration. The test file stays as it is.

## Approach
One pure function or class. No dependency. Input validation throws an error.

## Tasks

### Task 1: Make a slug from a title

**Objective:** `src/slugify.ts` exports `export function slugify(title: string): string`, and the existing test passes.

**Files:**
- Create: `src/slugify.ts`
- Test: `tests/slugify.test.ts`

**Definition of Done:**
- `slugify("Kurulum Başlar")` returns `kurulum-baslar`.
- Upper-case letters become lower-case, and ı, ş, ğ, ü, ö, ç and İ fold to i, s, g, u, o, c and i.
- Every run of characters that is not a letter or a digit becomes one dash. Leading and trailing dashes are removed.
- A blank title throws `Error("empty title")`.
- The test file is not changed. Only `src/slugify.ts` is created.
- Verify: `bun test tests/slugify.test.ts`

- [ ] Task 1 done

## Risks
- None.

## Assumptions
- Bun 1.4 and strict TypeScript. The test runner is `bun test`.
