import { describe, expect, test } from 'bun:test'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { consentFile, consentGate, readConsentState, recordPromptGrants, writeConsentState } from '../../../src/adapters/shared/consent-store'
import { withSandbox } from '../../helpers/sandbox'

const NOW = 1_790_000_000_000
const REPO = join(import.meta.dir, '..', '..', '..')

describe('consent store gates', () => {
  test('a single command that needs consent is denied and the question is recorded', async () => {
    await withSandbox(async () => {
      const reason = consentGate('claude', 'sid-1', 'git push origin main', NOW)
      expect(reason).toBeDefined()
      expect(readConsentState('claude', 'sid-1').pending).toBeDefined()
    })
  })

  test('a command that needs no consent passes without a consent file', async () => {
    await withSandbox(async () => {
      expect(consentGate('codex', 'sid-2', 'git status', NOW)).toBeUndefined()
      expect(existsSync(consentFile('codex', 'sid-2'))).toBe(false)
    })
  })

  test('a grant from the user lets the held command run once', async () => {
    await withSandbox(async () => {
      expect(consentGate('opencode', 'sid-4', 'git push origin feature', NOW)).toBeDefined()
      recordPromptGrants('opencode', 'sid-4', 'yes, push it', NOW + 1_000)
      expect(consentGate('opencode', 'sid-4', 'git push origin feature', NOW + 2_000)).toBeUndefined()
    })
  })
})

describe('consent store: concurrent hooks', () => {
  async function race(root: string, sid: string, command: string, n: number, delayMs = 2_000): Promise<string[]> {
    const script = join(root, 'gate.ts')
    writeFileSync(script, [
      `import { consentGate } from ${JSON.stringify(join(REPO, 'src/adapters/shared/consent-store'))}`,
      'const start = Number(process.argv[2])',
      'while (Date.now() < start) { /* wait for the others */ }',
      `const r = consentGate('codex', ${JSON.stringify(sid)}, ${JSON.stringify(command)}, ${NOW})`,
      "process.stdout.write(r === undefined ? 'allow' : 'deny')",
    ].join('\n'))
    const start = Date.now() + delayMs
    const procs = Array.from({ length: n }, () => Bun.spawn([process.execPath, script, String(start)], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' }))
    return Promise.all(procs.map(p => new Response(p.stdout).text()))
  }

  test('several gated calls at once: the last use of a grant lets exactly one of them run', async () => {
    await withSandbox(async ({ root }) => {
      writeConsentState('codex', 'sid-race', { v: 1, grants: [{ kind: 'push', until: NOW + 60_000, uses: 1, source: 'ask' }] })
      const answers = await race(root, 'sid-race', 'git push origin feat', 8)
      expect(answers.sort()).toEqual(['allow', ...Array.from({ length: 7 }, () => 'deny')])
      expect(readConsentState('codex', 'sid-race').grants).toEqual([])
    })
  }, 30_000)

  test('a gate waits for a lock another process holds, then decides on what that process wrote', async () => {
    await withSandbox(async ({ root }) => {
      writeConsentState('codex', 'sid-wait', { v: 1, grants: [] })
      const lock = `${consentFile('codex', 'sid-wait')}.lock`
      writeFileSync(lock, JSON.stringify({ pid: process.pid }))
      const child = race(root, 'sid-wait', 'git push origin feat', 1, 1_500)
      await Bun.sleep(2_000)
      writeConsentState('codex', 'sid-wait', { v: 1, grants: [{ kind: 'push', until: NOW + 60_000, uses: 2, source: 'ask' }] })
      unlinkSync(lock)
      expect(await child).toEqual(['allow'])
      expect(readConsentState('codex', 'sid-wait').grants).toEqual([{ kind: 'push', until: NOW + 60_000, uses: 1, source: 'ask' }])
    })
  }, 30_000)

  test('a lock that never comes free does not open the gate: the call is still judged (and denied without a grant)', async () => {
    await withSandbox(async () => {
      writeConsentState('claude', 'sid-stuck', { v: 1, grants: [] })
      writeFileSync(`${consentFile('claude', 'sid-stuck')}.lock`, JSON.stringify({ pid: process.pid }))
      const started = Date.now()
      expect(consentGate('claude', 'sid-stuck', 'git push origin feat', NOW)).toContain('Ask the user first')
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(readConsentState('claude', 'sid-stuck').pending?.kind).toBe('push')
    })
  }, 30_000)

  test('a prompt that grants records its grant under the lock as well', async () => {
    await withSandbox(async () => {
      consentGate('omp', 'sid-p', 'git push origin feat', NOW)
      recordPromptGrants('omp', 'sid-p', 'evet', NOW + 1_000)
      expect(existsSync(`${consentFile('omp', 'sid-p')}.lock`)).toBe(false)
      expect(consentGate('omp', 'sid-p', 'git push origin feat', NOW + 2_000)).toBeUndefined()
    })
  })
})
