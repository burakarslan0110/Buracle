import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { assembleFiles, TESTED_WITH, writeAssembly } from '../../../src/adapters/claude/template/dev-assemble'
import { claudeVersionGate, claudeVersionText } from '../../helpers/claude-version'
import { withSandbox } from '../../helpers/sandbox'

const CLAUDE = Bun.which('claude')

const GATE = CLAUDE === null || process.env['BURACLE_SKIP_CLAUDE_CLI'] === '1' ? undefined : claudeVersionGate(claudeVersionText(CLAUDE))
const RUNS = CLAUDE !== null && GATE?.runs === true
if (GATE?.note !== undefined) console.warn(`claude plugin checks: ${GATE.note}`)

function isolatedEnv(home: string, xdg: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_DIRS', 'BURACLE_SESSION_ID', 'BURACLE_HARNESS']) delete env[k]
  return { ...env, HOME: home, XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: xdg, XDG_STATE_HOME: xdg, XDG_CACHE_HOME: xdg }
}

describe(`claude ${GATE?.version || TESTED_WITH} checks on the assembled mod`, () => {
  (RUNS ? test : test.skip)('claude plugin validate --strict and claude plugin test pass', async () => {
    await withSandbox(({ root, home }) => {
      const dir = join(root, 'plugin')
      const xdg = join(root, 'xdg')
      mkdirSync(xdg, { recursive: true })
      writeAssembly(dir, assembleFiles())
      const env = isolatedEnv(home, xdg)
      const validate = Bun.spawnSync([CLAUDE ?? 'claude', 'plugin', 'validate', '--strict', '--json', dir], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 })
      const report = validate.stdout.toString()
      expect(validate.exitCode, report).toBe(0)
      const parsed = JSON.parse(report) as { success: boolean; contents: Array<{ gatingHooks: Array<{ hook: string; hasCatch: boolean }> }> }
      expect(parsed.success).toBe(true)
      const gates = parsed.contents.flatMap(c => c.gatingHooks)
      for (const hook of [
        'tool.call{tool=Bash|Monitor|PowerShell}', 'tool.call{tool=/"^mcp__(?:plugin_[^_]+_)?context-mode__ctx_(?:execute|execute_file|batch_execute)$"/}',
        'tool.call{tool=/"^(?:Edit|Write|MultiEdit|NotebookEdit)$"/}', 'tool.call{tool=/"^(?:Read|Grep|Glob|mcp__.+)$"/}',
        'tool.call{tool=/"^(?:Skill|Agent|TodoWrite|TaskCreate|TaskUpdate)$"/}', 'session.compact',
        'command.run{command=buracle-ping|buracle-status|buracle|remember|buracle-remember|brain|buracle-brain|aside|buracle-aside}', 'command.run{command=/"^buracle:[a-z][a-z0-9-]*$"/}',
        'command.run{command=buracle:buracle}',
      ]) {
        expect(gates.find(g => g.hook === hook)?.hasCatch, hook).toBe(true)
      }
      expect(report).toContain('declares state: buracle.band')
      expect(gates.filter(g => !g.hasCatch).map(g => g.hook)).toEqual([])
      const kit = Bun.spawnSync([CLAUDE ?? 'claude', 'plugin', 'test', dir], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', timeout: 170_000 })
      const output = `${kit.stdout.toString()}${kit.stderr.toString()}`
      expect(kit.exitCode, output).toBe(0)
      expect(output).toMatch(/\b0 fail\b/)
    })
  }, 300_000)
})
