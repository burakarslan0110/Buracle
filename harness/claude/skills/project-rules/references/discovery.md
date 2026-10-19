# Discovery: where commands and conventions live

A fact goes into guidance only with evidence: a `file:line` you read or a command you ran.
Work from the manifests outward; the code itself settles disputes.

## 1. Manifests and toolchain

| Ecosystem | Read | What it settles |
|---|---|---|
| JavaScript / TypeScript | `package.json` (`scripts`, `packageManager`, `engines`, `workspaces`), the lockfile, `tsconfig*.json`, `eslint.config.*` / `.eslintrc*`, `biome.json*`, `.prettierrc*`, `vitest`/`jest`/`playwright` configs, `turbo.json`, `nx.json`, `pnpm-workspace.yaml` | The lockfile picks the package manager: `bun.lock`/`bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm |
| Python | `pyproject.toml` (`[project]`, `[tool.uv]`, `[tool.poetry]`, `[tool.pytest.ini_options]`, `[tool.ruff]`, `[tool.mypy]`, `[tool.pyright]`), `uv.lock` / `poetry.lock` / `requirements*.txt`, `tox.ini`, `noxfile.py`, `conftest.py` | `uv.lock` → `uv run …`; poetry → `poetry run …`; bare `python` only when neither exists |
| Go | `go.mod` (module path, Go version), `Makefile`, `.golangci.y*ml` | `go test ./...` and `go vet ./...` unless a Makefile wraps them |
| Rust | `Cargo.toml` (workspace members), `rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml` | `cargo test`, `cargo clippy` with the flags CI uses |
| JVM | `gradlew` / `mvnw`, `build.gradle*`, `pom.xml` | Always the wrapper, never a global `gradle` or `mvn` |
| .NET | `global.json`, `*.sln` / `*.slnx`, `Directory.Build.props`, `.editorconfig` analyzers | `dotnet test <solution>` |
| Ruby / PHP | `Gemfile` and `Rakefile`; `composer.json` `scripts` | `bundle exec …`; `composer <script>` |
| Any | `Makefile`, `justfile`, `Taskfile.yml`, `mise.toml`, `.tool-versions`, `.nvmrc`, `.python-version`, `Dockerfile`, `compose*.yml`, `.devcontainer/`, `.env.example` (variable names only) | Task-runner targets usually wrap the real commands; document the entry point the team uses |

## 2. CI and commit hooks: the real gate

- CI files: `.github/workflows/*.yml`, `.gitlab-ci.yml`, `.circleci/config.yml`,
  `azure-pipelines.yml`, `Jenkinsfile`, `.buildkite/`. Copy the exact commands of the test, lint,
  typecheck and build jobs with their flags and required environment variable names.
- When CI and package scripts disagree, CI is the gate. Document the local command that matches it.
- Commit hooks: `.husky/`, `.pre-commit-config.yaml`, `lefthook.yml`. List what runs on commit so
  agents expect it and never bypass it with `--no-verify`.

## 3. Test layout

Establish, with one example path for each:

- framework and config file;
- where tests live (a mirrored `tests/` tree or next to the source) and how they are named
  (`*.test.ts`, `test_*.py`, `*_test.go`);
- shared fixtures, factories, snapshot files, and the snapshot-update command;
- how to run one file and one test by name;
- which tests need services (database, Docker, network) and how to start them;
- how slow or e2e suites are separated from the fast ones.

## 4. Architecture map

- Entry points (CLI mains, servers, workers, cron jobs): `codegraph` first, then confirm by reading.
- Package and module boundaries, plus any enforced import restrictions (lint rules such as
  `no-restricted-imports`, import-linter, depguard).
- Generated code: `rg -l 'DO NOT EDIT|@generated'` finds markers; find the generator command in
  scripts or CI and document it next to the directory.
- Vendored or copied third-party code.

## 5. Conventions

Candidate topics: error handling (types, wrapping, where errors are logged), logging (library,
levels, structured fields), configuration and environment loading, dependency injection, async and
concurrency patterns, database access and migrations, API shape and versioning, feature flags,
i18n, file and symbol naming, public API stability.

Method for each candidate:

1. Ask `semble` an intent query ("how are HTTP errors returned to clients").
2. Read the top hits. Use `codegraph` to see how widely the helper or pattern is used.
3. Search for counterexamples with `rg`.
4. Weigh recent code more: `git log --since=6.months --diff-filter=A --name-only --format=` lists
   files added recently.

Write it down only when at least three independent places agree and it differs from what the
ecosystem does by default, or when history shows agents or people getting it wrong (reverts, fix
commits, review comments in `git log`).

## 6. Library-specific advice

Only for the version in the lockfile: resolve the library with `context7` (`resolve-library-id`),
query the specific topic (`query-docs`), and keep the version in your notes. Put a version in
`AGENTS.md` only when the repo pins it.

## 7. Verification log

Keep this table while you work; it goes into the final report, not into `AGENTS.md`.

| Command | Exit | Time | Note |
|---|---|---|---|
| `bun install --frozen-lockfile` | 0 | 4 s | |
| `bun test tests/core/plan.test.ts` | 0 | 1 s | single-file form works |
| `bun run e2e` | — | — | not run: needs `PLAYWRIGHT_BASE_URL` and a running server |

Never run: deploys, publishes, releases, version bumps, migrations against non-local databases,
commands that need production credentials, destructive cleanups, or anything that writes to a
remote. Never print or store secret values you meet in `.env` files; record variable names only.
