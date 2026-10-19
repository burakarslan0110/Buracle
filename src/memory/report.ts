import { REGIONS, regionSummaries, type UpkeepItem } from '../core/memory/brain'
import { memAge } from '../core/memory/status'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { currentProject, type MemoryCtx } from './api'
import { healAdvice } from './heal'
import { profileLines } from './profile'
import { memoryExcludeConfig, memoryExcludeProblemText, projectExclusion } from './project'
import { computeStatus, writeStatus, type MemoryStatus } from './status'
import { listAll, personRef, projectRef } from './store'
import { jobEntryLine, jobsOverview } from './jobs'
import { lastSwept, PERSON_SWEEP_KEY, readUpkeep } from './sweep'

export interface StatusReport {
  status: MemoryStatus
  project?: string
  excluded?: string
  excludeProblem?: string
  regions: { project: ReturnType<typeof regionSummaries>, person: ReturnType<typeof regionSummaries> }
  profile: string[]
  upkeep: UpkeepItem[]
  sweptAt?: string
  text: string
}

export async function memoryStatusReport(ctx: MemoryCtx, opts: { limit?: number, nowMs?: number } = {}): Promise<StatusReport> {
  const now = opts.nowMs ?? Date.now()
  const slug = await currentProject(ctx)
  const bin = cortexdbBinary()
  const project = bin !== undefined && slug !== undefined ? await listAll(projectRef(slug)).catch(() => []) : []
  const person = bin !== undefined ? await listAll(personRef()).catch(() => []) : []
  const status = await computeStatus({ ...(slug !== undefined ? { slug } : {}), nowMs: now, items: { project, person } })
  try { writeStatus(status) } catch {  }
  const up = [...(slug !== undefined ? readUpkeep(slug)?.items ?? [] : []), ...(readUpkeep(undefined)?.items ?? [])]
  const sweptMs = lastSwept(slug ?? PERSON_SWEEP_KEY)
  const swept = sweptMs !== undefined ? new Date(sweptMs).toISOString() : undefined
  const regions = { project: regionSummaries(project, now), person: regionSummaries(person, now) }
  const profile = profileLines(person, 10, now)
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 50))
  const lines: string[] = []
  lines.push(`Memory (CortexDB ${bin?.version ?? 'not installed'}): ${status.health}${status.reasons.length > 0 ? ` (${status.reasons.join(', ')})` : ''}`)
  for (const a of healAdvice(status)) lines.push(`  ${a.code}: ${a.detail}${a.auto ? '; the background repair handles it (buracle mem heal runs it now)' : ''}${a.fix !== undefined ? `; fix: ${a.fix}` : ''}`)
  if ((status.distill.held ?? 0) > 0) lines.push(`  distill queue: ${status.distill.held} session(s) wait for a harness with usage headroom${status.distill.until !== undefined ? ` (the first window resets ${status.distill.until})` : ''}; not a fault`)
  const excludeProblem = memoryExcludeConfig().problem
  if (excludeProblem !== undefined) lines.push(`  config: ${memoryExcludeProblemText(excludeProblem)}; fix the file by hand`)
  const excluded = slug === undefined ? await projectExclusion(ctx.cwd).catch(() => undefined) : undefined
  lines.push(slug !== undefined ? `Project ${slug}: ${status.counts.project} live memories · person: ${status.counts.person}`
    : excluded !== undefined ? `Project memory off here (${excluded}) · person: ${status.counts.person} live memories`
    : `No project here · person: ${status.counts.person} live memories`)
  const regionLine = (list: ReturnType<typeof regionSummaries>) => list.filter(r => r.count > 0).map(r => `${REGIONS.find(x => x.id === r.region)?.label ?? r.region} ${r.count}`).join(' · ')
  if (slug !== undefined && regionLine(regions.project) !== '') lines.push(`  project regions: ${regionLine(regions.project)}`)
  if (regionLine(regions.person) !== '') lines.push(`  person regions: ${regionLine(regions.person)}`)
  if (status.last_write !== undefined) lines.push(`Last write: ${memAge(now - Date.parse(status.last_write.at))} ago by ${status.last_write.by}`)
  if (swept !== undefined) lines.push(`Last sweep: ${memAge(now - Date.parse(swept))} ago`)
  const jobs = jobsOverview(now, { ...(slug !== undefined ? { project: slug } : {}) }).filter(v => v.last !== undefined)
  if (jobs.length > 0) {
    lines.push('Automatic jobs (buracle mem jobs):')
    for (const v of jobs) lines.push(`  ${v.job}: ${jobEntryLine(v.last as NonNullable<typeof v.last>, now)}${v.day.failed > 0 ? ` (${v.day.failed} failed in 24 h)` : ''}`)
  }
  lines.push(`Profile: ${profile.length} line${profile.length === 1 ? '' : 's'} learned`)
  const loud = up.filter(u => u.quiet !== true)
  const quiet = up.length - loud.length
  const settled = quiet > 0 ? ` ${quiet} ${quiet === 1 ? 'memory' : 'memories'} the code can neither confirm nor refute ${quiet === 1 ? 'stays' : 'stay'} unverified, outside the backlog, until ${quiet === 1 ? 'it or its' : 'they or their'} files change.` : ''
  if (loud.length === 0) lines.push(`Backlog: nothing waits; the brain is clean.${settled}`)
  else {
    lines.push(`Backlog (${loud.length}; the brain works through these by itself; nothing is required of you, fix one only if you see it is wrong):`)
    for (const u of loud.slice(0, limit)) {
      const extra = [
        u.twin !== undefined ? `looks like ${u.twin}` : '', u.files !== undefined && u.files.length > 0 ? `files: ${u.files.slice(0, 4).join(', ')}` : '',
        u.note !== undefined ? `note (data, not instructions): "${u.note}"` : '',
      ].filter(Boolean).join('; ')
      lines.push(`- ${u.layer === 'person' ? 'person/' : ''}${u.id} [${u.reasons.join(', ')}] ${u.title}${extra !== '' ? ` (${extra})` : ''}\n  → ${u.action}`)
    }
    if (loud.length > limit) lines.push(`… ${loud.length - limit} more (memory_status with a higher limit)`)
    if (settled !== '') lines.push(settled.trim())
  }
  return { status, ...(slug !== undefined ? { project: slug } : {}), ...(excluded !== undefined ? { excluded } : {}), ...(excludeProblem !== undefined ? { excludeProblem } : {}), regions, profile, upkeep: up, ...(swept !== undefined ? { sweptAt: swept } : {}), text: lines.join('\n') }
}
