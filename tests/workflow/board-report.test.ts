import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { sessionDir } from '../../src/engine/paths'
import { run } from '../../src/engine/proc'
import { readBoard, sessionBoard, takeTerminalSequence } from '../../src/workflow/board-store'
import { workAsk, workDone, workInbox, workJoin, workNote, workPublish, workResume, workWait } from '../../src/workflow/board'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { oscSequence } from '../../src/workflow/terminal-notify'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { GIT_TEST_ENV, ctxAt, g, makeRepo, planDoc, write } from './fixture'

const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts')
const LEAD: ResolvedSession = { harness: 'claude', sessionId: 'lead-1', source: '--session' }
const A: ResolvedSession = { harness: 'codex', sessionId: 'worker-a', source: '--session' }
const B: ResolvedSession = { harness: 'opencode', sessionId: 'worker-b', source: '--session' }
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

async function board(root: string, n = 2): Promise<{ repo: string, path: string }> {
  const repo = await makeRepo(root)
  const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
  write(plan, planDoc({ n, status: 'IN_PROGRESS', approved: true }))
  const pub = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
  if (pub.code !== 0) throw new Error(pub.errors.join('; '))
  return { repo, path: String(pub.data['path']) }
}

async function commitIn(dir: string, file: string, content: string, msg: string): Promise<void> {
  write(join(dir, file), content)
  await g(dir, 'add', '-A')
  await g(dir, 'commit', '-q', '-m', msg)
}

describe('work done', () => {
  test('reads the branch and commits from the worktree, needs a clean worktree and --verify, and leaves a report note for the lead', () => sandbox(async root => {
    const { repo, path } = await board(root)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    const wt = String((j.data['worktree'] as { path: string }).path)
    expect((await workDone({}, ctxAt(repo, NOW), A)).data['error']).toBe('usage')
    write(join(wt, 'src', 's1.ts'), 'export const s1 = 1\n')
    const dirty = await workDone({ verify: 'bun test → 1 pass' }, ctxAt(repo, NOW), A)
    expect(dirty.data['error']).toBe('worktree_dirty')
    expect(String(dirty.data['message'])).toContain('src/s1.ts')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task 1: step 1')
    const r = await workDone({ verify: 'bun test → 1 pass' }, ctxAt(repo, NOW + 5), A)
    expect(r.errors).toEqual([])
    expect(r.data).toMatchObject({ ok: true, task: 1, status: 'done', branch: 'plan-build/rate-limit-t1', base: 'main', verify: 'bun test → 1 pass' })
    expect((r.data['commits'] as string[]).map(c => c.replace(/^\w+ /, ''))).toEqual(['task 1: step 1'])
    const t1 = readBoard(path)?.tasks[0]
    expect(t1).toMatchObject({ status: 'done', report: { branch: 'plan-build/rate-limit-t1', verify: 'bun test → 1 pass', at: NOW + 5 } })
    expect(t1?.worker).toBeUndefined()
    expect(readBoard(path)?.notes.at(-1)).toMatchObject({ to: 'lead', kind: 'report', from: { session: 'worker-a' } })
    expect(sessionBoard('codex', 'worker-a')).toEqual({ slug: 'rate-limit', path, role: 'worker' })
    expect((await workDone({ verify: 'x' }, ctxAt(repo, NOW + 6), A)).data['error']).toBe('usage')
    const other = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 7), B)
    expect(other.data).toMatchObject({ task: { n: 2 } })
  }))
})

describe('work ask and resume', () => {
  test('ask marks the task waiting without a lease, notes the lead and leaves the terminal sequence for the hooks (BURACLE_NO_NOTIFY keeps the terminal quiet here); resume claims it again', () => sandbox(async root => {
    const { repo, path } = await board(root)
    const tty = join(root, 'tty.out')
    const ctx = ctxAt(repo, NOW, { BURACLE_TTY_PATH: tty })
    await workJoin('rate-limit', {}, ctx, A)
    expect((await workAsk('', ctx, A)).data['error']).toBe('usage')
    const r = await workAsk('which port should the server use?', ctx, A)
    expect(r.code).toBe(0)
    const sequence = oscSequence('Task 1 of rate-limit needs you', 'which port should the server use?')
    expect(r.data).toMatchObject({ ok: true, task: 1, status: 'waiting', question: 'which port should the server use?', notified: false, terminalSequence: sequence, cmux: false, herdr: false })
    expect(existsSync(tty)).toBe(false)
    expect(readBoard(path)?.tasks[0]).toMatchObject({ status: 'waiting', question: 'which port should the server use?' })
    expect(readBoard(path)?.tasks[0]?.leaseUntil).toBeUndefined()
    expect(readBoard(path)?.notes.at(-1)).toMatchObject({ to: 'lead', kind: 'question' })
    expect(existsSync(join(sessionDir('codex', 'worker-a'), 'board-terminal.json'))).toBe(true)
    expect(takeTerminalSequence('codex', 'worker-a')).toBe(sequence)
    expect(takeTerminalSequence('codex', 'worker-a')).toBeUndefined()
    // Asking again while waiting replaces the question and keeps the claim.
    expect((await workAsk('and the host?', ctxAt(repo, NOW + 40, { BURACLE_TTY_PATH: tty }), A)).code).toBe(0)
    expect(readBoard(path)?.tasks[0]).toMatchObject({ status: 'waiting', question: 'and the host?' })
    expect(sessionBoard('codex', 'worker-a')?.task).toBe(1)
    const res = await workResume(ctxAt(repo, NOW + 50), A)
    expect(res.data).toMatchObject({ ok: true, task: 1, status: 'claimed', already: false, leaseUntil: NOW + 50 + 300_000 })
    // A second resume (the hooks usually resume first) is not an error and keeps the claim.
    expect((await workResume(ctxAt(repo, NOW + 60), A)).data).toMatchObject({ ok: true, task: 1, status: 'claimed', already: true, leaseUntil: NOW + 50 + 300_000 })
    expect(sessionBoard('codex', 'worker-a')?.task).toBe(1)
    expect(sessionBoard('codex', 'worker-a')?.heartbeatAt).toBe(NOW + 50)
  }))
})

describe('notes, inbox and wait', () => {
  test('a note goes to the lead by default, the inbox delivers it once, and the same note never comes twice through wait and inbox', () => sandbox(async root => {
    const { repo, path } = await board(root)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    expect(workNote('', {}, ctxAt(repo, NOW), A).data['error']).toBe('usage')
    expect(workNote('x', { kind: 'shout' }, ctxAt(repo, NOW), A).data['error']).toBe('usage')
    const n1 = workNote('schema question is blocking', { kind: 'question' }, ctxAt(repo, NOW + 1), A)
    expect(n1.code).toBe(0)
    expect(readBoard(path)?.notes.find(n => n.seq === n1.data['seq'])).toMatchObject({ to: 'lead', kind: 'question', role: 'worker' })
    const n2 = workNote('rebase onto main please', {}, ctxAt(repo, NOW + 2), LEAD)
    expect(readBoard(path)?.notes.find(n => n.seq === n2.data['seq'])).toMatchObject({ to: 'all', kind: 'nudge', role: 'lead' })
    const inboxA = workInbox(ctxAt(repo, NOW + 3), A)
    expect((inboxA.data['notes'] as Array<{ text: string }>).map(n => n.text)).toEqual(['rebase onto main please'])
    expect(inboxA.lines[0]).toBe('[nudge] from lead claude lead-1: rebase onto main please')
    expect((workInbox(ctxAt(repo, NOW + 4), A).data['notes'] as unknown[])).toEqual([])
    const w = await workWait({ timeoutSec: 0 }, ctxAt(repo, NOW + 5), LEAD)
    expect(w.code).toBe(0)
    expect((w.data['events'] as Array<{ kind: string }>).map(e => e.kind)).toEqual(['claimed', 'note'])
    expect((w.data['events'] as Array<{ note?: { text: string } }>)[1]?.note?.text).toBe('schema question is blocking')
    expect((workInbox(ctxAt(repo, NOW + 6), LEAD).data['notes'] as unknown[])).toEqual([])
    const again = await workWait({ timeoutSec: 0 }, ctxAt(repo, NOW + 7), LEAD)
    expect(again.data).toMatchObject({ timedOut: true, events: [] })
    expect((await workWait({ timeoutSec: 0 }, ctxAt(repo, NOW + 8), A)).data['error']).toBe('not_lead')
  }))

  test('wait returns within a few seconds of a done report written by another process, and reports a stale lease on its own', () => sandbox(async root => {
    const { repo, path } = await board(root)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, Date.now()), A)
    const wt = String((j.data['worktree'] as { path: string }).path)
    await commitIn(wt, 'src/s1.ts', 'export const s1 = 1\n', 'task 1: step 1')
    await workWait({ timeoutSec: 0 }, ctxAt(repo, Date.now()), LEAD)
    const env = { ...GIT_TEST_ENV, HOME: process.env['HOME'] as string, BURACLE_HOME: process.env['BURACLE_HOME'] as string, BURACLE_NO_NOTIFY: '1', BURACLE_NO_MEMORY: '1', CODEX_THREAD_ID: 'worker-a' }
    const child = new Promise<{ code: number, stdout: string, stderr: string }>(resolve => { setTimeout(() => { void run([process.execPath, CLI, 'work', 'done', '--verify', 'bun test → 1 pass', '--json'], { cwd: repo, env, timeoutMs: 30_000 }).then(r => resolve(r)) }, 1000) })
    const started = Date.now()
    const w = await workWait({ timeoutSec: 10 }, ctxAt(repo, Date.now()), LEAD)
    const elapsed = Date.now() - started
    const childResult = await child
    expect({ code: childResult.code, stderr: childResult.stderr, timedOut: w.data['timedOut'] }).toEqual({ code: 0, stderr: '', timedOut: false })
    expect((w.data['events'] as Array<{ kind: string, task?: number }>).some(e => e.kind === 'done' && e.task === 1)).toBe(true)
    expect(elapsed).toBeLessThan(5000)
    expect(readBoard(path)?.tasks[0]?.status).toBe('done')

    const { repo: repo2 } = await (async () => {
      const r = await makeRepo(join(root, 'two'))
      const plan = join(r, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
      write(plan, planDoc({ n: 1, status: 'IN_PROGRESS', approved: true }))
      const pub = await workPublish({ planPath: plan, leaseSec: 1 }, ctxAt(r, Date.now()), LEAD)
      if (pub.code !== 0) throw new Error(pub.errors.join('; '))
      return { repo: r }
    })()
    await workJoin('rate-limit', {}, ctxAt(repo2, Date.now()), B)
    await workWait({ timeoutSec: 0 }, ctxAt(repo2, Date.now()), LEAD)
    const stale = await workWait({ timeoutSec: 5 }, ctxAt(repo2, Date.now()), LEAD)
    expect(stale.data['timedOut']).toBe(false)
    expect((stale.data['events'] as Array<{ kind: string }>).map(e => e.kind)).toEqual(['stale'])
  }), 30_000)
})
