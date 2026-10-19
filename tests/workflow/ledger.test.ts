import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyTool } from '../../src/core/events'
import type { PromptRoute } from '../../src/core/policy/skill-router'
import { emptyLedger, ledgerCall, ledgerPrompt } from '../../src/core/policy/usage'
import { sessionDir } from '../../src/engine/paths'
import { ledgerPath, loadLedger, resetLedger, updateLedger } from '../../src/workflow/ledger'
import { withSandbox } from '../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..')
const route = (p: Partial<PromptRoute> = {}): PromptRoute => ({ invoked: [], load: [], candidates: [], categories: [], memory: { recall: false, write: false }, ...p })
const grep = { harness: 'claude' as const, sessionId: 's1', cwd: '/r', tool: 'Grep', input: { pattern: 'x' }, ...classifyTool('claude', 'Grep', { pattern: 'x' }, '/r') }

describe('ledger.json', () => {
  test('missing reads as empty; an update writes it and reads back the same', () => withSandbox(() => {
    expect(loadLedger('claude', 's1')).toEqual(emptyLedger())
    expect(existsSync(ledgerPath('claude', 's1'))).toBe(false)
    const stored = updateLedger('claude', 's1', l => ledgerCall(ledgerPrompt(l, route({ load: ['plan-build'] }), 5), grep))
    expect(ledgerPath('claude', 's1')).toBe(join(sessionDir('claude', 's1'), 'ledger.json'))
    expect(loadLedger('claude', 's1')).toEqual(stored)
    expect(stored.turn).toBe(1)
    expect(stored.turnTools.search).toBe(1)
    expect(existsSync(`${ledgerPath('claude', 's1')}.lock`)).toBe(false)
  }))

  test('returning the same ledger skips the write; reset starts over', () => withSandbox(() => {
    updateLedger('codex', 's2', l => l)
    expect(existsSync(ledgerPath('codex', 's2'))).toBe(false)
    updateLedger('codex', 's2', l => ledgerPrompt(l, route(), 1))
    resetLedger('codex', 's2')
    expect(loadLedger('codex', 's2')).toEqual(emptyLedger())
  }))

  test('an unreadable file reads as empty and is replaced by the next update', () => withSandbox(() => {
    updateLedger('omp', 's3', l => ledgerPrompt(l, route(), 1))
    writeFileSync(ledgerPath('omp', 's3'), '{ broken')
    expect(loadLedger('omp', 's3')).toEqual(emptyLedger())
    expect(updateLedger('omp', 's3', l => ledgerPrompt(l, route(), 2)).turn).toBe(1)
    expect(JSON.parse(readFileSync(ledgerPath('omp', 's3'), 'utf8')).turn).toBe(1)
  }))

  test('a stale lock is broken; a live one makes the update throw after the timeout', () => withSandbox(() => {
    updateLedger('opencode', 's4', l => l)
    const lock = `${ledgerPath('opencode', 's4')}.lock`
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 'x' }))
    expect(() => updateLedger('opencode', 's4', l => ledgerPrompt(l, route(), 1), { timeoutMs: 50 })).toThrow(/lock busy/)
    const old = (Date.now() - 60_000) / 1000
    utimesSync(lock, old, old)
    expect(updateLedger('opencode', 's4', l => ledgerPrompt(l, route(), 1)).turn).toBe(1)
    expect(existsSync(lock)).toBe(false)
  }))

  test('a lock left by a process that is gone is broken at once', () => withSandbox(() => {
    updateLedger('claude', 's5', l => l)
    const gone = Bun.spawnSync([process.execPath, '-e', '0'], { env: { ...process.env } }).pid
    writeFileSync(`${ledgerPath('claude', 's5')}.lock`, JSON.stringify({ pid: gone, at: 'x' }))
    expect(updateLedger('claude', 's5', l => ledgerPrompt(l, route(), 1), { timeoutMs: 50 }).turn).toBe(1)
  }))

  test('hook processes updating at once lose no update', () => withSandbox(async () => {
    const script = [
      `import { classifyTool } from ${JSON.stringify(join(REPO, 'src', 'core', 'events.ts'))}`,
      `import { ledgerCall } from ${JSON.stringify(join(REPO, 'src', 'core', 'policy', 'usage.ts'))}`,
      `import { updateLedger } from ${JSON.stringify(join(REPO, 'src', 'workflow', 'ledger.ts'))}`,
      "const input = { pattern: 'x' }",
      "const call = { harness: 'claude', sessionId: 'p', cwd: '/r', tool: 'Grep', input, ...classifyTool('claude', 'Grep', input, '/r') }",
      'for (let i = 0; i < 20; i++) updateLedger(\'claude\', \'p\', l => ledgerCall(l, call), { timeoutMs: 20_000 })',
    ].join('\n')
    const file = join(process.env['HOME'] as string, 'bump.ts')
    writeFileSync(file, script)
    const procs = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, file], { env: process.env, stdout: 'ignore', stderr: 'pipe' }))
    const stderrs = procs.map(p => new Response(p.stderr).text())
    const codes = await Promise.all(procs.map(p => p.exited))
    // A process that failed says why.
    const failed = codes.some(c => c !== 0)
    expect({ codes, stderr: failed ? await Promise.all(stderrs) : [] }).toEqual({ codes: [0, 0, 0, 0], stderr: [] })
    const l = loadLedger('claude', 'p')
    expect(l.turnTools.calls).toBe(80)
    expect(l.turnTools.search).toBe(80)
  }), 60_000)
})
