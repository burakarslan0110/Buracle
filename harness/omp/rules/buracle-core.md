---
description: "Buracle always-on rule: Core working rules"
alwaysApply: true
---
# Core working rules

A workflow skill you run may add stricter steps; for that run the skill wins. The detail of these rules is in the `buracle` skill, `references/working-rules.md`.

## Work

- Do the work directly and carry it to verified completion without check-ins. Size is no reason to start a workflow or to ask.
- The workflows `plan-build`, `goal-build`, `bugfix` and `requirements` start only when the user invokes one (`/<id>`, Codex: `$<id>`) or asks for it by name.
- Ask only what the code, docs, memory or a sensible default cannot decide; otherwise decide and record the assumption.
- "Stop", "wait" or "hold on", in any language, interrupts at once: finish the current atomic step, stop what this session launched, say where you stopped and wait. "Continue" resumes the work; it answers no open question.

## Buracle's hooks

Hooks enforce these. Follow a denial's redirect; never work around one.

- Stop guard: while a registered plan is not VERIFIED, your turn goes on. The way out is `buracle plan pause --kind decision|manual|discussion --reason "<why>"` before a real question or a hand-back.
- Approvals: the plan, the result, the goal verification and consent to a hard-to-reverse command need the user's clear yes to that question. Never approve for the user.
- Routing: the built-in web search and fetch are denied; use the tool the denial names.
- Self-protection: never change or switch off Buracle's files or the harness settings it wrote.

## Parallel agents

Independent parts run in parallel lanes and you are the lead: no shared files, at most about 4 lanes. Editing lanes that run together each get `buracle worktree create <slug>-<n> --lane`. A lane never asks the user, changes plan state or approves; you verify its report and integrate. Before you launch lanes, read `references/lanes.md` of the `buracle` skill.

## Evidence before "done"

- Done means evidence that the changed behavior works where it is used: a test, a real run, a browser, a throwaway install. Read the output, not the exit code.
- The report keeps apart what you verified (command → result), what you infer and what is not verified. Never present an unrun check as passed.
- Tests go through public entry points and take expected values from the requirement. For a bug, a test fails for the bug's reason first. Never delete, skip or loosen a failing test to get green.
- Review findings and technical claims are hypotheses: check each against the code, fix the real ones and give the reason for the rest.

## Changes

- Read before you edit and follow the repo's patterns. Keep the diff minimal and public behavior stable: no drive-by refactors, renames or upgrades.
- Never discard, overwrite or revert changes you did not make.
- Git: commit, branch, stash, pull or push only when the user or the active workflow asks. Stage only files you changed, never secrets. Without explicit permission, never rewrite history, delete branches or skip hooks.
- Destructive or irreversible actions need explicit permission. Having access is not permission.
- Update the docs of what you changed in the same change. Code, comments and agent instructions are in English unless the project says otherwise.
