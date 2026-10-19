# Cleanup signals: analyzers, dynamic usage and conventions

Use this file during Phases 1-3. Everything here is read-only. If a command would write into the
project (a cache, a build directory that git tracks, a fix), skip it or use the no-write flag shown.

## 1. Counting families correctly

- **One tool family counts once.** The helper script, `rg` and `ast-grep` are all text (T). Two text
  searches never make two families.
- **Absence in semantic search is weak.** semble missing a hit does not count as a family. A semble hit
  that shows real usage *contradicts* the candidate.
- **Graph evidence needs a fresh index.** Read codegraph's staleness banner, or the `index` block of
  `scripts/graph-candidates.ts` (`state` must be `complete`, `stale` false, `pendingReferences` 0).
  Dynamic dispatch (callbacks, interfaces, reflection, string lookups) can hide edges, so G alone never
  clears a dynamic-usage hint. The snapshot and `codegraph_explore` are one family.
- **The snapshot is filtered, not proof.** `graph-candidates.ts` uses codegraph's dead-code report,
  which already drops exported, decorated, overriding and same-name symbols and checks each row against
  its own file's text. When it prints `report: findDeadCode`, the list is the raw unreferenced set
  (codegraph's own docs put the real dead share near 1%): treat each row as a lead only.
- **Boundary (B) is a review, not a search, and a precondition.** You read manifests, registries and
  conventions and state why the item has no public or framework role. It never counts as one of the
  two families: two searches plus a review is not two independent signals.
- **Contradictions win.** One credible use (a config key with the same name that is loaded by name, a test
  that exercises a route) moves the item to `keep-uncertain` or `public-surface` until resolved.

## 2. Project analyzers (family A)

Run only tools that are already installed and configured for the project. Prefer the project's own
binary under `node_modules/.bin/` or its virtualenv. Never install, never pass a fix flag.

### TypeScript and JavaScript
| Tool | When | Command (no writes) | What it proves |
|---|---|---|---|
| knip | `knip` in devDependencies or a knip config exists | `./node_modules/.bin/knip --no-progress --reporter compact` | unused files, exports, dependencies |
| tsc | a `tsconfig.json` exists | `./node_modules/.bin/tsc --noEmit --incremental false --noUnusedLocals --noUnusedParameters -p tsconfig.json` | unused locals and parameters only, not unused exports. Skip if the project uses `composite` and tsc refuses `--incremental false` |
| ESLint | the config enables `no-unused-vars` or the TS variant | `./node_modules/.bin/eslint <paths>` (no `--fix`, no `--cache`) | unused bindings inside files |

### Python
| Tool | When | Command (no writes) | What it proves |
|---|---|---|---|
| ruff | `ruff` on PATH or in the venv | `ruff check --no-cache --select F401,F811,F841 <paths>` | unused imports, redefinitions, unused locals |
| vulture | installed | `vulture <paths> --min-confidence 80` | unused functions, classes, attributes (respect an existing whitelist file) |

### Go
| Tool | When | Command | What it proves |
|---|---|---|---|
| staticcheck | installed | `staticcheck -checks U1000 ./...` | unused unexported identifiers |
| deadcode | installed (`golang.org/x/tools/cmd/deadcode`) | `deadcode ./...` (add `-test` to count tests as roots) | functions unreachable from `main` packages; meaningless for pure libraries |

`go vet` is not a dead-code tool; do not count it.

### Other ecosystems
- Rust: `cargo check` reports `dead_code` warnings but builds into `target/`. Ask the user before a
  long build; `target/` is normally git-ignored, so the tree check still holds.
- A project script named like `lint:unused` or `deadcode`: read it first and run it only if it does not
  write or fix.

## 3. Dynamic usage (resolve before `remove-candidate`)

The helper script reports some of these as `dynamic-usage hints`. Search for the rest with `rg` when the
candidate's language or framework makes them plausible.

### TypeScript and JavaScript
- ``import(`./${name}`)``, `require(variable)`, `require.context(...)`, `import.meta.glob(...)`.
- Registries indexed by string: `handlers[action]`, `components[type]`, `commands.get(name)`.
- `eval`, `new Function`, `globalThis[name]`.
- Auto-import setups (Nuxt, unplugin-auto-import): names are used without import statements, so text
  absence proves little; rely on G and A.
- Decorators and dependency injection (NestJS and Angular `@Injectable`, `@Controller`, module
  `providers` arrays): classes are instantiated by the container.

### Python
- `getattr(obj, name)`, `importlib.import_module(...)`, `__import__`, `globals()[...]`, `pkgutil` scans.
- Entry points: `[project.scripts]`, `[project.entry-points.*]`, `console_scripts` in `setup.cfg`.
- Framework wiring: Django `INSTALLED_APPS`, `urls.py`, `admin.py` registrations,
  `management/commands/*`, `@receiver` signals, template tags; Flask or FastAPI route decorators; Celery
  `@shared_task`; Click or Typer commands; pytest fixtures, which are used by parameter name and from
  `conftest.py`.
- `__all__` lists define a module's public surface.

### Go
- Methods are used through interfaces; the helper script skips them, and you should too unless
  staticcheck reports them.
- `init()` functions, `//go:generate`, build tags (`//go:build linux`), cgo `//export`, `reflect`,
  `plugin.Open`.
- Exported identifiers in a library package are public API unless the package is under `internal/`.

### Everywhere
- Names stored in YAML, JSON or TOML and resolved at runtime (job names, handlers, feature flags).
- CLI command registries, event names, queue and cron job names, RPC or GraphQL resolvers by name.
- Serialization by field name, templates that call helpers, shell scripts, Makefiles, CI workflows,
  Dockerfiles.
- Documentation that describes a feature: documented does not mean used, but it makes the item a
  `public-surface` until the user decides.

## 4. Framework convention files (family B)

Files loaded because of where they are, not because something imports them. Treat them as
`public-surface` unless the framework itself is unused. Confirm conventions with context7
(`resolve-library-id`, then `query-docs` for the installed version) when unsure.

- Next.js: `app/**/{page,layout,route,loading,error,not-found,template,default}.tsx`, `pages/**`,
  `middleware.ts`, `instrumentation.ts`.
- Nuxt: `pages/`, `layouts/`, `server/api/`, `plugins/`, `composables/` (auto-imported).
- SvelteKit: `+page.svelte`, `+layout.svelte`, `+server.ts`, `hooks.server.ts`.
- Remix and React Router file routes: `app/routes/**`. Astro: `src/pages/**`.
- Storybook `*.stories.*`, test setup files named in a config, Vite or Webpack entry files.
- Django and Rails style directories that the framework scans.

## 5. codegraph usage notes

- One `codegraph_explore` call usually returns the source, the call paths and a blast-radius summary.
  Name the symbol and its file in the query.
- Pass the project root (the git top level) as `projectPath`, and another repository's root to query
  that one.
- A missing index returns guidance instead of results: run `buracle index ensure --cwd <project root>`
  once and retry; if there is still no index, record G as `unchecked`.

## 6. Estimating payoff and risk

- Size: for an export, the lines from its definition to the end of its body; for a file, its line count.
- Risk is low when the item is private to an application, has no tests and no dynamic sites nearby;
  medium when tests or docs mention it; high when it is in a library's public surface or near reflection.
