import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../../src/cli/router'
import { profileSignalsFromPrompt } from '../../src/core/memory/profile'
import type { SpoolEntry } from '../../src/core/memory/spool'
import { write } from '../../src/memory/api'
import { contextText } from '../../src/memory/context'
import { finalize } from '../../src/memory/finalize'
import { profileEvidenceDir } from '../../src/memory/layout'
import { dropProfileClaim, profileLines } from '../../src/memory/profile'
import { sessionStart } from '../../src/memory/session-record'
import { appendSpool } from '../../src/memory/spool'
import { listAll, personRef, projectRef } from '../../src/memory/store'
import { agentCtx, makeRepo, withBrain } from './helpers'

const signals = (text: string, ts: number): SpoolEntry[] => profileSignalsFromPrompt(text).map(signal => ({ ts, ev: 'signal' as const, signal }))

async function session(h: 'claude' | 'codex', sid: string, cwd: string, prompts: string[], t0 = Date.now() - 60_000): Promise<void> {
  await sessionStart(h, sid, cwd, { nowMs: t0 })
  appendSpool(h, sid, [
    ...prompts.flatMap((p, i) => [{ ts: t0 + i * 10 + 1, ev: 'prompt' as const }, ...signals(p, t0 + i * 10 + 2)]),
    { ts: t0 + 500, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'bun test', exit: 0 },
    { ts: t0 + 600, ev: 'turn', excerpt: 'Done.' },
  ])
  await finalize(h, sid, { nowMs: t0 + 1000 })
}

const titles = async (ref: ReturnType<typeof personRef>, kind: string) => (await listAll(ref)).filter(i => i.kind === kind).map(i => i.title)

describe('the profile at finalize', () => {
  test('personal rules land in the person brain; a rule seen in one project stays in that project', async () => {
    await withBrain(async ({ repo }) => {
      await session('claude', 'prof-s1', repo, ['From now on always reply in Turkish.', 'Never deploy on Fridays, please.', '/plan-build add the cart'])
      expect(readdirSync(profileEvidenceDir())).toEqual(['claude-prof-s1.json'])
      expect(await titles(personRef(), 'profile')).toContain('Reply in Turkish')
      expect((await titles(personRef(), 'profile')).join('\n')).not.toContain('Fridays')
      expect(await titles(projectRef('demo'), 'convention')).toEqual(['Never deploy on Fridays, please'])
      const ctx = await contextText({ cwd: repo, sweep: false })
      expect(ctx.indexOf('## How the user works')).toBeLessThan(ctx.indexOf('## Project memory: demo'))
      expect(ctx).toContain('- Reply in Turkish')
      expect(ctx).toContain('### Conventions learned here\n- Never deploy on Fridays, please')
    })
  })

  test('the same rule in two projects moves to the person brain; nothing names the projects there', async () => {
    await withBrain(async ({ repo, root }) => {
      const other = makeRepo(join(root, 'blog'), 'git@github.com:me/blog.git')
      await session('claude', 'prof-a', repo, ['Never deploy on Fridays, please.'])
      await session('codex', 'prof-b', other, ['Please, never deploy on Fridays.'])
      const person = await listAll(personRef())
      expect(person.filter(i => i.kind === 'profile').some(i => /deploy on Fridays/i.test(i.title))).toBe(true)
      expect(JSON.stringify(person)).not.toMatch(/"demo"|"blog"/)
      expect(await titles(projectRef('demo'), 'convention')).toEqual([])
      await finalize('codex', 'prof-b')
      expect(readdirSync(profileEvidenceDir()).sort()).toEqual(['claude-prof-a.json', 'codex-prof-b.json'])
    })
  })

  test('sessions in folders that are never projects teach the profile nothing', async () => {
    await withBrain(async ({ home, repo, root }) => {
      const job = makeRepo(join(home, '.claude', 'jobs', 'f02b828c', 'repo'))
      const scratch = join(root, 'work', 'scratchpad', 'try')
      mkdirSync(scratch, { recursive: true })
      for (const [h, sid, cwd] of [['claude', 'prof-job', job], ['codex', 'prof-scratch', scratch], ['claude', 'prof-home', home]] as const) {
        await session(h, sid, cwd, ['From now on always use pnpm instead of npm.'])
      }
      expect(existsSync(profileEvidenceDir()) ? readdirSync(profileEvidenceDir()) : []).toEqual([])
      expect(await contextText({ cwd: repo, sweep: false })).not.toContain('pnpm')
    })
  })

  test('a preference memory counts as a stated rule', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'preference', title: 'Keep commit messages in English', summary: 'even in Turkish sessions', body: '' })
      await session('claude', 'prof-p', repo, ['ok'])
      expect(profileLines(await listAll(personRef()))).toContain('- Keep commit messages in English')
    })
  })

  test('drop takes a wrongly learned line out until the user states it again', async () => {
    await withBrain(async ({ repo }) => {
      await session('claude', 'prof-d1', repo, ['From now on always reply in Turkish.'])
      expect(await titles(personRef(), 'profile')).toContain('Reply in Turkish')
      const r = await dropProfileClaim('reply in turkish')
      expect(r.dropped.map(d => d.text)).toEqual(['Reply in Turkish'])
      expect(await titles(personRef(), 'profile')).not.toContain('Reply in Turkish')
      await session('claude', 'prof-d2', repo, ['From now on always reply in Turkish.'], Date.now() + 1000)
      expect(await titles(personRef(), 'profile')).toContain('Reply in Turkish')
    })
  })
})

describe('buracle mem profile', () => {
  test('shows what sessions start with', async () => {
    await withBrain(async ({ repo }) => {
      await session('claude', 'prof-cli', repo, ['From now on always reply in Turkish.'])
      let out = ''
      const code = await main(['mem', 'profile', '--rebuild'], { stdout: { write: (s: string) => { out += s } }, stderr: { write: () => {} }, stdin: { isTTY: true, text: async () => '' } })
      expect(code).toBe(0)
      expect(out).toContain('What sessions start with:\n- Reply in Turkish')
    })
  })
})
