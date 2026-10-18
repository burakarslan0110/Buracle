import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { HARNESSES } from '../../../src/core/events'
import type { StatusLayout } from '../../../src/core/status/model'
import { SEGMENT_IDS, rows } from '../../../src/core/status/render'
import { CanonicalError, loadCanonicalSync } from '../../../src/engine/canonical'
import { canonicalDir } from '../../../src/engine/paths'
import { FALLBACK_LAYOUT, loadLayout, validateLayout } from '../../../src/usage/bar'

const FILE = join(canonicalDir(), 'statusline.yaml')
const doc = parseYaml(readFileSync(FILE, 'utf8')) as Record<string, StatusLayout>

const CODEX_STATUS_LINE_IDS = [
  'model', 'model-name', 'model-with-reasoning', 'reasoning', 'current-dir', 'project-name', 'project', 'project-root',
  'hostname', 'git-branch', 'pull-request-number', 'branch-changes', 'run-state', 'status', 'permissions',
  'approval-mode', 'approval', 'context-remaining', 'context-used', 'context-usage', 'five-hour-limit', 'weekly-limit',
  'codex-version', 'context-window-size', 'used-tokens', 'total-input-tokens', 'total-output-tokens', 'thread-credits',
  'estimated-thread-cost', 'thread-id', 'session-id', 'fast-mode', 'daybreak', 'raw-output', 'thread-name',
  'thread-title', 'workspace-headline', 'task-progress',
]
const CODEX_TITLE_IDS = [
  'app-name', 'project-name', 'project', 'current-dir', 'activity', 'spinner', 'run-state', 'status', 'thread-name',
  'thread-title', 'thread', 'git-branch', 'context-remaining', 'context-used', 'context-usage', 'five-hour-limit',
  'weekly-limit', 'codex-version', 'used-tokens', 'total-input-tokens', 'total-output-tokens', 'thread-credits',
  'estimated-thread-cost', 'thread-id', 'session-id', 'fast-mode', 'daybreak', 'model', 'model-name',
  'model-with-reasoning', 'reasoning', 'task-progress',
]
const OMP_SEGMENT_IDS = [
  'pi', 'status', 'model', 'mode', 'path', 'git', 'pr', 'subagents', 'token_in', 'token_out', 'token_total', 'token_rate',
  'cost', 'context_pct', 'context_total', 'time_spent', 'time', 'session', 'hostname', 'cache_read', 'cache_write',
  'cache_hit', 'session_name', 'usage', 'collab', 'stream', 'vim',
]
const WINDOW_LABELS = ['5h', '1d', '7d', '30d']

describe('canonical/statusline.yaml', () => {
  test('one valid StatusLayout per harness', () => {
    expect(Object.keys(doc).sort()).toEqual([...HARNESSES].sort())
    for (const h of HARNESSES) {
      expect({ h, errors: validateLayout(doc[h]) }).toEqual({ h, errors: [] })
      expect(doc[h]?.thresholds).toEqual({ ctxWarn: 75, ctxCrit: 90 })
    }
  })

  test('rows only use Buracle segment ids or window labels', () => {
    const known = new Set<string>([...SEGMENT_IDS, ...WINDOW_LABELS])
    for (const h of HARNESSES) {
      const l = doc[h] as StatusLayout
      for (const id of [...l.rows.flat(), ...(l.compact ?? []).flat(), ...Object.values(l.native?.setStatus ?? {}).flat()]) {
        expect({ h, id, known: known.has(id) }).toEqual({ h, id, known: true })
      }
    }
  })

  test('claude: full rows (DESIGN §6.3) and compact rows', () => {
    expect(doc.claude?.rows).toEqual([['model', 'ctx', '5h', '7d', 'month', 'cost'], ['git', 'dir', 'mem', 'index', 'flow', 'plan', 'upd', 'hooks']])
    expect(doc.claude?.compact?.length).toBe(1)
  })

  test('O3: every layout (rows and compact) carries Buracle\'s hook health, which shows only while something is wrong', () => {
    for (const h of HARNESSES) {
      const l = doc[h] as StatusLayout
      for (const [which, rowsOf] of [['rows', l.rows], ['compact', l.compact]] as const) {
        if (rowsOf === undefined) continue
        expect({ h, which, hooks: rowsOf.flat().includes('hooks') }).toEqual({ h, which, hooks: true })
      }
    }
  })

  test('no layout names the retired Context Mode segment (cm)', () => {
    for (const h of HARNESSES) {
      const l = doc[h] as StatusLayout
      for (const rowsOf of [l.rows, l.compact]) expect(rowsOf?.flat() ?? []).not.toContain('cm')
    }
    expect(FALLBACK_LAYOUT.rows.flat()).not.toContain('cm')
  })

  test('every layout shows the running workflow and the code index state, the workflow on the row of the plan it replaces', () => {
    for (const h of HARNESSES) {
      const l = doc[h] as StatusLayout
      for (const [which, rowsOf] of [['rows', l.rows], ['compact', l.compact]] as const) {
        if (rowsOf === undefined) continue
        const ids = rowsOf.flat()
        expect({ h, which, flow: ids.includes('flow'), index: ids.includes('index') }).toEqual({ h, which, flow: true, index: true })
        const planRow = rowsOf.find(r => r.includes('plan'))
        if (planRow !== undefined) expect({ h, which, sameRow: planRow.includes('flow') }).toEqual({ h, which, sameRow: true })
      }
    }
  })

  test('codex: native footer and terminal title ids exist in codex 0.161.0', () => {
    const n = doc.codex?.native
    expect(n?.status_line).toEqual(['model-with-reasoning', 'context-used', 'five-hour-limit', 'weekly-limit', 'git-branch', 'branch-changes', 'task-progress', 'run-state'])
    for (const id of n?.status_line ?? []) expect(CODEX_STATUS_LINE_IDS).toContain(id)
    expect(n?.terminal_title?.length).toBeGreaterThan(0)
    for (const id of n?.terminal_title ?? []) expect(CODEX_TITLE_IDS).toContain(id)
    expect(doc.codex?.rows.length).toBe(1)
  })

  test('omp: native segments exist in omp 18.8.3 and the status keys are buracle.budget / buracle.hooks / buracle.mem', () => {
    const n = doc.omp?.native
    expect(n?.preset).toBe('custom')
    expect(n?.leftSegments).toEqual(['model', 'path', 'git', 'pr', 'subagents'])
    expect(n?.rightSegments).toEqual(['usage', 'context_pct', 'cost', 'status'])
    for (const id of [...(n?.leftSegments ?? []), ...(n?.rightSegments ?? [])]) expect(OMP_SEGMENT_IDS).toContain(id)
    expect(n?.showHookStatus).toBe(false)
    expect(Object.keys(n?.setStatus ?? {})).toEqual(['buracle.budget', 'buracle.hooks', 'buracle.mem'])
    expect(n?.setStatus).toEqual({ 'buracle.budget': ['month'], 'buracle.hooks': ['hooks'], 'buracle.mem': ['mem'] })
  })

  test('opencode: the status line keeps the footer slot; the slot above the prompt is the workflow band\'s', () => {
    expect(doc.opencode?.native).toEqual({ slot: 'prompt.footer.status' })
    for (const h of HARNESSES) expect(JSON.stringify(doc[h]?.native ?? {})).not.toContain('session.composer.top')
  })

  test('the canonical loader and loadLayout read the same data', () => {
    let bundle: ReturnType<typeof loadCanonicalSync> | undefined
    try {
      bundle = loadCanonicalSync()
    } catch (e) {
      if (!(e instanceof CanonicalError) || e.problems.some(p => /statusline|pricing/.test(p))) throw e
    }
    if (bundle !== undefined) expect(bundle.statusline).toEqual(doc)
    for (const h of HARNESSES) expect(loadLayout(h)).toEqual(doc[h] as StatusLayout)
    expect(loadLayout('claude', join(canonicalDir(), 'missing.yaml'))).toEqual(FALLBACK_LAYOUT)
  })

  test('every layout renders an empty bar without errors', () => {
    for (const h of HARNESSES) expect(rows({ harness: h, windows: [] }, doc[h] as StatusLayout, 80, 0)).toEqual([])
  })
})

describe('validateLayout', () => {
  test('reports shape problems', () => {
    expect(validateLayout(null)).toEqual(['expected a mapping'])
    expect(validateLayout({ rows: [['model', 1]], thresholds: { ctxWarn: 'x' }, emoji: 'yes', compact: 'no', native: [] })).toEqual([
      'rows: expected a list of lists of segment ids',
      'compact: expected a list of lists of segment ids',
      'thresholds: expected { ctxWarn, ctxCrit } numbers',
      'emoji: expected a boolean',
      'native: expected a mapping',
    ])
  })
})
