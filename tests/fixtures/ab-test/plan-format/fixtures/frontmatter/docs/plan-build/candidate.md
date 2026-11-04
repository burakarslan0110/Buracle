---
created: 2026-11-05
status: APPROVED
approved: true
worktree: false
type: Feature
iterations: 0
---
# Read a Markdown frontmatter block

## Goal
`parseFrontmatter` reads the `key: value` lines between the two `---` fences at the top of a Markdown text. A text without a closed frontmatter block is an error.
Done when:
- `bun test tests/frontmatter.test.ts` passes.

## Context
- The repository is a small Bun project. Tests run with `bun test`. Source files live in `src/`, tests in `tests/`.
- `tests/frontmatter.test.ts` exists and fails today. `src/frontmatter.ts` does not exist yet.

## Scope
- In: the file `src/frontmatter.ts`.
- Out: every other file, dependency or configuration. The test file stays as it is.

## Approach
One pure function or class. No dependency. Input validation throws an error.

## Tasks

### Task 1: Read a Markdown frontmatter block

**Objective:** `src/frontmatter.ts` exports `export function parseFrontmatter(markdown: string): Record<string, string>`, and the existing test passes.

**Files:**
- Create: `src/frontmatter.ts`
- Test: `tests/frontmatter.test.ts`

**Definition of Done:**
- `parseFrontmatter("---\\ntitle: Hello\\nstatus: draft\\n---\\n# Hello\\n")` returns `{ title: "Hello", status: "draft" }`.
- Spaces around a value are removed. The first colon separates the key from the value.
- A text that does not start with `---`, or has no second `---` line, throws `Error("no frontmatter")`.
- The test file is not changed. Only `src/frontmatter.ts` is created.
- Verify: `bun test tests/frontmatter.test.ts`

- [ ] Task 1 done

## Risks
- None.

## Assumptions
- Bun 1.4 and strict TypeScript. The test runner is `bun test`.
