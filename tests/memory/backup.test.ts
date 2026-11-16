import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { main } from '../../src/cli/router'
import { MemoryError, search, update, write } from '../../src/memory/api'
import { backupBrains, backupBuckets, listBackups, maybeDailyBackup, restoreBackup } from '../../src/memory/backup'
import { CortexError, pidAlive, readerEntries } from '../../src/memory/cortex'
import { removeDeadLocks } from '../../src/memory/housekeeping'
import { brainBackupsDir, brainDbFile, brainHoldFile, cortexChildFile } from '../../src/memory/layout'
import { removeProject } from '../../src/memory/project-remove'
import { getStored, listAll, personRef, projectRef } from '../../src/memory/store'
import { agentCtx, makeRepo, withBrain } from './helpers'

async function cli(argv: string[], stdin = ''): Promise<{ code: number, out: string, err: string }> {
  let out = ''
  let err = ''
  const code = await main(argv, {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    stdin: { isTTY: stdin === '', text: async () => stdin },
  })
  return { code, out, err }
}

const ids = async (ref: Parameters<typeof listAll>[0]) => (await listAll(ref)).map(i => i.id).sort()
const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts')

function sleeper(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env } })
}

function readLines(stream: ReadableStream<Uint8Array>): { next(): Promise<string> } {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  return {
    async next(): Promise<string> {
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); return line }
        const { value, done } = await reader.read()
        if (done) throw new Error(`the stream ended before a line: ${buf}`)
        buf += decoder.decode(value, { stream: true })
      }
    },
  }
}

async function parentOf(root: string, name: string): Promise<{ parent: ReturnType<typeof Bun.spawn>, child: number }> {
  let cmd = ['sleep', '30']
  if (name !== 'sleep') {
    const link = join(mkdtempSync(join(root, 'proc-')), name)
    symlinkSync(process.execPath, link)
    cmd = [link, '-e', 'setTimeout(() => {}, 30000)']
  }
  const parent = Bun.spawn(['sh', '-c', '"$@" & echo $!; wait', 'sh', ...cmd], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env } })
  const child = Number((await readLines(parent.stdout).next()).trim())
  const ready = Date.now() + 3000
  while (!pidAlive(child) && Date.now() < ready) await Bun.sleep(20)
  return { parent, child }
}

describe('buracle mem backup and restore', () => {
  test('a backup is one copy of the brain file with the buckets it holds; --all puts the whole file back and keeps what it replaced', async () => {
    await withBrain(async ({ repo }) => {
      const a = await write(agentCtx(repo), { type: 'decision', title: 'Backups live inside the brain folder', summary: 'kept by uninstall', body: '' })
      await write(agentCtx(repo), { type: 'preference', title: 'Short replies always', summary: 'brevity', body: '' })
      const r = await backupBrains({ all: true }, { nowMs: Date.parse('2026-10-17T10:00:00Z') })
      expect(r.manifest?.id).toBe('20261017-100000')
      expect(r.manifest).toMatchObject({ v: 2, trigger: 'manual', file: { name: 'brain.db' }, buckets: { person: 1, projects: { demo: 1 } } })
      expect(r.manifest && backupBuckets(r.manifest)).toEqual(['person', 'demo'])
      const file = join(brainBackupsDir(), '20261017-100000', 'brain.db')
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(listBackups().map(m => m.id)).toEqual(['20261017-100000'])

      const later = await write(agentCtx(repo), { type: 'gotcha', title: 'A gotcha written after the backup', summary: 'later', body: '' })
      await update(agentCtx(repo), { id: a.id, patch: { status: 'deprecated' } })
      await write(agentCtx(repo), { type: 'preference', title: 'Tables for comparisons', summary: 'format', body: '' })
      const restored = await restoreBackup('20261017-100000', { all: true }, { nowMs: Date.parse('2026-10-17T11:00:00Z') })
      expect(restored.restored).toEqual([expect.objectContaining({ all: true })])
      expect(await ids(projectRef('demo'))).toEqual([a.id])
      expect((await getStored(projectRef('demo'), a.id))?.item.status).toBe('active')
      expect((await listAll(personRef())).length).toBe(1)
      expect(restored.safety).toBe('20261017-110000')
      const back = await restoreBackup(restored.safety as string, { all: true }, { nowMs: Date.parse('2026-10-17T12:00:00Z') })
      expect(back.restored).toHaveLength(1)
      expect(await ids(projectRef('demo'))).toEqual([a.id, later.id].sort())
      expect((await listAll(personRef())).length).toBe(2)
      expect((await search(agentCtx(repo), { query: 'gotcha written after' })).rows.map(x => x.id)).toEqual([later.id])
      expect(((await restoreBackup('nope', { all: true }).catch(e => e)) as Error).message).toContain('not a backup id')
    })
  })

  test('the session-end finalizer keeps a daily copy: one when none is newer than a day, none within the day, another after it', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'decision', title: 'Daily copies come from the session end', summary: 'no timer', body: '' })
      const t0 = Date.parse('2026-10-17T10:00:00Z')
      const first = await maybeDailyBackup(t0)
      expect(first).toMatchObject({ trigger: 'daily', buckets: { projects: { demo: 1 } } })
      expect(await maybeDailyBackup(t0 + 23 * 3600_000)).toBeUndefined()
      const manual = await backupBrains({ all: true }, { nowMs: t0 + 25 * 3600_000 })
      expect(await maybeDailyBackup(t0 + 26 * 3600_000)).toBeUndefined()
      const next = await maybeDailyBackup(t0 + 50 * 3600_000)
      expect(next?.trigger).toBe('daily')
      expect(listBackups().map(m => m.id)).toEqual([next, manual.manifest, first].map(m => m?.id as string))
    })
  })

  test('restoring one bucket replaces that bucket only: the other projects and the person keep what they have now', async () => {
    await withBrain(async ({ repo, root }) => {
      const other = makeRepo(join(root, 'other'), 'git@github.com:me/other.git')
      const d1 = await write(agentCtx(repo), { type: 'decision', title: 'Demo decides on queues', summary: 'queues', body: '' })
      const o1 = await write(agentCtx(other), { type: 'decision', title: 'Other decides on cron', summary: 'cron', body: '' })
      await write(agentCtx(repo), { type: 'preference', title: 'Short replies always', summary: 'brevity', body: '' })
      const id = (await backupBrains({ all: true }, { nowMs: Date.parse('2026-10-17T10:00:00Z') })).manifest?.id as string

      // After the backup: demo gets a new memory and loses its decision's activity; other and the person change too.
      const d2 = await write(agentCtx(repo), { type: 'gotcha', title: 'Demo gotcha written later', summary: 'later', body: '' })
      await update(agentCtx(repo), { id: d1.id, patch: { status: 'deprecated' } })
      const o2 = await write(agentCtx(other), { type: 'gotcha', title: 'Other gotcha written later', summary: 'later', body: '' })
      const p2 = await write(agentCtx(repo), { type: 'preference', title: 'Tables for comparisons', summary: 'format', body: '' })

      const r = await restoreBackup(id, { project: 'demo' }, { nowMs: Date.parse('2026-10-17T11:00:00Z') })
      expect(r.restored).toEqual([{ layer: 'project', project: 'demo', memories: 1 }])
      expect(r.safety).toBeDefined()
      expect(await ids(projectRef('demo'))).toEqual([d1.id])
      expect((await getStored(projectRef('demo'), d1.id))?.item.status).toBe('active')
      expect(await ids(projectRef('other'))).toEqual([o1.id, o2.id].sort())
      expect((await ids(personRef())).includes(p2.id)).toBe(true)
      expect((await getStored(projectRef('demo'), d2.id))).toBeUndefined()

      // The safety backup holds the brain as it was, so the restore itself can be undone bucket by bucket.
      await restoreBackup(r.safety as string, { project: 'demo' })
      expect(await ids(projectRef('demo'))).toEqual([d1.id, d2.id].sort())
      const person = await restoreBackup(id, { person: true })
      expect(person.restored).toEqual([{ layer: 'person', memories: 1 }])
      expect(await ids(personRef())).toHaveLength(1)
      expect(await ids(projectRef('other'))).toEqual([o1.id, o2.id].sort())
      const none = await restoreBackup(id, { project: 'nowhere' }).catch(e => e)
      expect((none as Error).message).toContain('holds no copy of the project nowhere')
    })
  })

  test('a backup folder in the format of Buracle Stack 0.5 (one copy per layer) is not a backup any more: not listed, not restored', async () => {
    await withBrain(async () => {
      const dir = join(brainBackupsDir(), '20261001-090000')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'backup.json'), JSON.stringify({
        v: 1, id: '20261001-090000', at: '2026-10-01T09:00:00.000Z', trigger: 'manual',
        brains: [{ layer: 'person', file: 'person.db', bytes: 1, method: 'copy' }],
      }))
      expect(listBackups()).toEqual([])
      const e = await restoreBackup('20261001-090000', { all: true }).catch(x => x)
      expect((e as Error).message).toContain('there is no backup 20261001-090000')
      expect(existsSync(join(dir, 'backup.json'))).toBe(true)
    })
  })

  test('a removed project leaves a backup that brings its bucket back, and nothing else is removed', async () => {
    await withBrain(async ({ repo, root }) => {
      const gone = makeRepo(join(root, 'gone'), 'git@github.com:me/gone.git')
      const keep = await write(agentCtx(repo), { type: 'decision', title: 'The demo project stays', summary: 'stays', body: '' })
      const g = await write(agentCtx(gone), { type: 'gotcha', title: 'The client project is removed', summary: 'client', body: '' })
      await write(agentCtx(repo), { type: 'preference', title: 'Short replies always', summary: 'brevity', body: '' })
      const r = await removeProject('gone')
      expect(r).toMatchObject({ slug: 'gone', brain: true, memories: 1, total: 1 })
      expect(r.backup).toBeDefined()
      expect(listBackups().find(m => m.id === r.backup)).toMatchObject({ trigger: 'pre-remove' })
      expect(await listAll(projectRef('gone'))).toEqual([])
      expect(await ids(projectRef('demo'))).toEqual([keep.id])
      expect((await listAll(personRef())).length).toBe(1)
      await restoreBackup(r.backup as string, { project: 'gone' })
      expect(await ids(projectRef('gone'))).toEqual([g.id])
      expect(await ids(projectRef('demo'))).toEqual([keep.id])
    })
  })

  test('a restore of the whole file stops the CortexDB readers other processes registered for the brain, and no other process', async () => {
    await withBrain(async ({ repo, root }) => {
      await write(agentCtx(repo), { type: 'decision', title: 'Readers are stopped before a restore', summary: 'no foreign WAL', body: '' })
      const r = await backupBrains({ all: true })
      const db = brainDbFile()
      const reader = await parentOf(root, 'cortexdb-mcp')
      const notReader = await parentOf(root, 'sleep')
      const stranger = await parentOf(root, 'cortexdb-mcp')
      const unrelated = sleeper()
      const register = (pid: number, child: number) => {
        const file = cortexChildFile(db, pid)
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, JSON.stringify({ v: 1, pid, child, db, at: new Date().toISOString() }))
        return file
      }
      const entries = {
        reader: register(reader.parent.pid, reader.child),
        notReader: register(notReader.parent.pid, notReader.child),
        reused: register(unrelated.pid, stranger.child),
        dead: register(999_999, 999_998),
      }
      try {
        const out = await restoreBackup(r.manifest?.id as string, { all: true }, { waitMs: 3000 })
        expect(out.stopped).toBe(1)
        await reader.parent.exited
        expect(pidAlive(reader.child)).toBe(false)
        expect(pidAlive(notReader.child)).toBe(true)
        expect(pidAlive(stranger.child)).toBe(true)
        expect(pidAlive(unrelated.pid)).toBe(true)
        for (const file of Object.values(entries)) expect(existsSync(file)).toBe(false)
      } finally {
        for (const p of [reader, notReader, stranger]) { try { process.kill(p.child) } catch {  } p.parent.kill() }
        unrelated.kill()
      }
    })
  })

  test('the session-end housekeeping removes reader entries whose process is gone', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'decision', title: 'Dead reader entries are swept', summary: 'housekeeping', body: '' })
      const db = brainDbFile()
      const live = sleeper()
      const dead = cortexChildFile(db, 999_999)
      const alive = cortexChildFile(db, live.pid)
      mkdirSync(join(dead, '..'), { recursive: true })
      writeFileSync(dead, JSON.stringify({ v: 1, pid: 999_999, child: 999_998, db, at: new Date().toISOString() }))
      writeFileSync(alive, JSON.stringify({ v: 1, pid: live.pid, child: live.pid, db, at: new Date().toISOString() }))
      writeFileSync(join(dead, '..', `.${basename(dead)}.buracle-999999-0a1b2c3d.tmp`), '{')
      try {
        expect(removeDeadLocks()).toBe(2)
        expect(existsSync(dead)).toBe(false)
        expect(existsSync(alive)).toBe(true)
      } finally {
        live.kill()
      }
    })
  })

  test('a memory server stopped by a signal closes its reader and leaves no reader entry behind', async () => {
    await withBrain(async ({ repo }) => {
      const proc = Bun.spawn([process.execPath, MAIN, 'mcp', 'memory'], { cwd: repo, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
      const lines = readLines(proc.stdout)
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_write', arguments: { type: 'gotcha', title: 'Codex kills its MCP children on drop', summary: 'SIGTERM', body: '' } } }) + '\n')
      await proc.stdin.flush()
      expect(JSON.parse(await lines.next()).id).toBe(1)
      const mine = readerEntries(brainDbFile()).filter(e => e.entry.pid === proc.pid)
      expect(mine).toHaveLength(1)
      proc.kill('SIGTERM')
      expect(await proc.exited).toBe(0)
      expect(existsSync(mine[0]?.file as string)).toBe(false)
      const late = Date.now() + 3000
      while (pidAlive(mine[0]?.entry.child as number) && Date.now() < late) await Bun.sleep(50)
      expect(pidAlive(mine[0]?.entry.child as number)).toBe(false)
    })
  }, 30_000)

  test('while another process restores the brain, its readers refuse to start and the tools report a conflict', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'decision', title: 'The restore hold blocks new readers', summary: 'hold', body: '' })
      const holder = sleeper()
      const hold = brainHoldFile(brainDbFile())
      mkdirSync(join(hold, '..'), { recursive: true })
      writeFileSync(hold, JSON.stringify({ pid: holder.pid, at: new Date().toISOString(), token: 'x' }))
      try {
        const e = await getStored(projectRef('demo'), 'decision-the-restore-hold-blocks-new-readers').then(() => undefined, (x: unknown) => x)
        expect(e).toBeInstanceOf(CortexError)
        expect((e as CortexError).code).toBe('busy')
        const s = await search(agentCtx(repo), { query: 'restore hold', layer: 'project' }).catch(x => x)
        expect((s as MemoryError).code).toBe('conflict')
      } finally {
        holder.kill()
        await holder.exited
      }
      expect((await search(agentCtx(repo), { query: 'restore hold' })).rows).toHaveLength(1)
    })
  })

  test('a whole-file restore that cannot take the hold says what it did and where the brain as it was is', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'decision', title: 'A failed restore says so', summary: 'partial', body: '' })
      const id = (await backupBrains({ all: true }, { nowMs: Date.parse('2026-10-17T10:00:00Z') })).manifest?.id as string
      const holder = sleeper()
      const hold = brainHoldFile(brainDbFile())
      mkdirSync(join(hold, '..'), { recursive: true })
      writeFileSync(hold, JSON.stringify({ pid: holder.pid, at: new Date().toISOString(), token: 'x' }))
      try {
        const r = await cli(['mem', 'restore', id, '--all'])
        expect(r.code).toBe(1)
        const safety = listBackups().find(m => m.trigger === 'pre-restore')
        expect(r.err).toContain(`the brain file was not restored: another restore holds the brain; nothing was restored; the brain file as it was before this restore is in backup ${safety?.id} (buracle mem restore ${safety?.id} --all puts it back)`)
      } finally {
        holder.kill()
        await holder.exited
      }
    })
  })

  test('pruning keeps the newest copies; the one just taken is never pruned', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'decision', title: 'Retention counts copies', summary: 'per backup', body: '' })
      const at = (h: number) => Date.parse('2026-01-01T00:00:00Z') + h * 3600_000
      const first = await backupBrains({ all: true }, { nowMs: at(1) })
      const one = await backupBrains({ all: true }, { nowMs: at(26), keep: 2 })
      expect(one.pruned).toEqual([])
      const two = await backupBrains({ all: true }, { nowMs: at(27), keep: 2 })
      expect(two.pruned).toEqual([first.manifest?.id as string])
      expect(listBackups().map(m => m.id)).toEqual([two.manifest?.id as string, one.manifest?.id as string])
      const now = await cli(['mem', 'backup', '--cwd', repo, '--keep', '1', '--json'])
      expect(now.code).toBe(0)
      const r = JSON.parse(now.out) as { manifest: { id: string }, pruned: string[] }
      expect(r.pruned.sort()).toEqual([one.manifest?.id as string, two.manifest?.id as string].sort())
      expect(listBackups().map(m => m.id)).toEqual([r.manifest.id])
    })
  })

  test('the CLI backs up, lists and refuses a restore that does not say what it replaces', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'decision', title: 'The CLI twin of the backup', summary: 'cli', body: '' })
      // A backup is the whole file: a bucket flag is refused (it would suggest a partial copy).
      for (const flag of [['--project', 'demo'], ['--person']]) {
        const refused = await cli(['mem', 'backup', '--cwd', repo, ...flag])
        expect(refused.code).toBe(1)
        expect(refused.err).toContain('a backup holds the whole brain file')
      }
      expect(listBackups()).toEqual([])
      const b = await cli(['mem', 'backup', '--cwd', repo, '--json'])
      expect(b.code).toBe(0)
      const id = (JSON.parse(b.out) as { manifest: { id: string } }).manifest.id
      expect((await cli(['mem', 'backup', '--list'])).out).toContain(`${id}  `)
      const bare = await cli(['mem', 'restore', id])
      expect(bare.code).toBe(1)
      expect(bare.err).toContain('name what to restore')
      expect((await cli(['mem', 'restore', id, '--person'])).err).toContain('holds no copy of the person brain')
      const ok = await cli(['mem', 'restore', id, '--project', 'demo'])
      expect(ok.code).toBe(0)
      expect(ok.out).toContain(`Restored from ${id}: project demo (1 memories)`)
    })
  }, 60_000)
})
