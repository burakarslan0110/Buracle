#!/usr/bin/env bun

import { runProcess } from './router'

if (import.meta.main) {
  process.exit(await runProcess(process.argv.slice(2)))
}
