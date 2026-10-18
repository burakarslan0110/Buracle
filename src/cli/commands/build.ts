import type { CommandIO } from '../router'
import type { Harness } from '../../core/events'
import { HARNESSES, isHarness } from '../../core/events'
import { loadConfigSync, writeRuntimeConfig } from '../../engine/config'
import { parseFlags } from '../../engine/update/args'
import { MANIFEST_REL, runBuild, type BuildReport } from '../../engine/update/build'
import { opsDeps } from '../../engine/update/deps'
import { errText, table, tildeText, writeJson } from '../../engine/update/output'
import { HOOK_DATA_REL } from '../hook-data'

export const name = 'build'
export const summary = 'Generate harness/* from canonical/ and src/core (--check reports drift only)'
export const usage = `Usage: buracle build [--check] [--harness <h>[,<h>…]] [--json]

Runs every harness adapter's generator over canonical/ and writes the result
under harness/ (the shared Agent Skills render goes to harness/agents-skills/),
plus ${HOOK_DATA_REL}, the part of canonical/ the command hooks read.
Also writes docs/reference/{hooks,cli,config,statusline,plan-format,install}.md (local only:
not in the manifest, not compared by --check) and refreshes ~/.buracle/state/runtime-config.json.
Generated files are listed in ${MANIFEST_REL}; only files listed there are ever deleted as stale.

Options:
  --check        compare instead of writing; exit 1 with the drift list
  --harness <h>  only these adapters (${HARNESSES.join(', ')}); docs and
                 ${HOOK_DATA_REL} are always included
  --json         machine-readable report

Output is deterministic (no timestamps, no machine-specific paths).`

export interface BuildCommandResult { code: number; report: BuildReport; runtimeConfig?: string }

export async function runBuildFlow(opts: { check: boolean, harnesses?: Harness[], runtimeConfig?: boolean }): Promise<BuildCommandResult> {
  const repoRoot = opsDeps.repoRoot()
  const adapters = await opsDeps.adapters()
  const buildOpts: Parameters<typeof runBuild>[0] = { repoRoot, check: opts.check, adapters }
  if (opts.harnesses) buildOpts.harnesses = opts.harnesses
  const report = await runBuild(buildOpts)
  const res: BuildCommandResult = { code: report.ok ? 0 : 1, report }
  if (!opts.check && opts.runtimeConfig !== false) {
    try {
      res.runtimeConfig = await writeRuntimeConfig(loadConfigSync({ repoRoot }).config)
    } catch (e) {
      report.warnings.push(`runtime-config.json: ${errText(e)}`)
    }
  }
  return res
}

export function renderBuild(r: BuildReport, io: CommandIO): void {
  const out = io.stdout
  if (r.check) {
    if (r.drift.length === 0 && r.errors.length === 0) out.write(`build --check: ${r.generated} generated file(s) are in sync.\n`)
    else if (r.drift.length > 0) {
      out.write(`build --check: ${r.drift.length} file(s) differ from the generator output (run \`buracle build\`):\n`)
      out.write(table(r.drift.map(d => [d.kind, d.path, d.by !== undefined ? `(${d.by})` : ''])))
    }
  } else {
    out.write(`build: ${r.generated} file(s) from ${r.producers.join(', ') || 'no generator'}; wrote ${r.written.length}, removed ${r.removed.length} stale, ${r.unchanged} unchanged.\n`)
    for (const p of r.removed) out.write(`  removed ${p}\n`)
  }
  for (const w of r.warnings) io.stderr.write(`warning: ${tildeText(w)}\n`)
  for (const e of r.errors) io.stderr.write(`error: ${e.source}: ${tildeText(e.error)}\n`)
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const p = parseFlags(argv, { flags: { check: 'bool', harness: 'list', json: 'bool' } })
  const json = io.flags.json || p.bools.has('json')
  const bad = p.lists.get('harness')?.filter(h => !isHarness(h)) ?? []
  if (p.errors.length > 0 || p.positionals.length > 0 || bad.length > 0) {
    const msg = [...p.errors, ...p.positionals.map(x => `unexpected argument ${x}`), ...bad.map(h => `unknown harness ${h}`)].join('; ')
    io.stderr.write(`buracle build: ${msg}\n${usage}\n`)
    return 1
  }
  const opts: { check: boolean, harnesses?: Harness[] } = { check: p.bools.has('check') }
  const hs = p.lists.get('harness')
  if (hs && hs.length > 0) opts.harnesses = hs.filter(isHarness)
  let res: BuildCommandResult
  try {
    res = await runBuildFlow(opts)
  } catch (e) {
    io.stderr.write(`buracle build: ${errText(e)}\n`)
    return 1
  }
  if (json) writeJson(io.stdout, { ...res.report, code: res.code })
  else renderBuild(res.report, io)
  return res.code
}
