import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BandAgent as ModAgent, BandCriterion as ModCriterion, BandFlowEntry, BandFlowRecord, BandInteraction as ModInteraction, BandPlan as ModPlan,
  BandState as ModBand, BandTodo as ModTodo,
} from '../../../src/adapters/claude/template/types/index'
import type { BandAgent, BandCriterion, BandInteraction, BandPlan, BandState, BandTodo, FlowEntry, FlowRecord } from '../../../src/core/index'

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
function assertType<T extends true>(_: T): void {  }

assertType<Same<ModBand, BandState>>(true)
assertType<Same<BandFlowRecord, FlowRecord>>(true)
assertType<Same<BandFlowEntry, FlowEntry>>(true)
assertType<Same<ModPlan, BandPlan>>(true)
assertType<Same<ModCriterion, BandCriterion>>(true)
assertType<Same<ModTodo, BandTodo>>(true)
assertType<Same<ModAgent, BandAgent>>(true)
assertType<Same<ModInteraction, BandInteraction>>(true)
assertType<Equals<keyof ModBand, keyof BandState>>(true)
assertType<Equals<keyof BandFlowEntry, keyof FlowEntry>>(true)
assertType<Equals<keyof ModPlan, keyof BandPlan>>(true)

const CONTRACT = readFileSync(join(import.meta.dir, '..', '..', '..', 'src', 'adapters', 'claude', 'template', 'types', 'index.d.ts'), 'utf8')

describe('$.state contract', () => {
  test('is self-contained and declares buracle.band (and nothing else)', () => {
    expect(CONTRACT).not.toMatch(/^\s*import\b/m)
    expect(CONTRACT).not.toMatch(/\/\/\/\s*<reference/)
    expect(CONTRACT).toMatch(/declare module 'claude-code' \{\s*interface PluginState \{\s*buracle: \{/)
    expect(CONTRACT).toMatch(/\bband: BandState\b/)
    expect(CONTRACT).not.toMatch(/\bbar: /)
  })
})
