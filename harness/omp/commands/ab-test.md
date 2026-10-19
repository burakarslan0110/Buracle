---
description: "Buracle ab-test: Paired before/after evals of skills and rules with tool-use evidence"
argument-hint: "<skill:<id> | rule:<path> | routing> [harness]"
---
Run Buracle's `ab-test` workflow for the request below; the user asked for it explicitly.
First read `skill://ab-test` and follow that skill step by step (its references and scripts resolve under `skill://ab-test/`). If the skill cannot be read, say so and stop instead of improvising the procedure.

Request: $ARGUMENTS
