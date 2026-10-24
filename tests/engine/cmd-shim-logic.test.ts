import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { shimContent, windowsShimContent } from '../../src/engine/update/install-core'

// cmd.exe cannot run on the machines that run most of this suite, so these tests read the generated buracle.cmd with
// a small interpreter of exactly the statements the generator writes (if / goto / set / type / del / echo / exit /b, a
// bun invocation with or without a redirect). They check the shim's control flow: which exit codes pass through and
// which are answered with the deny JSON. What they cannot check is cmd.exe's own parsing (quoting, %-expansion rules);
// the windows-install job in CI runs the real shim on Windows.

const BUN = 'C:\\bun\\bun.exe'
const REPO = 'C:\\src\\buracle'
const RUNTIME = 'C:\\h\\.buracle\\runtime\\0123456789abcdef'
// The generator joins with the host's separator, so these are what it writes on whichever machine runs the test.
const RUNTIME_MAIN = join(RUNTIME, 'src', 'cli', 'main.ts')
const REPO_MAIN = join(REPO, 'src', 'cli', 'main.ts')

interface BunResult { stdout: string, code: number }
interface CmdRun { stdout: string, stderr: string, code: number, bunCalls: string[][], leftoverFiles: string[] }

function runCmd(script: string, args: string[], opts: { exists: string[], bun: (args: string[]) => BunResult }): CmdRun {
  const lines = script.split('\r\n').filter(l => l !== '')
  const labels = new Map<string, number>()
  lines.forEach((l, i) => { if (l.startsWith(':')) labels.set(l.slice(1).toLowerCase(), i) })
  const env = new Map<string, string>([['TEMP', 'C:\\Temp'], ['RANDOM', '4242']])
  const files = new Map<string, string>()
  const out: CmdRun = { stdout: '', stderr: '', code: 0, bunCalls: [], leftoverFiles: [] }
  let level = 0

  const expand = (s: string): string => s.replace(/%~(\d)|%\*|%([A-Za-z_][A-Za-z0-9_]*)%/g, (_all: string, n?: string, name?: string) => {
    if (n !== undefined) return args[Number(n) - 1] ?? ''
    if (name === undefined) return args.join(' ')
    if (name.toUpperCase() === 'ERRORLEVEL') return String(level)
    return env.get(name.toUpperCase()) ?? ''
  })

  type Flow = { kind: 'next' } | { kind: 'goto', label: string } | { kind: 'exit', code: number }
  const next: Flow = { kind: 'next' }

  function exec(raw: string): Flow {
    const stmt = raw.trim()
    let m: RegExpExecArray | null
    if (stmt === '@echo off' || stmt.toLowerCase().startsWith('rem ') || stmt.toLowerCase() === 'setlocal' || stmt.startsWith(':')) return next
    if ((m = /^if (\/i )?(not )?defined (\w+) (.+)$/i.exec(stmt))) {
      const defined = env.has((m[3] as string).toUpperCase())
      return (m[2] !== undefined ? !defined : defined) ? exec(m[4] as string) : next
    }
    if ((m = /^if (\/i )?(not )?exist "([^"]*)" (.+)$/i.exec(stmt))) {
      const there = opts.exists.includes(m[3] as string)
      return (m[2] !== undefined ? !there : there) ? exec(m[4] as string) : next
    }
    if ((m = /^if (\/i )?(not )?"([^"]*)"=="([^"]*)" (.+)$/i.exec(stmt))) {
      let a = expand(m[3] as string)
      let b = expand(m[4] as string)
      if (m[1] !== undefined) { a = a.toLowerCase(); b = b.toLowerCase() }
      return (m[2] !== undefined ? a !== b : a === b) ? exec(m[5] as string) : next
    }
    if ((m = /^goto (\w+)$/i.exec(stmt))) return { kind: 'goto', label: (m[1] as string).toLowerCase() }
    if ((m = /^exit \/b (\S+)$/i.exec(stmt))) return { kind: 'exit', code: Number(expand(m[1] as string)) }
    if ((m = /^set "([^=]+)=(.*)"$/i.exec(stmt))) { env.set((m[1] as string).toUpperCase(), expand(m[2] as string)); return next }
    if ((m = /^type "([^"]*)"$/i.exec(stmt))) { out.stdout += files.get(expand(m[1] as string)) ?? ''; return next }
    if ((m = /^del "([^"]*)"( 2>nul)?$/i.exec(stmt))) { files.delete(expand(m[1] as string)); return next }
    if ((m = /^echo (.*?)( 1>&2)?$/i.exec(stmt))) {
      const line = `${m[1] as string}\n`
      if (m[2] !== undefined) out.stderr += line
      else out.stdout += line
      return next
    }
    if ((m = /^"([^"]+)" "([^"]+)" %\*(?: > "([^"]+)")?$/.exec(stmt))) {
      if (m[1] !== BUN) throw new Error(`the shim runs ${m[1]}, not the recorded bun`)
      const callArgs = [m[2] as string, ...args]
      out.bunCalls.push(callArgs)
      const r = opts.bun(callArgs)
      level = r.code
      if (m[3] !== undefined) files.set(expand(m[3]), r.stdout)
      else out.stdout += r.stdout
      return next
    }
    throw new Error(`the interpreter does not know this statement: ${stmt}`)
  }

  for (let pc = 0, steps = 0; pc < lines.length; steps++) {
    if (steps > 500) throw new Error('the shim does not terminate')
    const flow = exec(lines[pc] as string)
    if (flow.kind === 'exit') { out.code = flow.code; out.leftoverFiles = [...files.keys()]; return out }
    if (flow.kind === 'goto') {
      const to = labels.get(flow.label)
      if (to === undefined) throw new Error(`goto :${flow.label} has no label`)
      pc = to
    } else pc++
  }
  out.code = level
  out.leftoverFiles = [...files.keys()]
  return out
}

const script = (runtime = false) => windowsShimContent(runtime ? { bun: BUN, repoRoot: REPO, runtime: RUNTIME } : { bun: BUN, repoRoot: REPO })
const bunReturns = (code: number, stdout = '') => (_args: string[]): BunResult => ({ stdout, code })

describe('the Windows shim answers a guard hook it cannot run with the deny JSON, like the sh shim', () => {
  const allow = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
  const exists = [RUNTIME_MAIN, REPO_MAIN]

  for (const harness of ['claude', 'codex']) {
    test(`hook ${harness} PreToolUse: exit 0 and 2 pass through with the hook's output, any other exit is a deny and exit 0`, () => {
      for (const runtime of [false, true]) {
        const main = runtime ? RUNTIME_MAIN : REPO_MAIN
        for (const code of [0, 2]) {
          const r = runCmd(script(runtime), ['hook', harness, 'PreToolUse'], { exists: [main], bun: bunReturns(code, `${allow}\n`) })
          expect(r).toMatchObject({ code, stdout: `${allow}\n`, stderr: '', leftoverFiles: [] })
          expect(r.bunCalls).toEqual([[main, 'hook', harness, 'PreToolUse']])
        }
        for (const code of [1, 3, 9009, 255, -1, -1073741819]) {
          const r = runCmd(script(runtime), ['hook', harness, 'PreToolUse'], { exists: [main], bun: bunReturns(code, 'half an output') })
          expect(r.code).toBe(0)
          expect(r.leftoverFiles).toEqual([])
          expect(r.stdout.endsWith('\n')).toBe(true)
          const decision = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string, permissionDecisionReason: string } }
          expect(decision.hookSpecificOutput.permissionDecision).toBe('deny')
          expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('buracle doctor')
        }
      }
    })
  }

  test('the deny is the sh shim\'s (the characters cmd would treat as operators aside)', () => {
    const r = runCmd(script(), ['hook', 'codex', 'PreToolUse'], { exists, bun: bunReturns(1) })
    const sh = shimContent({ bun: '/b', repoRoot: '/r' })
    const shDeny = /printf '%s\\n' '(\{[^\n]*\})'; fi/.exec(sh)?.[1]
    expect(shDeny).toBeDefined()
    expect(r.stdout.trimEnd()).toBe((shDeny as string).replace(/'\\''/g, "'").replace(/[<>|&^%!]/g, ' '))
  })

  test('anything that is not a guard hook keeps its exit code and writes straight to stdout', () => {
    for (const args of [['hook', 'codex', 'PostToolUse'], ['hook', 'claude', 'Stop'], ['hook', 'opencode', 'PreToolUse'], ['doctor'], ['mcp', 'serve']]) {
      const r = runCmd(script(), args, { exists, bun: bunReturns(7, 'some output\n') })
      expect(r).toMatchObject({ code: 7, stdout: 'some output\n' })
    }
  })

  test('a missing runtime: a guard hook is denied, other hooks do nothing, other commands use the checkout or fail with 127', () => {
    const pre = runCmd(script(true), ['hook', 'codex', 'PreToolUse'], { exists: [], bun: bunReturns(0) })
    expect(pre.code).toBe(0)
    expect((JSON.parse(pre.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(pre.bunCalls).toEqual([])
    const stop = runCmd(script(true), ['hook', 'codex', 'Stop'], { exists: [], bun: bunReturns(0) })
    expect(stop).toMatchObject({ code: 0, stdout: '' })
    const viaCheckout = runCmd(script(true), ['doctor'], { exists: [REPO_MAIN], bun: bunReturns(0, 'ok\n') })
    expect(viaCheckout.bunCalls).toEqual([[REPO_MAIN, 'doctor']])
    const nowhere = runCmd(script(true), ['doctor'], { exists: [], bun: bunReturns(0) })
    expect(nowhere.code).toBe(127)
    expect(nowhere.stderr).toContain('is missing')
  })
})
