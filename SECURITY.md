# Security

Buracle runs coding agents without approval prompts and relies on its own hooks to stop
destructive commands, writes to secret files and changes to its own setup. A way around those
guards, a secret that reaches the model or the memory unmasked, or a weakness in the memory web UI
(`127.0.0.1:41777`) counts as a security issue.

## Reporting

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting
on this repository: **Security → Report a vulnerability**. Include the harness and its version, the
command or input that reproduces the problem, and what the guard should have done.

This is one developer's project, maintained in spare time: expect an answer within two weeks and a
fix on the default branch. Only the newest commit on the default branch is supported.

## Out of scope

- A command that Buracle holds for consent and the user then allows.
- The behavior of the tools Buracle installs (MCP servers, language servers, CortexDB): report
  those upstream.
