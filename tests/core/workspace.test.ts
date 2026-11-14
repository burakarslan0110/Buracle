import { describe, expect, test } from 'bun:test'
import { HARNESSES } from '../../src/core/events'
import {
  describeIndexState, indexExclusion, indexHealth, indexRetryDelayMs, indexState, indexToolDue, isCorruptIndexError, isPathWithin, pathKey,
  workspaceContext, workspaceNotice, type IndexExclusionContext, type ProjectIndex, type WorkspaceInfo,
} from '../../src/core/workspace'

const MIN = 60_000
const ctx = (o: Partial<IndexExclusionContext> = {}): IndexExclusionContext => ({
  home: '/Users/burak',
  buracleHome: '/Users/burak/.buracle',
  vault: '/Users/burak/Documents/Buracle',
  exclude: [],
  caseInsensitive: true,
  ...o,
})

describe('paths', () => {
  test('pathKey normalizes separators, dots and trailing slashes; lower-cases only when asked', () => {
    expect(pathKey('/a/b/../c/./d/', false)).toBe('/a/c/d')
    expect(pathKey('C:\\Users\\Burak\\', false)).toBe('C:/Users/Burak')
    expect(pathKey('C:\\', false)).toBe('C:/')
    expect(pathKey('/Users/Burak/Proj', true)).toBe('/users/burak/proj')
  })

  test('isPathWithin compares whole segments, case-insensitively where the file system is', () => {
    expect(isPathWithin('/Users/burak/proj', '/Users/burak', false)).toBe(true)
    expect(isPathWithin('/Users/burakx', '/Users/burak', false)).toBe(false)
    expect(isPathWithin('/users/BURAK/proj', '/Users/burak', true)).toBe(true)
    expect(isPathWithin('/users/BURAK/proj', '/Users/burak', false)).toBe(false)
    expect(isPathWithin('C:\\Users\\Burak', 'c:\\users', true)).toBe(true)
    expect(isPathWithin('/anything', '/', false)).toBe(true)
  })
})

describe('indexExclusion: folders Buracle never indexes', () => {
  test('the filesystem root, the home folder and its parents, the vault and Buracle state', () => {
    expect(indexExclusion('/', ctx())).toBe('the filesystem root')
    expect(indexExclusion('D:\\', ctx())).toBe('the filesystem root')
    expect(indexExclusion('/Users/burak', ctx())).toBe('your home folder')
    expect(indexExclusion('/Users', ctx())).toBe('a parent of your home folder')
    expect(indexExclusion('/Users/burak/Documents/Buracle', ctx())).toBe('inside the memory vault')
    expect(indexExclusion('/Users/burak/Documents/Buracle/projects/x', ctx())).toBe('inside the memory vault')
    expect(indexExclusion('/Users/burak/.buracle/toolchain', ctx())).toBe("inside Buracle's state folder")
    expect(indexExclusion('/Users/burak/code/app', ctx())).toBeUndefined()
    expect(indexExclusion('/Users/burak/Documents/BuracleNotes', ctx())).toBeUndefined()
  })

  test('home spelled in another case is still home on case-insensitive systems (macOS, Windows)', () => {
    expect(indexExclusion('/users/BURAK', ctx())).toBe('your home folder')
    expect(indexExclusion('/users/BURAK', ctx({ caseInsensitive: false }))).toBeUndefined()
    const win = ctx({ home: 'C:\\Users\\Burak', buracleHome: 'C:\\Users\\Burak\\.buracle', vault: 'C:\\Users\\Burak\\Documents\\Buracle' })
    expect(indexExclusion('c:\\users\\burak', win)).toBe('your home folder')
    expect(indexExclusion('C:/USERS/burak/Documents/buracle/x', win)).toBe('inside the memory vault')
    expect(indexExclusion('c:\\users\\burak\\code\\app', win)).toBeUndefined()
  })

  test('index.exclude: absolute and ~ paths cover the folder and everything inside it', () => {
    const c = ctx({ exclude: ['~/Desktop/Buracle Plugin/Vendor Kit', '/opt/vendor/'] })
    expect(indexExclusion('/Users/burak/Desktop/Buracle Plugin/Vendor Kit', c)).toBe('excluded by index.exclude (~/Desktop/Buracle Plugin/Vendor Kit)')
    expect(indexExclusion('/Users/burak/Desktop/Buracle Plugin/Vendor Kit/src', c)).toBe('excluded by index.exclude (~/Desktop/Buracle Plugin/Vendor Kit)')
    expect(indexExclusion('/users/burak/desktop/buracle plugin/vendor kit', c)).toContain('excluded by index.exclude')
    expect(indexExclusion('/Users/burak/Desktop/Buracle Plugin/buracle', c)).toBeUndefined()
    expect(indexExclusion('/opt/vendor/lib', c)).toBe('excluded by index.exclude (/opt/vendor/)')
    expect(indexExclusion('/opt/vendor-two', c)).toBeUndefined()
  })

  test('index.exclude: globs, and bare names that match a folder of that name anywhere', () => {
    const c = ctx({ exclude: ['~/work/*-legacy', 'scratch', 'archive/**'] })
    expect(indexExclusion('/Users/burak/work/api-legacy', c)).toBe('excluded by index.exclude (~/work/*-legacy)')
    expect(indexExclusion('/Users/burak/work/api-legacy/src', c)).toBe('excluded by index.exclude (~/work/*-legacy)')
    expect(indexExclusion('/Users/burak/work/api', c)).toBeUndefined()
    expect(indexExclusion('/Users/burak/code/scratch', c)).toBe('excluded by index.exclude (scratch)')
    expect(indexExclusion('/Users/burak/code/scratch/deep', c)).toBe('excluded by index.exclude (scratch)')
    expect(indexExclusion('/Users/burak/code/scratchpad', c)).toBeUndefined()
    expect(indexExclusion('/Users/burak/archive/old', c)).toBe('excluded by index.exclude (archive/**)')
    expect(indexExclusion('/Users/burak/code/app', ctx({ exclude: ['', '   '] }))).toBeUndefined()
  })
})

describe('index states and the retry backoff', () => {
  test('a run is due when never run, after index.minIntervalMin when ok, after a growing wait when failed', () => {
    expect(indexToolDue(undefined, true, 10, 0)).toBe(true)
    expect(indexToolDue(undefined, false, 10, 0)).toBe(false)
    const ok = { at: 1_000_000, ok: true }
    expect(indexToolDue(ok, true, 10, ok.at + 9 * MIN)).toBe(false)
    expect(indexToolDue(ok, true, 10, ok.at + 10 * MIN)).toBe(true)
    expect(indexToolDue(ok, true, 10, ok.at - 1)).toBe(true)
    const failedOnce = { at: 1_000_000, ok: false, failures: 1 }
    expect(indexToolDue(failedOnce, true, 10, failedOnce.at + 1)).toBe(false)
    expect(indexToolDue(failedOnce, true, 10, failedOnce.at + 10 * MIN)).toBe(true)
    const failedThrice = { at: 1_000_000, ok: false, failures: 3 }
    expect(indexToolDue(failedThrice, true, 10, failedThrice.at + 59 * MIN)).toBe(false)
    expect(indexToolDue(failedThrice, true, 10, failedThrice.at + 60 * MIN)).toBe(true)
  })

  test('the retry wait: 5 m, 15 m, 1 h, 4 h, then a day; never sooner than index.minIntervalMin', () => {
    expect([1, 2, 3, 4, 5, 9].map(n => indexRetryDelayMs(n, 0) / MIN)).toEqual([5, 15, 60, 240, 1440, 1440])
    expect(indexRetryDelayMs(1, 10) / MIN).toBe(10)
    expect(indexRetryDelayMs(0, 0) / MIN).toBe(5)
  })

  test('indexState: off, building, ready, failed and none', () => {
    expect(indexState({ enabled: false, building: {} }, 10)).toEqual({ state: 'off' })
    expect(indexState({ enabled: true }, 10)).toEqual({ state: 'none' })
    expect(indexState({ enabled: true, building: { since: 5 } }, 10)).toEqual({ state: 'building', since: 5 })
    expect(indexState({ enabled: true, record: { at: 7, ok: true } }, 10)).toEqual({ state: 'ready', at: 7 })
    expect(indexState({ enabled: true, present: true }, 10)).toEqual({ state: 'ready' })
    expect(indexState({ enabled: true, record: { at: 7, ok: false, error: 'boom', failures: 2 } }, 10)).toEqual({ state: 'failed', at: 7, error: 'boom', retryAt: 7 + 15 * MIN })
  })

  test('a refresh over a usable index keeps it ready; a failed refresh of an existing index stays usable', () => {
    expect(indexState({ enabled: true, record: { at: 7, ok: true }, building: { since: 9 } }, 10)).toEqual({ state: 'ready', at: 7 })
    expect(indexState({ enabled: true, present: true, building: {} }, 10)).toEqual({ state: 'ready' })
    expect(indexState({ enabled: true, present: true, record: { at: 7, ok: false, error: 'sync failed' } }, 10)).toEqual({ state: 'ready', error: 'sync failed' })
    expect(indexState({ enabled: true, record: { at: 7, ok: false } }, 10)).toMatchObject({ state: 'failed', error: 'failed' })
  })

  test('indexHealth is the worse of the two; describeIndexState says it in words', () => {
    const pi = (codegraph: ProjectIndex['codegraph'], semble: ProjectIndex['semble']): ProjectIndex => ({ codegraph, semble })
    expect(indexHealth(pi({ state: 'ready' }, { state: 'ready' }))).toBe('ready')
    expect(indexHealth(pi({ state: 'building' }, { state: 'ready' }))).toBe('building')
    expect(indexHealth(pi({ state: 'none' }, { state: 'building' }))).toBe('none')
    expect(indexHealth(pi({ state: 'failed', at: 0, error: 'x', retryAt: 1 }, { state: 'none' }))).toBe('failed')
    expect(indexHealth(pi({ state: 'off' }, { state: 'ready' }))).toBe('ready')
    expect(indexHealth(pi({ state: 'off' }, { state: 'off' }))).toBe('off')
    const now = 10 * 3_600_000
    expect(describeIndexState({ state: 'ready', at: now - 5 * MIN }, now)).toBe('ready (refreshed 5m ago)')
    expect(describeIndexState({ state: 'ready', error: 'boom' }, now)).toBe('ready, but the last refresh failed: boom')
    expect(describeIndexState({ state: 'building', since: now - 2 * MIN }, now)).toBe('building (for 2m)')
    expect(describeIndexState({ state: 'failed', at: now, error: 'boom', retryAt: now + 15 * MIN }, now)).toBe('failed: boom (next try in 15m)')
    expect(describeIndexState({ state: 'failed', at: 0, error: 'boom', retryAt: 1 }, now)).toBe('failed: boom (retried at the next session start)')
    expect(describeIndexState({ state: 'none' }, now)).toBe('not built yet')
  })

  test('isCorruptIndexError knows the SQLite and codegraph texts of a damaged database, and nothing else', () => {
    for (const text of [
      'Error: database disk image is malformed',
      'SqliteError: file is not a database',
      'the database is corrupt',
      '/repo/.codegraph/codegraph.db is not a SQLite database, so it cannot be rebuilt in place.',
      'code: SQLITE_CORRUPT',
      'SQLITE_NOTADB: file is encrypted or is not a database',
    ]) expect(isCorruptIndexError(text)).toBe(true)
    for (const text of ['database is locked', 'SQLITE_BUSY', 'CodeGraph not initialized', 'exit 1', '']) expect(isCorruptIndexError(text)).toBe(false)
  })
})

const ready: ProjectIndex = { codegraph: { state: 'ready', at: 1 }, semble: { state: 'ready', at: 1 } }

describe('workspaceContext: what the agent is told at a session start', () => {
  test('a project: the root to pass, the index state, and that indexing is Buracle\'s job', () => {
    const text = workspaceContext({ cwd: '/w/app/src', root: '/w/app', children: [], index: ready }, 'claude')
    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('Project root: /w/app. Pass it as codegraph `projectPath` and semble `repo` (not a subfolder, a parent folder or your home folder).')
    expect(lines[1]).toContain('codegraph ready, semble ready')
    expect(lines[2]).toContain("Indexing is Buracle's job, not the user's decision")
    expect(lines[2]).toContain('`buracle index ensure --cwd <project>`')
    expect(lines[2]).toContain('never stop using codegraph for the session')
  })

  test('while codegraph builds, or before it was built, the agent keeps codegraph and knows what to do', () => {
    const building = workspaceContext({ cwd: '/w/app', root: '/w/app', children: [], index: { codegraph: { state: 'building' }, semble: { state: 'ready' } } }, 'codex')
    expect(building).toContain('codegraph building now, semble ready')
    expect(building).toContain('Until codegraph is ready, use semble and rg')
    const none = workspaceContext({ cwd: '/w/app', root: '/w/app', children: [], index: { codegraph: { state: 'none' }, semble: { state: 'none' } } }, 'omp')
    expect(none).toContain('codegraph not built yet')
    expect(none).toContain('Run `buracle index ensure --cwd /w/app` to build codegraph\'s index')
    const failed = workspaceContext({ cwd: '/w/app', root: '/w/app', children: [], index: { codegraph: { state: 'failed', at: 0, error: 'init timed out', retryAt: 1 }, semble: { state: 'ready' } } }, 'opencode')
    expect(failed).toContain('codegraph failed to build (init timed out)')
    expect(failed).toContain('buracle index ensure --cwd /w/app')
  })

  test('codegraph turned off: no codegraph guidance', () => {
    const text = workspaceContext({ cwd: '/w/app', root: '/w/app', children: [], index: { codegraph: { state: 'off' }, semble: { state: 'ready' } } }, 'claude')
    expect(text.split('\n')).toHaveLength(2)
    expect(text).toContain('codegraph off, semble ready')
    expect(text).not.toContain('index ensure')
  })

  test('a folder of projects: the child projects to choose from, never the folder itself', () => {
    const info: WorkspaceInfo = {
      cwd: '/w', children: ['/w/api', '/w/web'], index: { codegraph: { state: 'none' }, semble: { state: 'none' } },
      childIndex: { '/w/api': ready, '/w/web': { codegraph: { state: 'building' }, semble: { state: 'none' } } },
    }
    const lines = workspaceContext(info, 'claude').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('/w is not a project; it holds 2 projects: api, web. Pass the one you work in (/w/<name>) as codegraph `projectPath` and semble `repo`, never this folder or your home folder.')
    expect(lines[1]).toContain('api: codegraph ready, semble ready; web: codegraph building now, semble not built yet')
    expect(lines[2]).toContain("Indexing is Buracle's job")
    expect(workspaceContext({ ...info, children: ['/w/api'], childIndex: { '/w/api': ready } }, 'claude')).toContain('it holds one project: api. Pass it (/w/<name>)')
    const win = workspaceContext({ cwd: 'C:\\w', children: ['C:\\w\\api'], index: info.index, childIndex: { 'C:\\w\\api': ready } }, 'claude')
    expect(win).toContain('C:\\w is not a project; it holds one project: api. Pass it (C:\\w\\<name>)')
  })

  test('home, an excluded folder, or no project at all: never pass this folder', () => {
    const idle: ProjectIndex = { codegraph: { state: 'none' }, semble: { state: 'none' } }
    const home = workspaceContext({ cwd: '/Users/burak', children: [], excluded: 'your home folder', index: idle }, 'claude')
    expect(home.split('\n')[0]).toBe('/Users/burak is your home folder: Buracle does not index it. Pass the project folder you work in as codegraph `projectPath` and semble `repo`, never this folder.')
    const excluded = workspaceContext({ cwd: '/x/Vendor Kit', children: [], excluded: 'excluded by index.exclude (/x/Vendor Kit)', index: idle }, 'claude')
    expect(excluded).toContain('never this folder or anything inside it.')
    const plain = workspaceContext({ cwd: '/tmp/notes', children: [], index: idle }, 'claude')
    expect(plain.split('\n')[0]).toContain('/tmp/notes is not a project (no git repository or project manifest)')
    expect(plain).toContain('never a parent folder or your home folder')
  })

  test('the same words on every harness, at most 4 lines', () => {
    const infos: WorkspaceInfo[] = [
      { cwd: '/w/app', root: '/w/app', children: [], index: ready },
      { cwd: '/w', children: ['/w/a', '/w/b'], index: ready, childIndex: { '/w/a': ready, '/w/b': ready } },
      { cwd: '/', children: [], excluded: 'the filesystem root', index: ready },
    ]
    for (const info of infos) {
      const texts = HARNESSES.map(h => workspaceContext(info, h))
      expect(new Set(texts).size).toBe(1)
      expect(texts[0]?.split('\n').length).toBeLessThanOrEqual(4)
      expect(texts[0]).not.toMatch(/[^\x20-\x7E\n]/)
    }
  })
})

describe('workspaceNotice: the first prompt after the background build', () => {
  const at = (codegraph: ProjectIndex['codegraph']): WorkspaceInfo => ({ cwd: '/w/app', root: '/w/app', children: [], index: { codegraph, semble: { state: 'ready' } } })

  test('codegraph became ready, or its build failed', () => {
    expect(workspaceNotice(at({ state: 'building' }), at({ state: 'ready', at: 1 }))).toBe('The codegraph index of /w/app is ready now: call codegraph with `projectPath` /w/app.')
    expect(workspaceNotice(at({ state: 'none' }), at({ state: 'ready' }))).toContain('ready now')
    expect(workspaceNotice(at({ state: 'building' }), at({ state: 'failed', at: 1, error: 'boom', retryAt: 2 }))).toBe('Building the codegraph index of /w/app failed (boom); use semble and rg, or run `buracle index ensure --cwd /w/app` to retry.')
  })

  test('nothing to say when nothing changed or there was no earlier state', () => {
    expect(workspaceNotice(at({ state: 'ready' }), at({ state: 'ready' }))).toBeUndefined()
    expect(workspaceNotice(at({ state: 'building' }), at({ state: 'building' }))).toBeUndefined()
    expect(workspaceNotice(undefined, at({ state: 'ready' }))).toBeUndefined()
  })

  test('child projects of a folder of projects', () => {
    const kids = (a: ProjectIndex['codegraph'], b: ProjectIndex['codegraph']): WorkspaceInfo => ({
      cwd: '/w', children: ['/w/a', '/w/b'], index: { codegraph: { state: 'none' }, semble: { state: 'none' } },
      childIndex: { '/w/a': { codegraph: a, semble: { state: 'ready' } }, '/w/b': { codegraph: b, semble: { state: 'ready' } } },
    })
    expect(workspaceNotice(kids({ state: 'building' }, { state: 'building' }), kids({ state: 'ready' }, { state: 'ready' }))).toBe('The codegraph indexes of /w/a, /w/b are ready now: call codegraph with the project as `projectPath`.')
  })
})
