import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { Harness } from '../../src/core/events'

// .github/workflows/ci.yml cannot be run here; these tests pin what a push to a branch relies on: the install job
// installs the latest release of each harness, the jobs the release waits for exist, and a published release deploys
// the website through .github/workflows/pages.yml.

const FILE = join(import.meta.dir, '..', '..', '.github', 'workflows', 'ci.yml')
const HAS_CI = existsSync(FILE)
const text = HAS_CI ? readFileSync(FILE, 'utf8') : ''
const PAGES_FILE = join(import.meta.dir, '..', '..', '.github', 'workflows', 'pages.yml')
const HAS_PAGES = existsSync(PAGES_FILE)

interface Step { name?: string, id?: string, uses?: string, run?: string, with?: Record<string, string> }
interface Job {
  name?: string, needs?: string | string[], if?: string, uses?: string, outputs?: Record<string, string>
  permissions?: Record<string, string>, environment?: { name?: string }, steps?: Step[]
  strategy?: { matrix?: { include?: Array<Record<string, string>> } }
}
interface Workflow { on?: Record<string, unknown>, env?: Record<string, string>, jobs: Record<string, Job> }
const workflow = HAS_CI ? parse(text) as Workflow : { jobs: {} as Record<string, Job> } as Workflow
const pages = HAS_PAGES ? parse(readFileSync(PAGES_FILE, 'utf8')) as Workflow : { jobs: {} as Record<string, Job> } as Workflow

// The hosts the CI job installs; Qwen Code, Pi and AGY CLI join it with their own tasks.
const PACKAGES: Record<Exclude<Harness, 'qwen' | 'pi' | 'agy'>, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  opencode: '@opencode/cli',
  omp: '@oh-my-pi/pi-coding-agent',
}

const escape = (s: string): string => s.replace(/[/@.$]/g, c => `\\${c}`)

describe.skipIf(!HAS_CI)('ci.yml', () => {
  test('no job pins a harness version anywhere in the file', () => {
    for (const pkg of Object.values(PACKAGES)) expect(text).not.toMatch(new RegExp(`${escape(pkg)}@`))
  })

  test('the POSIX install job installs the latest release of each harness and reads no version file', () => {
    const steps = workflow.jobs['posix-install']?.steps ?? []
    const script = steps.map(s => s.run ?? '').join('\n')
    for (const pkg of Object.values(PACKAGES)) expect(script).toMatch(new RegExp(`(^|[\\s"'])${escape(pkg)}(?=[\\s"']|$)`, 'm'))
    expect(script).not.toMatch(/_VERSION\b|src\/engine\/update\/|GITHUB_ENV.*VERSION/)
    expect(steps.map(s => s.name ?? '')).not.toContain('Harness versions from tested-with.ts')
  })

  test('the checks and the install job run on macOS and Linux only, and the release waits for both', () => {
    const include = workflow.jobs['checks']?.strategy?.matrix?.include ?? []
    expect(include.map(i => i['name'])).toEqual(['macOS arm64', 'Linux x64'])
    expect((workflow.jobs['posix-install']?.strategy?.matrix?.include ?? []).map(i => i['runner'])).toEqual(['macos-latest', 'ubuntu-latest'])
    expect(Object.keys(workflow.jobs).sort()).toEqual(['checks', 'pages', 'posix-install', 'release'])
    expect(text).not.toMatch(/windows-latest|pwsh|install\.ps1/)
    expect(workflow.jobs['release']?.needs).toEqual(['checks', 'posix-install'])
  })

  test('the release says whether it published, on every way out of its script', () => {
    const release = workflow.jobs['release']
    expect(release?.outputs?.['published']).toBe('${{ steps.publish.outputs.published }}')
    const publish = (release?.steps ?? []).find(s => s.id === 'publish')
    const script = publish?.run ?? ''
    const lines = script.split('\n').map(l => l.trim())
    const exits = lines.flatMap((l, i) => (/^exit 0$/.test(l) ? [i] : []))
    expect(exits.length).toBeGreaterThan(0)
    for (const i of exits) expect(lines[i - 1]).toBe('echo "published=false" >> "$GITHUB_OUTPUT"')
    expect(lines.filter(Boolean).at(-1)).toBe('echo "published=true" >> "$GITHUB_OUTPUT"')
    expect(lines.filter(l => l.includes('published=')).length).toBe(exits.length + 1)
  })

  test('the pages job waits for the release, runs only when it published, and calls the Pages workflow', () => {
    const job = workflow.jobs['pages']
    expect([job?.needs].flat()).toEqual(['release'])
    expect(job?.if?.replace(/\s+/g, ' ')).toBe("needs.release.outputs.published == 'true'")
    expect(job?.uses).toBe('./.github/workflows/pages.yml')
    expect(job?.permissions).toEqual({ contents: 'read', pages: 'write', 'id-token': 'write' })
  })

  test('the release tree leaves out the website as well as the test suite', () => {
    expect((workflow.env?.['RELEASE_DROPS'] ?? '').split(/\s+/)).toEqual(['tests', 'bunfig.toml', 'site'])
  })
})

describe.skipIf(!HAS_PAGES)('pages.yml', () => {
  test('it runs by hand and when CI calls it', () => {
    expect(Object.keys(pages.on ?? {}).sort()).toEqual(['workflow_call', 'workflow_dispatch'])
  })

  test('the build job sets up the Bun of .bun-version, builds site/dist and uploads it as the Pages artifact', () => {
    const steps = pages.jobs['build']?.steps ?? []
    const uses = steps.map(s => s.uses ?? '')
    expect(uses).toContain('actions/configure-pages@v6')
    expect(steps.find(s => s.uses?.startsWith('oven-sh/setup-bun@'))?.with?.['bun-version-file']).toBe('.bun-version')
    expect(steps.some(s => /(^|\s)bun site\/build\.ts(\s|$)/.test(s.run ?? ''))).toBe(true)
    expect(steps.find(s => s.uses === 'actions/upload-pages-artifact@v5')?.with?.['path']).toBe('site/dist')
  })

  test('the deploy job deploys to the github-pages environment with the Pages permissions only', () => {
    const deploy = pages.jobs['deploy']
    expect([deploy?.needs].flat()).toEqual(['build'])
    expect(deploy?.environment?.name).toBe('github-pages')
    expect(deploy?.permissions).toEqual({ pages: 'write', 'id-token': 'write' })
    expect((deploy?.steps ?? []).map(s => s.uses)).toContain('actions/deploy-pages@v5')
  })
})
