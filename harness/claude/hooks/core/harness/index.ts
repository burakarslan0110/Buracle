import { claudeProfile } from './claude'
import { codexProfile } from './codex'
import { ompProfile } from './omp'
import { opencodeProfile } from './opencode'
import { defineHarnesses, type HarnessProfile } from './profile'

// The harnesses Buracle supports. The key order is their order everywhere (tables, loops, generated output).
export const HARNESS_PROFILES = {
  claude: claudeProfile,
  codex: codexProfile,
  opencode: opencodeProfile,
  omp: ompProfile,
} as const satisfies Readonly<Record<string, HarnessProfile>>

export type Harness = keyof typeof HARNESS_PROFILES

const SET = defineHarnesses<Harness>(HARNESS_PROFILES)

export const HARNESSES: readonly Harness[] = SET.ids

export function isHarness(x: unknown): x is Harness {
  return SET.is(x)
}

export function harnessProfile(h: Harness): HarnessProfile {
  return SET.of(h)
}

/** One value per harness, read from its profile. */
export function harnessTable<T>(pick: (p: HarnessProfile) => T): Readonly<Record<Harness, T>> {
  return SET.table(pick)
}

/** The harnesses whose profile passes, in harness order. */
export function harnessesWhere(test: (p: HarnessProfile) => boolean): Harness[] {
  return SET.where(test)
}

/** The product names ("Claude Code", "Codex", "OpenCode", "Oh My Pi"). */
export const HARNESS_LABEL: Readonly<Record<Harness, string>> = harnessTable(p => p.label)

/** The harnesses that read the neutral skill render from a folder of their own. */
export const NEUTRAL_SKILL_HARNESSES: readonly Harness[] = harnessesWhere(p => p.skills.dir !== undefined)

export * from './profile'
export { CLAUDE_PLUGIN_NAME } from './claude'
export { CLAUDE_CLASSIC_EVENTS, CLAUDE_ENGINE_EVENTS, CODEX_EVENTS, OMP_EVENTS, OPENCODE_EVENTS } from './native-events'
