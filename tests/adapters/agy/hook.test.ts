import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { handleAgyHook } from '../../../src/adapters/agy/hook'
import { adapter } from '../../../src/adapters/agy/index'
import { defaultConfig } from '../../../src/core/config'
import { dispatchHook } from '../../../src/cli/commands/hook'
import * as paths from '../../../src/engine/paths'
import { activeFlow } from '../../../src/core/flow/record'
import { readFlow } from '../../../src/workflow/flow'
import { loadLedger } from '../../../src/workflow/ledger'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { call, ctx, injected, json, payload, SID } from './helpers'

const hook = (event: string, stdin: string, config = defaultConfig()) => handleAgyHook(event, stdin, ctx(config))
const EMPTY = { stdout: '{}\n', exitCode: 0 }
const prompt = (text: string, extra: Record<string, unknown> = {}) => payload('PreInvocation', { lastUserInput: text, invocationNum: 1, initialNumSteps: 0, ...extra }, process.cwd())
const start = () => hook('SessionStart', payload('SessionStart', {}, process.cwd()))

describe('PreToolUse: the guards answer {decision, reason}', () => {
  test('H01 denies a catastrophic shell command, read from CommandLine', async () => {
    await withSandbox(async () => {
      const out = await hook('PreToolUse', payload('PreToolUse', call('run_command', { CommandLine: 'rm -rf ~', Cwd: '/work/app' })))
      expect(out.exitCode).toBe(0)
      expect(json(out.stdout)).toMatchObject({ decision: 'deny' })
      expect(String(json(out.stdout)['reason'])).toStartWith('Buracle H01: ')
    })
  })

  test('H02 denies a write to a secret through write_to_file and replace_file_content, and lets an ordinary edit pass', async () => {
    await withSandbox(async ({ home }) => {
      const secret = join(home, '.ssh', 'id_rsa')
      for (const [tool, args] of [['write_to_file', { TargetFile: secret, CodeContent: 'x' }], ['replace_file_content', { TargetFile: secret, TargetContent: 'a', ReplacementContent: 'b' }], ['multi_replace_file_content', { TargetFile: secret, ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: 'b' }] }]] as const) {
        const o = json((await hook('PreToolUse', payload('PreToolUse', call(tool, args)))).stdout)
        expect({ tool, decision: o['decision'], reason: String(o['reason']).slice(0, 13) }).toEqual({ tool, decision: 'deny', reason: 'Buracle H02: ' })
      }
      expect(await hook('PreToolUse', payload('PreToolUse', call('write_to_file', { TargetFile: '/work/app/a.ts', CodeContent: 'x' })))).toEqual(EMPTY)
    })
  })

  test('an edit tool the profile does not list, that names a TargetFile and its content, is still held to the write guard', async () => {
    await withSandbox(async ({ home }) => {
      const o = json((await hook('PreToolUse', payload('PreToolUse', call('code_action', { TargetFile: join(home, '.ssh', 'id_rsa'), CodeContent: 'x' })))).stdout)
      expect(o).toMatchObject({ decision: 'deny' })
    })
  })

  test('an MCP tool name nothing places goes through the MCP write guard: an output path in a secret place is denied, a plain call is not', async () => {
    await withSandbox(async ({ home }) => {
      for (const name of ['mcp_tool', 'mcp_other_save']) {
        const bad = json((await hook('PreToolUse', payload('PreToolUse', call(name, { path: join(home, '.ssh', 'id_rsa') })))).stdout)
        expect({ name, decision: bad['decision'] }).toEqual({ name, decision: 'deny' })
        expect(await hook('PreToolUse', payload('PreToolUse', call(name, { query: 'x' })))).toEqual(EMPTY)
      }
    })
  })

  test('H03 routing: the built-in web search is denied while its MCP server is healthy', async () => {
    await withSandbox(async () => {
      const o = json((await hook('PreToolUse', payload('PreToolUse', call('search_web', { query: 'bun test' })))).stdout)
      expect(o['decision']).toBe('deny')
      expect(String(o['reason'])).toStartWith('Buracle H03: ')
    })
  })

  test('H20 holds a command that needs the user\'s consent', async () => {
    await withSandbox(async () => {
      const o = json((await hook('PreToolUse', payload('PreToolUse', call('run_command', { CommandLine: 'git push --force origin main' })))).stdout)
      expect(o['decision']).toBe('deny')
      expect(String(o['reason'])).toMatch(/^Buracle H(01|20)/)
    })
  })

  test('a harmless call answers {} and never "allow", so AGY\'s own permission rules still decide', async () => {
    await withSandbox(async () => {
      expect(await hook('PreToolUse', payload('PreToolUse', call('run_command', { CommandLine: 'ls' })))).toEqual(EMPTY)
    })
  })

  test('a payload without a usable conversation id still meets the guards, and nothing else runs', async () => {
    await withSandbox(async () => {
      const bad = JSON.stringify({ conversationId: '../x', cwd: '/w', hookEventName: 'PreToolUse', ...call('run_command', { CommandLine: 'rm -rf ~' }) })
      expect(json((await hook('PreToolUse', bad)).stdout)).toMatchObject({ decision: 'deny' })
      expect(await hook('SessionStart', bad)).toEqual({ stdout: '', exitCode: 0 })
      expect(await hook('PreToolUse', JSON.stringify({ conversationId: '../x', cwd: '/w', ...call('view_file', { AbsolutePath: '/a' }) }))).toEqual(EMPTY)
    })
  })

  test('a guard that cannot run fails closed through the dispatcher in the decision shape; other events fail open', async () => {
    await withSandbox(async () => {
      const boom = { ...adapter, hook: async () => { throw new Error('boom') } }
      const closed = await dispatchHook('agy', 'PreToolUse', payload('PreToolUse'), { adapter: boom } as never)
      expect(closed.exitCode).toBe(0)
      expect(json(closed.stdout)).toMatchObject({ decision: 'deny' })
      const open = await dispatchHook('agy', 'Stop', payload('Stop'), { adapter: boom } as never)
      expect(open).toEqual({ stdout: '', exitCode: 0 })
      expect(await hook('PreToolUse', 'not json')).toEqual({ stdout: '', exitCode: 0 })
    })
  })
})

describe('SessionStart: context as an injected system message', () => {
  test('injects the workspace and the capability card, and saves the workspace for the later events', async () => {
    await withSandbox(async () => {
      const out = await start()
      expect(Object.keys(json(out.stdout))).toEqual(['injectSteps'])
      expect(injected(out.stdout)).toContain('mcp_')
      expect(existsSync(join(paths.sessionDir('agy', SID), 'workspace.json'))).toBe(true)
    })
  })

  test('the memory runner\'s own child gets nothing', async () => {
    await withSandbox(async () => {
      await withEnv({ BURACLE_MEMORY_RUNNER: '1' }, async () => {
        expect(await start()).toEqual(EMPTY)
        expect(await hook('PreInvocation', prompt('x'))).toEqual(EMPTY)
      })
    })
  })
})

describe('PreInvocation: the prompt step runs on a user turn only', () => {
  test('a workflow the user names is routed once; the model calls that follow with the same lastUserInput get nothing', async () => {
    await withSandbox(async () => {
      await start()
      const text = '$plan-build add rate limiting'
      const first = await hook('PreInvocation', prompt(text))
      expect(injected(first.stdout)).toContain('plan-build')
      expect(injected(first.stdout)).toContain('read ')
      for (const n of [2, 3]) expect(await hook('PreInvocation', prompt(text, { invocationNum: n }))).toEqual(EMPTY)
      expect(injected((await hook('PreInvocation', prompt('$plan-build and now this', { invocationNum: 1 }))).stdout)).toContain('plan-build')
    })
  })

  test('an empty lastUserInput injects nothing', async () => {
    await withSandbox(async () => {
      expect(await hook('PreInvocation', prompt(''))).toEqual(EMPTY)
    })
  })

  test('a note a tool event left is injected once, with the next model call, and not again', async () => {
    await withSandbox(async () => {
      await start()
      await hook('PreInvocation', prompt('hello'))
      // H03's early-edit note rides on a PreToolUse allow; a plan in the planning phase would produce it. Leave one by hand through the state file.
      const { writeFileSync, mkdirSync } = await import('node:fs')
      mkdirSync(paths.sessionDir('agy', SID), { recursive: true })
      writeFileSync(join(paths.sessionDir('agy', SID), 'agy-turn.json'), JSON.stringify({ prompt: 'hello', pending: ['note one'] }))
      expect(injected((await hook('PreInvocation', prompt('hello', { invocationNum: 2 }))).stdout)).toBe('note one')
      expect(await hook('PreInvocation', prompt('hello', { invocationNum: 3 }))).toEqual(EMPTY)
    })
  })
})

describe('Stop: the stop guard and the routing audit answer {decision: continue}', () => {
  const stop = (extra: Record<string, unknown> = {}) => payload('Stop', { executionNum: 0, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, continuationActive: false, ...extra }, process.cwd())

  test('a workflow the user asked for and the model did not load holds the stop once', async () => {
    await withSandbox(async () => {
      await start()
      await hook('PreInvocation', prompt('$plan-build add rate limiting'))
      const first = json((await hook('Stop', stop())).stdout)
      expect(first['decision']).toBe('continue')
      expect(String(first['reason'])).toStartWith('Buracle routing check: the user asked for plan-build and it was not loaded.')
      expect(await hook('Stop', stop({ continuationActive: true }))).toEqual(EMPTY)
    })
  })

  test('a stop the user cancelled or an error ended is never held', async () => {
    await withSandbox(async () => {
      await start()
      await hook('PreInvocation', prompt('$plan-build add rate limiting'))
      for (const terminationReason of ['USER_CANCELED', 'ERROR', 'MAX_INVOCATIONS']) expect(await hook('Stop', stop({ terminationReason }))).toEqual(EMPTY)
    })
  })

  test('a stop with nothing to guard goes through', async () => {
    await withSandbox(async () => {
      expect(await hook('Stop', stop())).toEqual(EMPTY)
    })
  })
})

describe('PostToolUse answers {} and records what it saw', () => {
  test('a failed call of a Buracle server is counted in the ledger when the name is placed; an unplaced MCP name is not guessed at', async () => {
    await withSandbox(async () => {
      expect(await hook('PostToolUse', payload('PostToolUse', { ...call('mcp_web_search_search', {}), error: 'boom' }))).toEqual(EMPTY)
      expect(loadLedger('agy', SID).mcpErrors).toEqual({ 'web-search': 1 })
      expect(await hook('PostToolUse', payload('PostToolUse', { ...call('mcp_tool', {}), error: 'boom' }))).toEqual(EMPTY)
      expect(loadLedger('agy', SID).mcpErrors).toEqual({ 'web-search': 1 })
    })
  })

  test('an edit that ran no checker, and events AGY has that Buracle does not use, answer quietly', async () => {
    await withSandbox(async () => {
      expect(await hook('PostToolUse', payload('PostToolUse', call('replace_file_content', { TargetFile: '/nope/a.txt', TargetContent: 'a', ReplacementContent: 'b' })))).toEqual(EMPTY)
      expect(await hook('PostInvocation', payload('PostInvocation'))).toEqual({ stdout: '', exitCode: 0 })
      expect(await hook('SomethingNew', payload('SomethingNew'))).toEqual({ stdout: '', exitCode: 0 })
    })
  })
})

describe('H25: flow tracking', () => {
  const active = () => activeFlow(readFlow('agy', SID))?.workflow
  test('reading a workflow skill\'s SKILL.md starts its flow record; reading another file does not', async () => {
    await withSandbox(async ({ home }) => {
      await hook('PostToolUse', payload('PostToolUse', call('view_file', { AbsolutePath: join(home, '.gemini', 'config', 'skills', 'memory', 'SKILL.md') }), process.cwd()))
      await hook('PostToolUse', payload('PostToolUse', call('view_file', { AbsolutePath: '/work/app/README.md' }), process.cwd()))
      expect(active()).toBeUndefined()
      await hook('PostToolUse', payload('PostToolUse', call('view_file', { AbsolutePath: join(home, '.gemini', 'config', 'skills', 'bugfix', 'SKILL.md') }), process.cwd()))
      expect(active()).toBe('bugfix')
    })
  })
  test('a user message that starts with /<workflow> starts it', async () => {
    await withSandbox(async () => {
      await hook('PreInvocation', prompt('/plan-build add a thing'))
      expect(active()).toBe('plan-build')
    })
  })
})
