# Changelog

Buracle Stack follows [semantic versioning](https://semver.org). CI publishes every release on `main` with a tag
`v<version>` and the install script attached; the GitHub release notes list each change.

## 1.0.0

The first stable release and the public launch.

### Added

- The guide at [stack.buracle.dev](https://stack.buracle.dev), in English and Turkish. It covers installing, the
  workflows, the memory, the Console, the guards, the tools, what each harness gets, the `buracle` command and updating.
- A 40-second introduction video on the guide's home page.
- A one-time notice after `buracle update` that points to the guide.

### Changed

- The install command is `curl -fsSL https://stack.buracle.dev/install.sh | bash`. The `install.sh` attached to each
  GitHub release still works.
- `README.md` and `README.tr.md` are short start pages. The reference they held (settings, guards, the harness table,
  host limits, commands) moved to the guide.
- The host-limit rows of `buracle doctor` point to the guide's Harnesses page.
- Versions count up from 1.0.0: the next releases are 1.0.1, 1.0.2 and so on.

### In this release

- One setup in `canonical/` for Claude Code, Codex CLI, OpenCode, Oh My Pi, Qwen Code, Pi and AGY CLI, written by
  `buracle install` as a transaction with a backup, a journal, an ownership ledger and a rollback per harness.
- One memory in a CortexDB file, with a brain for each project and one for you, shared by every harness through the
  `buracle-memory` MCP server.
- The `/requirements`, `/plan-build`, `/goal-build` and `/bugfix` workflows with approval gates, test-first work for
  behavior changes, independent reviews and a stop guard that holds a plan's turn until it is verified.
- Guards that deny catastrophic commands, ask before hard-to-undo ones and mask secrets.
- Nine MCP servers, six language servers and the Buracle Stack Console at `http://localhost:41777`.
