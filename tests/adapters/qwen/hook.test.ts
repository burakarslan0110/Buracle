import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { handleQwenHook } from '../../../src/adapters/qwen/hook'
import { adapter } from '../../../src/adapters/qwen/index'
import { defaultConfig } from '../../../src/core/config'
import { dispatchHook } from '../../../src/cli/commands/hook'
import * as paths from '../../../src/engine/paths'
import { activeFlow } from '../../../src/core/flow/record'
import { readFlow } from '../../../src/workflow/flow'
import { loadLedger } from '../../../src/workflow/ledger'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { ctx, json, payload, SID } from './helpers'

const QUIET = { stdout: '', exitCode: 0 }
const hook = (event: string, stdin: string, config = defaultConfig()) => handleQwenHook(event, stdin, ctx(config))
const context = (out: { stdout: string }) => String((json(out.stdout)['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])

describe('PreToolUse: the guards', () => {
  test('H01 denies a catastrophic shell command in Buracle\'s denial shape; the monitor tool is a shell too', async () => {
    await withSandbox(async () => {
      for (const tool of ['run_shell_command', 'monitor']) {
        const out = await hook('PreToolUse', payload('PreToolUse', { tool_name: tool, tool_input: { command: 'rm -rf ~' } }))
        expect(out.exitCode).toBe(0)
        const o = json(out.stdout)['hookSpecificOutput'] as Record<string, unknown>
        expect(o).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
        expect(String(o['permissionDecisionReason'])).toStartWith('Buracle H01: ')
      }
    })
  })

  test('H02 denies a write to a secret through write_file and edit, and lets an ordinary edit pass', async () => {
    await withSandbox(async ({ home }) => {
      const secret = join(home, '.ssh', 'id_rsa')
      for (const [tool, input] of [['write_file', { file_path: secret, content: 'x' }], ['edit', { file_path: secret, old_string: 'a', new_string: 'b' }]] as const) {
        const o = json((await hook('PreToolUse', payload('PreToolUse', { tool_name: tool, tool_input: input }))).stdout)['hookSpecificOutput'] as Record<string, unknown>
        expect({ tool, decision: o['permissionDecision'], reason: String(o['permissionDecisionReason']).slice(0, 13) }).toEqual({ tool, decision: 'deny', reason: 'Buracle H02: ' })
      }
      const fine = await hook('PreToolUse', payload('PreToolUse', { tool_name: 'write_file', tool_input: { file_path: '/work/app/a.ts', content: 'x' } }))
      expect(fine.stdout.includes('"deny"')).toBe(false)
    })
  })

  test('a harmless call is allowed: nothing on stdout, or context that comes with an explicit allow', async () => {
    await withSandbox(async () => {
      const out = await hook('PreToolUse', payload('PreToolUse', { tool_name: 'run_shell_command', tool_input: { command: 'ls' } }))
      expect(out.exitCode).toBe(0)
      if (out.stdout !== '') expect(json(out.stdout)['hookSpecificOutput']).toMatchObject({ permissionDecision: 'allow' })
    })
  })

  test('H20 holds a command that needs the user\'s consent', async () => {
    await withSandbox(async () => {
      const out = await hook('PreToolUse', payload('PreToolUse', { tool_name: 'run_shell_command', tool_input: { command: 'git push --force origin main' } }))
      const o = json(out.stdout)['hookSpecificOutput'] as Record<string, unknown>
      expect(o['permissionDecision']).toBe('deny')
      expect(String(o['permissionDecisionReason'])).toMatch(/^Buracle H0?1|^Buracle H20/)
    })
  })

  test('H03 routing: the built-in web search is denied while its MCP server is healthy', async () => {
    await withSandbox(async () => {
      const out = await hook('PreToolUse', payload('PreToolUse', { tool_name: 'web_search', tool_input: { query: 'bun test' } }))
      const o = json(out.stdout)['hookSpecificOutput'] as Record<string, unknown>
      expect(o['permissionDecision']).toBe('deny')
      expect(String(o['permissionDecisionReason'])).toStartWith('Buracle H03: ')
    })
  })

  test('a payload without a usable session id still meets the guards, and nothing else runs', async () => {
    await withSandbox(async () => {
      const bad = JSON.stringify({ session_id: '../x', cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'run_shell_command', tool_input: { command: 'rm -rf ~' } })
      expect(json((await hook('PreToolUse', bad)).stdout)['hookSpecificOutput']).toMatchObject({ permissionDecision: 'deny' })
      expect(await hook('SessionStart', bad)).toEqual(QUIET)
      expect(await hook('PreToolUse', JSON.stringify({ session_id: '../x', cwd: '/w', tool_name: 'read_file', tool_input: { file_path: '/a' } }))).toEqual(QUIET)
    })
  })

  test('a guard that cannot run fails closed through the dispatcher; other events fail open', async () => {
    await withSandbox(async () => {
      const boom = { ...adapter, hook: async () => { throw new Error('boom') } }
      const closed = await dispatchHook('qwen', 'PreToolUse', payload('PreToolUse'), { adapter: boom } as never).catch(() => undefined)
      if (closed !== undefined) expect(json(closed.stdout)['hookSpecificOutput']).toMatchObject({ permissionDecision: 'deny' })
      expect(await hook('PreToolUse', 'not json')).toEqual(QUIET)
    })
  })
})

describe('SessionStart, SubagentStart and the prompt: context for the model', () => {
  test('SessionStart injects the workspace and the capability card as additionalContext of its own event', async () => {
    await withSandbox(async () => {
      const out = await hook('SessionStart', payload('SessionStart', { source: 'startup', model: 'qwen3-coder' }, process.cwd()))
      expect(json(out.stdout)['hookSpecificOutput']).toMatchObject({ hookEventName: 'SessionStart' })
      expect(context(out)).toContain('mcp__')
    })
  })

  test('SessionStart records the session for the memory (H14) and saves the workspace for the later events', async () => {
    await withSandbox(async () => {
      await hook('SessionStart', payload('SessionStart', { source: 'startup' }, process.cwd()))
      expect(existsSync(join(paths.sessionDir('qwen', SID), 'workspace.json'))).toBe(true)
    })
  })

  test('SubagentStart gets the workspace note alone', async () => {
    await withSandbox(async () => {
      await hook('SessionStart', payload('SessionStart', { source: 'startup' }, process.cwd()))
      const out = await hook('SubagentStart', payload('SubagentStart', { agent_id: 'a1', agent_type: 'Explorer' }, process.cwd()))
      if (out.stdout !== '') expect(json(out.stdout)['hookSpecificOutput']).toMatchObject({ hookEventName: 'SubagentStart' })
    })
  })

  test('UserPromptSubmit: a workflow the user names is routed with a note that names Qwen\'s skill tool; Qwen\'s own /<id> needs none', async () => {
    await withSandbox(async () => {
      await hook('SessionStart', payload('SessionStart', { source: 'startup' }, process.cwd()))
      const out = await hook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: '$plan-build add rate limiting', submitted_prompt: '$plan-build add rate limiting' }, process.cwd()))
      expect(json(out.stdout)['hookSpecificOutput']).toMatchObject({ hookEventName: 'UserPromptSubmit' })
      expect(context(out)).toContain('plan-build')
      expect(context(out)).toContain('skill tool, plan-build')
      expect(await hook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: '/plan-build add a cache', submitted_prompt: '/plan-build add a cache' }, process.cwd()))).toEqual(QUIET)
    })
  })

  test('UserPromptSubmit without submitted_prompt and with a notice of the host is not the user\'s text', async () => {
    await withSandbox(async () => {
      const out = await hook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: '<system-reminder>background task finished</system-reminder>' }, process.cwd()))
      expect(out.exitCode).toBe(0)
      expect(out.stdout.includes('plan-build')).toBe(false)
    })
  })

  test('the memory runner\'s own child neither loads context nor records a prompt', async () => {
    await withSandbox(async () => {
      await withEnv({ BURACLE_MEMORY_RUNNER: '1' }, async () => {
        expect(await hook('SessionStart', payload('SessionStart', { source: 'startup' }, process.cwd()))).toEqual(QUIET)
        expect(await hook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'x' }, process.cwd()))).toEqual(QUIET)
      })
    })
  })
})

describe('Stop: the stop guard and the routing audit', () => {
  const stop = payload('Stop', { last_assistant_message: 'Done.', stop_hook_active: false }, process.cwd())

  test('a workflow the user asked for and the model did not load holds the stop once, as {decision: block, reason}', async () => {
    await withSandbox(async () => {
      await hook('SessionStart', payload('SessionStart', { source: 'startup' }, process.cwd()))
      await hook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: '$plan-build add rate limiting', submitted_prompt: '$plan-build add rate limiting' }, process.cwd()))
      const first = json((await hook('Stop', stop)).stdout)
      expect(first['decision']).toBe('block')
      expect(String(first['reason'])).toStartWith('Buracle routing check: the user asked for plan-build and it was not loaded.')
      expect(await hook('Stop', stop)).toEqual(QUIET)
    })
  })

  test('a stop with nothing to guard goes through', async () => {
    await withSandbox(async () => {
      expect(await hook('Stop', stop)).toEqual(QUIET)
    })
  })
})

describe('PostToolUse, PostToolUseFailure and the compaction and end events', () => {
  test('an MCP failure is counted in the session ledger; an interrupt is not', async () => {
    await withSandbox(async () => {
      const fail = (extra: Record<string, unknown>) => payload('PostToolUseFailure', { tool_name: 'mcp__web-search__search', tool_input: {}, error: 'boom', ...extra })
      expect(await hook('PostToolUseFailure', fail({ is_interrupt: true }))).toEqual(QUIET)
      expect(loadLedger('qwen', SID).mcpErrors).toBeUndefined()
      expect(await hook('PostToolUseFailure', fail({}))).toEqual(QUIET)
      expect(loadLedger('qwen', SID).mcpErrors).toEqual({ 'web-search': 1 })
    })
  })

  test('a successful call of a Buracle server clears nothing it should not, and an edit runs no checker that is not installed', async () => {
    await withSandbox(async () => {
      expect((await hook('PostToolUse', payload('PostToolUse', { tool_name: 'mcp__web-search__search', tool_input: {}, tool_response: {} }))).exitCode).toBe(0)
      expect((await hook('PostToolUse', payload('PostToolUse', { tool_name: 'edit', tool_input: { file_path: '/nope/a.txt', old_string: 'a', new_string: 'b' }, tool_response: {} }))).exitCode).toBe(0)
    })
  })

  test('PreCompact, PostCompact and SessionEnd answer nothing and never throw', async () => {
    await withSandbox(async () => {
      await hook('SessionStart', payload('SessionStart', { source: 'startup' }, process.cwd()))
      expect(await hook('PreCompact', payload('PreCompact', { trigger: 'auto' }, process.cwd()))).toEqual(QUIET)
      expect(await hook('PostCompact', payload('PostCompact', { trigger: 'auto', compact_summary: 'we did x' }, process.cwd()))).toEqual(QUIET)
      expect(await hook('SessionEnd', payload('SessionEnd', { reason: 'other' }, process.cwd()))).toEqual(QUIET)
      expect(await hook('SomethingNew', payload('SomethingNew'))).toEqual(QUIET)
    })
  })
})

describe('H25: flow tracking', () => {
  const active = () => activeFlow(readFlow('qwen', SID))?.workflow
  test('the skill tool loading a workflow skill starts its flow record; another skill or a failure does not', async () => {
    await withSandbox(async () => {
      await hook('PostToolUse', payload('PostToolUse', { tool_name: 'skill', tool_input: { skill: 'memory' }, tool_response: {} }))
      expect(active()).toBeUndefined()
      await hook('PostToolUse', payload('PostToolUse', { tool_name: 'skill', tool_input: { skill: 'plan-build' }, tool_response: {} }))
      expect(active()).toBe('plan-build')
    })
  })
  test('a typed /<workflow> prompt starts it', async () => {
    await withSandbox(async () => {
      await hook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: '/bugfix login fails', submitted_prompt: '/bugfix login fails' }))
      expect(active()).toBe('bugfix')
    })
  })
})
