import { redact } from './memory/index'
import { fold } from './policy/text'

export interface ReceiptEdit { path: string; added: number; removed: number }
export interface ReceiptCommand { command: string; failed: boolean; check: boolean }

export interface ReceiptState {
  edits: Record<string, { added: number, removed: number }>
  commands: ReceiptCommand[]
  lastEditSeq: number
  lastCheckSeq: number
  seq: number
  failStreak: { command: string, count: number } | undefined
  removedTexts: Record<string, string[]>
  flipFlops: Record<string, number>
}

export function emptyReceipt(): ReceiptState {
  return { edits: {}, commands: [], lastEditSeq: -1, lastCheckSeq: -1, seq: 0, failStreak: undefined, removedTexts: {}, flipFlops: {} }
}

const PROSE = /\.(?:md|mdx|txt|rst|adoc|json|ya?ml|toml|ini|cfg|conf|csv|svg|png|jpe?g|gif|lock|env\.example)$/iu

const CHECK = new RegExp([
  String.raw`\b(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?(?:test|check|lint|typecheck|type-check|tsc|verify|ci)\b`,
  String.raw`\bbunx?\s+(?:test|tsc|vitest|jest|eslint|biome|prettier\s+--check)\b`,
  String.raw`\bnpx\s+(?:tsc|vitest|jest|eslint|biome|playwright\s+test)\b`,
  String.raw`(?:^|[;&|(]\s*|\b(?:npx|bunx|uvx|pnpx|exec|time|xargs)\s+)(?:tsc|vitest|jest|mocha|ava|eslint|biome\s+check|ruff\s+check|ruff|mypy|pyright|pytest|tox|nox|phpunit|rspec|shellcheck|golangci-lint)\b`,
  String.raw`\bpython3?\s+-m\s+(?:pytest|unittest|mypy)\b`,
  String.raw`\bgo\s+(?:test|vet|build)\b`,
  String.raw`\bcargo\s+(?:test|check|clippy|build)\b`,
  String.raw`\b(?:make|just)\s+(?:test|check|lint|verify|ci)\b`,
  String.raw`\bgradlew?\s+(?:test|check|build)\b`,
  String.raw`\bmvn\s+(?:test|verify)\b`,
  String.raw`\bdotnet\s+(?:test|build)\b`,
  String.raw`\bclaude\s+plugin\s+(?:test|validate)\b`,
  String.raw`\bburacle\s+(?:build\s+--check|doctor|skills\s+lint|rules\s+lint|lsp\s+check)\b`,
  String.raw`\bbun\s+src/cli/main\.ts\s+(?:build\s+--check|doctor)\b`,
].join('|'), 'iu')

export function isCheckCommand(command: string): boolean {
  return CHECK.test(command)
}

export function needsVerification(path: string): boolean {
  return !PROSE.test(path)
}

export function lineDelta(oldText: string, newText: string): { added: number, removed: number } {
  if (oldText === newText) return { added: 0, removed: 0 }
  const a = newText === '' ? [] : newText.split('\n')
  const r = oldText === '' ? [] : oldText.split('\n')
  let head = 0
  while (head < a.length && head < r.length && a[head] === r[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < r.length - head && a[a.length - 1 - tail] === r[r.length - 1 - tail]) tail++
  return { added: a.length - head - tail, removed: r.length - head - tail }
}

export function noteEdit(s: ReceiptState, e: ReceiptEdit & { removedText?: string, addedText?: string }): { state: ReceiptState, alarm?: string } {
  const prev = s.edits[e.path] ?? { added: 0, removed: 0 }
  const edits = { ...s.edits, [e.path]: { added: prev.added + Math.max(0, e.added), removed: prev.removed + Math.max(0, e.removed) } }
  const removedTexts = { ...s.removedTexts }
  const flipFlops = { ...s.flipFlops }
  let alarm: string | undefined
  const added = e.addedText?.trim()
  if (added !== undefined && added !== '' && (removedTexts[e.path] ?? []).includes(added)) {
    flipFlops[e.path] = (flipFlops[e.path] ?? 0) + 1
    if (flipFlops[e.path] === 2) alarm = `${e.path}: the same change was undone and redone twice (you may be going in circles; rethink the approach)`
  }
  const removed = e.removedText?.trim()
  if (removed !== undefined && removed !== '') removedTexts[e.path] = [...(removedTexts[e.path] ?? []), removed].slice(-6)
  const state: ReceiptState = { ...s, edits, removedTexts, flipFlops, lastEditSeq: s.seq, failStreak: undefined }
  return alarm !== undefined ? { state, alarm } : { state }
}

export function noteCommand(s: ReceiptState, command: string, failed: boolean): { state: ReceiptState, alarm?: string } {
  const check = isCheckCommand(command)
  const commands = [...s.commands, { command: command.slice(0, 300), failed, check }].slice(-200)
  const seq = s.seq + 1
  let failStreak = s.failStreak
  let alarm: string | undefined
  if (failed) {
    failStreak = failStreak !== undefined && failStreak.command === command ? { command, count: failStreak.count + 1 } : { command, count: 1 }
    if (failStreak.count === 3) alarm = `the same command failed 3 times in a row: \`${command.length > 80 ? `${command.slice(0, 77)}...` : command}\` (do not run it again as is; read the output and change your hypothesis)`
  } else failStreak = undefined
  const state: ReceiptState = { ...s, commands, seq, failStreak, lastCheckSeq: check && !failed ? seq : s.lastCheckSeq }
  return alarm !== undefined ? { state, alarm } : { state }
}

export interface ReceiptChange { path: string; removed: string; added: string }

export const RECEIPT_TEXT_MAX = 2_000

export function noteChanges(s: ReceiptState, changes: ReadonlyArray<ReceiptChange>): { state: ReceiptState, alarm?: string } {
  let state = s
  let alarm: string | undefined
  for (const c of changes) {
    if (typeof c.path !== 'string' || c.path === '') continue
    const removed = typeof c.removed === 'string' ? c.removed : ''
    const added = typeof c.added === 'string' ? c.added : ''
    const delta = lineDelta(removed, added)
    const r = noteEdit(state, { path: c.path, added: delta.added, removed: delta.removed, removedText: removed.slice(0, RECEIPT_TEXT_MAX), addedText: added.slice(0, RECEIPT_TEXT_MAX) })
    state = r.state
    alarm ??= r.alarm
  }
  return alarm !== undefined ? { state, alarm } : { state }
}

function countOf(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0
}

function seqOf(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? Math.floor(x) : -1
}

function plainRecord(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
}

export function parseReceipt(x: unknown): ReceiptState {
  const r = plainRecord(x)
  const out = emptyReceipt()
  for (const [path, e] of Object.entries(plainRecord(r['edits']))) {
    const v = plainRecord(e)
    out.edits[path] = { added: countOf(v['added']), removed: countOf(v['removed']) }
  }
  if (Array.isArray(r['commands'])) {
    for (const c of r['commands'] as unknown[]) {
      const v = plainRecord(c)
      if (typeof v['command'] !== 'string') continue
      out.commands.push({ command: v['command'].slice(0, 300), failed: v['failed'] === true, check: v['check'] === true })
    }
    out.commands = out.commands.slice(-200)
  }
  out.lastEditSeq = seqOf(r['lastEditSeq'])
  out.lastCheckSeq = seqOf(r['lastCheckSeq'])
  out.seq = countOf(r['seq'])
  const streak = plainRecord(r['failStreak'])
  if (typeof streak['command'] === 'string') out.failStreak = { command: streak['command'], count: countOf(streak['count']) }
  for (const [path, list] of Object.entries(plainRecord(r['removedTexts']))) {
    if (Array.isArray(list)) out.removedTexts[path] = (list as unknown[]).filter((t): t is string => typeof t === 'string').map(t => t.slice(0, RECEIPT_TEXT_MAX)).slice(-6)
  }
  for (const [path, n] of Object.entries(plainRecord(r['flipFlops']))) out.flipFlops[path] = countOf(n)
  return out
}

export function longTurnText(durationMs: number, notifyAfterSec: number, run = ''): string | undefined {
  if (!Number.isFinite(durationMs) || !Number.isFinite(notifyAfterSec) || notifyAfterSec <= 0 || durationMs < notifyAfterSec * 1000) return undefined
  return `Turn finished after ${Math.max(1, Math.round(durationMs / 60_000))} min${run !== '' ? `: ${run}` : ''}`
}

export function unverified(s: ReceiptState): boolean {
  const code = Object.keys(s.edits).some(needsVerification)
  return code && s.lastCheckSeq <= s.lastEditSeq
}

const CLAIM = /\b(?:tests?\s+(?:pass|passed|are\s+green|green)|all\s+(?:tests\s+)?pass(?:es|ed)?|fixed|works\s+now|it\s+works|verified|done\s+and\s+verified)\b|\b(?:testler(?:in\s+tamami)?\s+(?:gecti|geciyor|yesil)|duzeltildi|calisiyor|dogrulandi|tamamlandi)\b(?!\s+m[iu]\b)/

export function claimsSuccess(answer: string): boolean {
  return CLAIM.test(fold(answer))
}

export interface ReceiptSummary { line: string; warn: boolean }

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function receiptLine(s: ReceiptState, answer = ''): ReceiptSummary | undefined {
  const files = Object.entries(s.edits)
  const cmds = s.commands
  if (files.length === 0 && cmds.length === 0) return undefined
  const parts: string[] = []
  if (files.length > 0) {
    const add = files.reduce((n, [, e]) => n + e.added, 0)
    const rem = files.reduce((n, [, e]) => n + e.removed, 0)
    parts.push(`${plural(files.length, 'file', 'files')} (+${add} −${rem})`)
  }
  if (cmds.length > 0) {
    const failed = cmds.filter(c => c.failed).length
    parts.push(`${plural(cmds.length, 'command', 'commands')}${failed > 0 ? ` (${failed} failed)` : ''}`)
  }
  const checks = cmds.filter(c => c.check)
  let warn = false
  if (unverified(s)) {
    warn = true
    parts.push(claimsSuccess(answer) ? '⚠ success claimed without evidence: no test or check ran after the change' : '⚠ unverified change')
  } else if (checks.length > 0) {
    const lastCheck = checks[checks.length - 1] as ReceiptCommand
    parts.push(lastCheck.failed ? '✗ last check failed' : '✓ checked')
    if (lastCheck.failed) warn = true
  }
  return { line: `Buracle · ${parts.join(' · ')}`, warn }
}

function text(x: unknown): string {
  return typeof x === 'string' ? x : ''
}

export function editOf(tool: string, input: Readonly<Record<string, unknown>>): { path: string, removed: string, added: string } | undefined {
  const path = text(input['file_path']) || text(input['notebook_path'])
  if (path === '') return undefined
  if (tool === 'Edit') return { path, removed: text(input['old_string']), added: text(input['new_string']) }
  if (tool === 'Write') return { path, removed: '', added: text(input['content']) }
  if (tool === 'NotebookEdit') return { path, removed: '', added: text(input['new_source']) }
  let removed = ''
  let added = ''
  if (tool === 'MultiEdit' && Array.isArray(input['edits'])) {
    for (const ed of input['edits'] as unknown[]) {
      if (ed === null || typeof ed !== 'object') continue
      const o = ed as Record<string, unknown>
      removed += `${text(o['old_string'])}\n`
      added += `${text(o['new_string'])}\n`
    }
  }
  return { path, removed, added }
}

export function maskSecrets(value: unknown, maxChars: number, depth = 0): { value: unknown, count: number } {
  if (depth > 12) return { value, count: 0 }
  if (typeof value === 'string') {
    if (value.length < 16 || value.length > maxChars) return { value, count: 0 }
    const r = redact(value)
    return r.count > 0 ? { value: r.text, count: r.count } : { value, count: 0 }
  }
  if (value === null || typeof value !== 'object') return { value, count: 0 }
  let count = 0
  if (Array.isArray(value)) {
    const out = value.map(v => { const r = maskSecrets(v, maxChars, depth + 1); count += r.count; return r.value })
    return count > 0 ? { value: out, count } : { value, count: 0 }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) { const r = maskSecrets(v, maxChars, depth + 1); count += r.count; out[k] = r.value }
  return count > 0 ? { value: out, count } : { value, count: 0 }
}

export function shellFailed(result: unknown): boolean {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false
  const r = result as Record<string, unknown>
  for (const k of ['exitCode', 'returnCode', 'exit_code', 'code']) {
    const v = r[k]
    if (typeof v === 'number') return v !== 0
  }
  return r['interrupted'] === true
}
