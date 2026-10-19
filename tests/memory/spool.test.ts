import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { SPOOL_LIMITS } from '../../src/core/memory/spool'
import { redactionsFile, spoolDir } from '../../src/memory/layout'
import { activeSpoolFiles, appendSpool, captureOff, pruneRedactions, readSpool, recordRedactions, redactionsSince, spoolFiles } from '../../src/memory/spool'
import { withSandbox } from '../helpers/sandbox'
import { withCapture } from './helpers'

const SID = '3f2a9c1e-0000-4000-8000-000000000000'

describe('appendSpool', () => {
  test('writes sanitized, redacted JSON lines and records redactions', async () => {
    await withCapture(() => withSandbox(() => {
      appendSpool('claude', SID, [
        { ts: 1, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'curl -H "Authorization: Bearer abcdef1234567890xyz" x', exit: 0 },
        { ts: 2, ev: 'turn', excerpt: 'done', model: 'claude-opus-5-5', tokens: 12 },
        { ts: 3, ev: 'bogus' } as never,
      ])
      const file = join(spoolDir(), `claude-${SID}.jsonl`)
      const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(lines).toEqual([
        { ts: 1, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'curl -H "Authorization: Bearer [REDACTED:bearer]" x', exit: 0 },
        { ts: 2, ev: 'turn', excerpt: 'done', model: 'claude-opus-5-5', tokens: 12 },
      ])
      expect(redactionsSince(0)).toBe(1)
    }))
  })

  test('is a no-op for invalid session ids and never throws', async () => {
    await withCapture(() => withSandbox(() => {
      appendSpool('claude', '../escape', [{ ts: 1, ev: 'prompt' }])
      appendSpool('claude', '', [{ ts: 1, ev: 'prompt' }])
      appendSpool('claude', SID, [])
      appendSpool('claude', SID, null as never)
      expect(existsSync(spoolDir())).toBe(false)
    }))
  })

  test('per-turn suffix files are read together, done/ files included', async () => {
    await withCapture(() => withSandbox(() => {
      appendSpool('claude', SID, [{ ts: 5, ev: 'stop', excerpt: 'b' }], { suffix: 'turn-2' })
      appendSpool('claude', SID, [{ ts: 1, ev: 'prompt' }])
      mkdirSync(join(spoolDir(), 'done'), { recursive: true })
      writeFileSync(join(spoolDir(), 'done', `claude-${SID}-turn-1.jsonl`), '{"ts":3,"ev":"turn","excerpt":"a"}\n')
      appendSpool('claude', 'other-session', [{ ts: 9, ev: 'prompt' }])
      const files = spoolFiles('claude', SID)
      expect(files.active.map(f => basename(f))).toEqual([`claude-${SID}-turn-2.jsonl`, `claude-${SID}.jsonl`])
      expect(files.done).toHaveLength(1)
      expect(readSpool('claude', SID).map(e => e.ts)).toEqual([1, 3, 5])
    }))
  })

  test('activeSpoolFiles groups the active files of many sessions from one listing, as spoolFiles does', async () => {
    await withCapture(() => withSandbox(() => {
      appendSpool('claude', SID, [{ ts: 1, ev: 'prompt' }])
      appendSpool('claude', SID, [{ ts: 2, ev: 'stop', excerpt: 'b' }], { suffix: 'end' })
      appendSpool('claude', 'abc', [{ ts: 1, ev: 'prompt' }])
      appendSpool('claude', 'abc-def', [{ ts: 1, ev: 'prompt' }], { suffix: 'end' })
      appendSpool('codex', SID, [{ ts: 1, ev: 'prompt' }])
      mkdirSync(join(spoolDir(), 'done'), { recursive: true })
      writeFileSync(join(spoolDir(), 'done', `claude-${SID}-turn-1.jsonl`), '{"ts":3,"ev":"turn","excerpt":"a"}\n')
      const sids = [SID, 'abc', 'abc-def', 'idle']
      const grouped = activeSpoolFiles('claude', new Set(sids))
      for (const sid of sids) expect([sid, grouped.get(sid) ?? []]).toEqual([sid, spoolFiles('claude', sid).active])
      expect(grouped.get('idle')).toBeUndefined()
    }))
  })

  test('caps the file: tool entries stop at the soft limit, everything at the hard limit', async () => {
    await withCapture(() => withSandbox(() => {
      const file = join(spoolDir(), `codex-${SID}.jsonl`)
      mkdirSync(spoolDir(), { recursive: true })
      writeFileSync(file, 'x'.repeat(SPOOL_LIMITS.softFileBytes))
      appendSpool('codex', SID, [{ ts: 1, ev: 'tool', cmd: 'ls' }, { ts: 2, ev: 'stop', excerpt: 'kept' }])
      const tail = readFileSync(file, 'utf8').slice(SPOOL_LIMITS.softFileBytes)
      expect(tail).toBe('{"ts":2,"ev":"stop","excerpt":"kept"}\n')
      writeFileSync(file, 'x'.repeat(SPOOL_LIMITS.hardFileBytes))
      appendSpool('codex', SID, [{ ts: 3, ev: 'stop', excerpt: 'dropped' }])
      expect(readFileSync(file, 'utf8').length).toBe(SPOOL_LIMITS.hardFileBytes)
    }))
  })
})

describe('BURACLE_NO_CAPTURE=1', () => {
  test('appendSpool writes nothing (read live on every call)', async () => {
    await withSandbox(async () => {
      expect(process.env['BURACLE_NO_CAPTURE']).toBe('1')
      expect(captureOff()).toBe(true)
      appendSpool('codex', SID, [{ ts: 1, ev: 'stop', excerpt: 'not recorded' }])
      expect(existsSync(spoolDir())).toBe(false)
      await withCapture(() => {
        expect(captureOff()).toBe(false)
        appendSpool('codex', SID, [{ ts: 2, ev: 'stop', excerpt: 'recorded' }])
      })
      expect(readSpool('codex', SID).map(e => e.excerpt)).toEqual(['recorded'])
    })
  })
})

describe('redaction log', () => {
  test('counts the last 24 h and prunes old entries once it grows', async () => {
    await withCapture(() => withSandbox(() => {
      const now = Date.now()
      for (let i = 0; i < 4000; i++) recordRedactions(1, ['entropy'], 'old entry with some padding to grow the file quickly', now - 72 * 3600_000)
      recordRedactions(2, ['github'], 'spool', now - 3600_000)
      expect(redactionsSince(now - 24 * 3600_000)).toBe(2)
      pruneRedactions(now)
      expect(readFileSync(redactionsFile(), 'utf8').trim().split('\n')).toHaveLength(1)
      expect(redactionsSince(now - 24 * 3600_000)).toBe(2)
    }))
  })
})
