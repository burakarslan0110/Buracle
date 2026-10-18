import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { NOTICES_PER_SESSION, noticeTexts, pendingNotices, validateNotices, type Notice } from '../../src/core/notices'

const NOW = Date.UTC(2026, 9, 17)
const none = new Set<string>()
const n = (id: string, since: string, until?: string): Notice => ({ id, since, ...(until !== undefined ? { until } : {}), message: `message of ${id}` })

describe('pendingNotices: what a session start still has to show', () => {
  test('only notices of this version or older, before their end, and not yet acknowledged', () => {
    const list = [n('old', '0.4.0'), n('now', '0.5.0', '0.6.0'), n('next', '0.6.0'), n('ended', '0.4.0', '0.5.0'), n('dated', '0.5.0', '2026-10-18'), n('expired', '0.5.0', '2026-10-17')]
    expect(pendingNotices(list, { version: '0.5.0', nowMs: NOW, acked: none }).map(x => x.id)).toEqual(['old', 'now', 'dated'])
    expect(pendingNotices(list, { version: '0.5.0', nowMs: NOW, acked: new Set(['old', 'dated']) }).map(x => x.id)).toEqual(['now'])
    expect(pendingNotices(list, { version: '0.6.0', nowMs: NOW, acked: none }).map(x => x.id)).toEqual(['old', 'next', 'dated'])
  })

  test('versions compare by number, and a pre-release comes before its release', () => {
    const list = [n('a', '0.10.0'), n('b', '0.5.0')]
    expect(pendingNotices(list, { version: '0.9.3', nowMs: NOW, acked: none }).map(x => x.id)).toEqual(['b'])
    expect(pendingNotices(list, { version: '0.10.0-rc.1', nowMs: NOW, acked: none }).map(x => x.id)).toEqual(['b'])
    expect(pendingNotices(list, { version: '0.10.0', nowMs: NOW, acked: none }).map(x => x.id)).toEqual(['a', 'b'])
  })

  test(`at most ${NOTICES_PER_SESSION} per session; malformed entries are ignored`, () => {
    const list = [...['a', 'b', 'c', 'd'].map(id => n(id, '0.1.0')), { id: 'Bad Id', since: '0.1.0', message: 'x' }, { id: 'empty', since: '0.1.0', message: ' ' }] as Notice[]
    expect(pendingNotices(list, { version: '0.5.0', nowMs: NOW, acked: none }).map(x => x.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('noticeTexts: one line for the user, one instruction for the model', () => {
  test('the user line names the version; the model is told to pass it on without asking', () => {
    const t = noticeTexts([{ id: 'x', since: '0.5.0', message: 'Projects\n  sync now.' }])
    expect(t?.user).toBe('Buracle 0.5.0: Projects sync now.')
    expect(t?.model.split('\n')).toEqual([
      'Buracle notice, shown once on this machine. Tell the user in one short line at the start of your next reply, do not ask anything about it, and carry on with their request:',
      '- Projects sync now.',
    ])
    expect(noticeTexts([])).toBeUndefined()
  })
})

describe('validateNotices: canonical/notices.yaml', () => {
  test('the shipped file is valid', () => {
    const raw = parseYaml(readFileSync(join(import.meta.dir, '..', '..', 'canonical', 'notices.yaml'), 'utf8')) as unknown
    expect(validateNotices(raw)).toEqual([])
  })

  test('names each problem', () => {
    expect(validateNotices([])).toEqual(['(root): expected { notices: [...] }'])
    expect(validateNotices({ notices: [
      { id: 'a', since: '0.5', message: 'x' },
      { id: 'a', since: '0.5.0', message: 'x', until: 'soon', extra: 1 },
      { id: 'b', since: '0.5.0', message: 'y'.repeat(401) },
    ] })).toEqual([
      'notices[0].since: expected a version such as 0.5.0',
      'notices[1].extra: unknown key',
      'notices[1].id: duplicate a',
      'notices[1].until: expected a version such as 0.6.0 or a date such as 2026-12-31',
      'notices[2].message: at most 400 characters',
    ])
  })
})
