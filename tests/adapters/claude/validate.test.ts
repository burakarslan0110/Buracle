import { describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildClaude, packageVersion, readTree } from '../../../src/adapters/claude/build'
import { TEMPLATE_REL } from '../../../src/adapters/claude/constants'
import { devContext, syncTree } from '../../../src/adapters/claude/dev-build'
import { readValidateReport, validateFinding } from '../../../src/adapters/claude/doctor'
import { generatePlugin } from '../../../src/adapters/claude/plugin'
import * as paths from '../../../src/engine/paths'
import { run, which } from '../../../src/engine/proc'
import { withSandbox } from '../../helpers/sandbox'

const REPO = paths.repoRoot()
const CLAUDE = which('claude')
const HAS_MODULE = existsSync(join(REPO, TEMPLATE_REL, 'register.tsx'))

async function validate(dir: string): Promise<{ code: number, stdout: string, stderr: string }> {
  return run([CLAUDE as string, 'plugin', 'validate', '--strict', '--json', dir], { timeoutMs: 120_000 })
}

async function buildRepoCopy(root: string): Promise<string> {
  const out = join(root, 'harness', 'claude')
  mkdirSync(out, { recursive: true })
  syncTree(out, await buildClaude(devContext()))
  mkdirSync(join(root, '.claude-plugin'))
  copyFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), join(root, '.claude-plugin', 'marketplace.json'))
  return out
}

describe('claude plugin validate --strict --json', () => {
  test.skipIf(CLAUDE === undefined)('manifest, hooks.json and .mcp.json of the build validate (mod left out)', async () => {
    await withSandbox(async sb => {
      const ctx = devContext()
      const out = join(sb.root, 'plugin')
      mkdirSync(out)
      syncTree(out, generatePlugin({
        canonical: ctx.canonical,
        buracleVersion: packageVersion(REPO),
        coreFiles: readTree(join(REPO, 'src', 'core'), rel => rel.endsWith('.ts')),
        templateFiles: readTree(join(REPO, TEMPLATE_REL)).filter(f => f.path !== 'register.tsx'),
      }))
      expect(validateFinding(await validate(out))).toEqual({ level: 'ok', check: 'plugin validate', detail: expect.any(String) })
    })
  }, 180_000)

  test.skipIf(CLAUDE === undefined || !HAS_MODULE)('the full plugin and the repo marketplace pass strict validation (exit 0, no error, no warning)', async () => {
    await withSandbox(async sb => {
      const out = await buildRepoCopy(join(sb.root, 'repo'))
      const plugin = await validate(out)
      const report = readValidateReport(plugin.stdout)
      expect(report).toBeDefined()
      expect(report?.problems).toEqual([])
      expect(report?.gates).toBeGreaterThan(0)
      expect(plugin.code, plugin.stdout).toBe(0)

      const r = await validate(join(sb.root, 'repo'))
      const m = JSON.parse(r.stdout) as { success: boolean, manifest: { errors: unknown[], warnings: unknown[] } }
      expect(m.manifest.errors).toEqual([])
      expect(m.manifest.warnings).toEqual([])
      expect(r.code, r.stdout).toBe(0)
    })
  }, 180_000)

  test.skipIf(CLAUDE === undefined || !HAS_MODULE)('every gating hook of the mod has a .catch (DESIGN §15)', async () => {
    await withSandbox(async sb => {
      const out = await buildRepoCopy(join(sb.root, 'repo'))
      const report = readValidateReport((await validate(out)).stdout)
      expect(report?.uncaught).toEqual([])
    })
  }, 180_000)
})
