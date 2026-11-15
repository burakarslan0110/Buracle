# Contributing

Buracle is one developer's harness, published as it is. Bug reports, questions and small, focused pull requests are
welcome. For a larger change, open an issue first.

## Set up

- Use the Bun version in `.bun-version` (`engines.bun` in `package.json` is the minimum) and run `bun install`.
- The CLI runs from source: `bun src/cli/main.ts --help`. Every run refreshes `$BURACLE_HOME/state/runtime-config.json`,
  which installed harnesses read, so point `HOME` and `BURACLE_HOME` at a temp folder:
  `T=$(mktemp -d) && HOME=$T BURACLE_HOME=$T/.buracle bun src/cli/main.ts build`.

## Where to change things

- `canonical/` holds skills, rules, agents and YAML data; `src/` is the code. Skill and rule text is the same for every
  harness, with no placeholders or harness-only blocks (`buracle skills lint` and `buracle rules lint` check).
- A harness is defined in `src/core/harness/`. Do not add a harness-name switch elsewhere.
- `harness/` is generated, git-ignored on `dev` and never committed or edited. Commit changes to `canonical/` and
  `src/`, plus `canonical/skills/buracle/references/commands.md` when the CLI help changed (`build` refreshes it).
- `src/core/` stays pure: relative imports only, and no `node:*`, `bun:*`, `process`, timers or randomness
  (`tests/core/purity.test.ts`).
- Add no dependencies. Write everything in English (`tests/workflow/language-guard.test.ts`).

[`AGENTS.md`](AGENTS.md) has the full rules and [`ARCHITECTURE.md`](ARCHITECTURE.md) explains the layers.

## Before you open a pull request

Work on `dev`; `main` holds only released files. Run the three release checks (GitHub Actions runs them on every push to
a branch other than `main`):

```sh
bunx tsc --noEmit -p .
T=$(mktemp -d) && HOME=$T BURACLE_HOME=$T/.buracle bun src/cli/main.ts build --check
bun test
```

- Tests live in `tests/` and mirror `src/`. Anything that touches the filesystem uses `withSandbox()` from
  `tests/helpers/sandbox.ts`. Tests never touch the real `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.omp`,
  `~/.qwen`, `~/.pi`, `~/.gemini`, `~/.agents` or `~/.buracle`.
- Memory tests use the fake CortexDB in `tests/fixtures/cortexdb/`; never run the real binary in a test.
- After a Bun upgrade, rebuild a local `harness/` and update `.bun-version` in the same commit.

Keep a pull request to one change, say what you verified, and update the docs the change affects (`README.md`,
`README.tr.md`, `ARCHITECTURE.md`, `AGENTS.md`).

## Releases

When CI passes on `dev` and the released files changed, CI writes the next patch version as one commit on `main`
(without `tests/` and `bunfig.toml`) and publishes `v<version>` with the install script. Raise the major or minor version
in `package.json` to start a new line. The install script clones `main` and `buracle update` follows it. CI never runs on
`main`.
