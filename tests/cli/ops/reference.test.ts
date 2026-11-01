import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { COMMANDS, EXIT } from '../../../src/cli/router'
import { defaultConfig } from '../../../src/core/config'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { TXN_STEPS } from '../../../src/engine/txn'
import { INSTALL_PHASES } from '../../../src/engine/update/install-core'
import { configDescription, configLeaves, loadCommandInfos, referenceDocs, REFERENCE_DOCS } from '../../../src/engine/update/reference'
import { withSandbox } from '../../helpers/sandbox'
import { makeRepo } from './helpers'

const HOOKS_YAML = `hooks:
  - id: H01
    name: guard.bash
    blocking: deny
    failure: closed
    description: Deny destructive shell commands.
    bindings:
      claude: { event: tool.call, matcher: Bash, timeoutMs: 5000 }
      codex: { event: PreToolUse, matcher: [Bash, shell] }
      opencode: { event: permission.evaluate }
      omp: { event: tool_call }
    contract_test: tests/core/policy/bash-guard.test.ts
  - id: H14
    name: memory.capture
    blocking: none
    failure: open
    bindings:
      claude: { event: turn.complete, also: [{ event: session.end }], fallback: [{ event: SessionEnd, timeoutMs: 3000 }, { event: PostCompact }] }
      codex: { event: Stop, async: true }
      opencode: { unsupported: "no stop event; uses session.execution.succeeded" }
    contract_test: tests/memory/capture.test.ts
`

const STATUSLINE_YAML = 'claude:\n  rows: [[model, ctx], [git, mystery]]\n  compact: [[ctx]]\n  thresholds: { ctxWarn: 70, ctxCrit: 90 }\n  emoji: true\n  native: { slot: footer, items: [a, b] }\n'

const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/u

function docs(repo: string) {
  const c = loadCanonicalSync(join(repo, 'canonical'))
  return Object.fromEntries(referenceDocs({ canonical: c, commands: [{ name: 'demo', summary: 'Demo <x> | y', usage: 'Usage: buracle demo' }], exitCodes: { ok: 0, error: 1, partial: 2 } }).map(d => [d.path, d.content]))
}

describe('reference docs', () => {
  test('cli.md reads the router registry itself: every command in order, with its own summary and usage', async () => {
    const infos = await loadCommandInfos()
    expect(infos.exitCodes).toEqual({ ...EXIT })
    expect(infos.commands.map(c => c.name)).toEqual(COMMANDS.map(([n]) => n))
    for (const [name, load] of COMMANDS) {
      const mod = await load()
      expect(infos.commands.find(c => c.name === name)).toEqual({ name, summary: mod.summary, usage: mod.usage })
    }
  })

  test('every configuration key has a description', () => {
    const keys = ['repo', ...configLeaves(defaultConfig()).map(l => l.key)]
    const missing = keys.filter(k => configDescription(k) === undefined)
    expect(missing).toEqual([])
  })

  test('config.md lists every key with its default and the validator constraints', () => withSandbox(({ root }) => {
    const md = docs(makeRepo(root))['docs/reference/config.md'] as string
    for (const { key } of configLeaves(defaultConfig())) expect(md).toContain(`| \`${key}\` |`)
    expect(md).toContain('| `routing.strictness` | text: `enforce` · `nudge` · `off` | `enforce` |')
    expect(md).toContain('| `context.warnPct` | integer, 0–100 | `85` |')
    expect(md).toContain('| `plan.runaway.perPlan` | integer, ≥ 1 | `30` |')
    expect(md).toContain('| `effort.claude` | text: `auto` · `keep` · `low` · `medium` · `high` · `xhigh` | `auto` |')
    expect(md).toContain('| `permissions.enforce` | boolean (`true`/`false`) | `true` |')
    expect(md).toContain('| `repo` | text | not set (the running checkout) |')
    expect(md).toContain('reach them with the next `buracle install`')
    expect(configLeaves(defaultConfig()).map(l => l.key).filter(k => k.startsWith('memory.'))).toEqual(['memory.ui.port', 'memory.ui.autostart', 'memory.exclude'])
    expect(configDescription('memory.ui.autostart')).toContain('last harness session')
    expect(configDescription('memory.ui.port')).toContain('usage headroom')
    expect(configDescription('memory.ui.port')).toContain('no external API')
    expect(configDescription('memory.exclude')).toContain('owner/repo')
  }))

  test('hooks.md is generated from hooks.yaml (bindings, async flag, unsupported reason, contract test)', () => withSandbox(({ root }) => {
    const repo = makeRepo(root, { 'canonical/hooks.yaml': HOOKS_YAML })
    const md = docs(repo)['docs/reference/hooks.md'] as string
    expect(md).toContain('| H01 | `guard.bash` | `deny` | `closed` | `tool.call` · `Bash` | `PreToolUse` · `Bash \\| shell` | `permission.evaluate` | `tool_call` |')
    expect(md).toContain('| H14 | `memory.capture` | `none` | `open` | `turn.complete` | `Stop` · async | unsupported | — |')
    expect(md).toContain('| OpenCode | unsupported: no stop event; uses session.execution.succeeded | — | — | — |')
    expect(md).toContain('| Claude Code | `tool.call` | `Bash` | sync | 5000 ms |')
    expect(md).toContain('| Claude Code (also) | `session.end` | — | sync | — |')
    expect(md).toContain('| Claude Code (classic fallback) | `SessionEnd` | — | sync | 3000 ms |')
    expect(md).toContain('| Claude Code (classic fallback) | `PostCompact` | — | sync | — |')
    expect(md).toContain('- Blocks? yes: it can deny a tool call')
    expect(md).toContain('- If the hook fails: the call is denied (fail-closed)')
    expect(md).toContain('Contract test: `tests/core/policy/bash-guard.test.ts`')
    expect(md).toContain('Deny destructive shell commands.')
    const empty = docs(makeRepo(join(root, 'b')))['docs/reference/hooks.md'] as string
    expect(empty).toContain('defines no hooks yet')
  }))

  test('statusline.md describes every segment the real canonical/statusline.yaml uses', () => {
    const c = loadCanonicalSync(join(import.meta.dir, '..', '..', '..', 'canonical'))
    const md = referenceDocs({ canonical: c, commands: [], exitCodes: {} }).find(d => d.path === 'docs/reference/statusline.md')?.content ?? ''
    const segments = md.slice(md.indexOf('## Segments'), md.indexOf('\n## ', md.indexOf('## Segments') + 1))
    expect(segments).toContain('| `index` | The project\'s code indexes (codegraph and semble): ready, building, none, failed or off |')
    expect(segments).toContain('| `plan` | The bound spec/build plan: title, phase and done/total tasks (only while no workflow is visible) |')
    expect(segments).toContain('| `flow` | The running workflow: the band\'s one-row view')
    expect(segments).not.toContain('| `cm` |')
    expect(segments.split('\n').filter(l => l.endsWith('| — |'))).toEqual([])
  })

  test('statusline.md follows statusline.yaml', () => withSandbox(({ root }) => {
    const repo = makeRepo(root, { 'canonical/statusline.yaml': STATUSLINE_YAML })
    const md = docs(repo)['docs/reference/statusline.md'] as string
    expect(md).toContain('| 1 | `model` · `ctx` |')
    expect(md).toContain('| 2 | `git` · `mystery` |')
    expect(md).toContain('| `mystery` | — |')
    expect(md).toContain('| `ctx` | Context fill: bar, percentage, tokens/window and the auto-compaction point |')
    expect(md).toContain('Compact layout (`statusline.style: compact`)')
    expect(md).toContain('- Context thresholds: green below 70%, yellow below 90%, red above')
    expect(md).toContain('- Emoji: on (together with `statusline.emoji`)')
    expect(md).toContain('  - `items`: `a` · `b`')
  }))

  test('install.md lists every install phase, the engine\'s transaction steps, the merge law and its state files', () => withSandbox(({ root }) => {
    const md = docs(makeRepo(root))['docs/reference/install.md'] as string
    for (const p of INSTALL_PHASES) expect(md).toContain(`**${p.title}** (\`${p.id}\`)`)
    const at = TXN_STEPS.map((s, i) => md.indexOf(`${i + 1}. **${s.title}** (\`${s.id}\`): ${s.detail}`))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    for (const f of ['~/.buracle/state/owned.json', '~/.buracle/journal/<txn>.json', '~/.buracle/backups/<txn>/', '~/.buracle/state/txn.lock', '~/.buracle/state/runtime-config.json', '~/.buracle/state/health.json', '~/.buracle/rules/paths/<id>.md', '~/.agents/skills/<id>', '~/.local/bin/buracle', 'harness/.manifest.json']) expect(md).toContain(`\`${f}\``)
    expect(md).toContain(`m='<BURACLE_HOME>/runtime/<id>/src/cli/main.ts'`)
    expect(md).toContain('omp plugin uninstall buracle-omp')
    expect(md).toContain('those an older Buracle release wrote included')
    expect(md).toContain('| `~/.buracle/state/health.json` | MCP server and tool health: the last `buracle doctor` and `buracle update` results, and the servers `buracle mcp run` could not start (down for 10 minutes); routing and the capability card skip servers that are `down` |')
    expect(md).toContain('| An enforced key with another value, or removed (the harnesses\' no-approval mode while `permissions.enforce` is on, and the Claude Code env keys in `~/.claude/settings.json`) | Buracle\'s value is written again')
    expect(md).toContain('| A soft key with another value, or removed (the default reasoning effort) | The user\'s value (or removal) is kept and reported as skipped ("kept user value"), not as a conflict')
  }))

  test('cli.md escapes summaries, plan-format.md lists every status; no doc has machine paths', () => withSandbox(({ root, home }) => {
    const all = docs(makeRepo(root))
    expect(Object.keys(all).sort()).toEqual(REFERENCE_DOCS.map(d => `docs/reference/${d}.md`).sort())
    expect(all['docs/reference/cli.md']).toContain('| [`demo`](#buracle-demo) | Demo &lt;x&gt; \\| y |')
    expect(all['docs/reference/cli.md']).toContain('| `2` | partial success, or the user needs to act |')
    for (const s of ['PENDING', 'APPROVED', 'IN_PROGRESS', 'COMPLETE', 'VERIFIED', 'SAVED']) expect(all['docs/reference/plan-format.md']).toContain(`| \`${s}\` |`)
    expect(all['docs/reference/plan-format.md']).toContain('`buracle plan init --type feature --title "Example plan"`')
    for (const text of Object.values(all)) {
      expect(text).not.toContain(home)
      expect(text).not.toContain(root)
      expect(text.endsWith('\n')).toBe(true)
      expect(text).not.toMatch(/[ \t]+$/m)
    }
  }))

  test('the reference docs and every key description are English (no Turkish letters)', () => withSandbox(({ root }) => {
    const all = docs(makeRepo(root, { 'canonical/hooks.yaml': HOOKS_YAML, 'canonical/statusline.yaml': STATUSLINE_YAML }))
    const hits = Object.entries(all).flatMap(([path, text]) => text.split('\n').flatMap((line, i) => (TURKISH_LETTERS.test(line) ? [`${path}:${i + 1}: ${line}`] : [])))
    expect(hits).toEqual([])
    const keys = ['repo', 'harnesses.codex.enabled', ...configLeaves(defaultConfig()).map(l => l.key)]
    expect(keys.filter(k => TURKISH_LETTERS.test(configDescription(k) ?? ''))).toEqual([])
    expect(['the dotless ı', 'an s-cedilla ş', 'plain ASCII'].map(s => TURKISH_LETTERS.test(s))).toEqual([true, true, false])
  }))
})
