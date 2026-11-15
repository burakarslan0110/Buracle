import { describe, expect, test } from 'bun:test'
import { HOST_LIMITS, missingEventLimit } from '../../../src/adapters/shared/host-limits'
import { CANONICAL_EVENTS, HARNESSES, harnessProfile, missingEvents } from '../../../src/core/harness/index'
import { DENY_EVENTS, HOOK_EVENTS, STOP_EVENTS } from '../../../src/core/policy/hooks-matrix'

describe('canonical events per harness', () => {
  test('every canonical event is mapped: to native events the host has, or to null', () => {
    for (const h of HARNESSES) {
      const { map, native } = harnessProfile(h).events
      expect(Object.keys(map).sort()).toEqual([...CANONICAL_EVENTS].sort())
      for (const e of CANONICAL_EVENTS) {
        const names = map[e]
        if (names === null) continue
        expect({ h, e, mapped: names.length > 0 }).toEqual({ h, e, mapped: true })
        for (const name of names) expect({ h, e, name, native: native.includes(name) }).toEqual({ h, e, name, native: true })
      }
    }
  })

  test('an event a host lacks is null in its profile and has its record in HOST_LIMITS, and only then', () => {
    for (const h of HARNESSES) {
      for (const e of CANONICAL_EVENTS) {
        const lacks = harnessProfile(h).events.map[e] === null
        const record = missingEventLimit(h, e)
        expect({ h, e, recorded: record !== undefined }).toEqual({ h, e, recorded: lacks })
        if (record !== undefined) expect({ id: record.id, kind: record.kind }).toEqual({ id: record.id, kind: 'limit' })
      }
    }
    for (const l of HOST_LIMITS) {
      if (l.event !== undefined) expect({ id: l.id, missing: missingEvents(harnessProfile(l.harness)).includes(l.event) }).toEqual({ id: l.id, missing: true })
    }
  })

  test('the hook matrix reads its tables from the profiles', () => {
    expect(DENY_EVENTS).toEqual({
      claude: ['tool.call', 'tool.check', 'classic.PreToolUse'],
      codex: ['PreToolUse', 'PermissionRequest'],
      opencode: ['permission.evaluate', 'tool.execute.before'],
      omp: ['tool_call'],
      qwen: ['PreToolUse'],
      pi: ['tool_call'],
      agy: ['PreToolUse'],
    })
    expect(STOP_EVENTS).toEqual({
      claude: ['classic.Stop', 'classic.SubagentStop'],
      codex: ['Stop', 'SubagentStop'],
      opencode: ['session.execution.succeeded', 'session.idle'],
      omp: ['session_stop'],
      qwen: ['Stop', 'SubagentStop'],
      pi: ['agent_before_settle'],
      agy: ['Stop'],
    })
    for (const h of HARNESSES) expect(HOOK_EVENTS[h]).toBe(harnessProfile(h).events.native)
  })
})
