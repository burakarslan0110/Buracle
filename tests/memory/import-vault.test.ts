import { describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { importVault, oldVaultPath, vaultImportDone } from '../../src/memory/import-vault'
import { listAll, personRef, projectRef } from '../../src/memory/store'
import { withBrain } from './helpers'

function note(fm: Record<string, unknown>, body: string): string {
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : typeof v === 'string' && /[:#]/.test(v) ? JSON.stringify(v) : String(v)}`).join('\n')
  return `---\n${yaml}\n---\n${body}`
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(dir, p)] = `${statSync(p).mtimeMs}:${readFileSync(p, 'utf8')}`
    }
  }
  walk(dir)
  return out
}

describe('import-vault', () => {
  test('imports the live notes into their brains, once, and leaves the vault as it was', async () => {
    await withBrain(async ({ home }) => {
      const vault = join(home, 'Documents', 'Buracle')
      expect(oldVaultPath()).toBe(vault)
      put(vault, 'projects/demo/decisions/use-bun.md', note({ id: 'm-1', type: 'decision', title: 'Use bun for every script', description: 'One runtime', status: 'active', tags: ['tooling'], sources: ['package.json'], importance: 4 }, '# Use bun for every script\n\n## Decision\nBun.\n\n## History\n- created\n'))
      put(vault, 'projects/demo/gotchas/old.md', note({ id: 'm-2', type: 'gotcha', title: 'An old gotcha', status: 'superseded' }, 'gone'))
      put(vault, 'projects/demo/core/brief.md', note({ id: 'c-1', type: 'core', title: 'Brief: demo', status: 'draft' }, '# Brief: demo\n\n<!-- What this project is. -->\n'))
      put(vault, 'projects/demo/core/glossary.md', note({ id: 'c-2', type: 'core', title: 'Glossary: demo', status: 'active' }, '# Glossary: demo\n\n- **Brain**: the CortexDB files.\n'))
      put(vault, 'projects/demo/sessions/2026/10/s.md', note({ type: 'session', title: 's' }, 'x'))
      put(vault, 'projects/demo/claude/feedback_short.md', note({ name: 'Keep answers short', type: 'feedback' }, 'The user wants short answers.'))
      put(vault, 'global/gotchas/bun-fetch.md', note({ id: 'g-1', type: 'gotcha', title: 'Bun fetch tells a dead server apart by its error code', status: 'active' }, 'ECONNREFUSED vs ECONNRESET'))
      put(vault, 'inbox/idea.md', note({ id: 'i-1', type: 'knowledge', title: 'Try a brain-shaped UI', status: 'draft' }, 'idea'))
      put(vault, 'global/profile/user-profile.md', note({ id: 'u-profile', type: 'profile', title: 'User profile' }, '# User profile\n\n## Pinned by the user\n\n- Reply in Turkish; code in English.\n<!-- Add your own rules here -->\n'))
      const before = snapshot(vault)

      const dry = await importVault({ dryRun: true })
      expect(dry.imported.length).toBe(6)
      expect(await listAll(projectRef('demo'))).toEqual([])

      const r = await importVault()
      expect(r.imported.map(i => `${i.layer}:${i.kind}:${i.from}`).sort()).toEqual([
        'person:capture:inbox/idea.md',
        'person:gotcha:global/gotchas/bun-fetch.md',
        'person:preference:global/profile/user-profile.md#pinned',
        'person:preference:projects/demo/claude/feedback_short.md',
        'project:core:projects/demo/core/glossary.md',
        'project:decision:projects/demo/decisions/use-bun.md',
      ])
      expect(r.skipped.map(s => s.from).sort()).toEqual(['projects/demo/core/brief.md', 'projects/demo/gotchas/old.md'])
      const project = await listAll(projectRef('demo'))
      const decision = project.find(i => i.kind === 'decision')
      expect(decision).toMatchObject({ title: 'Use bun for every script', summary: 'One runtime', tags: ['tooling'], sources: ['package.json'], importance: 4, review: 'pending' })
      expect(decision?.body).toBe('## Decision\nBun.')
      expect(project.find(i => i.kind === 'core')?.id).toBe('core-glossary')
      const pinned = (await listAll(personRef())).find(i => i.title === 'Reply in Turkish; code in English.')
      expect(pinned).toMatchObject({ author: 'user', review: 'ok', kind: 'preference' })
      expect(vaultImportDone()?.vault).toBe(vault)

      const again = await importVault()
      expect(again.imported).toEqual([])
      expect(snapshot(vault)).toEqual(before)
    })
  })

  test('no vault, nothing to import', async () => {
    await withBrain(async () => {
      const r = await importVault()
      expect(r.found).toBe(false)
      expect(vaultImportDone()).toBeUndefined()
    })
  })

  test('a vault path an older config named is found', async () => {
    await withBrain(async ({ home, buracleHome }) => {
      mkdirSync(buracleHome, { recursive: true })
      writeFileSync(join(buracleHome, 'config.yaml'), 'vault: ~/Notes/Brain\n')
      expect(oldVaultPath()).toBe(join(home, 'Notes', 'Brain'))
    })
  })
})
