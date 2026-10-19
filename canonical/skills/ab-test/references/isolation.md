# Isolation recipes

Goal: each arm sees exactly one variant of the target and nothing else of the user's setup, and
the user's real setup is never touched. Throwaway directories plus environment overrides achieve
both; renaming or hiding the user's files is never acceptable.

## Layout

```text
<root>/                      mktemp -d "${TMPDIR:-/tmp}/buracle-bench-<slug>-XXXXXX"
  baseline/  candidate/      one folder per arm
    claude/                  CLAUDE_CONFIG_DIR (Claude Code)
    home/                    HOME (Codex, OpenCode, omp)
    buracle/                 BURACLE_HOME (holds the arm's brain: seed memories here when cases need them)
    plugin/                  a Claude plugin variant, when the target lives in the plugin
    repo/                    candidate only: the repo copy where a canonical change is rendered
  results/                   runner output: results.jsonl, meta.jsonl, transcripts, work dirs
```

## Every arm

| Variable | Value | Why |
|---|---|---|
| `BURACLE_HOME` | `<arm>/buracle` | Session state, spool, caches and the memory (`<arm>/buracle/brain`) stay out of `~/.buracle` |
| `BURACLE_CORTEXDB_BIN` | `$HOME/.buracle/toolchain/cortexdb/<version>/cortexdb-mcp` | Only when cases need memory: the arm's toolchain has no CortexDB binary, and this one only runs; it opens the arm's brain files |

Seed the memories a case needs with the CLI under the arm's environment, from a folder that maps
to the fixture's project:
`BURACLE_HOME=<arm>/buracle BURACLE_CORTEXDB_BIN=… buracle mem write --type decision --title "<claim>" --summary "<one line>" --body "<text>"`.

When the arm loads Buracle's hooks, copy `~/.buracle/config.yaml` to `<arm>/buracle/` and
`~/.buracle/state/runtime-config.json` to `<arm>/buracle/state/`; both hold settings, not secrets.

The runner already removes the caller's session variables from the child environment
(`BURACLE_SESSION_ID`, `BURACLE_HARNESS`, every `CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_PID`,
`CLAUDE_EFFORT`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `OPENCODE_SESSION_ID`, `OMP_SESSION_ID`), so a trial can never
write into your own session's plan state. Because `CLAUDE_CODE_*` is stripped, pass
`CLAUDE_CODE_OAUTH_TOKEN` explicitly with `--env`.

Installing Buracle into an arm: with `HOME`, `BURACLE_HOME` and the harness variables pointing into
the arm, `buracle install <h> --dry-run` shows what would be written. Every path it lists
must be inside `<root>`; only then repeat it without `--dry-run`.

## Claude Code

- **Isolate:** `CLAUDE_CONFIG_DIR=<arm>/claude`. Settings, user skills, rules, plugins and
  `.claude.json` all live there.
- **Place the variant:**
  - Buracle plugin: put each arm's rendered plugin at `<arm>/plugin` so both arms use the same
    flags, `--append-arg --plugin-dir --append-arg <arm>/plugin`. Baseline:
    `git archive <ref> harness/claude | tar -x -C <arm>`, then move `<arm>/harness/claude` to
    `<arm>/plugin`. Candidate: render it in a repo copy (SKILL.md phase 4), then copy
    `<arm>/repo/harness/claude` to `<arm>/plugin`.
  - User-level skill: the rendered Claude copy (`harness/claude/skills/<id>/`) into
    `<arm>/claude/skills/<id>/`.
  - Global rule: `<arm>/claude/rules/<file>.md`.
  - Project guidance (`AGENTS.md`, `.claude/rules/`, `.agents/skills/`): in the case fixture.
  - To test a path rule's content rather than its scoping, drop its `paths:` line in both arms'
    copies; otherwise it loads only when the agent reads a matching file.
- **Credentials:** the login is stored per config directory (the macOS Keychain entry is keyed to
  it), so a fresh directory is logged out. Use a long-lived token: the user runs
  `claude setup-token` once and stores the token in the Keychain
  (`security add-generic-password -a "$USER" -s buracle-bench-claude -w`); pass it per batch with
  `--env CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s buracle-bench-claude -w)"`.
  `ANTHROPIC_API_KEY` also works. Do not export the token in the user's shell profile: token
  sessions cannot use claude.ai connectors. `--bare` ignores the token.
- **Permissions:** the profile runs `--permission-mode acceptEdits --permission-prompts none`.
  Edits inside the work dir go through; anything else that would prompt is denied, and the
  attempted call still appears in the transcript, which is enough for routing probes. Cases that
  must run a command need a narrow allowance:
  `--append-arg --allowedTools --append-arg "Bash(bun test:*)"`. Never
  `--dangerously-skip-permissions`.
- **Pin** `--append-arg --model --append-arg <model>` and
  `--append-arg --effort --append-arg <level>` identically in both arms.

## Codex CLI

- **Isolate:** `HOME=<arm>/home` (user skills come from `$HOME/.agents/skills`) and
  `CODEX_HOME=<arm>/home/.codex`; create that directory first, Codex requires it to exist.
- **Place the variant:** neutral skill render `harness/agents-skills/<id>/` into
  `<arm>/home/.agents/skills/<id>/`; global guidance into `<arm>/home/.codex/AGENTS.md`; project
  guidance into the fixture. MCP servers come from `<arm>/home/.codex/config.toml`; install them
  with Buracle into the arm (above) rather than copying the real file.
- **Credentials:** `--env CODEX_API_KEY=…`, or, only with the user's consent, a copy of
  `~/.codex/auth.json` in `<arm>/home/.codex/` (mode 600, deleted with the temp root).
- **Flags** (profile): `codex exec --json --ephemeral --skip-git-repo-check --sandbox workspace-write -C {work} "{prompt}"`.
  Never `--dangerously-bypass-approvals-and-sandbox`.
- **Caches:** a moved `HOME` empties package caches, so npx/uvx MCP servers would download on
  every run. Point them back: `--env npm_config_cache=<real home>/.npm`,
  `--env UV_CACHE_DIR=<real home>/.cache/uv`. Caches hold packages, not settings.

## OpenCode

- **Isolate:** `HOME=<arm>/home`, `XDG_CONFIG_HOME=<arm>/home/.config`,
  `XDG_DATA_HOME=<arm>/home/.local/share`. OpenCode also reads `~/.claude/skills` and
  `~/.agents/skills`; the moved `HOME` covers both.
- **Always `opencode run --standalone`:** without it the run attaches to the background service,
  which carries the user's real configuration.
- **Credentials:** provider API key variables, or, with consent, a copy of the OpenCode auth file
  in the arm's data directory.
- **Permissions:** no `--auto` for trigger and routing cases; for edit cases only with a fixture
  and the user's consent.
- **Caches:** as for Codex.

## omp

- **Isolate:** `HOME=<arm>/home` and `PI_CODING_AGENT_DIR=<arm>/home/.omp/agent`. omp reads
  `~/.agents` (skills and rules) by default, so the moved `HOME` matters.
- **Place the variant:** `<arm>/home/.agents/skills/<id>/`; project rules in the fixture's
  `.agents/rules/` or `.omp/rules/` (omp does not read `.claude/rules/`).
- **Flags** (profile): `omp -p --mode json --no-session --cwd {work} "{prompt}"`. A without-arm
  can use `--append-arg --no-skills` or `--append-arg --skills=<glob>`.
- **Credentials:** `--api-key` or provider variables, or a dedicated profile the user logs into
  once (`omp --profile buracle-bench`). Never `--auto-approve` or the `yolo` approval mode.
- **Caches:** as for Codex.

## Admin-managed policies

Managed settings (for example a write guard) still apply inside throwaway configurations. If the
agent under test cannot write in its work dir, ask the user where benchmark sandboxes may live,
or restrict the benchmark to read-only cases.

## Cleanup

Delete `<root>` when the report is done, unless the user wants to read transcripts. They contain
prompts and outputs: never copy them into the repo or memory.
