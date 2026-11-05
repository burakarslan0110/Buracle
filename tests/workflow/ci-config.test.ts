import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { TESTED_WITH } from '../../src/engine/update/tested-with'

// .github/workflows/ci.yml cannot be run here; these tests pin what a push to a branch relies on: the harness versions
// the install jobs use are the ones src/engine/update/tested-with.ts records, and the jobs the release waits for exist.

const FILE = join(import.meta.dir, '..', '..', '.github', 'workflows', 'ci.yml')
const HAS_CI = existsSync(FILE)
const text = HAS_CI ? readFileSync(FILE, 'utf8') : ''

interface Job { name?: string, needs?: string[], steps?: Array<{ name?: string, run?: string }>, strategy?: { matrix?: { include?: Array<Record<string, string>> } } }
const workflow = HAS_CI ? parse(text) as { jobs: Record<string, Job> } : { jobs: {} as Record<string, Job> }

const PACKAGES: Record<keyof typeof TESTED_WITH, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  opencode: '@opencode/cli',
  omp: '@oh-my-pi/pi-coding-agent',
}

describe.skipIf(!HAS_CI)('ci.yml', () => {
  test('no job writes a harness version out: the install job reads them from tested-with.ts', () => {
    for (const pkg of Object.values(PACKAGES)) expect(text).not.toMatch(new RegExp(`${pkg.replace(/[/@]/g, c => `\\${c}`)}@\\d`))
  })

  test('the POSIX install job reads the versions from tested-with.ts instead of copying them', () => {
    const steps = workflow.jobs['posix-install']?.steps ?? []
    const script = steps.map(s => s.run ?? '').join('\n')
    expect(script).toContain('src/engine/update/tested-with.ts')
    for (const pkg of Object.values(PACKAGES)) expect(script).not.toMatch(new RegExp(`${pkg.replace(/[/@]/g, c => `\\${c}`)}@\\d`))
  })

  test('the checks and the install job run on macOS and Linux only, and the release waits for both', () => {
    const include = workflow.jobs['checks']?.strategy?.matrix?.include ?? []
    expect(include.map(i => i['name'])).toEqual(['macOS arm64', 'Linux x64'])
    expect((workflow.jobs['posix-install']?.strategy?.matrix?.include ?? []).map(i => i['runner'])).toEqual(['macos-latest', 'ubuntu-latest'])
    expect(Object.keys(workflow.jobs).sort()).toEqual(['checks', 'posix-install', 'release'])
    expect(text).not.toMatch(/windows-latest|pwsh|install\.ps1/)
    expect(workflow.jobs['release']?.needs).toEqual(['checks', 'posix-install'])
  })
})
