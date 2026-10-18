import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { appendJob, jobEntryLine, jobsOverview, readJobs, trimJobs, type JobEntry } from '../../src/memory/jobs'
import { jobsFile } from '../../src/memory/layout'
import { withSandbox } from '../helpers/sandbox'

const NOW = Date.parse('2026-10-14T12:00:00.000Z')

describe('jobs journal', () => {
  test('appends one line per call, redacts and clips the detail, and never throws', async () => {
    await withSandbox(async () => {
      appendJob({ job: 'reflect', trigger: 'session-end', outcome: 'skipped', reason: 'interval', detail: 'last run 12 min ago', project: 'demo', layer: 'project' }, NOW)
      appendJob({ job: 'distill', trigger: 'session-end', outcome: 'failed', reason: 'runner-failed', detail: `claude: token sk-ant-api03-${'A'.repeat(90)} refused\n${'x'.repeat(400)}` }, NOW + 1000)
      const all = readJobs()
      expect(all.map(e => [e.job, e.outcome, e.reason])).toEqual([['reflect', 'skipped', 'interval'], ['distill', 'failed', 'runner-failed']])
      const failed = all[1] as JobEntry
      expect(failed.detail).not.toContain('sk-ant-api03')
      expect(failed.detail).toContain('[REDACTED')
      expect((failed.detail ?? '').length).toBeLessThanOrEqual(200)
      expect(failed.detail).not.toContain('\n')
      expect(failed.at).toBe(new Date(NOW + 1000).toISOString())
      writeFileSync(jobsFile(), readFileSync(jobsFile(), 'utf8') + '{"v":1,"job":"nope"\n{"v":2}\n')
      expect(readJobs()).toHaveLength(2)
    })
  })

  test('trimJobs keeps the last 30 days and at most 2000 lines', async () => {
    await withSandbox(async () => {
      appendJob({ job: 'sweep', trigger: 'cli', outcome: 'ran' }, NOW - 31 * 86_400_000)
      for (let i = 0; i < 2005; i++) appendJob({ job: 'kick', trigger: 'session-start', outcome: 'ran' }, NOW - 1000 + i)
      expect(trimJobs(NOW + 5000)).toBe(6)
      const kept = readJobs()
      expect(kept).toHaveLength(2000)
      expect(kept.every(e => e.job === 'kick')).toBe(true)
      expect(trimJobs(NOW + 5000)).toBe(0)
    })
  })

  test('the overview gives each job its newest run, failure and skip, and its 24-hour counts', async () => {
    await withSandbox(async () => {
      appendJob({ job: 'reflect', trigger: 'session-end', outcome: 'ran', detail: 'applied 3, rejected 0', project: 'demo' }, NOW - 2 * 86_400_000)
      appendJob({ job: 'reflect', trigger: 'session-end', outcome: 'ran', detail: 'applied 1, rejected 0', project: 'demo' }, NOW - 3600_000)
      appendJob({ job: 'reflect', trigger: 'session-end', outcome: 'skipped', reason: 'interval', project: 'demo' }, NOW - 600_000)
      appendJob({ job: 'reflect', trigger: 'session-end', outcome: 'skipped', reason: 'interval', project: 'other' }, NOW - 300_000)
      const views = jobsOverview(NOW, { project: 'demo' })
      expect(views.map(v => v.job)).toContain('verify')
      const reflect = views.find(v => v.job === 'reflect')
      expect(reflect?.last?.reason).toBe('interval')
      expect(reflect?.last?.project).toBe('demo')
      expect(reflect?.lastRan?.detail).toBe('applied 1, rejected 0')
      expect(reflect?.lastFailed).toBeUndefined()
      expect(reflect?.day).toEqual({ ran: 1, skipped: 1, failed: 0 })
      expect(views.find(v => v.job === 'heal')?.last).toBeUndefined()
      expect(jobEntryLine(reflect?.last as JobEntry, NOW)).toBe('skipped 10 min ago (project demo) - interval')
    })
  })
})
