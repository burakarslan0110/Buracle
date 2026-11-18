---
title: Install
description: Install Buracle Stack with one command and check the result.
order: 1
---

Run the install script. It sets up every agent it finds.

## Requirements

You need git, curl and Bun. Read [the harness list](harnesses.md) and the [host limits](harnesses.md#host-limits) first.

```sh
curl -fsSL https://stack.buracle.dev/install.sh | bash
```

### After the install

Read [the workflows](./workflows.md) next, or go back to [the requirements](#requirements).

## What’s new? (beta)

| Command | What it does |
|---|---|
| `buracle install` | Writes the format of each agent |

> The install keeps a backup of every file it changes.

## Requirements

A second heading with the same text gets its own id.
