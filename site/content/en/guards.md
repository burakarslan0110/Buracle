---
title: Guards
description: What Buracle Stack's hooks deny, what they ask you about first, what they mask and how to add your own patterns.
order: 6
---

Buracle Stack sets every harness to run without approval prompts (`permissions.bypass`), and its hooks do the guarding instead. The checks run before each tool call, on every harness. A denial starts with `Buracle Stack H<nn>:`, which names the hook that denied the call.

## Denied commands

The shell guard (H01) denies commands that cannot be undone:

- `rm -rf` of `/`, a system folder, `~` or a home folder such as `~/Documents` or `~/.ssh`
- a force push, mirror push or delete of `main` or `master`
- piping a download into a shell (`curl ... | sh`)
- `mkfs`, `dd` to a device and erasing a disk with `diskutil`
- a fork bomb, killing every process, `crontab -r` and `gh repo delete`

The guard looks through wrappers such as `sudo`, `env`, `sh -c`, `find -exec` and code passed to an interpreter. A command it cannot follow to the end is denied.

## Denied writes

The write guard (H02) denies writes to:

- secrets: `.env` files, keys and credentials
- `~/.ssh`, `~/.aws` and `~/.gnupg`
- credential stores such as `~/.netrc`, `~/.npmrc` and `~/.docker/config.json`
- Buracle Stack's own setup: `~/.buracle` and the harness settings that register its hooks

## Commands only you can run

The agent cannot switch Buracle Stack off. The shell guard denies these commands when the agent runs them:

- `buracle uninstall`
- `buracle config set` or `unset` of the guards, the permissions, the harnesses, the routing, the stop guard and the approval, review and verification switches
- a command that removes or disables Buracle Stack's harness plugin

Run them yourself, in a terminal or as `! <command>` in the harness.

## Asked first

Hard-to-undo commands wait for your answer (H20):

| Kind | Examples |
|---|---|
| Force push | `git push --force`, `git push --force-with-lease` |
| Rewrite git history | `git reset --hard`, `git rebase`, `git commit --amend` |
| Discard uncommitted changes | `git checkout -- <path>`, `git restore <path>`, `git clean -f`, `git stash drop` |
| Delete a branch or tag | `git branch -D`, `git tag -d`, `git push --delete` |
| Skip the git hooks | `git commit --no-verify` |
| Push to a remote | `git push` |
| Publish outside this machine | `npm publish`, `cargo publish`, `gh release create`, `gh pr merge`, `docker push` |
| Delete database data | `dropdb`, `prisma migrate reset`, `rails db:drop`, `DROP TABLE` in a SQL client |
| Delete a folder tree | `rm -r` of a folder that is not a build or cache folder such as `node_modules` or `dist` |

Where the harness has a dialog, the command waits in it. In Claude Code you choose Allow once, Allow for this session or Refuse. Codex shows its own approval prompt, OpenCode shows a dialog in its TUI, and Oh My Pi and Pi show a select dialog.

In Qwen Code and AGY CLI, and in sessions without a dialog such as `codex exec`, the denial tells the agent to ask you. Reply with "yes", "ok" or "go ahead" to allow the command. The [host limits](harnesses.md#host-limits) list each case.

## Masking

Keys, tokens and passwords are masked in what tools return (file reads, shell output, search results and MCP results) before the model reads them. `guards.redact` controls it, and its default is `true`. Codex has two gaps, listed in the [host limits](harnesses.md#host-limits): the live output of a running command and the output of a failed MCP call.

## When a hook fails

The guards fail closed, and every other hook lets the work go on and writes the error to `~/.buracle/logs/buracle.log`.

- In Claude Code, Codex, Qwen Code and AGY CLI, the hooks are commands. If the guard hook cannot load or decide, every guarded tool call is denied until Buracle Stack works again. The denial asks you to run `buracle doctor` and then `buracle install`.
- OpenCode, Oh My Pi and Pi run the hooks inside the harness. There a failing shell guard or write guard denies the call.

## Your own patterns

Add patterns in `~/.buracle/config.yaml`:

```yaml
guards:
  bash:
    extraDeny:
      - "terraform destroy"
  write:
    protect:
      - "infra/prod/**"
      - "~/notes/*.md"
```

- `guards.bash.extraDeny` holds regular expressions matched against the command, also as `/pattern/flags`. A match is denied and the agent is told to ask you.
- `guards.write.protect` holds globs. A path that starts with `~` or `/` is absolute. A pattern with `/` is relative to the session's folder. A bare name matches a file name anywhere. Matching ignores case.
