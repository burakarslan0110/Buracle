---
description: "Buracle path rule: TypeScript and JavaScript (injected when editing or writing matching files)"
condition:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
  - "**/*.cts"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.cjs"
  - "**/package.json"
  - "**/tsconfig*.json"
---
# TypeScript and JavaScript

## Package manager and runtime
- Detect the package manager from the lockfile and use only that one: `bun.lock` or `bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm. A `packageManager` field in package.json takes precedence. Never create a second lockfile; never delete or regenerate one unasked. In a monorepo, several lockfiles may belong to separate workspaces: use each workspace's own manager, and never regenerate another workspace's lockfile.
- Install and run through that manager (`bun add -d x`, `pnpm add x`, `bun run test`). Read the `scripts` in package.json for the real test, lint, typecheck and build commands before guessing.
- Respect the target runtime (Node version from `.nvmrc` or `engines`, Bun, Deno, browser) and the module system (ESM or CommonJS). Import Node built-ins with the `node:` prefix.
- Prefer the platform and the standard library; justify every new package. Add `@types/*` only when a library ships no types of its own.

## Types
- Keep `strict` on. Never loosen tsconfig or add `@ts-ignore` to get green; use `// @ts-expect-error <reason>` only for a known upstream typing bug.
- No `any`. Take `unknown` at boundaries and narrow it with type guards. Use `as` only right after validation; prefer `satisfies` for typed literals.
- No non-null assertions (`!`) unless an invariant guarantees the value. Under `noUncheckedIndexedAccess`, handle the `undefined` case.
- Model variants as discriminated unions and make each `switch` exhaustive (`const unreachable: never = value`).
- Give public APIs explicit exported types; keep internal types unexported.

## Runtime data
- Validate everything that crosses a trust boundary — JSON from network or disk, environment variables, CLI arguments, message payloads — with the project's validator (zod, valibot, …) or explicit guards before typing it. `JSON.parse(text) as T` is not validation.

## Async and errors
- Every promise is awaited, returned, or explicitly handled: no floating promises, no `async` callbacks inside `forEach` (use `for…of` or `Promise.all`).
- Run independent work concurrently with `Promise.all` or `Promise.allSettled`; bound concurrency for large fan-outs.
- Give network calls a timeout or an `AbortSignal`; clean up timers, listeners and subscriptions.
- Throw `Error` instances or subclasses, never strings, and keep the original error as `cause`. In `catch (err)`, treat `err` as `unknown` and narrow it.

## Tests
- Use the runner the repo already uses — `bun test`, Vitest, Jest or `node --test` — as found in scripts and config, and follow its file naming and placement. Runner flags differ: don't pass Jest-only flags (`--runInBand`, `--detectOpenHandles`) to a test script that is not Jest.
- Test exported behavior. Use fake timers for time; avoid snapshot tests for logic; mock only real boundaries (network, clock, filesystem when needed).
- Iterate with a filter (`bun test path/to/file`, `vitest run path -t "name"`). Before finishing, run the typecheck (`tsc --noEmit` or the repo script), the linter (ESLint or Biome per config) and the test suite.

## Library docs
- Check framework and library APIs with context7 at the version in the lockfile; they change between majors (React, Next.js, Vite, Prisma, …).
