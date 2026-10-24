import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buracleHooksFile, HOOK_COMMAND_PREFIX, windowsHookPrefix, type CodexCommandHandler } from '../../src/adapters/codex/hooks-config'
import { isFailClosedReason } from '../../src/engine/hook-fail'
import * as paths from '../../src/engine/paths'
import { windowsShimContent } from '../../src/engine/update/install-core'
import { CLAUDE_PLUGIN, installShim, preToolUsePayload, REPO, runWire, decisionOf, type RunWire } from '../helpers/wire'
import { withSandbox } from '../helpers/sandbox'

// "Wire" tests: the command lines the generators write into the harness configs are run as written, the way the
// harness runs them, against a sandbox install (the shim `buracle install` writes, this checkout behind it), with a
// PreToolUse payload that must be denied (`rm -rf ~`) and one that must pass (`ls`). `buracle build --check` proves the
// committed files are what the generators emit; these tests prove that what they emit works. Each variant runs on the
// operating systems where its harness runs it: CI executes all of them (macOS, Linux, Windows), and the Windows-only
// ones (Codex's `commandWindows` through `cmd /d /s /c`, the real buracle.cmd) run only in the Windows job.

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

  test.skipIf(process.platform === 'win32')('Codex on macOS and Linux: `command` of harness/codex/hooks.json, run by sh -c', () => withSandbox(async ({ home }) => {
    installShim()
    const committed = JSON.parse(readFileSync(join(REPO, 'harness', 'codex', 'hooks.json'), 'utf8')) as ReturnType<typeof buracleHooksFile>
    const { matcher, handler } = codexPreToolUse(committed)
    expect(new RegExp(matcher).test('Bash')).toBe(true)
    expect(handler.command).toBe(`${HOOK_COMMAND_PREFIX}PreToolUse`)
    const go: RunWire = runWire(home)
    await expectGuard(command => go(['/bin/sh', '-c', handler.command], preToolUsePayload('codex', command, home)))
  }), 120_000)

  test.skipIf(process.platform !== 'win32')('Codex on Windows: `commandWindows` through cmd /d /s /c, with the real buracle.cmd shim', () => withSandbox(async ({ home }) => {
    installShim()
    const { matcher, handler } = codexPreToolUse(buracleHooksFile(HOOK_COMMAND_PREFIX, windowsHookPrefix(paths.shimPath())))
    expect(new RegExp(matcher).test('Bash')).toBe(true)
    expect(handler.commandWindows).toBe(`"${paths.shimPath().replace(/\//g, '\\')}" hook codex PreToolUse`)
    const go: RunWire = runWire(home)
    // /s makes cmd.exe drop the first and the last quote of the line, so the line that holds quotes gets another pair.
    await expectGuard(command => go(['cmd.exe', '/d', '/s', '/c', `"${handler.commandWindows}"`], preToolUsePayload('codex', command, home)))
  }), 120_000)

  test.skipIf(process.platform !== 'win32')('Codex on Windows: a buracle.cmd whose bun is gone denies a PreToolUse call instead of letting it through', () => withSandbox(async ({ home, root }) => {
    const shim = join(root, 'buracle.cmd')
    writeFileSync(shim, windowsShimContent({ bun: join(root, 'no-such-dir', 'bun.exe'), repoRoot: REPO }))
    const go: RunWire = runWire(home)
    const pre = await go(['cmd.exe', '/d', '/s', '/c', `""${shim}" hook codex PreToolUse"`], preToolUsePayload('codex', 'ls', home))
    expect(pre.code).toBe(0)
    const d = decisionOf(pre.stdout)
    expect(d.decision).toBe('deny')
    expect(isFailClosedReason(d.reason)).toBe(true)
    const stop = await go(['cmd.exe', '/d', '/s', '/c', `""${shim}" hook codex Stop"`], '{}')
    expect(stop.code).not.toBe(0)
  }), 120_000)
})
