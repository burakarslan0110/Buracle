import { describe, expect, test } from 'bun:test'
import { slashWorkflowOf } from '../../../src/adapters/shared/command-host/index'
import { tipText, tipsFor } from '../../../src/adapters/shared/tip-text'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { join } from 'node:path'

const canonical = loadCanonicalSync(join(import.meta.dir, '..', '..', '..', 'canonical'))
const IDS = new Set(['plan-build', 'research'])

describe('tipText', () => {
  test('respells a skill as the profile invokes it: /skill:<id> on Pi, /<id> on Qwen Code', () => {
    expect(tipText('/plan-build writes a plan; try /research <q>', 'pi', IDS)).toBe('/skill:plan-build writes a plan; try /skill:research <q>')
    expect(tipText('/plan-build writes a plan', 'qwen', IDS)).toBe('/plan-build writes a plan')
  })
  test('leaves paths, unknown commands and text inside words alone', () => {
    expect(tipText('plans go to docs/plan-build/ and /unknown stays', 'pi', IDS)).toBe('plans go to docs/plan-build/ and /unknown stays')
  })
  test('every canonical tip keeps its id and, on Pi, names no bare skill command', () => {
    const pi = tipsFor(canonical, 'pi')
    expect(pi.map(t => t.id)).toEqual((canonical.tips ?? []).map(t => t.id))
    expect(pi.find(t => t.id === 'plan-build')?.text).toStartWith('/skill:plan-build ')
  })
})

describe('slashWorkflowOf', () => {
  const isWf = (id: string) => id === 'plan-build' || id === 'bugfix'
  test('a leading /<workflow> starts it, with the rest of the first line as the title', () => {
    expect(slashWorkflowOf('/plan-build add a thing\nmore', isWf)).toEqual({ workflow: 'plan-build', title: 'add a thing' })
    expect(slashWorkflowOf('  /bugfix', isWf)).toEqual({ workflow: 'bugfix' })
  })
  test('a non-workflow, a mid-text mention or a longer name does not', () => {
    expect(slashWorkflowOf('/memory x', isWf)).toBeUndefined()
    expect(slashWorkflowOf('run /bugfix', isWf)).toBeUndefined()
    expect(slashWorkflowOf('/bugfixer', isWf)).toBeUndefined()
  })
})
