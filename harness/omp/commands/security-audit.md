---
description: "Buracle security-audit: Cloudflare's security-audit skill, Buracle's default security review"
argument-hint: "[<path or scope>] [quick|standard|deep] [output to <dir>]"
---
Run Buracle's `security-audit` workflow for the request below; the user asked for it explicitly.
First read `skill://security-audit` and follow that skill step by step (its references and scripts resolve under `skill://security-audit/`). If the skill cannot be read, say so and stop instead of improvising the procedure.

Request: $ARGUMENTS
