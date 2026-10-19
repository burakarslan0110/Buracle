---
name: alpha
description: >-
  Alpha workflow for the golden test: plan, build and verify one change. Run only when the user
  explicitly asks for alpha.
when_to_use: >-
  The user says "alpha ile yap" or invokes alpha by name.
invocation: explicit
argument-hint: "<task>"
mcp: [docs, buracle-memory]
short-description: Plan, build and verify one change
---

# Alpha

Track the phases with {{todo}}. Ask with {{ask_user}}: 2 to 4 options.
Launch {{agent:reviewer}} with {{spawn_agent}}, then continue in {{skill:beta}}.
Inline code keeps one span: `{{skill:alpha}} <task>` and `{{ask_user}}`.
A literal placeholder stays literal: \{{ask_user}} and \{{skill:alpha}}.
Unknown placeholders are left alone: {{nope}} and {{skill:Bad Id}}.

```text
{{agent:reviewer}}
plan_file: docs/plans/x.md
```

<!-- harness:claude -->
Claude block line.
<!-- /harness -->
<!-- harness:codex -->
Codex block line.
<!-- /harness -->
<!-- harness:omp -->
omp block line.
<!-- /harness -->
Inline <!-- harness:claude -->claude<!-- /harness --><!-- harness:opencode -->opencode<!-- /harness --> marker.

See [references/ref.md](references/ref.md).
