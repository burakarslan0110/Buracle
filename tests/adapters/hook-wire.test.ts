import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buracleHooksFile, HOOK_COMMAND_PREFIX, type CodexCommandHandler } from '../../src/adapters/codex/hooks-config'
import { isFailClosedReason } from '../../src/engine/hook-fail'
import { CLAUDE_PLUGIN, installShim, preToolUsePayload, REPO, runWire, decisionOf, type RunWire } from '../helpers/wire'
import { withSandbox } from '../helpers/sandbox'

// "Wire" tests: the command lines the generators write into the harness configs are run as written, the way the
// harness runs them, against a sandbox install (the shim `buracle install` writes, this checkout behind it), with a
// PreToolUse payload that must be denied (`rm -rf ~`) and one that must pass (`ls`). `buracle build --check` proves the
// committed files are what the generators emit; these tests prove that what they emit works.

async function expectGuard(go: (command: string) => Promise<{ code: number, stdout: string, stderr: string }>): Promise<void> {
  const deny = await go('rm -rf ~')
  const denied = decisionOf(deny.stdout)
  expect({ decision: denied.decision, shimFailure: isFailClosedReason(denied.reason), stdout: deny.stdout.slice(0, 300), stderr: deny.stderr.slice(0, 300) })
    .toMatchObject({ decision: 'deny', shimFailure: false })
  const allow = await go('ls')
  expect({ code: allow.code, decision: decisionOf(allow.stdout).decision, stderr: allow.stderr.slice(0, 300) }).toMatchObject({ code: 0 })
  expect(decisionOf(allow.stdout).decision).not.toBe('deny')
}

function claudePreToolUse(): { matcher: string, command: string, args: string[] } {
  const file = JSON.parse(readFileSync(join(CLAUDE_PLUGIN, 'hooks', 'hooks.json'), 'utf8')) as { hooks: { PreToolUse: Array<{ matcher: string, hooks: Array<{ command: string, args: string[] }> }> } }
  const group = file.hooks.PreToolUse[0]
  const hook = group?.hooks[0]
  if (group === undefined || hook === undefined) throw new Error('no PreToolUse hook in harness/claude/hooks/hooks.json')
  return { matcher: group.matcher, command: hook.command, args: hook.args }
}

function codexPreToolUse(file: ReturnType<typeof buracleHooksFile>): { matcher: string, handler: CodexCommandHandler } {
  const group = file.hooks.PreToolUse?.[0]
  const handler = group?.hooks[0]
  if (group?.matcher === undefined || handler === undefined) throw new Error('no PreToolUse hook for Codex')
  return { matcher: group.matcher, handler }
}

describe('hook wire: the generated PreToolUse commands guard a Bash call', () => {
  test('Claude Code: the exec-form command and args of the plugin\'s hooks.json (every OS)', () => withSandbox(async ({ home }) => {
    installShim()
    const { matcher, command, args } = claudePreToolUse()
    expect(new RegExp(matcher).test('Bash')).toBe(true)
    const argv = [command, ...args.map(a => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', CLAUDE_PLUGIN))]
    const go: RunWire = runWire(home)
    await expectGuard(command => go(argv, preToolUsePayload('claude', command, home)))
  }), 120_000)

  test('Codex on macOS and Linux: `command` of harness/codex/hooks.json, run by sh -c', () => withSandbox(async ({ home }) => {
    installShim()
    const committed = JSON.parse(readFileSync(join(REPO, 'harness', 'codex', 'hooks.json'), 'utf8')) as ReturnType<typeof buracleHooksFile>
    const { matcher, handler } = codexPreToolUse(committed)
    expect(new RegExp(matcher).test('Bash')).toBe(true)
    expect(handler.command).toBe(`${HOOK_COMMAND_PREFIX}PreToolUse`)
    const go: RunWire = runWire(home)
    await expectGuard(command => go(['/bin/sh', '-c', handler.command], preToolUsePayload('codex', command, home)))
  }), 120_000)
})
