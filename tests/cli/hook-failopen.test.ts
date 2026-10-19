import { describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapedErrorExit } from '../../src/cli/router'
import { dispatchHook } from '../../src/cli/commands/hook'
import { withSandbox } from '../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..')

function sink() {
  let text = ''
  return { write: (s: string) => { text += s }, get text() { return text } }
}

function decisionOf(stdout: string): { decision?: unknown, reason?: unknown } {
  const o = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown, permissionDecisionReason?: unknown } }
  return { decision: o.hookSpecificOutput?.permissionDecision, reason: o.hookSpecificOutput?.permissionDecisionReason }
}

function cliCopy(root: string): string {
  const copy = join(root, 'repo')
  mkdirSync(join(copy, 'canonical'), { recursive: true })
  cpSync(join(REPO, 'src'), join(copy, 'src'), { recursive: true })
  cpSync(join(REPO, 'package.json'), join(copy, 'package.json'))
  cpSync(join(REPO, 'canonical', 'buracle.yaml'), join(copy, 'canonical', 'buracle.yaml'))
  symlinkSync(join(REPO, 'node_modules'), join(copy, 'node_modules'))
  return copy
}

function runHook(copy: string, harness: string, event: string, payload: string) {
  return Bun.spawnSync([process.execPath, join(copy, 'src', 'cli', 'main.ts'), 'hook', harness, event], {
    stdin: new TextEncoder().encode(payload), env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  })
}

describe('errors that escape a command', () => {
  test('a hook answers exit 0 and logs; other commands report on stderr and exit 1', () => withSandbox(async ({ buracleHome }) => {
    const err = sink()
    const out = sink()
    expect(await escapedErrorExit(['hook', 'codex', 'Stop'], new Error('kaboom'), { stderr: err, stdout: out })).toBe(0)
    expect(err.text).toBe('')
    expect(out.text).toBe('')
    expect(readFileSync(join(buracleHome, 'logs', 'buracle.log'), 'utf8')).toContain('kaboom')
    expect(await escapedErrorExit(['doctor'], new Error('kaboom'), { stderr: err, stdout: out })).toBe(1)
    expect(err.text).toBe('buracle: kaboom\n')
  }))

  test('a guard hook (PreToolUse) that fails before dispatch denies the call and names the fix', () => withSandbox(async () => {
    for (const h of ['claude', 'codex']) {
      const out = sink()
      expect(await escapedErrorExit(['hook', h, 'PreToolUse'], new Error('kaboom'), { stderr: sink(), stdout: out })).toBe(0)
      const d = decisionOf(out.text)
      expect(d.decision).toBe('deny')
      expect(String(d.reason)).toContain('kaboom')
      expect(String(d.reason)).toContain('buracle doctor')
    }
  }))

  test('the dispatcher denies a guard event whose adapter cannot load or throws; other events fail open', () => withSandbox(async ({ buracleHome }) => {
    const broken = { loadAdapter: () => { throw new SyntaxError('Unexpected <<') }, loadContext: () => { throw new Error('unused') } }
    const pre = await dispatchHook('claude', 'PreToolUse', '{}', broken)
    expect(pre.exitCode).toBe(0)
    expect(decisionOf(pre.stdout).decision).toBe('deny')
    expect(String(decisionOf(pre.stdout).reason)).toContain('Unexpected <<')
    expect(await dispatchHook('claude', 'Stop', '{}', broken)).toEqual({ stdout: '', exitCode: 0 })
    expect(await dispatchHook('opencode', 'PreToolUse', '{}', broken)).toEqual({ stdout: '', exitCode: 0 })
    const throwing = { loadAdapter: async () => ({ harness: 'codex', hook: async () => { throw new Error('handler blew up') } }) as never, loadContext: () => ({}) as never }
    const codex = await dispatchHook('codex', 'PreToolUse', '{}', throwing)
    expect(decisionOf(codex.stdout).decision).toBe('deny')
    expect(await dispatchHook('codex', 'PostToolUse', '{}', throwing)).toEqual({ stdout: '', exitCode: 0 })
    const log = readFileSync(join(buracleHome, 'logs', 'buracle.log'), 'utf8')
    expect(log).toContain('"result":"fail-closed"')
    expect(log).toContain('"result":"fail-open"')
  }))

  test('a handler that prints to stdout cannot corrupt the response the harness parses', () => withSandbox(async ({ root, buracleHome }) => {
    const copy = cliCopy(root)
    writeFileSync(join(copy, 'src', 'adapters', 'codex', 'index.ts'), [
      'export const adapter = {',
      "  harness: 'codex',",
      '  detect: async () => ({ installed: false }),',
      '  build: async () => [],',
      "  installPlan: async () => ({ id: 'codex', harness: 'codex', ops: [] }),",
      '  doctor: async () => [],',
      '  hook: async (event: string) => {',
      "    console.log('debug noise', event)",
      '    console.info({ structured: true })',
      "    process.stdout.write('raw noise\\n')",
      `    return { stdout: '{"decision":"approve"}', exitCode: 0 }`,
      '  },',
      '}',
      'export default adapter',
    ].join('\n'))
    const r = runHook(copy, 'codex', 'PreToolUse', '{}')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString()).toBe('{"decision":"approve"}')
    const log = readFileSync(join(buracleHome, 'logs', 'buracle.log'), 'utf8')
    expect(log).toContain('debug noise PreToolUse')
    expect(log).toContain('raw noise')
  }), 30_000)

  const broken: Array<[string, string, RegExp]> = [
    ['throws while evaluating', [
      'export class CanonicalError extends Error {}',
      'export function parseFrontmatter() { return { frontmatter: {}, body: "" } }',
      'export function loadCanonicalSync() { throw new Error("unreachable") }',
      'export async function loadCanonical() { throw new Error("unreachable") }',
      "throw new Error('broken at import')",
    ].join('\n'), /broken at import/],
    ['lacks an export (link error)', 'export {}\n', /loadCanonicalSync/],
    ['holds a merge-conflict marker (syntax error)', '<<<<<<< HEAD\nexport const x = 1\n=======\nexport const x = 2\n>>>>>>> other\n', /Unexpected|<</],
  ]
  for (const [what, source, logged] of broken) {
    test(`a guard hook fails closed and other hooks fail open when an imported module ${what}`, () => withSandbox(async ({ root, buracleHome }) => {
      const copy = cliCopy(root)
      writeFileSync(join(copy, 'src', 'engine', 'canonical.ts'), source)
      const payload = '{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"ls"}}'
      for (const h of ['codex', 'claude']) {
        const pre = runHook(copy, h, 'PreToolUse', payload)
        expect(pre.exitCode).toBe(0)
        expect(decisionOf(pre.stdout.toString()).decision).toBe('deny')
      }
      const stop = runHook(copy, 'codex', 'Stop', '{"session_id":"s1"}')
      expect(stop.exitCode).toBe(0)
      expect(stop.stdout.toString()).toBe('')
      expect(existsSync(join(buracleHome, 'logs', 'buracle.log'))).toBe(true)
      expect(readFileSync(join(buracleHome, 'logs', 'buracle.log'), 'utf8')).toMatch(logged)
    }), 30_000)
  }
})
