import { test } from 'bun:test'

// Checks that run a real harness binary in a way that can start a sign-in flow (a browser window) or ask a real provider
// for a model turn run only on request: `BURACLE_LIVE_SMOKE=1 bun test <file>`. A mock model on a local port is not live.
export const LIVE_SMOKE = process.env['BURACLE_LIVE_SMOKE'] === '1'

/** `test` when the binary is present and the switch is on, `test.skip` otherwise. */
export function liveTest(binary: string | undefined): typeof test {
  return binary !== undefined && LIVE_SMOKE ? test : test.skip
}

/** Suffix for a describe title that says why the live checks are skipped; empty when they run. */
export function liveNote(name: string, binary: string | undefined): string {
  if (binary === undefined) return ` (skipped: ${name} is not on PATH)`
  return LIVE_SMOKE ? '' : ' (live checks skipped: set BURACLE_LIVE_SMOKE=1 to run them)'
}
