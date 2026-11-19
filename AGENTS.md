# Buracle Stack: repository guide for coding agents

Buracle Stack is one engineering setup and one memory for every coding agent. It keeps one canonical set of
skills, rules, agents, MCP servers, hooks and status lines and generates it for Claude Code, Codex CLI,
OpenCode (v2), Oh My Pi, Qwen Code, Pi and AGY CLI. The code is TypeScript on Bun ≥ 1.4, ESM only, with strict
TypeScript, and the CLI runs from source.

## Read first

- `docs/` is gitignored and holds only the reference the build generates (`docs/reference/`, local).
  The design (`docs/DESIGN.md`) and the contracts (`docs/dev/CONTRACTS.md` and its parts) are not in this
  repository, although comments in code and tests still cite them as "DESIGN §n" and "CONTRACTS §n". The code
  and the tests are the reference. The doc lint skips whatever is missing.
- [ARCHITECTURE.md](ARCHITECTURE.md) maps the layers, the shared hook pipeline, the harness profiles, the
  transaction engine and the Brain. When a comment cites a contract and the code disagrees with it, report the
  disagreement and do not work around it.

## Commands

| Task | Command |
|---|---|
| Install | `bun install --frozen-lockfile` (exact pins from `bun.lock`) |
| Typecheck | `bunx tsc --noEmit -p .` (must stay clean for the whole repo) |
| Build `harness/` (local, git-ignored; only needed to try the plugin or omp extension in place) | `T=$(mktemp -d) && HOME=$T BURACLE_HOME=$T/.buracle bun src/cli/main.ts build` |
| Determinism check | the same with `build --check`: two builds must be identical, and a local `harness/` must match too |
| All tests | `bun test` |
| One test file | `bun test tests/engine/txn.test.ts` |
| Skill lint | `bun src/cli/main.ts skills lint canonical/skills` |
| CLI help | `bun src/cli/main.ts --help` |
| Build the guide site | `bun site/build.ts` (writes `site/dist/`, git-ignored) |

Release checks: run all three before every commit. GitHub Actions runs them on every push to a branch other
than `main`, on macOS arm64 and Linux x64, with the Bun in `.bun-version`, and every job has to pass.

```sh
bunx tsc --noEmit -p .                                                   # clean
T=$(mktemp -d) && HOME=$T BURACLE_HOME=$T/.buracle bun src/cli/main.ts build --check   # deterministic
bun test                                                                 # 0 fail
```

CI also parses the install script with `bash -n scripts/install.sh`. Run that after you edit
`scripts/install.sh`.

## Layout

- `canonical/` is the single source of truth: YAML data and English prose (rules, skills, agents). It names no
  harness. `mcp.yaml` ships a server to every harness unless it says `except:`, and `buracle.yaml` (config defaults)
  holds no harness names, because per-harness keys come from the profiles. `skill-triggers.yaml` has the MCP routing
  trigger phrases, `notices.yaml` the one-time release notices, `tips.yaml` the usage tips (Claude Code's spinner,
  OpenCode's home screen, Qwen Code's loading phrases, Pi's working message). One file is generated:
  `skills/buracle/references/commands.md`, written by the build from the CLI help.
- `src/core/` is pure logic, copied verbatim into the Claude plugin (`harness/claude/hooks/core/`).
  `src/core/events.ts` defines the seven canonical events; `src/core/harness/` holds one `HarnessProfile` per harness,
  and the `Harness` type, tool tables, MCP name shapes, event maps, labels, skill syntax and path tables derive from it.
- `src/engine/` is IO: paths, files, processes, git, log, config and canonical loaders, the transaction engine, merge
  and diff.
- `src/cli/main.ts` is a thin entry; never import it. The router is `src/cli/router.ts`, with one module per command in
  `src/cli/commands/<name>.ts`.
- `src/adapters/<harness>/` has the generator, runtime templates and hook handlers; `src/adapters/registry.ts` lists
  them. `src/adapters/shared/pipeline/` is the one hook pipeline, a file per canonical event. Claude Code, Codex, Qwen
  Code and AGY CLI call it from command hooks; OpenCode, Oh My Pi and Pi from in-process runtimes. An adapter only
  decodes its host's payload and encodes its host's answer.
- `src/workflow/` has plans, flows, worktrees, review scope, project sync and check, skill and rule lint, the session
  store, the usage ledger, code indexes and the second opinion (`companion*`). `src/workflow/non-project.ts` holds the
  one "never a project" rule.
- `src/memory/` is the memory on CortexDB: one `brain.db` with a bucket per project and one for the person; prefixed ids
  live in `src/memory/store.ts` only. Two detached processes: the session-end `mem finalize` and the web UI
  (`src/memory/ui/`), which the install, a session start (`src/memory/ui-presence.ts`, while `memory.ui.autostart` is
  on) or `mem ui` starts and which stops when the last harness session ends.
- `src/usage/` has the per-harness usage collectors.
- `harness/<harness>/`, `harness/agents-skills/` (the rendered skills, which install writes to `~/.agents/skills`) and
  `harness/hook-data.json` are generated by `buracle build`, listed in `harness/.manifest.json`, git-ignored, so no branch holds
  them. Never edit them by hand. `buracle install` and `buracle update` build them first in a checkout that has none. `hook-data.json` is the part of `canonical/` the Claude and Codex command hooks
  read (`src/cli/hook-data.ts`), so a `canonical/` edit reaches them only after a build. The one generated file that stays
  committed is `canonical/skills/buracle/references/commands.md`, which `build` refreshes. `harness/codex/AGENTS.md` is
  output for users' Codex, not guidance for this repository.
- `tests/` mirrors `src/`, with fixtures in `tests/fixtures/<area>/`.
- `site/` is the bilingual guide at https://stack.buracle.dev (GitHub Pages). Each topic is one Markdown page in
  `site/content/en/` and the same page in `site/content/tr/`; `home.json` and `ui.json` hold the landing and UI text.
  `site/build.ts` (no dependencies, `Bun.markdown`) renders it with `site/templates/` and `site/assets/` into `site/dist/`
  and serves `scripts/install.sh` as `/install.sh`. `site/video/` is the launch video's source and `site/media/` holds the
  MP4s, posters and the README GIF.

## Conventions

- Sources. Work only from official harness docs and sources and local `--help` output. Write everything in your
  own words.
- Ownership. Each task owns specific paths, named in its brief. Change only what your task owns, and ask for
  other changes in your report.
- Harness names. Never add a `switch (harness)` or a harness-name literal outside `src/core/harness/`. Add a
  profile field instead.
- Neutral text. Skills and rules are the same text for every harness: no `{{…}}` placeholders and no
  harness-only blocks (`buracle skills lint` and `buracle rules lint` reject them). The always-loaded rules stay
  under 8,000 bytes together, with detail in skill references.
- Generation. Edit `canonical/` and `src/`; do not commit `harness/`. Run the sandboxed build only when you need
  `harness/` locally, and commit the refreshed `canonical/skills/buracle/references/commands.md` when the CLI help
  changed. Generated output must be deterministic (no timestamps, stable key order). `build --check` builds twice into
  temporary folders and fails when they differ, when the manifest does not list exactly the files written, or when a
  local `harness/` or the committed command reference is out of date. Tests never read the repository's `harness/`: they
  build one into the run's temp folder (`tests/helpers/built-harness.ts`).
- Pure core. `src/core/**` takes no IO, no clock and no randomness; the scoped rule below lists its limits.
- Harness writes. Every write into a harness directory goes through the transaction engine
  (`src/engine/txn.ts`), and every path comes from `src/engine/paths.ts`. Hooks fail open, except the
  deliberate guards. The scoped rule below has the details.
- Child processes. Pass `env: { ...process.env }` to every `Bun.spawn` and `Bun.spawnSync`. Without it the child
  gets the environment the process started with, which in tests is the real `HOME` (the preload sandboxes
  `HOME` through `process.env`). `tests/engine/spawn-env.test.ts` enforces it under `src/`.
- Dependencies. Add none, with one registered exception: `beautiful-mermaid` (exact pin, MIT; brings `elkjs` and
  `entities`) draws the review page's Mermaid blocks as SVG. Only `src/workflow/diagram-worker.ts` imports it, inside a
  Bun `Worker` with a time limit. Dependencies are pinned exactly in `package.json`. Bun built-ins are fine outside
  `src/core/`.
- Language. Everything is English: code, comments, identifiers, test names, agent-facing prose (skills, rules, agents,
  hook texts), user docs, CLI output, status lines, the mod and the web UI (one dictionary in `src/memory/ui/i18n.js`,
  no language switch). Agents still reply in the user's language, and the workflow documents under `docs/` (PRDs, plans,
  build contracts, audits) follow it too, with the markers Buracle Stack reads in English (PRD 2026-11-06). The one exception
  is category D, the recognition of text in the user's language: whole-message control words, the reply to a held consent
  question, memory query stopwords and inflections, secret-word redaction, case folding and the MCP categories' trigger
  phrases. Its Turkish words stay as matching data behind English identifiers and comments. A new file with category D
  data needs an entry, with its reason, in the allowlist of `tests/workflow/language-guard.test.ts`. The Turkish
  documents are `README.tr.md`, kept in step with `README.md`, and the Turkish edition of the guide in
  `site/content/tr/`, kept in step with `site/content/en/`. The ab-test fixture under
  `tests/fixtures/ab-test/plan-format/` holds Turkish prompts and plans in the format before the English standard (the
  measured input of PRD 2026-11-04 R9), allowlisted in the same test.

## Testing

- Read `.claude/rules/tests.md` before you write a test: sandbox, fake CortexDB, fault injection.
- Live harness checks that need a login or a real model run (`agy`, `qwen -p`) run only with
  `BURACLE_LIVE_SMOKE=1` (`tests/helpers/live-smoke.ts`). A mock model on a local port is not live.
- Tests never touch the real `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.omp`, `~/.qwen`, `~/.pi`,
  `~/.gemini`, `~/.agents`, `~/.buracle` (the brain included) or `~/Documents/Buracle` (the old memory vault).
  `tests/zz-real-home-untouched.test.ts` fails the run when one of the folders it fingerprints changed.
- `tests/workflow/doc-lint.test.ts` checks that every repository path `README.md` and this file name in
  backticks exists, and that their links resolve. Update them when you move or rename a file. It also checks that the
  Harnesses page of both guide editions lists every record of `src/adapters/shared/host-limits.ts`.

## Branches and releases

- Work lands on `dev`. `main` is dev's own history: CI's `release` job fast-forwards it to a `dev` commit that passed
  every job, and the push is refused when it is not a fast-forward, so `main` and `dev` always have one history and one
  tree. Nothing writes to `main` by hand, and CI never runs on it.
- A GitHub release `v<version>` is cut when `package.json` holds a version that has no tag yet. Raise the version there
  to publish one.
- Every push to `dev` that passes the checks builds the site and deploys it to GitHub Pages (the `pages` job calls
  `.github/workflows/pages.yml`). The Pages workflow also runs by hand for another ref.
- Git tracks nothing that `.gitignore` lists, on any branch. `harness/` is built on the user's machine, so released
  code may use `tests/` and `site/`'s files only as the repository has them. The `posix-install` job installs the tested
  commit as it is, the install script clones `main`, and `buracle update` follows the checkout's upstream.

## Gotchas

- `error TS2688: Cannot find type definition file for 'bun'` from `tsc`, or `opencode: Bundle failed` from
  `build`: the dependencies are not installed. Run `bun install --frozen-lockfile`.
- Every `bun src/cli/main.ts …` run (`build` included) rewrites `$BURACLE_HOME/state/runtime-config.json`, which
  the installed harnesses read. Run it with `HOME` and `BURACLE_HOME` pointing at a temp dir, as in Commands;
  the output does not depend on them. A local `harness/` is yours to rebuild. A stale one makes `build --check`
  fail until you run `build` (delete `harness/` to see the clean-clone state).
- The installed hooks run a frozen copy of the checkout (`$BURACLE_HOME/runtime/<id>`,
  `src/engine/update/runtime.ts`), and OpenCode runs a copy of its plugin. A checkout edit reaches them only
  after `buracle install`. The Claude plugin's mod and the omp extension load `harness/` in place (after
  `/reload-plugins` or a new omp session).
- After a Bun upgrade, a local `harness/` is stale, so `build --check` and the local-harness test of
  `tests/cli/ops/repo-drift.test.ts` fail until the OpenCode and omp bundles are rebuilt. Follow
  `.claude/rules/host-versions.md`.

## Scoped rules

Read the matching rule before you edit those files. The `.claude/rules/` files are not tracked in git, so a
fresh clone lacks them. The guards and helpers they describe are in the named tests and in `tests/helpers/`.

- `.claude/rules/pure-core.md`: `src/core/**`, what pure code may import and use.
- `.claude/rules/harness-writes.md`: `src/engine/**`, `src/adapters/**`, `src/cli/commands/**`; the transaction
  engine, ownership ledger, paths and hook failure modes.
- `.claude/rules/tests.md`: `tests/**`; sandbox, fake CortexDB, fault injection and test guards.
- `.claude/rules/host-versions.md`: `.bun-version`, `src/engine/update/min-versions.ts`,
  `src/adapters/shared/host-limits.ts`, `tests/adapters/*/smoke.test.ts`, `tests/adapters/parity.test.ts`,
  `tests/cli/ops/repo-drift.test.ts`; Bun upgrades, minimum harness versions and host limits.
