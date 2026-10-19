# Investigation evidence guide

## 1. Claim class → evidence that counts

| Claim class | Example question | Evidence that settles it | Not enough on its own |
|---|---|---|---|
| Structure | "Where is X implemented? Who calls it?" | definition read at `path:line`; callers from `codegraph_explore` confirmed by reading at least the decisive ones | a name match from `rg` |
| Control flow | "What happens when Y?" | every hop of the active path read, with the branch conditions that select it | the happy path only, or a function name that sounds right |
| Data flow | "Where does this value come from / go?" | the chain of assignments and calls from source to sink, each cited | one end of the chain |
| Configuration | "Which setting wins?" | the full precedence chain (defaults → files → environment → flags) read in code, plus the actual config files in the repo | a sample config or documentation alone |
| Dependency behavior | "Does library L retry / throw / cache?" | context7 docs for the installed version (version from the lockfile) and, when available, the vendored source | docs for a different major version, memory of the API |
| Runtime result | "What does it output / how long does it take?" | execution evidence from this session (test or command output) | static reading: report it as *not verified at runtime* |
| History | "Why is it like this? Since when?" | commits (`git log -S`, `git blame`), linked PR or issue text, decision memories with ids | a guess from code style |
| Reachability | "Is this still used?" | graph plus text plus dynamic-usage checks (see the dead-code workflow's rules) | a single empty search |
| Build output or installed copy | "Does the installed X do Y? Does the bundle keep Z?" | the generated or installed file itself, read this session: a build folder (`dist/`, `build/`), generated code, `node_modules/<pkg>` or another installed package, a plugin copy a tool installed (for Buracle itself: `harness/<harness>/`, `~/.agents/skills/<id>/`, the hook runtime under `$BURACLE_HOME/runtime/<id>`, OpenCode's copy in `~/.config/opencode/plugins/buracle/`) | the source it was built from |
| Test result | "Does this test pass?" | a fresh run of that focused test this session, with the selected test count | reading the test, which proves only what it asserts |

## 2. Confidence rubric

- **High:** every hop on the answer path is cited and re-opened; the counterexample search ran and found
  nothing contrary; no unresolved dynamic dispatch, configuration or environment dependence; runtime
  claims were executed.
- **Medium:** the path is traced but at least one hop is inferred (dynamic dispatch, a value from the
  environment, library behavior from docs rather than source), or the counterexample search was partial.
- **Low:** a decisive hop is missing, evidence conflicts, or the claim is runtime-only and nothing ran.

State the reason in one line, for example "Medium: the handler is chosen from a registry at runtime;
only the default entry was traced."

## 3. Execution ledger (before the report)

Reconcile the answer with what this session actually did:

- **Observed source:** the files and line ranges you opened.
- **Executed checks:** each command that produced a result, with its exit status and, for tests, the
  number of tests it selected.
- **Inferred:** conclusions drawn from observed source but not executed end to end.
- **Not verified:** each material boundary you left unchecked.

Delete or correct every "ran", "passed", "confirmed" or "verified" with no matching tool result, and
never paste a command into the report as if it had run. A test run that selected zero tests, or other
tests than the ones you name, proves nothing about them.

## 4. Command patterns (read-only)

```bash
# exact identifier, whole word, including hidden config such as .github/
rg -n -w --hidden -g '!.git' 'createSession'
# literal text such as an error message or config key
rg -n -F 'retry.maxAttempts' -g '*.{yaml,yml,json,toml}'
# the name used as a string (registries, reflection)
rg -n -F '"createSession"'
# scope a search and skip tests
rg -n -w 'createSession' src/ -g '!**/*.test.*'
# syntax shapes with ast-grep (search mode only)
ast-grep run -l ts -p 'createSession($$$ARGS)'
ast-grep run -l py -p '@app.route($$$)'
ast-grep run -l go -p 'if err != nil { return $$$ }'
# history
git log -S'createSession' --oneline -- src/
git log -G'retry\s*=' --oneline
git blame -L 80,100 -- src/api/client.ts
git show --stat <sha>
gh pr view <number> --json title,body,url
```

MCP calls:

- `codegraph_explore`: a natural-language query that names the symbol and file, for example
  "how does `uploadFile` in src/upload/send.ts reach the network, and who calls it". Read the call paths
  and the blast-radius summary. Pass the project root (the git top level) as `projectPath`.
- semble `search`: describe the behavior in plain words, with the project root as `repo`; set `content`
  to `all` when config or docs may hold the answer. `find_related` takes a file path and line to find
  similar code.
- context7: `resolve-library-id` with the library name and your question, then `query-docs` with the
  chosen id and one focused topic.
- buracle-memory: `memory_search` in any language (filter `types: [decision, gotcha]` for
  history questions); `memory_get` reads at most a few memories in full, with their history.

## 5. Report template

```markdown
**Answer:** <one to three sentences that answer the question directly; one outcome per enumerated case>

**Confidence:** High | Medium | Low (<one-line reason>)

**Trace**
1. `src/routes/upload.ts:23`: `POST /api/upload` → `handleUpload()`.
2. `src/upload/send.ts:41`: sends with `rawFetch` (no interceptors).
3. `src/api/client.ts:88`: the 401 refresh lives only in the shared client's interceptor, so step 2 never reaches it.

**Evidence**
| Claim | Evidence | Kind |
|---|---|---|
| uploads bypass the interceptor | `src/upload/send.ts:41` | observed |
| a 401 surfaces to the caller | `tests/upload.test.ts:57` asserts the error | observed |
| production behaves the same | no environment-specific branch found (`rg -n NODE_ENV src/upload`) | inferred |

**Counter-check:** <what you looked for that would have disproved the answer, and what you found>

**Not verified:** <runtime facts not executed, code you could not see, inferred hops>

**History:** <commits, PRs or memory ids that explain why, if any>

**Next step (optional):** <for example: this is a defect, the bugfix workflow fits; nothing was started>
```

Kinds: **observed** (read in code or docs this session), **executed** (seen in command or test output
this session), **inferred** (reasoned from observed facts; say from which).
