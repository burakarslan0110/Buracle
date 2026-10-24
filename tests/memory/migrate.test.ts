import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../../src/cli/router'
import type { MemItem } from '../../src/core/memory/brain'
import { fromCortex } from '../../src/core/memory/brain'
import * as paths from '../../src/engine/paths'
import { readToolchainState, updateToolchainState } from '../../src/engine/toolchain/state'
import { MemoryError, search } from '../../src/memory/api'
import { backupBrains } from '../../src/memory/backup'
import { contextText } from '../../src/memory/context'
import { CortexError } from '../../src/memory/cortex'
import { brainBackupsDir, brainDbFile, legacyBrainDir, legacyStateDir, locksDir, migrationFile, migrationLockFile } from '../../src/memory/layout'
import { tryLock } from '../../src/memory/lock'
import { MigrationError, dryRun, ensureMigrated, migrationInfo, purgeLegacy, rollback, runMigration } from '../../src/memory/migrate'
import { memoryStatusReport } from '../../src/memory/status-report'
import { forgetListCache, getStored, listAll, personRef, projectRef } from '../../src/memory/store'
import { withEnv } from '../helpers/sandbox'
import { agentCtx, installLegacyBrain, REAL_CORTEXDB, withBrain } from './helpers'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts')
const LEGACY = join(import.meta.dir, '..', 'fixtures', 'legacy-brain', 'brain')

async function cli(argv: string[]): Promise<{ code: number, out: string, err: string }> {
  let out = ''
  let err = ''
  const code = await main(argv, { stdout: { write: (s: string) => { out += s } }, stderr: { write: (s: string) => { err += s } }, stdin: { isTTY: true, text: async () => '' } })
  return { code, out, err }
}

// The whole brain as the rest of Buracle reads it, in a form two runs can be compared by.
async function snapshot(): Promise<Record<string, MemItem[]>> {
  forgetListCache()
  const by = (a: MemItem, b: MemItem) => a.id.localeCompare(b.id)
  return { person: (await listAll(personRef())).sort(by), demo: (await listAll(projectRef('demo'))).sort(by) }
}

// What the 0.5 files hold, read straight from the fixture the baseline code wrote.
function legacyItems(file: string, layer: 'person' | 'project'): MemItem[] {
  const db = JSON.parse(readFileSync(join(LEGACY, file), 'utf8')) as { records: Record<string, unknown> }
  return Object.values(db.records).map(r => fromCortex(r, layer)).filter((i): i is MemItem => i !== undefined)
}

describe.skipIf(REAL_CORTEXDB)('migrating Buracle 0.5 brain files into brain.db', () => {
  test('a clean run keeps every field, hides the superseded memory, moves the old files aside and backs them up first', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      const r = await runMigration({ nowMs: NOW })
      expect(r.ran).toBe(true)
      expect(r.files.map(f => [f.path, f.memories, f.written])).toEqual([['person.db', 3, 3], ['projects/demo.db', 5, 5], ['absorbed/old-checkout.db', 0, 0]])
      expect(existsSync(brainDbFile())).toBe(true)

      const got = await snapshot()
      // Every field of every 0.5 memory is there, plus the preferences the profile claims became.
      for (const [file, layer, bucket] of [['person.db', 'person', 'person'], ['projects/demo.db', 'project', 'demo']] as const) {
        for (const want of legacyItems(file, layer)) {
          const have = got[bucket]?.find(i => i.id === want.id)
          expect(have, want.id).toBeDefined()
          expect({ ...have, history: have?.history }).toEqual({ ...want })
        }
      }
      const postgres = got['demo']?.find(i => i.id === 'decision-orders-live-in-postgresql-16')
      expect(postgres).toMatchObject({ status: 'superseded', supersededBy: 'decision-orders-live-in-cockroachdb' })
      expect(got['demo']?.find(i => i.id === 'decision-orders-live-in-cockroachdb')?.recallCount).toBe(2)
      expect(got['demo']?.find(i => i.id === 'gotcha-the-legacy-importer-writes-local-timestamps')).toMatchObject({ pinned: true, review: 'ok' })
      // The superseded memory stays out of a search, as it did before.
      expect((await search(agentCtx(paths.home()), { query: 'orders storage', layer: 'person' })).rows).toEqual([])

      // Nothing was deleted: the 0.5 files wait in legacy-0.5, and verified copies were taken before anything changed.
      for (const f of ['person.db', 'projects/demo.db', 'absorbed/old-checkout.db']) {
        expect(existsSync(join(paths.brainDir(), ...f.split('/')))).toBe(false)
        expect(existsSync(join(legacyBrainDir(), ...f.split('/')))).toBe(true)
        expect(existsSync(join(brainBackupsDir(), r.backup as string, ...f.split('/')))).toBe(true)
      }
      expect(r.backup).toMatch(/^pre-migrate-\d{8}T\d{6}Z$/)
      // The state only 0.5's background jobs wrote is moved aside too.
      for (const n of ['sweep.json', 'upkeep', 'profile']) {
        expect(existsSync(join(paths.memoryStateDir(), n))).toBe(false)
        expect(existsSync(join(legacyStateDir(), n))).toBe(true)
      }
      const marker = JSON.parse(readFileSync(migrationFile(), 'utf8')) as { v: number, from: string, status: string, backup: string, files: Array<{ path: string, count: number, done: boolean }> }
      expect(marker).toMatchObject({ v: 1, from: '0.5', status: 'complete', backup: r.backup })
      expect(marker.files.map(f => [f.path, f.count, f.done])).toEqual([['person.db', 3, true], ['projects/demo.db', 5, true], ['absorbed/old-checkout.db', 1, true]])
    })
  })

  test('the embedding model folder and its toolchain record, which nothing uses any more, go with the migration', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      const model = join(paths.toolchainDir(), 'embed', 'some-model', 'model.onnx')
      mkdirSync(join(model, '..'), { recursive: true })
      writeFileSync(model, 'weights')
      updateToolchainState(s => { s.system['embed-model'] = { via: 'github', version: 'abc1234', path: model, installed_at: '2026-10-01T00:00:00Z' }; s.system['other-tool'] = { via: 'npm', installed_at: '2026-10-01T00:00:00Z' } }, '2026-10-01T00:00:00Z')
      const r = await runMigration({ nowMs: NOW })
      expect(r.cleaned).toEqual(expect.arrayContaining(['toolchain/embed', 'toolchain record embed-model']))
      expect(existsSync(join(paths.toolchainDir(), 'embed'))).toBe(false)
      expect(Object.keys(readToolchainState().system)).toEqual(['other-tool'])
      // The live state next to the old job state stays where it is.
      writeFileSync(join(paths.memoryStateDir(), 'runner-backoff.json'), '{}')
      expect((await runMigration({ nowMs: NOW })).ran).toBe(false)
      expect(existsSync(join(paths.memoryStateDir(), 'runner-backoff.json'))).toBe(true)
    })
  })

  test('the stated profile claims become explicit preference memories, once, without the dropped, observed or duplicate ones', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      const r = await runMigration({ nowMs: NOW })
      expect(r.profile).toEqual({ claims: 8, written: 3 })
      const person = (await listAll(personRef())).filter(i => i.sources.includes('migrated:profile-claims'))
      expect(person.map(i => i.title).sort()).toEqual(['Never add comments that restate the code', 'Reply in Turkish when the user writes Turkish'])
      for (const i of person) expect(i).toMatchObject({ kind: 'preference', origin: 'explicit', confidence: 1, review: 'ok', layer: 'person', importance: 4 })
      expect(person.find(i => i.title.startsWith('Never'))?.sources).toContain('signal:said:never-restate|not')
      expect(person.find(i => i.title.startsWith('Reply'))?.body).toBe('The user said: "lütfen Türkçe cevap ver"')
      // A claim that only one project's work showed is a preference of that project.
      expect((await listAll(projectRef('demo'))).find(i => i.title === 'In demo run bun test before every commit')).toMatchObject({ kind: 'preference', origin: 'explicit', layer: 'project' })
      const titles = (await listAll(personRef())).map(i => i.title)
      expect(titles.filter(t => t === 'Answers should be short')).toHaveLength(1)
      expect(titles).not.toContain('Always squash before pushing')
      expect(titles).not.toContain('codegraph')
      expect(titles).not.toContain('Probably prefers tabs')
    })
  })

  test('a second run changes nothing', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      await runMigration({ nowMs: NOW })
      const before = await snapshot()
      const marker = readFileSync(migrationFile(), 'utf8')
      const again = await runMigration({ nowMs: NOW + 60_000 })
      expect(again.ran).toBe(false)
      expect(await snapshot()).toEqual(before)
      expect(readFileSync(migrationFile(), 'utf8')).toBe(marker)
      expect(migrationInfo().state).toBe('complete')
    })
  })

  test('a run that stops after any number of writes and runs again ends exactly like a run that did not stop', async () => {
    let clean: Record<string, MemItem[]> | undefined
    await withBrain(async () => {
      installLegacyBrain()
      await runMigration({ nowMs: NOW })
      clean = await snapshot()
    })
    expect(clean?.['demo']).toHaveLength(6)
    for (const stopAfter of [0, 1, 3, 4, 7, 9]) {
      await withBrain(async () => {
        installLegacyBrain()
        const stopped = await withEnv({ BURACLE_MIGRATE_FAIL_AFTER: String(stopAfter) }, () => runMigration({ nowMs: NOW })).catch((e: unknown) => e)
        expect(stopped, `stop after ${stopAfter}`).toBeInstanceOf(MigrationError)
        // The 0.5 files are untouched and the marker says the run is unfinished.
        expect(existsSync(join(paths.brainDir(), 'person.db'))).toBe(true)
        expect(existsSync(join(paths.brainDir(), 'projects', 'demo.db'))).toBe(true)
        expect(JSON.parse(readFileSync(migrationFile(), 'utf8')).status).toBe('failed')
        // Nothing is served from the half-migrated brain meanwhile.
        const done = await runMigration({ nowMs: NOW })
        expect(done.ran).toBe(true)
        expect(await snapshot(), `stop after ${stopAfter}`).toEqual(clean as Record<string, MemItem[]>)
        expect(migrationInfo().state).toBe('complete')
      })
    }
  }, 60_000)

  test('a backup copy that does not match its file aborts the run before anything changed', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      const err = await runMigration({
        nowMs: NOW,
        hooks: { afterBackupCopy: (copy, source) => { if (source.path === 'projects/demo.db') writeFileSync(copy, '{"v":1,"seq":0,"records":{}}') } },
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MigrationError)
      expect((err as Error).message).toContain('the backup copy of projects/demo.db holds 0 rows, the file holds 5')
      expect((err as Error).message).toContain('nothing was changed')
      expect(existsSync(brainDbFile())).toBe(false)
      expect(existsSync(migrationFile())).toBe(false)
      expect(existsSync(legacyBrainDir())).toBe(false)
      expect(existsSync(join(paths.brainDir(), 'person.db'))).toBe(true)
      expect(existsSync(join(paths.brainDir(), 'projects', 'demo.db'))).toBe(true)
      expect(existsSync(brainBackupsDir()) ? readdirSync(brainBackupsDir()) : []).toEqual([])
      expect(existsSync(join(paths.memoryStateDir(), 'profile', 'claims.json'))).toBe(true)
    })
  })

  test('a file that cannot be read stops the run with the old files in place, never an empty brain', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      await withEnv({ FAKE_CORTEXDB_FAIL: 'memory_list_all' }, async () => {
        const err = await runMigration({ nowMs: NOW }).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(MigrationError)
        expect((err as Error).message).toContain('nothing was changed')
      })
      expect(existsSync(brainDbFile())).toBe(false)
      expect(existsSync(join(paths.brainDir(), 'person.db'))).toBe(true)
    })
  })

  test('rollback puts the 0.5 files and state back, keeps the migrated brain aside, and the next read migrates again', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      await runMigration({ nowMs: NOW })
      const migrated = await snapshot()
      const r = await rollback()
      expect(r.restored.sort()).toEqual(['absorbed/old-checkout.db', 'person.db', 'projects/demo.db'])
      expect(r.keptBrain).toBe(`${brainDbFile()}.rolled-back`)
      expect(existsSync(brainDbFile())).toBe(false)
      expect(existsSync(`${brainDbFile()}.rolled-back`)).toBe(true)
      expect(existsSync(migrationFile())).toBe(false)
      expect(existsSync(join(paths.memoryStateDir(), 'profile', 'claims.json'))).toBe(true)
      expect(existsSync(legacyBrainDir())).toBe(false)
      // The files are the ones that were there: the fixture's bytes.
      expect(readFileSync(join(paths.brainDir(), 'person.db'), 'utf8')).toBe(readFileSync(join(LEGACY, 'person.db'), 'utf8'))
      // The new Buracle migrates them again at its next read, to the same brain.
      expect((await listAll(projectRef('demo'))).length).toBe(6)
      expect((await snapshot())['person']?.map(i => i.id)).toEqual(migrated['person']?.map(i => i.id))
    })
  })

  test('rollback --force deletes the migrated brain instead of keeping it', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      await runMigration({ nowMs: NOW })
      const r = await rollback({ force: true })
      expect(r.removedBrain).toBe(true)
      expect(existsSync(brainDbFile())).toBe(false)
      expect(existsSync(`${brainDbFile()}.rolled-back`)).toBe(false)
    })
  })

  test('purge-legacy deletes the moved-aside files and the copies only after a complete migration', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      const refused = await purgeLegacy().catch((e: unknown) => e)
      expect(refused).toBeInstanceOf(MigrationError)
      expect(existsSync(join(paths.brainDir(), 'person.db'))).toBe(true)
      const r = await runMigration({ nowMs: NOW })
      const purged = await purgeLegacy()
      expect(purged.removed).toHaveLength(3)
      expect(existsSync(legacyBrainDir())).toBe(false)
      expect(existsSync(join(legacyStateDir()))).toBe(false)
      expect(existsSync(join(brainBackupsDir(), r.backup as string))).toBe(false)
      expect((await listAll(projectRef('demo'))).length).toBe(6)
    })
  })

  test('a dry run reads the 0.5 files and writes nothing', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      const d = await dryRun()
      expect(d.files.map(f => [f.path, f.memories, f.wouldWrite])).toEqual([['person.db', 3, 3], ['projects/demo.db', 5, 5], ['absorbed/old-checkout.db', 0, 0]])
      expect(d.claims).toBe(8)
      expect(existsSync(brainDbFile())).toBe(false)
      expect(existsSync(migrationFile())).toBe(false)
      expect(existsSync(join(paths.brainDir(), 'person.db'))).toBe(true)
      const viaCli = await cli(['mem', 'migrate', '--dry-run', '--json'])
      expect(viaCli.code).toBe(0)
      expect(existsSync(brainDbFile())).toBe(false)
    })
  })
})

describe.skipIf(REAL_CORTEXDB)('memory calls while the 0.5 files wait', () => {
  test('the first memory call migrates by itself, so a brain that only exists as 0.5 files is never reported as empty', async () => {
    await withBrain(async ({ repo }) => {
      installLegacyBrain()
      expect(existsSync(brainDbFile())).toBe(false)
      const rows = (await search(agentCtx(repo), { query: 'cockroachdb' })).rows
      expect(rows.map(r => r.id)).toEqual(['decision-orders-live-in-cockroachdb'])
      expect(migrationInfo().state).toBe('complete')
      expect((await getStored(personRef(), 'preference-answers-should-be-short'))?.item.title).toBe('Answers should be short')
    })
  })

  test('while another process migrates, a call waits a few seconds and then fails as migrating; it never answers from half-migrated data', async () => {
    await withBrain(async ({ repo }) => {
      installLegacyBrain()
      const holder = tryLock(migrationLockFile(), 60_000)
      expect(holder).toBeDefined()
      try {
        await withEnv({ BURACLE_MIGRATE_WAIT_MS: '150' }, async () => {
          const e = await listAll(projectRef('demo')).then(() => undefined, (x: unknown) => x)
          expect(e).toBeInstanceOf(CortexError)
          expect((e as CortexError).code).toBe('migrating')
          const s = await search(agentCtx(repo), { query: 'orders' }).then(() => undefined, (x: unknown) => x)
          expect(s).toBeInstanceOf(MemoryError)
          expect((s as MemoryError).code).toBe('migrating')
          expect((s as MemoryError).message).toContain('being migrated')
          // The session-start text says so instead of showing no memory, and the status is unreadable, not empty.
          expect(await contextText({ cwd: repo })).toContain('being migrated')
          const status = await memoryStatusReport(agentCtx(repo))
          expect(status.status.health).toBe('error')
          expect(status.status.reasons).toContain('brain_unreadable')
        })
      } finally {
        holder?.()
      }
      expect(existsSync(brainDbFile())).toBe(false)
      expect((await listAll(projectRef('demo'))).length).toBe(6)
    })
  })

  test('two processes started together migrate once: one does the work, the other waits for it and finds nothing left', async () => {
    await withBrain(async ({ repo }) => {
      installLegacyBrain()
      const spawn = () => Bun.spawn([process.execPath, MAIN, 'mem', 'migrate', '--json'], { cwd: repo, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
      const procs = [spawn(), spawn()]
      const results = await Promise.all(procs.map(async p => ({ out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(), code: await p.exited })))
      expect(results.map(r => r.code)).toEqual([0, 0])
      const ran = results.map(r => (JSON.parse(r.out) as { ran: boolean }).ran)
      expect(ran.filter(Boolean)).toHaveLength(1)
      expect(readdirSync(brainBackupsDir()).filter(n => n.startsWith('pre-migrate-'))).toHaveLength(1)
      expect((await listAll(projectRef('demo'))).length).toBe(6)
    })
  }, 60_000)

  test('a lock left by a killed migration is broken, and the run resumes', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      mkdirSync(locksDir(), { recursive: true })
      writeFileSync(migrationLockFile(), JSON.stringify({ pid: 999_999, at: new Date().toISOString(), token: 'x' }))
      await ensureMigrated({ waitMs: 200 })
      expect(migrationInfo().state).toBe('complete')
      expect((await listAll(personRef())).length).toBeGreaterThan(3)
    })
  })

  test('two calls of one process share one migration', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      const [a, b] = await Promise.all([listAll(projectRef('demo')), listAll(personRef())])
      expect(a).toHaveLength(6)
      expect(b.length).toBeGreaterThan(3)
      expect(readdirSync(join(brainBackupsDir()))).toHaveLength(1)
    })
  })

  test('a backup asked for while only the 0.5 files exist migrates first instead of reporting that there is nothing to back up', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      const r = await backupBrains({ all: true })
      expect(r.manifest?.buckets).toEqual({ person: 5, projects: { demo: 6 } })
      expect(migrationInfo().state).toBe('complete')
      // And when the migration cannot run, the backup says why instead of "no brain file yet".
      rmSync(brainDbFile())
      installLegacyBrain()
      const holder = tryLock(migrationLockFile(), 60_000)
      try {
        await withEnv({ BURACLE_MIGRATE_WAIT_MS: '50' }, async () => {
          const e = await backupBrains({ all: true }).catch((x: unknown) => x)
          expect((e as Error).message).toContain('not migrated yet')
        })
      } finally {
        holder?.()
      }
    })
  })

  test('without CortexDB the 0.5 files are not read as empty either', async () => {
    await withBrain(async ({ root }) => {
      installLegacyBrain()
      await withEnv({ BURACLE_CORTEXDB_BIN: join(root, 'missing') }, async () => {
        const e = await listAll(projectRef('demo')).then(() => undefined, (x: unknown) => x)
        expect(e).toBeInstanceOf(CortexError)
        expect((e as CortexError).code).toBe('not_installed')
      })
    })
  })
})

describe.skipIf(REAL_CORTEXDB)('buracle mem migrate', () => {
  test('migrates, reports, and a second run says there is nothing to do', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      const first = await cli(['mem', 'migrate'])
      expect(first.code).toBe(0)
      expect(first.out).toContain('person.db -> person: 3 memories, 3 written')
      expect(first.out).toContain('projects/demo.db -> project:demo: 5 memories, 5 written')
      expect(first.out).toContain('profile claims: 3 of 8')
      const status = await cli(['mem', 'migrate', '--status', '--json'])
      const s = JSON.parse(status.out) as { state: string, legacy: string[], brain: { person: number, projects: Record<string, number> } }
      expect(s.state).toBe('complete')
      expect(s.legacy).toEqual([])
      expect(s.brain.projects['demo']).toBe(6)
      const second = await cli(['mem', 'migrate'])
      expect(second.out).toContain('Nothing to migrate')
      expect((await cli(['mem', 'migrate', '--rollback', '--status'])).err).toContain('pass one of')
      expect((await cli(['mem', 'migrate', '--force'])).err).toContain('--force goes with --rollback')
    })
  })

  test('--rollback and --purge-legacy are explicit', async () => {
    await withBrain(async () => {
      installLegacyBrain()
      await cli(['mem', 'migrate'])
      const back = await cli(['mem', 'migrate', '--rollback'])
      expect(back.code).toBe(0)
      expect(back.out).toContain('brain.db.rolled-back')
      expect(existsSync(join(paths.brainDir(), 'person.db'))).toBe(true)
      await cli(['mem', 'migrate'])
      const purge = await cli(['mem', 'migrate', '--purge-legacy'])
      expect(purge.code).toBe(0)
      expect(existsSync(legacyBrainDir())).toBe(false)
    })
  })

  test('a fresh install with no 0.5 files has nothing to migrate and creates no brain', async () => {
    await withBrain(async () => {
      const r = await cli(['mem', 'migrate'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('Nothing to migrate')
      expect(existsSync(brainDbFile())).toBe(false)
      expect(existsSync(migrationFile())).toBe(false)
    })
  })
})
