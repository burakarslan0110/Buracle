# Native plan mode (feature plans)

Use this only when `buracle config get plan` shows `nativePlanMode` set to `on`, `planApproval` is on, the plan is a feature plan, and you are the lead, not a plan lane. Then the harness's own plan mode carries [plan.md](plan.md) P3 to P7, and leaving it is the approval gate. Buracle switches no model: the harness decides which model plans (N1 says how). In every other case, follow plan.md as it is.

## N1. Prepare, before plan mode

1. Do plan.md P1 and P2 as usual: plan mode allows no file writes, so the plan file is created and registered (`--phase plan`) first.
2. `buracle plan prepare-native <absolute plan path>`. It binds that file once to the coming plan mode. When it refuses, continue with plan.md P3 and say why in one line.
3. Enter plan mode:
   call EnterPlanMode (load it with tool search when it is deferred). Claude Code plans on the Opus leg when the user picked the `opusplan` model.
4. Plan mode is unavailable, or the user declines it: `buracle plan prepare-native --cancel`, then plan.md P3.

## N2. Plan inside plan mode

1. Do plan.md P3 to P7: explore (read-only lanes work), clarify, choose the approach, write and self-check the plan.
2. Write the whole plan in the P6 format, from its `# Title` line on, without frontmatter:
   into the plan file that plan mode names, then present it with ExitPlanMode. Tell the user to approve with a Yes option that keeps the context, not one that starts "Yes, clear context": those, offered when Claude Code's `showClearContextOnPlanAccept` setting is on, start a fresh conversation, which this run does not carry over to.
3. Until plan mode ends, write no other file, run no state-changing `buracle` command (`plan`, `flow`, `notify`) and launch no reviewer: plan mode forbids writes, and P8 runs after it.

## N3. After plan mode

Buracle (H12) writes the plan text into the registered plan file under its own frontmatter, and its note says what happened.

1. Read the registered file. Run `buracle plan validate <path> --strict` until exit 0; fix only the format.
2. P8: the plan review on this text (your own check while `reviews.plan` is off).
3. Approval. The note says the plan is approved (the user approved it when leaving plan mode): when the review or a fix changes a task or a behavior, run `buracle plan set approved false` and do P9 with approval on; otherwise go straight to P9 *On approval*, without a question. The note says it is not approved yet: do P9 with approval on.
4. The note reports that the registered file changed after the preparation: merge the copy Buracle saved beside it into the registered plan, validate again, and do P9 with approval on.
