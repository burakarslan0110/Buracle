import type { CommandIO } from '../router'
import { loadConfigSync } from '../../engine/config'
import { parseFlags } from '../../engine/update/args'
import { writeJson } from '../../engine/update/output'

const TRAPPED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

export const name = 'index'
export const summary = 'Build, refresh or show the codegraph and semble indexes of a project'
export const usage = `Usage: buracle index [status] [--cwd <dir>] [--json]
       buracle index ensure [--cwd <dir>] [--if-due] [--quiet] [--json]
       buracle index rebuild [--cwd <dir>] [--force] [--json]

status   the state of the project's code indexes (ready, building, failed, not built yet), when
         Buracle last built or refreshed them, and the last error
ensure   build what is missing (codegraph init), refresh what exists (codegraph sync, which a
         running codegraph server already does by itself; references an interrupted run left
         unresolved are resolved) and warm semble's caches (code, and all content). A session
         start runs it in the background with --if-due: only indexes older than
         index.minIntervalMin, or failed long enough ago (the wait grows after each failure)
rebuild  rebuild the codegraph index from scratch (codegraph index) and warm semble again.
         It stops a running codegraph server of the project, so the sessions using it lose
         codegraph until they reconnect: refused while one runs, unless --force
         (ensure --force is rebuild --force)

The project is the git top level of --cwd (default: the current directory), else the nearest
folder above it with a project manifest (package.json, go.mod, Cargo.toml, *.sln, ...), never the
home folder or above it. A folder that only holds projects (loose files and hidden folders
aside) works on each child project (index.children, at most index.maxChildren). Never indexed:
the home folder and its parents, the filesystem root, the memory vault, ~/.buracle and what
index.exclude names.
config: index.auto, index.codegraph, index.semble, index.minIntervalMin, index.exclude,
index.children, index.maxChildren.
Ctrl-C (SIGINT), SIGTERM or SIGHUP stops ensure and rebuild together with the codegraph and semble
processes they started (exit 130, 143 or 129); an interrupted tool keeps its previous record.`

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const p = parseFlags(argv, { flags: { cwd: 'string', force: 'bool', quiet: 'bool', json: 'bool', 'if-due': 'bool' } })
  const json = io.flags.json || p.bools.has('json')
  const quiet = p.bools.has('quiet')
  const sub = p.positionals[0] ?? 'status'
  if (p.errors.length > 0 || !['status', 'ensure', 'rebuild'].includes(sub)) {
    io.stderr.write(`buracle index: ${[...p.errors, ...(['status', 'ensure', 'rebuild'].includes(sub) ? [] : [`unknown subcommand ${sub}`])].join('; ')}\n${usage}\n`)
    return 1
  }
  const ws = await import('../../workflow/workspace')
  const { describeIndexState } = await import('../../core/workspace')
  const cfg = loadConfigSync().config
  const cwd = p.strings.get('cwd') ?? process.cwd()
  const target = await ws.resolveWorkspace(cwd, ws.workspaceOptions(cfg))
  const roots = target.root !== undefined ? [target.root] : target.children
  const now = Date.now()
  if (roots.length === 0) {
    const msg = target.excluded !== undefined
      ? `${target.cwd} is ${target.excluded}: Buracle never indexes it`
      : `${target.cwd} is not a project (no git repository and no project manifest) and holds no projects`
    if (json) writeJson(io.stdout, { ok: false, cwd: target.cwd, ...(target.excluded !== undefined ? { excluded: target.excluded } : {}), error: msg })
    else if (!quiet) io.stderr.write(`buracle index: ${msg}\n`)
    return sub === 'status' ? 0 : 2
  }

  if (sub === 'status') {
    const entries = roots.map(root => ({ root, record: ws.readIndexRecord(root) ?? null, state: ws.projectIndex(root, cfg.index, now) }))
    if (json) {
      if (target.root !== undefined) {
        const e = entries[0]
        writeJson(io.stdout, { ok: true, root: target.root, record: e?.record ?? null, state: e?.state })
      } else writeJson(io.stdout, { ok: true, root: null, cwd: target.cwd, children: entries })
      return 0
    }
    const notes = (r: { note?: string } | undefined) => r?.note !== undefined ? `  (${r.note})` : ''
    const lines: string[] = []
    if (target.root === undefined) lines.push(`${target.cwd} holds ${roots.length} project${roots.length === 1 ? '' : 's'}:`)
    for (const e of entries) {
      lines.push(e.root)
      lines.push(`  ${'codegraph'.padEnd(10)}${describeIndexState(e.state.codegraph, now)}${notes(e.record?.codegraph)}`)
      lines.push(`  ${'semble'.padEnd(10)}${describeIndexState(e.state.semble, now)}${notes(e.record?.semble)}`)
    }
    io.stdout.write(lines.join('\n') + '\n')
    return 0
  }

  if (process.env['BURACLE_NO_TOOLCHAIN'] === '1' && process.env['BURACLE_INDEX_TEST'] !== '1') {
    if (!quiet) io.stderr.write('buracle index: BURACLE_NO_TOOLCHAIN=1, nothing indexed\n')
    return 0
  }
  const wi = await import('../../workflow/workspace-index')
  const rebuild = sub === 'rebuild' || p.bools.has('force')
  if (rebuild && !p.bools.has('force')) {
    const busy = roots.flatMap(root => {
      const w = wi.codegraphLiveWriter(root)
      return w !== undefined ? [{ root, pid: w.pid }] : []
    })
    if (busy.length > 0) {
      const msg = busy.map(b => `a codegraph server (pid ${b.pid}) is serving ${b.root}`).join('; ') +
        ': a rebuild stops it and the sessions using it lose codegraph until they reconnect. Close those sessions, or run `buracle index rebuild --force`.'
      if (json) writeJson(io.stdout, { ok: false, error: msg, busy })
      else io.stderr.write(`buracle index: ${msg}\n`)
      return 2
    }
  }
  const abort = new AbortController()
  let got: NodeJS.Signals | undefined
  const onSignal = (sig: NodeJS.Signals) => { got ??= sig; abort.abort() }
  for (const s of TRAPPED_SIGNALS) process.on(s, onSignal)
  let results: Awaited<ReturnType<typeof wi.ensureWorkspace>>
  try {
    results = await wi.ensureWorkspace(target, cfg, { ifDue: p.bools.has('if-due') && !rebuild, force: rebuild, signal: abort.signal })
  } finally {
    for (const s of TRAPPED_SIGNALS) process.off(s, onSignal)
  }
  if (got !== undefined) {
    const msg = `interrupted by ${got}: the codegraph and semble runs were stopped`
    if (json) writeJson(io.stdout, { ok: false, interrupted: got, error: msg, ...(target.root !== undefined ? { root: target.root } : { root: null, cwd: target.cwd }) })
    else if (!quiet) io.stderr.write(`buracle index: ${msg}\n`)
    return 128 + (got === 'SIGINT' ? 2 : got === 'SIGHUP' ? 1 : 15)
  }
  const ok = results.every(r => (r.skipped === undefined || r.skipped === 'not due') && (r.codegraph?.ok ?? true) && (r.semble?.ok ?? true))
  if (json) writeJson(io.stdout, target.root !== undefined ? { ok, ...results[0] } : { ok, root: null, cwd: target.cwd, children: results })
  else if (!quiet) {
    for (const r of results) {
      if (target.root === undefined || r.skipped !== undefined) io.stdout.write(`${r.root}${r.skipped !== undefined ? `: ${r.skipped}` : ''}\n`)
      for (const [label, t] of [['codegraph', r.codegraph], ['semble', r.semble]] as const) {
        if (t !== undefined) io.stdout.write(`${t.ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(10)}${t.mode ?? ''}${t.ms !== undefined ? ` ${t.ms} ms` : ''}${t.error !== undefined ? `  ${t.error}` : ''}${t.note !== undefined ? `  (${t.note})` : ''}\n`)
      }
    }
  }
  return ok ? 0 : 2
}
