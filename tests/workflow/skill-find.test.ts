import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { runSkills } from '../../src/cli/commands/skills'
import type { FetchResult } from '../../src/engine/update/fetch'
import { GITHUB_API_URL, matchLocal, queryTokens, RAW_GITHUB_URL, REGISTRY_AUDIT_URL, REGISTRY_SEARCH_URL, skillFolderIn, skillsFind, type FindCandidate, type LocalMatch } from '../../src/workflow/skill-find'
import { skillsAdd } from '../../src/workflow/skill-install'
import type { WorkflowCtx } from '../../src/workflow/result'
import { withDeps } from '../cli/ops/helpers'
import { withSandbox } from '../helpers/sandbox'
import { memIO, write } from './fixture'

const NOW = Date.parse('2026-10-14T12:00:00Z')

function ctx(cwd: string): WorkflowCtx {
  return { cwd, now: NOW, env: { ...process.env, GITHUB_TOKEN: undefined, GH_TOKEN: undefined } }
}

const SEARCH = { skills: [
  { id: 'acme/skills/stripe-webhooks', source: 'acme/skills', skillId: 'stripe-webhooks', name: 'stripe-webhooks', installs: 587 },
  { id: 'someone/agents/webhook-guard', source: 'someone/agents', skillId: 'webhook-guard', name: 'webhook-guard', installs: 20 },
  { id: 'old/archive/hooks', source: 'old/archive', skillId: 'hooks', name: 'hooks', installs: 3 },
  { id: 'deep/mono/hooks', source: 'deep/mono', skillId: 'hooks', name: 'hooks', installs: 50 },
  { id: 'broken', source: 'not-a-repo' },
] }

const ACME_SKILL_MD = '---\nname: stripe-webhooks\ndescription: >\n  Receive and verify Stripe webhooks.\n  Use when setting up handlers.\nlicense: MIT\nallowed-tools: Bash(stripe:*)\n---\n\n# Stripe webhooks\n'
const SOMEONE_SKILL_MD = '---\nname: webhook-guard\ndescription: Guards webhooks.\n---\n'
const DEEP_SKILL_MD = '---\nname: hooks\ndescription: Hooks from a plugin monorepo.\n---\n'
const DEEP_TREE = { truncated: false, tree: [
  { path: 'plugins', type: 'tree' },
  { path: 'plugins/pay/skills/hooks/SKILL.md', type: 'blob' },
  { path: 'plugins/pay/skills/hooks/examples/copy/hooks/SKILL.md', type: 'blob' },
  { path: 'docs/hooks/README.md', type: 'blob' },
  { path: 'nothooks/SKILL.md', type: 'blob' },
] }

function fakeFetch(calls: string[], overrides: Record<string, FetchResult> = {}) {
  return async (url: string): Promise<FetchResult> => {
    calls.push(url)
    for (const [prefix, r] of Object.entries(overrides)) if (url.startsWith(prefix)) return r
    if (url.startsWith(REGISTRY_SEARCH_URL)) return { ok: true, status: 200, json: SEARCH }
    if (url === `${GITHUB_API_URL}/repos/acme/skills`) return { ok: true, status: 200, json: { license: { spdx_id: 'MIT', name: 'MIT License' }, pushed_at: '2026-10-12T15:02:36Z', stargazers_count: 91, archived: false } }
    if (url === `${GITHUB_API_URL}/repos/someone/agents`) return { ok: false, status: 403, error: 'HTTP 403', json: { message: 'API rate limit exceeded' } }
    if (url === `${GITHUB_API_URL}/repos/old/archive`) return { ok: true, status: 200, json: { license: null, pushed_at: '2024-01-01T00:00:00Z', stargazers_count: 2, archived: true } }
    if (url === `${GITHUB_API_URL}/repos/deep/mono`) return { ok: true, status: 200, json: { license: { spdx_id: 'NOASSERTION', name: 'Other' }, pushed_at: '2026-09-01T00:00:00Z', stargazers_count: 7, archived: false } }
    if (url === `${GITHUB_API_URL}/repos/deep/mono/git/trees/HEAD?recursive=1`) return { ok: true, status: 200, json: DEEP_TREE }
    if (url === `${RAW_GITHUB_URL}/deep/mono/HEAD/plugins/pay/skills/hooks/SKILL.md`) return { ok: true, status: 200, text: DEEP_SKILL_MD }
    if (url.startsWith(`${REGISTRY_AUDIT_URL}?source=acme%2Fskills`)) return { ok: true, status: 200, json: { 'stripe-webhooks': { socket: { risk: 'low', alerts: 0 }, snyk: { risk: 'safe' } } } }
    if (url.startsWith(REGISTRY_AUDIT_URL)) return { ok: true, status: 200, json: {} }
    if (url === `${RAW_GITHUB_URL}/acme/skills/HEAD/skills/stripe-webhooks/SKILL.md`) return { ok: true, status: 200, text: ACME_SKILL_MD }
    if (url === `${RAW_GITHUB_URL}/someone/agents/HEAD/webhook-guard/SKILL.md`) return { ok: true, status: 200, text: SOMEONE_SKILL_MD }
    return { ok: false, status: 404, error: 'HTTP 404', text: '404: Not Found' }
  }
}

describe('queryTokens, matchLocal and skillFolderIn', () => {
  test('the shortest <folder>/SKILL.md whose folder is the skill id wins; other folders do not count', () => {
    expect(skillFolderIn(DEEP_TREE.tree.map(e => e.path), 'hooks')).toBe('plugins/pay/skills/hooks')
    expect(skillFolderIn(['hooks/SKILL.md', 'skills/hooks/SKILL.md'], 'hooks')).toBe('hooks')
    expect(skillFolderIn(['webhooks/SKILL.md', 'hooks/README.md'], 'hooks')).toBeNull()
  })

  test('tokens drop stop words and short bits; local matches score the id above the description', () => {
    expect(queryTokens('a skill for Stripe webhooks, with retries')).toEqual(['stripe', 'webhooks', 'retries'])
    expect(queryTokens('Türkçe metni doğallaştır')).toEqual(['türkçe', 'metni', 'doğallaştır'])
    const skills = [
      { id: 'security-audit', source: 'buracle', description: 'Security review of a codebase, webhooks included.' },
      { id: 'stripe-webhooks', source: 'installed', description: 'Receive and verify Stripe webhooks.' },
      { id: 'memory', source: 'buracle', description: 'The memory protocol.' },
    ]
    expect(matchLocal('stripe webhooks', skills).map(m => [m.id, m.score])).toEqual([['stripe-webhooks', 4], ['security-audit', 1]])
    expect(matchLocal('', skills)).toEqual([])
  })
})

describe('skills find', () => {
  test('one registry call plus parallel enrichment: description, license, freshness, risk and the install line per candidate', async () => {
    await withSandbox(async ({ root }) => {
      const calls: string[] = []
      const r = await withDeps({ fetch: fakeFetch(calls) }, () => skillsFind('stripe webhooks', {}, ctx(root)))
      expect(r.code).toBe(0)
      const candidates = r.data['candidates'] as FindCandidate[]
      expect(candidates.map(c => c.id)).toEqual(['acme/skills/stripe-webhooks', 'someone/agents/webhook-guard', 'old/archive/hooks', 'deep/mono/hooks'])
      expect(candidates[0]).toEqual({
        rank: 1, id: 'acme/skills/stripe-webhooks', source: 'acme/skills', skill: 'stripe-webhooks', installs: 587,
        description: 'Receive and verify Stripe webhooks. Use when setting up handlers.', path: 'skills/stripe-webhooks',
        license: 'MIT', pushed_at: '2026-10-12T15:02:36Z', stars: 91, archived: false,
        risk: { socket: 'low', snyk: 'safe' }, allowed_tools: 'Bash(stripe:*)',
        install: 'buracle skills add acme/skills --skill stripe-webhooks',
      })
      expect(candidates[1]).toMatchObject({ license: null, stars: null, path: 'webhook-guard', description: 'Guards webhooks.', risk: null })
      expect(candidates[2]).toMatchObject({ license: null, archived: true, path: null, description: null })
      expect(candidates[3]).toMatchObject({ license: 'Other', path: 'plugins/pay/skills/hooks', description: 'Hooks from a plugin monorepo.', install: 'buracle skills add deep/mono --skill hooks' })
      expect(r.errors).toEqual([expect.stringContaining('GitHub API rate limit reached')])
      expect(r.data['warnings']).toEqual(r.errors)
      const text = r.lines.join('\n')
      expect(text).toContain('No installed or shipped skill matches "stripe webhooks".')
      expect(text).toContain('skills.sh: 4 results for "stripe webhooks", the top 4 with license, freshness and risk:')
      expect(text).toContain(' 1. acme/skills/stripe-webhooks   587 installs · 91 stars · MIT · pushed 2026-10-12 · socket low, snyk safe')
      expect(text).toContain('    allowed-tools: Bash(stripe:*)')
      expect(text).toContain('    buracle skills add acme/skills --skill stripe-webhooks --dry-run')
      expect(text).toContain(' 3. old/archive/hooks   3 installs · 2 stars · no license found · pushed 2024-01-01 · ARCHIVED')
      expect(text).toContain('(no hooks/SKILL.md in the repository at HEAD: the registry entry may be stale; the --dry-run lists what is there)')
      expect(calls.filter(u => u.startsWith(REGISTRY_SEARCH_URL))).toEqual([`${REGISTRY_SEARCH_URL}?q=stripe%20webhooks&limit=8`])
      expect(calls.filter(u => u.startsWith(GITHUB_API_URL) && !u.includes('/git/trees/'))).toHaveLength(4)
      expect(calls.filter(u => u.includes('/git/trees/HEAD?recursive=1')).sort()).toEqual([`${GITHUB_API_URL}/repos/deep/mono/git/trees/HEAD?recursive=1`, `${GITHUB_API_URL}/repos/old/archive/git/trees/HEAD?recursive=1`])
      expect(calls.filter(u => u.startsWith(REGISTRY_AUDIT_URL))).toHaveLength(4)
      expect(calls.filter(u => u.startsWith(`${RAW_GITHUB_URL}/acme/`))).toHaveLength(1)
      expect(calls.filter(u => u.startsWith(`${RAW_GITHUB_URL}/someone/`))).toHaveLength(2)
      expect(calls.filter(u => u.startsWith(`${RAW_GITHUB_URL}/old/`))).toHaveLength(5)
      expect(calls.filter(u => u.startsWith(`${RAW_GITHUB_URL}/deep/`))).toHaveLength(6)
    })
  })

  test('installed skills that match come first; an unreachable registry exits 1 but still prints them', async () => {
    await withSandbox(async ({ root }) => {
      write(join(root, 'mine', 'stripe-webhooks', 'SKILL.md'), '---\nname: stripe-webhooks\ndescription: Receive and verify Stripe webhooks.\n---\n\n# x\n')
      const c = ctx(root)
      expect((await skillsAdd(join(root, 'mine', 'stripe-webhooks'), {}, c)).code).toBe(0)
      const calls: string[] = []
      const ok = await withDeps({ fetch: fakeFetch(calls) }, () => skillsFind('stripe webhooks', { limit: 2 }, c))
      expect(ok.code).toBe(0)
      expect((ok.data['local'] as LocalMatch[])[0]).toEqual({ id: 'stripe-webhooks', source: 'installed', description: 'Receive and verify Stripe webhooks.', score: 4 })
      expect(ok.lines[0]).toBe('Already here and matching "stripe webhooks" (check these before installing anything):')
      expect(ok.lines[1]).toContain('stripe-webhooks')
      expect(ok.lines[1]).toContain('installed Receive and verify Stripe webhooks.')
      expect((ok.data['candidates'] as FindCandidate[]).map(c => c.rank)).toEqual([1, 2])
      expect(ok.lines.join('\n')).toContain('skills.sh: 2+ results')
      expect(calls[0]).toBe(`${REGISTRY_SEARCH_URL}?q=stripe%20webhooks&limit=2`)

      const down = await withDeps({ fetch: fakeFetch([], { [REGISTRY_SEARCH_URL]: { ok: false, status: 0, error: 'timed out after 10000 ms' } }) }, () => skillsFind('stripe', {}, c))
      expect(down.code).toBe(1)
      expect(down.data).toMatchObject({ ok: false, error: 'registry', candidates: [] })
      expect(down.errors[0]).toContain('skills.sh did not answer (timed out after 10000 ms)')
      expect(down.lines[1]).toContain('installed Receive and verify Stripe webhooks.')
      expect(calls.filter(u => u.startsWith(GITHUB_API_URL))).toHaveLength(2)
    })
  })

  test('the CLI: words need no quotes, --json carries the candidates, --limit is checked', async () => {
    await withSandbox(async ({ root }) => {
      const c = ctx(root)
      const io = memIO(true)
      expect(await withDeps({ fetch: fakeFetch([]) }, () => runSkills(['find', 'stripe', 'webhooks', '--limit', '2', '--json'], io, c))).toBe(0)
      const out = io.json<{ ok: boolean, query: string, candidates: FindCandidate[] }>()
      expect(out.ok).toBe(true)
      expect(out.query).toBe('stripe webhooks')
      expect(out.candidates.map(x => x.skill)).toEqual(['stripe-webhooks', 'webhook-guard'])
      const bad = memIO(false)
      expect(await runSkills(['find', 'stripe', '--limit', '0'], bad, c)).toBe(1)
      expect(bad.err()).toContain('--limit must be a whole number from 1 to 25')
      const empty = memIO(false)
      expect(await runSkills(['find'], empty, c)).toBe(1)
      expect(empty.err()).toContain('say what the skill should do')
      const wrong = memIO(false)
      expect(await runSkills(['list', '--limit', '3'], wrong, c)).toBe(1)
      expect(wrong.err()).toContain("--limit applies to 'skills find' only")
    })
  })
})
