# Notice

This skill is a copy of `skills/security-audit` from
https://github.com/cloudflare/security-audit-skill at commit c1c8a8c1471069fb0e188eeaff69b8e8db6564a8, licensed under the MIT
License (Copyright (c) 2025-2026 Cloudflare, Inc.; see LICENSE next to this file).

Changes made by Buracle:

- SKILL.md carries Buracle's frontmatter (name, description, when_to_use, invocation, argument-hint,
  mcp, short-description) and a short preamble that maps the skill's platform terms to Buracle's
  tools; the "Full audit setup" and "Full audit planning" sections moved to
  references/full-audit-setup.md so the skill fits Buracle's load budget.
- The companion Markdown files moved to references/, the validators and the JSON schema to
  scripts/, and every mention of them points at the new paths. Their text is unchanged.
