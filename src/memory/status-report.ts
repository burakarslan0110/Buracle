import { regionSummaries, REGIONS, type MemItem } from '../core/memory/brain'
import { memAge, memReasonAdvice, type MemoryStatus } from '../core/memory/status'
import { statSync } from 'node:fs'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { tilde } from '../engine/update/output'
import { currentProject, type MemoryCtx } from './api'
import { brainDbFile } from './layout'
import { migrationStatus } from './migrate'
import { memoryExcludeConfig, memoryExcludeProblemText, projectExclusion } from './project'
import { computeStatus, writeStatus } from './status'
import { brainExists, listAll, personRef, projectRef } from './store'

/** The one brain file: where it is, how big, and how many memories each bucket holds (retired ones included). */
export interface BrainFileInfo { file: string, bytes: number, person: number, projects: Record<string, number> }

export async function brainFileInfo(): Promise<BrainFileInfo | undefined> {
  if (!brainExists()) return undefined
  let bytes = 0
  try { bytes = statSync(brainDbFile()).size } catch {  }
  const s = await migrationStatus()
  return { file: tilde(brainDbFile()), bytes, person: s.brain.person, projects: s.brain.projects }
}

function sizeText(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export interface StatusReport {
  status: MemoryStatus
  brain?: BrainFileInfo
  project?: string
  excluded?: string
  excludeProblem?: string
  regions: { project: ReturnType<typeof regionSummaries>, person: ReturnType<typeof regionSummaries> }
  text: string
}

/** What `memory_status` and `buracle mem status` print: the store, the counts per brain region, the last write and the last capture. */
export async function memoryStatusReport(ctx: MemoryCtx, opts: { nowMs?: number } = {}): Promise<StatusReport> {
  const now = opts.nowMs ?? Date.now()
  const slug = await currentProject(ctx)
  const bin = cortexdbBinary()
  // A brain that cannot be read (a migration is running, CortexDB does not answer) is reported as unreadable, never as empty.
  let items: { project: MemItem[], person: MemItem[] } | undefined
  if (bin !== undefined) {
    try { items = { project: slug !== undefined ? await listAll(projectRef(slug)) : [], person: await listAll(personRef()) } } catch { items = undefined }
  }
  const project = items?.project ?? []
  const person = items?.person ?? []
  const status = await computeStatus({ ...(slug !== undefined ? { slug } : {}), nowMs: now, ...(items !== undefined ? { items } : {}) })
  try { writeStatus(status) } catch {  }
  const regions = { project: regionSummaries(project, now), person: regionSummaries(person, now) }
  const lines: string[] = []
  lines.push(`Memory (CortexDB ${bin?.version ?? 'not installed'}): ${status.health}${status.reasons.length > 0 ? ` (${status.reasons.join(', ')})` : ''}`)
  for (const code of status.reasons) {
    const a = memReasonAdvice(code, status)
    lines.push(`  ${code}: ${a.detail}${a.fix !== undefined ? `; fix: ${a.fix}` : ''}`)
  }
  const excludeProblem = memoryExcludeConfig().problem
  if (excludeProblem !== undefined) lines.push(`  config: ${memoryExcludeProblemText(excludeProblem)}; fix the file by hand`)
  const excluded = slug === undefined ? await projectExclusion(ctx.cwd).catch(() => undefined) : undefined
  lines.push(slug !== undefined ? `Project ${slug}: ${status.counts.project} live memories · person: ${status.counts.person}`
    : excluded !== undefined ? `Project memory off here (${excluded}) · person: ${status.counts.person} live memories`
    : `No project here · person: ${status.counts.person} live memories`)
  const brain = await brainFileInfo().catch(() => undefined)
  if (brain !== undefined) {
    const buckets = [`person ${brain.person}`, ...Object.entries(brain.projects).map(([k, n]) => `${k} ${n}`)]
    lines.push(`Brain file: ${brain.file} (${sizeText(brain.bytes)}), one CortexDB file with a bucket per project and one for the person: ${buckets.join(' · ')} memories kept (retired ones included)`)
  } else lines.push(`Brain file: none yet (${tilde(brainDbFile())} appears with the first memory)`)
  const regionLine = (list: ReturnType<typeof regionSummaries>) => list.filter(r => r.count > 0).map(r => `${REGIONS.find(x => x.id === r.region)?.label ?? r.region} ${r.count}`).join(' · ')
  if (slug !== undefined && regionLine(regions.project) !== '') lines.push(`  project regions: ${regionLine(regions.project)}`)
  if (regionLine(regions.person) !== '') lines.push(`  person regions: ${regionLine(regions.person)}`)
  if (status.last_write !== undefined) lines.push(`Last write: ${memAge(now - Date.parse(status.last_write.at))} ago by ${status.last_write.by}`)
  lines.push(status.last_capture !== undefined
    ? `Last capture: ${memAge(now - Date.parse(status.last_capture.at))} ago (${status.last_capture.saved} saved, by ${status.last_capture.by}); \`buracle mem capture\` runs one now`
    : 'Last capture: none yet; a session end captures what it learned, `buracle mem capture` does it on demand')
  if (status.captures > 0) lines.push(`Inbox: ${status.captures} capture${status.captures === 1 ? '' : 's'} wait to be filed (memory_update with move: {kind, layer})`)
  return { status, ...(brain !== undefined ? { brain } : {}), ...(slug !== undefined ? { project: slug } : {}), ...(excluded !== undefined ? { excluded } : {}), ...(excludeProblem !== undefined ? { excludeProblem } : {}), regions, text: lines.join('\n') }
}
