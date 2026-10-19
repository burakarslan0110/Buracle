import { chmodSync, closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Harness } from '../core/events'
import { atomicWriteSync, readJsonSafeSync, realPath, sha256 } from './fsx'
import { unifiedDiff } from './diff'
import { breakStaleLock, lockSnapshot, lockToken, lookUpProcess, releaseLockFile } from './lockfile'
import {
  getIn, jsoncParse, jsoncSet, mdBlockGet, mdBlockRemove, mdBlockUpsert, parseKeyPath, stableStringify, tomlNormalize,
  tomlParse, tomlPatchTables, tomlRemove, tomlRenameTable, valueHash, withoutValueAt, withValueAt, yamlAliasAt, yamlParse, yamlParseMerged, yamlPathProblem, yamlSet, type KeyPath,
} from './merge'
import * as paths from './paths'
import { run } from './proc'
import { log } from './log'

export type Op =
  | { kind: 'file'; path: string; content: string; mode?: number; owner: string }
  | ({ kind: 'json-merge'; path: string; set: Record<string, unknown>; owner: string } & KeyPolicy)
  | ({ kind: 'jsonc-merge'; path: string; set: Record<string, unknown>; owner: string } & KeyPolicy)
  | ({ kind: 'yaml-merge'; path: string; set: Record<string, unknown>; owner: string } & KeyPolicy)
  | ({ kind: 'toml-tables'; path: string; tables: Record<string, Record<string, unknown>>; keys?: Record<string, unknown>; owner: string; ignore?: Record<string, string[]> } & KeyPolicy)
  | { kind: 'md-block'; path: string; id: string; content: string; owner: string }
  | { kind: 'symlink'; path: string; target: string; owner: string }
  | { kind: 'remove'; path: string; owner: string; forget?: boolean }
  | { kind: 'exec'; argv: string[]; undo?: string[]; owner: string; idempotentCheck?: string[]; soft?: boolean }
  | JsonListMergeOp
  | TomlRekeyOp

export type KeyPolicy = { enforce?: string[]; soft?: string[] }

export type TomlRekeyOp = {
  kind: 'toml-rekey'; path: string; owner: string
  drops?: Array<{ table: string[]; value: Record<string, unknown> }>
  moves?: Array<{ from: string[]; to: string[]; value: Record<string, unknown> }>
}

export interface Plan { id: string; harness: Harness | 'core'; ops: Op[]; cleanupKeys?: Array<{ path: string, pointer: string }> }

export type JsonListMergeOp = {
  kind: 'json-list-merge'
  path: string
  pointer: string
  items: unknown[]
  identity: string | readonly string[]
  owner: string
  format?: 'json' | 'jsonc'
}

export const LIST_IDENTITY_HASH = '$hash'

export interface ApplyOptions {
  dryRun?: boolean
  restore?: boolean | ((op: Op) => boolean)
  takeOwnership?: boolean
  run?: string
}

export interface ApplyResult {
  txn: string; applied: number; skipped: Array<{ op: Op, reason: string }>; conflicts: Array<{ op: Op, detail: string, removed?: true }>
  warnings: string[]
  recovered?: string[]
}

export class TxnInterruptedError extends Error {
  readonly signal: string
  readonly txn: string
  readonly exitCode: number
  readonly interrupted = true
  constructor(signal: string, txn: string, message: string) {
    super(message)
    this.name = 'TxnInterruptedError'
    this.signal = signal
    this.txn = txn
    this.exitCode = 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15)
  }
}

export function isTxnInterrupted(e: unknown): e is TxnInterruptedError {
  return e instanceof TxnInterruptedError || (e !== null && typeof e === 'object' && (e as { interrupted?: unknown }).interrupted === true && typeof (e as { signal?: unknown }).signal === 'string')
}

export type LedgerKind = 'file' | 'symlink' | 'json' | 'jsonc' | 'yaml' | 'toml-table' | 'toml-key' | 'md-block' | 'json-list' | 'jsonc-list' | 'cleanup'

export interface LedgerListItem {
  id: string
  sha256: string
  adopted?: boolean
}

export interface LedgerEntry {
  owner: string
  sha256: string
  path: string
  pointer?: string
  writtenAt: string
  kind: LedgerKind
  segs?: string[]
  ignore?: string[]
  adopted?: boolean
  created?: string[]
  identity?: string | string[]
  items?: LedgerListItem[]
  absentBefore?: boolean
  displaced?: { value: unknown }
  soft?: boolean
}
export type Ledger = Record<string, LedgerEntry>

export function ledgerKey(path: string, pointer?: string): string {
  return pointer === undefined ? path : `${path}#${pointer}`
}

export function pointerOf(segs: KeyPath): string {
  return segs.map(s => (/^[A-Za-z0-9_-]+$/.test(String(s)) ? String(s) : JSON.stringify(String(s)))).join('.')
}

export function listPointerOf(pointer: string | KeyPath): string {
  return `${pointerOf(parseKeyPath(typeof pointer === 'string' ? pointer : [...pointer]))}[]`
}

export function listLedgerKey(path: string, pointer: string | KeyPath): string {
  return ledgerKey(path, listPointerOf(pointer))
}

export function cleanupLedgerKey(path: string, pointer: string | KeyPath): string {
  const segs = typeof pointer === 'string' ? (pointer === '' ? [] : parseKeyPath(pointer)) : [...pointer]
  return ledgerKey(resolve(path), `cleanup:${pointerOf(segs)}`)
}

function applyChanges(ledger: Ledger, changes: readonly LedgerChange[] | undefined): void {
  for (const ch of changes ?? []) {
    if (!ch || typeof ch.key !== 'string') continue
    if (ch.after) ledger[ch.key] = ch.after
    else delete ledger[ch.key]
  }
}

interface LedgerState { ledger: Ledger; existed: boolean; rebuilt?: { from: number } }

function loadLedgerState(): LedgerState {
  const r = readJsonSafeSync<Ledger>(paths.ownedLedgerFile())
  if (!r.ok) {
    if (r.code !== 'missing') throw new Error(`ownership ledger is unreadable, refusing to continue: ${r.error} (move it away and Buracle rebuilds it from its transaction journals)`)
    const rebuilt = rebuildLedger()
    return rebuilt ? { ledger: rebuilt.ledger, existed: false, rebuilt: { from: rebuilt.from } } : { ledger: {}, existed: false }
  }
  if (r.value === null || typeof r.value !== 'object' || Array.isArray(r.value)) throw new Error(`ownership ledger ${paths.ownedLedgerFile()} is not an object; refusing to continue`)
  return { ledger: r.value, existed: true }
}

function loadLedger(): Ledger {
  return loadLedgerState().ledger
}

export async function readLedger(): Promise<Ledger> {
  return loadLedger()
}

export function readLedgerSync(): Ledger {
  return loadLedger()
}

export function ledgerRebuildable(): boolean {
  try { lstatSync(paths.ownedLedgerFile()); return false } catch { return rebuildLedger() !== undefined }
}

function writeLedger(ledger: Ledger): void {
  const sorted: Ledger = {}
  for (const k of Object.keys(ledger).sort()) sorted[k] = ledger[k] as LedgerEntry
  atomicWriteSync(paths.ownedLedgerFile(), JSON.stringify(sorted, null, 2) + '\n', { mode: 0o600 })
}

interface Checkpoint { v: 1; through: string; ledger: Ledger; createdDirs: string[] }

const CHECKPOINT_NAME = '_checkpoint.json'

function checkpointFile(): string {
  return join(paths.journalDir(), CHECKPOINT_NAME)
}

function readCheckpoint(): Checkpoint | undefined {
  const r = readJsonSafeSync<Checkpoint>(checkpointFile())
  if (!r.ok || r.value === null || typeof r.value !== 'object' || typeof r.value.through !== 'string') return undefined
  const ledger = r.value.ledger !== null && typeof r.value.ledger === 'object' && !Array.isArray(r.value.ledger) ? r.value.ledger : {}
  const createdDirs = Array.isArray(r.value.createdDirs) ? r.value.createdDirs.filter((d): d is string => typeof d === 'string') : []
  return { v: 1, through: r.value.through, ledger, createdDirs }
}

function rebuildLedger(): { ledger: Ledger, from: number } | undefined {
  const cp = readCheckpoint()
  const journals = listJournalsSync().reverse()
  const ledger: Ledger = { ...(cp?.ledger ?? {}) }
  let from = 0
  for (const j of journals) {
    if (cp !== undefined && j.txn <= cp.through) continue
    if (j.status !== 'committed') continue
    if ((j.ledger ?? []).length === 0) continue
    applyChanges(ledger, j.ledger)
    from++
  }
  if (from === 0 && Object.keys(cp?.ledger ?? {}).length === 0) return undefined
  return { ledger, from }
}

export async function historyCreatedDirs(): Promise<string[]> {
  const dirs = new Set<string>(readCheckpoint()?.createdDirs ?? [])
  for (const j of listJournalsSync()) {
    if (j.status !== 'committed') continue
    for (const d of j.createdDirs ?? []) if (typeof d === 'string' && d !== '') dirs.add(d)
  }
  return [...dirs]
}

type Node =
  | { type: 'absent' }
  | { type: 'file'; content: string; mode: number }
  | { type: 'symlink'; target: string; raw?: string; content?: string; mode?: number }
  | { type: 'dir' }
  | { type: 'other' }

function readNode(path: string): Node {
  let st
  try { st = lstatSync(path) } catch { return { type: 'absent' } }
  if (st.isSymbolicLink()) {
    const raw = readlinkSync(path)
    const target = linkTarget(raw)
    const link = raw === target ? { target } : { target, raw }
    try {
      const real = statSync(path)
      if (real.isFile()) return { type: 'symlink', ...link, content: readFileSync(path, 'utf8'), mode: real.mode & 0o7777 }
    } catch {  }
    return { type: 'symlink', ...link }
  }
  if (st.isDirectory()) return { type: 'dir' }
  if (st.isFile()) return { type: 'file', content: readFileSync(path, 'utf8'), mode: st.mode & 0o7777 }
  return { type: 'other' }
}

function fingerprint(n: Node): string | undefined {
  if (n.type === 'file') return sha256(n.content)
  if (n.type === 'symlink') return sha256(`symlink:${n.target}`)
  return undefined
}

const windowsLinks = (): boolean => txnTestHooks.windowsLinks ?? process.platform === 'win32'

// Windows stores a link target with backslashes, an absolute one maybe behind the \\?\ prefix, and a rooted one
// without a drive ('/shim') on the current drive: there every target is kept, hashed and compared as the path
// it names, with '/' between the parts.
function linkTarget(target: string): string {
  if (!windowsLinks()) return target
  let t = target.replace(/^\\(?:\\\?|\?\?)\\/, '')
  if (/^[\\/](?![\\/])/.test(t)) t = win32.resolve(t)
  return t.replace(/\\/g, '/').replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`)
}

// The spelling a link is created with: Windows wants backslashes in a target.
function nativeLinkTarget(target: string): string {
  return windowsLinks() ? target.replace(/\//g, '\\') : target
}

// Windows keeps no POSIX mode: a file reads back as 0o666 (0o444 when read-only) whatever was written.
function sameMode(a: number | undefined, b: number | undefined): boolean {
  return !(txnTestHooks.keepsModes ?? process.platform !== 'win32') || a === b
}

function sameNode(a: Node, b: Node): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'file' && b.type === 'file') return a.content === b.content && sameMode(a.mode, b.mode)
  if (a.type === 'symlink' && b.type === 'symlink') return a.target === b.target && a.content === b.content
  return true
}

function realTextTarget(path: string): string {
  let st
  try { st = lstatSync(path) } catch { st = undefined }
  if (st !== undefined) {
    if (st.isSymbolicLink()) {
      try {
        const real = realPath(path)
        if (statSync(real).isFile()) return real
      } catch {  }
      return path
    }
    try { return realPath(path) } catch { return path }
  }
  try { return join(realPath(dirname(path)), basename(path)) } catch { return path }
}

class Vfs {
  private readonly disk = new Map<string, Node>()
  private readonly cur = new Map<string, Node>()
  readonly order: string[] = []
  private readonly textKeys = new Map<string, string>()
  private readonly byReal = new Map<string, string>()
  readonly via = new Map<string, string[]>()

  get(path: string): Node {
    const c = this.cur.get(path)
    if (c) return c
    const d = this.original(path)
    return d
  }
  original(path: string): Node {
    let d = this.disk.get(path)
    if (!d) { d = readNode(path); this.disk.set(path, d) }
    return d
  }
  set(path: string, node: Node): void {
    this.original(path)
    if (!this.order.includes(path)) this.order.push(path)
    this.cur.set(path, node)
  }
  textPath(path: string): string {
    const known = this.textKeys.get(path)
    if (known !== undefined) return known
    const real = realTextTarget(path)
    const first = this.byReal.get(real)
    let key = path
    if (first === undefined) this.byReal.set(real, path)
    else if (first !== path) {
      key = first
      const v = this.via.get(first) ?? []
      if (!v.includes(path)) v.push(path)
      this.via.set(first, v)
    }
    this.textKeys.set(path, key)
    return key
  }
  aliases(path: string): string[] {
    return [path, ...(this.via.get(path) ?? [])]
  }
  changes(): Array<{ path: string, before: Node, after: Node }> {
    const out: Array<{ path: string, before: Node, after: Node }> = []
    for (const p of this.order) {
      const before = this.original(p)
      const after = this.cur.get(p) as Node
      if (!sameNode(before, after)) out.push({ path: p, before, after })
    }
    return out
  }
}

function editableText(n: Node, path: string): { ok: true, text: string } | { ok: false, reason: string } {
  if (n.type === 'absent') return { ok: true, text: '' }
  if (n.type === 'file') return { ok: true, text: n.content }
  if (n.type === 'symlink') {
    if (n.content !== undefined) return { ok: true, text: n.content }
    return { ok: false, reason: `${path} is a symlink to ${n.target}, which is missing or not a regular file; not writing through it` }
  }
  return { ok: false, reason: `${path} is a directory or special file` }
}

function withText(n: Node, text: string): Node {
  if (n.type === 'file') return { type: 'file', content: text, mode: n.mode }
  if (n.type === 'symlink') return n.mode !== undefined ? { type: 'symlink', target: n.target, content: text, mode: n.mode } : { type: 'symlink', target: n.target, content: text }
  return { type: 'file', content: text, mode: 0o644 }
}

function readOnlyReason(n: Node, path: string): string | undefined {
  const mode = n.type === 'file' ? n.mode : n.type === 'symlink' ? n.mode : undefined
  if (mode === undefined || (mode & 0o200) !== 0) return undefined
  return `${path} is read-only (mode ${mode.toString(8).padStart(3, '0')}); not touching it`
}

const CONTENT_KINDS = new Set(['json-merge', 'jsonc-merge', 'yaml-merge', 'toml-tables', 'md-block', 'json-list-merge', 'toml-rekey'])

function policyKeys(list: readonly string[] | undefined): Set<string> {
  return new Set((list ?? []).map(k => pointerOf(parseKeyPath(k).map(String))))
}

function validateKeyPolicy(op: Record<string, unknown> | KeyPolicy, what: string, names: readonly string[]): void {
  const known = policyKeys(names)
  const seen = new Map<string, string>()
  for (const list of ['enforce', 'soft'] as const) {
    const v = (op as Record<string, unknown>)[list]
    if (v === undefined) continue
    if (!Array.isArray(v) || !v.every(k => typeof k === 'string' && k.trim() !== '')) throw new Error(`${what}: ${list} must be a list of keys`)
    for (const k of v as string[]) {
      const p = pointerOf(parseKeyPath(k).map(String))
      if (!known.has(p)) throw new Error(`${what}: ${list} names ${k}, which the op does not set`)
      const other = seen.get(p)
      if (other !== undefined && other !== list) throw new Error(`${what}: ${k} cannot be both enforced and soft`)
      seen.set(p, list)
    }
  }
}

function validateRekeyOp(op: Record<string, unknown>, what: string): void {
  const tablePath = (p: unknown, name: string) => {
    if (!Array.isArray(p) || p.length === 0 || !p.every(s => typeof s === 'string' && s !== '')) throw new Error(`${what}: ${name} must be a non-empty list of key segments`)
  }
  const drops = op['drops']
  const moves = op['moves']
  if (drops !== undefined) {
    if (!Array.isArray(drops)) throw new Error(`${what}: drops must be a list`)
    drops.forEach((d, i) => {
      if (!isRecord(d)) throw new Error(`${what}: drop #${i} is not an object`)
      tablePath(d['table'], `drop #${i} table`)
      if (!isRecord(d['value'])) throw new Error(`${what}: drop #${i} value must be a mapping`)
    })
  }
  if (moves !== undefined) {
    if (!Array.isArray(moves)) throw new Error(`${what}: moves must be a list`)
    moves.forEach((m, i) => {
      if (!isRecord(m)) throw new Error(`${what}: move #${i} is not an object`)
      tablePath(m['from'], `move #${i} from`)
      tablePath(m['to'], `move #${i} to`)
      if (!isRecord(m['value'])) throw new Error(`${what}: move #${i} value must be a mapping`)
    })
  }
}

export function listIdentity(rule: string | readonly string[]): (item: unknown) => string | undefined {
  if (rule === LIST_IDENTITY_HASH) return item => `sha256:${valueHash(item)}`
  const fields = (typeof rule === 'string' ? [rule] : [...rule]).map(f => parseKeyPath(f).map(String))
  if (fields.length === 1) {
    const only = fields[0] as string[]
    return item => { const g = getIn(item, only); return g.found ? stableStringify(g.value) : undefined }
  }
  return item => {
    const got = fields.map(f => getIn(item, f))
    return got.some(g => g.found) ? stableStringify(got.map(g => (g.found ? g.value : null))) : undefined
  }
}

function validateListOp(op: Record<string, unknown>, what: string): void {
  if (typeof op['pointer'] !== 'string' || op['pointer'].trim() === '') throw new Error(`${what}: pointer is required`)
  parseKeyPath(op['pointer'])
  const rule = op['identity']
  const ruleOk = (typeof rule === 'string' && rule.trim() !== '') || (Array.isArray(rule) && rule.length > 0 && rule.every(r => typeof r === 'string' && r.trim() !== ''))
  if (!ruleOk) throw new Error(`${what}: identity must be a field path, a list of field paths or ${JSON.stringify(LIST_IDENTITY_HASH)}`)
  if (rule !== LIST_IDENTITY_HASH) for (const f of (Array.isArray(rule) ? rule : [rule]) as string[]) parseKeyPath(f)
  if (op['format'] !== undefined && op['format'] !== 'json' && op['format'] !== 'jsonc') throw new Error(`${what}: format must be json or jsonc`)
  const items = op['items']
  if (!Array.isArray(items)) throw new Error(`${what}: items must be a list`)
  const idOf = listIdentity(rule as string | string[])
  const seen = new Set<string>()
  items.forEach((item, i) => {
    if (item === undefined || JSON.stringify(item) === undefined) throw new Error(`${what}: item #${i} is not a JSON value`)
    const id = idOf(item)
    if (id === undefined) throw new Error(`${what}: item #${i} has no identity (${JSON.stringify(rule)})`)
    if (seen.has(id)) throw new Error(`${what}: items #${i} and an earlier one share the identity ${id}`)
    seen.add(id)
  })
}

function normalizeOpPath(p: unknown, what: string): string {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) throw new Error(`${what}: path must be a non-empty string`)
  if (!isAbsolute(p)) throw new Error(`${what}: path must be absolute (got ${JSON.stringify(p)})`)
  const r = resolve(p)
  if (r === '/') throw new Error(`${what}: refusing to operate on /`)
  return r
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function isArgv(x: unknown): x is string[] {
  return Array.isArray(x) && x.length > 0 && x.every(a => typeof a === 'string') && x[0] !== ''
}

function validateOps(plans: Plan[]): Op[] {
  const ops: Op[] = []
  const wholeFile = new Map<string, number>()
  const content = new Map<string, number>()
  plans.forEach((plan, pi) => {
    if (!plan || !Array.isArray(plan.ops)) throw new Error(`plan #${pi}: ops must be an array`)
    plan.ops.forEach((op, oi) => {
      const what = `plan ${plan.id ?? pi} op #${oi} (${(op as { kind?: string })?.kind ?? '?'})`
      if (!isRecord(op)) throw new Error(`${what}: not an object`)
      if (typeof op.owner !== 'string' || op.owner.trim() === '') throw new Error(`${what}: owner is required`)
      switch (op.kind) {
        case 'exec':
          if (!isArgv(op.argv)) throw new Error(`${what}: argv must be a non-empty string list`)
          if (op.undo !== undefined && !isArgv(op.undo)) throw new Error(`${what}: undo must be a non-empty string list`)
          if (op.idempotentCheck !== undefined && !isArgv(op.idempotentCheck)) throw new Error(`${what}: idempotentCheck must be a non-empty string list`)
          if (op.soft !== undefined && typeof op.soft !== 'boolean') throw new Error(`${what}: soft must be a boolean`)
          ops.push({ ...op })
          return
        case 'file':
          if (typeof op.content !== 'string') throw new Error(`${what}: content must be a string`)
          if (op.mode !== undefined && (!Number.isInteger(op.mode) || op.mode < 0 || op.mode > 0o7777)) throw new Error(`${what}: invalid mode`)
          break
        case 'json-merge':
        case 'jsonc-merge':
        case 'yaml-merge':
          if (!isRecord(op.set)) throw new Error(`${what}: set must be a mapping`)
          for (const [k, v] of Object.entries(op.set)) {
            parseKeyPath(k)
            if (v === undefined) throw new Error(`${what}: value for ${JSON.stringify(k)} is undefined (use a remove op)`)
          }
          validateKeyPolicy(op, what, Object.keys(op.set))
          break
        case 'toml-tables':
          if (!isRecord(op.tables)) throw new Error(`${what}: tables must be a mapping`)
          for (const [k, v] of Object.entries(op.tables)) { parseKeyPath(k); if (!isRecord(v)) throw new Error(`${what}: table ${k} must be a mapping`) }
          if (op.ignore !== undefined) {
            if (!isRecord(op.ignore)) throw new Error(`${what}: ignore must be a mapping`)
            for (const [k, v] of Object.entries(op.ignore)) {
              if (!(k in op.tables)) throw new Error(`${what}: ignore names ${k}, which is not one of its tables`)
              if (!Array.isArray(v) || !v.every(x => typeof x === 'string' && x !== '')) throw new Error(`${what}: ignore.${k} must be a list of keys`)
              const table = op.tables[k] as Record<string, unknown>
              for (const x of v) if (x in table) throw new Error(`${what}: table ${k} sets ${x}, which it also ignores`)
            }
          }
          if (op.keys !== undefined) {
            if (!isRecord(op.keys)) throw new Error(`${what}: keys must be a mapping`)
            for (const [k, v] of Object.entries(op.keys)) {
              parseKeyPath(k)
              if (v === undefined || v === null) throw new Error(`${what}: key ${k} has no value (use a remove op)`)
            }
          }
          validateKeyPolicy(op, what, [...Object.keys(op.tables), ...Object.keys(op.keys ?? {})])
          break
        case 'md-block':
          if (typeof op.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(op.id)) throw new Error(`${what}: invalid block id`)
          if (typeof op.content !== 'string') throw new Error(`${what}: content must be a string`)
          break
        case 'symlink':
          if (typeof op.target !== 'string' || op.target === '') throw new Error(`${what}: target is required`)
          break
        case 'json-list-merge':
          validateListOp(op as unknown as Record<string, unknown>, what)
          break
        case 'toml-rekey':
          validateRekeyOp(op as unknown as Record<string, unknown>, what)
          break
        case 'remove':
          if (op.forget !== undefined && typeof op.forget !== 'boolean') throw new Error(`${what}: forget must be a boolean`)
          break
        default:
          throw new Error(`${what}: unknown op kind`)
      }
      if (op.kind === 'remove') {
        if (typeof op.path !== 'string' || op.path === '') throw new Error(`${what}: path is required`)
        const hash = op.path.indexOf('#')
        const filePart = hash >= 0 ? op.path.slice(0, hash) : op.path
        const norm = normalizeOpPath(filePart, what)
        ops.push({ ...op, path: hash >= 0 ? norm + op.path.slice(hash) : norm })
        ;(hash >= 0 ? content : wholeFile).set(norm, oi)
        return
      }
      const path = normalizeOpPath(op.path, what)
      ops.push({ ...op, path } as Op)
      ;(CONTENT_KINDS.has(op.kind) ? content : wholeFile).set(path, oi)
    })
  })
  for (const p of wholeFile.keys()) {
    if (content.has(p)) throw new Error(`invalid plan: ${p} has both whole-file and content-merge ops in one transaction`)
  }
  return ops
}

interface CleanupTarget { path: string; segs: string[]; owner: string }

function cleanupTargets(plans: Plan[]): CleanupTarget[] {
  const out: CleanupTarget[] = []
  const seen = new Set<string>()
  plans.forEach((plan, pi) => {
    const keys = (plan as { cleanupKeys?: unknown }).cleanupKeys
    if (keys === undefined) return
    if (!Array.isArray(keys)) throw new Error(`plan ${plan.id ?? pi}: cleanupKeys must be a list`)
    keys.forEach((k, i) => {
      const what = `plan ${plan.id ?? pi} cleanupKeys #${i}`
      if (!isRecord(k) || typeof k['pointer'] !== 'string') throw new Error(`${what}: needs path and pointer`)
      const path = normalizeOpPath(k['path'], what)
      const segs = k['pointer'] === '' ? [] : parseKeyPath(k['pointer']).map(String)
      const key = cleanupLedgerKey(path, segs)
      if (seen.has(key)) return
      seen.add(key)
      out.push({ path, segs, owner: String(plan.harness ?? 'core') })
    })
  })
  return out
}

interface LedgerChange { key: string; before?: LedgerEntry; after?: LedgerEntry }

interface JournalCleanup { path: string; segs: string[]; absentBefore: boolean; fileAbsentBefore: boolean }

interface ComputeOptions {
  restore: (op: Op) => boolean
  takeOwnership: boolean
}

interface Computed {
  vfs: Vfs
  applied: number
  skipped: Array<{ op: Op, reason: string }>
  conflicts: Array<{ op: Op, detail: string, removed?: true }>
  execs: Array<Extract<Op, { kind: 'exec' }>>
  ledger: Ledger
  ledgerChanges: Map<string, LedgerChange>
  opts: ComputeOptions
  cleanup: JournalCleanup[]
  warnings: string[]
}

function computeOptions(o: ApplyOptions): ComputeOptions {
  const r = o.restore
  return { restore: typeof r === 'function' ? r : () => r === true, takeOwnership: o.takeOwnership === true }
}

function entryEquals(a: LedgerEntry | undefined, b: LedgerEntry | undefined): boolean {
  if (!a || !b) return a === b
  return a.owner === b.owner && a.sha256 === b.sha256 && a.path === b.path && a.pointer === b.pointer && a.kind === b.kind && a.writtenAt === b.writtenAt
    && (a.adopted === true) === (b.adopted === true)
    && stableStringify(a.created ?? []) === stableStringify(b.created ?? [])
    && stableStringify(a.items ?? null) === stableStringify(b.items ?? null)
    && stableStringify(a.identity ?? null) === stableStringify(b.identity ?? null)
    && (a.absentBefore === true) === (b.absentBefore === true)
    && stableStringify(a.ignore ?? []) === stableStringify(b.ignore ?? [])
    && stableStringify(a.displaced ?? null) === stableStringify(b.displaced ?? null)
    && (a.soft === true) === (b.soft === true)
}

function pointerDepth(p: string): number {
  return p === '' ? 0 : parseKeyPath(p).length
}

function mergeCreated(...lists: Array<readonly string[] | undefined>): string[] {
  const all = [...new Set(lists.flatMap(l => l ?? []))]
  return all.sort((a, b) => pointerDepth(a) - pointerDepth(b) || (a < b ? -1 : a > b ? 1 : 0))
}

type SetEntryFn = (key: string, entry: LedgerEntry | undefined) => void

function compute(ops: Op[], ledgerIn: Ledger, now: string, opts: ComputeOptions, cleanup: readonly CleanupTarget[] = []): Computed {
  const vfs = new Vfs()
  const ledger: Ledger = { ...ledgerIn }
  const ledgerChanges = new Map<string, LedgerChange>()
  const c: Computed = { vfs, applied: 0, skipped: [], conflicts: [], execs: [], ledger, ledgerChanges, opts, cleanup: [], warnings: [] }

  const setEntry: SetEntryFn = (key, entry) => {
    const prev = ledger[key]
    if (entryEquals(prev, entry)) return
    const change = ledgerChanges.get(key) ?? (prev ? { key, before: prev } : { key })
    if (entry) { ledger[key] = entry; change.after = entry } else { delete ledger[key]; delete change.after }
    if (entryEquals(change.before, change.after)) ledgerChanges.delete(key)
    else ledgerChanges.set(key, change)
  }
  const own: OwnFn = (op, kind, hash, pointer, segs, wrote, created, extra) => {
    const key = ledgerKey(op.path, pointer)
    const prev = ledger[key]
    const same = prev !== undefined && prev.sha256 === hash
    const entry: LedgerEntry = { owner: op.owner, sha256: hash, path: op.path, kind, writtenAt: same && prev.owner === op.owner && !wrote ? prev.writtenAt : now }
    if (pointer !== undefined) entry.pointer = pointer
    if (segs !== undefined) entry.segs = segs
    if (extra?.ignore !== undefined && extra.ignore.length > 0) entry.ignore = [...extra.ignore]
    if (!wrote && !opts.takeOwnership && (!same || prev.adopted === true)) entry.adopted = true
    else {
      const ours = prev !== undefined && prev.adopted !== true
      const all = mergeCreated(ours ? prev.created : undefined, created)
      if (all.length > 0) entry.created = all
      const displaced = extra?.displaced ?? (ours ? prev.displaced : undefined)
      if (displaced !== undefined) entry.displaced = displaced
    }
    if (extra?.soft === true) entry.soft = true
    setEntry(key, entry)
  }

  for (const op of ops) {
    if (op.kind === 'exec') { c.execs.push(op); continue }
    switch (op.kind) {
      case 'file': opFile(c, op, own); break
      case 'symlink': opSymlink(c, op, own); break
      case 'json-merge':
      case 'jsonc-merge':
      case 'yaml-merge': opKeys(c, op, own); break
      case 'toml-tables': opToml(c, op, own); break
      case 'md-block': opMd(c, op, own); break
      case 'json-list-merge': opList(c, op, setEntry, now); break
      case 'toml-rekey': opTomlRekey(c, op); break
      case 'remove': opRemove(c, op, setEntry); break
    }
  }
  for (const t of cleanup) recordCleanup(c, t, setEntry, now)
  return c
}

type OwnFn = (op: Op & { path: string }, kind: LedgerKind, hash: string, pointer: string | undefined, segs: string[] | undefined, wrote: boolean, created?: readonly string[], extra?: Pick<LedgerEntry, 'ignore' | 'displaced' | 'soft'>) => void

function wroteThis(entry: LedgerEntry | undefined, hash: string | undefined): boolean {
  return entry !== undefined && entry.adopted !== true && hash !== undefined && entry.sha256 === hash
}

function notOurs(entry: LedgerEntry | undefined, absentEntry: string): string {
  if (!entry) return absentEntry
  return entry.adopted === true ? 'set by the user before Buracle (never written by Buracle)' : 'modified outside Buracle'
}

function removedDetail(label: string): string {
  return `${label}: removed since Buracle installed it; not re-creating it (run \`buracle install\` in a terminal to put it back)`
}

function keptUserValue(pointer: string): string {
  return `kept user value (${pointer})`
}

function enforcedNote(label: string, why: string): string {
  return `${label}: ${why}; wrote Buracle's value because the key is enforced`
}

function shortValue(v: unknown): string {
  let s: string
  try { s = JSON.stringify(v) ?? String(v) } catch { s = String(v) }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s
}

function plainJson(v: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(x => plainJson(x, depth + 1))
  if (typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v) as unknown
  if (proto !== Object.prototype && proto !== null) return false
  return Object.values(v as Record<string, unknown>).every(x => plainJson(x, depth + 1))
}

function takeoverRefusal(format: 'json' | 'jsonc' | 'yaml' | 'toml', text: string, segs: readonly string[], displaced: { value: unknown } | undefined): string | undefined {
  if (format === 'yaml') {
    const alias = yamlAliasAt(text, segs)
    if (alias !== undefined) return `the value is a YAML alias (*${alias}); Buracle does not override it, even for an enforced key`
  }
  if (displaced !== undefined && !plainJson(displaced.value)) return 'the value cannot be recorded exactly (it is not plain JSON data), so it could not be put back; Buracle does not override it, even for an enforced key'
  return undefined
}

interface Takeover { why: string; displaced?: { value: unknown } }

function userValueVerdict(entry: LedgerEntry | undefined, cur: { found: boolean, value: unknown }, curOwned: unknown, label: string, policy: { soft: boolean, enforce: boolean }, wording: { absentEntry: string, keeping: string }): { keep: true } | { conflict: string } | { takeover: Takeover } {
  if (policy.soft) return { keep: true }
  if (!cur.found) {
    if (!policy.enforce) return { conflict: removedDetail(label) }
    return { takeover: { why: 'removed since Buracle installed it' } }
  }
  const why = notOurs(entry, wording.absentEntry)
  if (!policy.enforce) return { conflict: `${label}: ${why}; ${wording.keeping}` }
  const t: Takeover = { why: `${why} (was ${shortValue(curOwned)})` }
  if (entry === undefined || entry.adopted === true) t.displaced = { value: curOwned }
  return { takeover: t }
}

function opFile(c: Computed, op: Extract<Op, { kind: 'file' }>, own: OwnFn): void {
  const node = c.vfs.get(op.path)
  const want = sha256(op.content)
  if (node.type === 'dir' || node.type === 'other') { c.conflicts.push({ op, detail: `${op.path} is a directory or special file` }); return }
  const entry = c.ledger[ledgerKey(op.path)]
  if (node.type === 'absent') {
    if (entry !== undefined && !c.opts.restore(op)) { c.conflicts.push({ op, detail: removedDetail(op.path), removed: true }); return }
    c.vfs.set(op.path, { type: 'file', content: op.content, mode: op.mode ?? 0o644 })
    own(op, 'file', want, undefined, undefined, true)
    c.applied++
    return
  }
  const cur = fingerprint(node) as string
  if (node.type === 'file' && cur === want) {
    own(op, 'file', want, undefined, undefined, false)
    if (op.mode !== undefined && !sameMode(node.mode, op.mode)) {
      const ro = readOnlyReason(node, op.path)
      if (ro !== undefined) { c.conflicts.push({ op, detail: ro }); return }
      c.vfs.set(op.path, { type: 'file', content: node.content, mode: op.mode })
      c.applied++
    } else c.skipped.push({ op, reason: 'unchanged' })
    return
  }
  if (wroteThis(entry, cur)) {
    const ro = node.type === 'file' ? readOnlyReason(node, op.path) : undefined
    if (ro !== undefined) { c.conflicts.push({ op, detail: ro }); return }
    c.vfs.set(op.path, { type: 'file', content: op.content, mode: op.mode ?? (node.type === 'file' ? node.mode : 0o644) })
    own(op, 'file', want, undefined, undefined, true)
    c.applied++
    return
  }
  c.conflicts.push({ op, detail: entry ? `${op.path} was ${notOurs(entry, '')}; keeping the user's version` : `${op.path} exists and is not owned by Buracle; keeping the user's version` })
}

function opSymlink(c: Computed, op: Extract<Op, { kind: 'symlink' }>, own: OwnFn): void {
  const node = c.vfs.get(op.path)
  const target = linkTarget(op.target)
  const want = sha256(`symlink:${target}`)
  const entry = c.ledger[ledgerKey(op.path)]
  if (node.type === 'absent') {
    if (entry !== undefined && !c.opts.restore(op)) { c.conflicts.push({ op, detail: removedDetail(op.path), removed: true }); return }
    c.vfs.set(op.path, { type: 'symlink', target })
    own(op, 'symlink', want, undefined, undefined, true)
    c.applied++
    return
  }
  if (node.type === 'symlink' && node.target === target) {
    own(op, 'symlink', want, undefined, undefined, false)
    c.skipped.push({ op, reason: 'unchanged' })
    return
  }
  const cur = fingerprint(node)
  if (wroteThis(entry, cur)) {
    c.vfs.set(op.path, { type: 'symlink', target })
    own(op, 'symlink', want, undefined, undefined, true)
    c.applied++
    return
  }
  c.conflicts.push({ op, detail: entry ? `${op.path} was ${notOurs(entry, '')}; keeping it` : `${op.path} exists and is not owned by Buracle; keeping it` })
}

function parseStructured(kind: 'json' | 'jsonc' | 'yaml', text: string): { ok: true, value: unknown } | { ok: false, error: string } {
  if (text.trim() === '') return { ok: true, value: {} }
  try {
    if (kind === 'json') return { ok: true, value: JSON.parse(text) as unknown }
    if (kind === 'jsonc') return jsoncParse(text)
    const v = yamlParse(text)
    return { ok: true, value: v === null || v === undefined ? {} : v }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function missingParents(root: unknown, segs: readonly string[]): string[] {
  const out: string[] = []
  for (let k = 1; k < segs.length; k++) if (!getIn(root, segs.slice(0, k)).found) out.push(pointerOf(segs.slice(0, k)))
  return out
}

function opKeys(c: Computed, op: Extract<Op, { kind: 'json-merge' | 'jsonc-merge' | 'yaml-merge' }>, own: OwnFn): void {
  const kind: 'json' | 'jsonc' | 'yaml' = op.kind === 'json-merge' ? 'json' : op.kind === 'jsonc-merge' ? 'jsonc' : 'yaml'
  const tp = c.vfs.textPath(op.path)
  const node = c.vfs.get(tp)
  const editable = editableText(node, op.path)
  if (!editable.ok) { c.conflicts.push({ op, detail: editable.reason }); return }
  let text = editable.text
  const parsed = parseStructured(kind, text)
  if (!parsed.ok) { c.conflicts.push({ op, detail: `${op.path} is not valid ${kind.toUpperCase()} (${parsed.error}); not touching it` }); return }
  if (!isRecord(parsed.value)) { c.conflicts.push({ op, detail: `${op.path}: top-level value is not an object; not touching it` }); return }
  const ro = readOnlyReason(node, op.path)
  const enforced = policyKeys(op.enforce)
  const softKeys = policyKeys(op.soft)
  let value: unknown = parsed.value
  let changed = 0
  let conflicted = 0
  let kept = 0
  let createsFile = node.type === 'absent'
  for (const [key, desired] of Object.entries(op.set)) {
    const segs = parseKeyPath(key).map(String)
    const pointer = pointerOf(segs)
    const want = valueHash(desired)
    const cur = getIn(value, segs)
    const entry = c.ledger[ledgerKey(op.path, pointer)]
    const policy = { soft: softKeys.has(pointer), enforce: enforced.has(pointer) }
    const flags: Pick<LedgerEntry, 'soft'> | undefined = policy.soft ? { soft: true } : undefined
    const keep = () => { kept++; c.skipped.push({ op, reason: keptUserValue(pointer) }) }
    const inherited = kind === 'yaml' ? yamlPathProblem(text, segs) : undefined
    if (inherited !== undefined) {
      let effective: { found: boolean, value: unknown } = { found: false, value: undefined }
      try { effective = getIn(yamlParseMerged(text), segs) } catch {  }
      if (effective.found && valueHash(effective.value) === want) { own(op, kind, want, pointer, segs, false, undefined, flags); continue }
      if (policy.soft) { keep(); continue }
      conflicted++
      c.conflicts.push({ op, detail: `${op.path} ${pointer}: ${inherited}; keeping the user's value` })
      continue
    }
    if (cur.found && valueHash(cur.value) === want) { own(op, kind, want, pointer, segs, false, undefined, flags); continue }
    let takeover: Takeover | undefined
    if ((cur.found && !wroteThis(entry, valueHash(cur.value))) || (!cur.found && entry !== undefined && !c.opts.restore(op))) {
      const v = userValueVerdict(entry, cur, cur.value, `${op.path} ${pointer}`, policy, { absentEntry: 'already set by the user', keeping: 'keeping the user\'s value' })
      if ('keep' in v) { keep(); continue }
      if ('conflict' in v) { conflicted++; c.conflicts.push({ op, detail: v.conflict }); continue }
      takeover = v.takeover
    }
    if (ro !== undefined) {
      conflicted++
      c.conflicts.push({ op, detail: `${ro} (${pointer})` })
      continue
    }
    const refusal = takeover !== undefined ? takeoverRefusal(kind, text, segs, takeover.displaced) : undefined
    if (refusal !== undefined) {
      conflicted++
      c.conflicts.push({ op, detail: `${op.path} ${pointer}: ${refusal}; keeping the user's value` })
      continue
    }
    try {
      const created = missingParents(value, segs)
      const next = kind === 'yaml' ? yamlSet(text, segs, desired) : jsoncSet(text, segs, desired)
      const reparsed = parseStructured(kind, next)
      if (!reparsed.ok) throw new Error(reparsed.error)
      const got = getIn(reparsed.value, segs)
      if (!got.found || valueHash(got.value) !== want) throw new Error('the value did not read back as written')
      text = next
      value = reparsed.value
      if (createsFile) { created.unshift(''); createsFile = false }
      own(op, kind, want, pointer, segs, true, created, { ...flags, ...(takeover?.displaced !== undefined ? { displaced: takeover.displaced } : {}) })
      if (takeover !== undefined) c.warnings.push(enforcedNote(`${op.path} ${pointer}`, takeover.why))
      changed++
    } catch (e) {
      conflicted++
      c.conflicts.push({ op, detail: `${op.path} ${pointer}: cannot set (${e instanceof Error ? e.message : String(e)})` })
    }
  }
  if (changed > 0) {
    c.vfs.set(tp, withText(node, text))
    c.applied++
  } else if (conflicted === 0 && kept === 0) c.skipped.push({ op, reason: 'unchanged' })
}

function opToml(c: Computed, op: Extract<Op, { kind: 'toml-tables' }>, own: OwnFn): void {
  const tp = c.vfs.textPath(op.path)
  const node = c.vfs.get(tp)
  const editable = editableText(node, op.path)
  if (!editable.ok) { c.conflicts.push({ op, detail: editable.reason }); return }
  const text = editable.text
  let parsed: Record<string, unknown>
  try { parsed = tomlParse(text) } catch (e) {
    c.conflicts.push({ op, detail: `${op.path} is not valid TOML (${e instanceof Error ? e.message : String(e)}); not touching it` })
    return
  }
  const ro = readOnlyReason(node, op.path)
  const enforced = policyKeys(op.enforce)
  const softKeys = policyKeys(op.soft)
  const okTables: Record<string, Record<string, unknown>> = {}
  const okKeys: Record<string, unknown> = {}
  const pending: Array<{ kind: 'toml-table' | 'toml-key', pointer: string, segs: string[], hash: string, want: unknown, ignore?: string[], takeover?: Takeover }> = []
  let conflicted = 0
  let kept = 0
  const consider = (kind: 'toml-table' | 'toml-key', name: string, desired: unknown) => {
    const segs = parseKeyPath(name).map(String)
    const pointer = kind === 'toml-table' ? `[${pointerOf(segs)}]` : pointerOf(segs)
    const ignore = kind === 'toml-table' ? op.ignore?.[name] : undefined
    const want = tomlNormalize(desired)
    const hash = valueHash(want)
    const cur = getIn(parsed, segs)
    const curOwned = cur.found ? ownedTomlValue(cur.value, ignore) : undefined
    const curHash = cur.found ? valueHash(curOwned) : undefined
    const entry = c.ledger[ledgerKey(op.path, pointer)]
    const policy = { soft: softKeys.has(pointerOf(segs)), enforce: enforced.has(pointerOf(segs)) }
    const flags = { ignore, ...(policy.soft ? { soft: true } : {}) }
    if (cur.found && curHash === hash) { own(op, kind, hash, pointer, segs, false, undefined, flags); return }
    let takeover: Takeover | undefined
    if ((cur.found && !wroteThis(entry, curHash)) || (!cur.found && entry !== undefined && !c.opts.restore(op))) {
      const v = userValueVerdict(entry, cur, curOwned, `${op.path} ${pointer}`, policy, { absentEntry: 'already defined by the user', keeping: 'keeping the user\'s version' })
      if ('keep' in v) { kept++; c.skipped.push({ op, reason: keptUserValue(pointer) }); return }
      if ('conflict' in v) { conflicted++; c.conflicts.push({ op, detail: v.conflict }); return }
      takeover = v.takeover
    }
    if (ro !== undefined) {
      conflicted++
      c.conflicts.push({ op, detail: `${ro} (${pointer})` })
      return
    }
    const refusal = takeover !== undefined ? takeoverRefusal('toml', text, segs, takeover.displaced) : undefined
    if (refusal !== undefined) {
      conflicted++
      c.conflicts.push({ op, detail: `${op.path} ${pointer}: ${refusal}; keeping the user's version` })
      return
    }
    if (kind === 'toml-table') okTables[name] = desired as Record<string, unknown>
    else okKeys[name] = desired
    pending.push({ kind, pointer, segs, hash, want, ...(ignore !== undefined ? { ignore } : {}), ...(takeover !== undefined ? { takeover } : {}) })
  }
  for (const [name, values] of Object.entries(op.tables)) consider('toml-table', name, values)
  for (const [name, value] of Object.entries(op.keys ?? {})) consider('toml-key', name, value)
  if (pending.length === 0) {
    if (conflicted === 0 && kept === 0) c.skipped.push({ op, reason: 'unchanged' })
    return
  }
  let next: string
  try {
    next = tomlPatchTables(text, okTables, okKeys, op.ignore ?? {})
    const check = tomlParse(next)
    for (const p of pending) {
      const got = getIn(check, p.segs)
      if (!got.found || valueHash(ownedTomlValue(got.value, p.ignore)) !== p.hash) throw new Error(`${p.pointer} did not read back as written`)
      const before = getIn(parsed, p.segs)
      for (const k of p.ignore ?? []) {
        const was = before.found ? getIn(before.value, [k]) : { found: false, value: undefined }
        const now = getIn(got.value, [k])
        if (was.found !== now.found || (was.found && valueHash(was.value) !== valueHash(now.value))) throw new Error(`${p.pointer} would lose its ${k}`)
      }
    }
  } catch (e) {
    c.conflicts.push({ op, detail: `${op.path}: cannot patch TOML (${e instanceof Error ? e.message : String(e)}); not touching it` })
    return
  }
  const createdFile = node.type === 'absent' ? [''] : undefined
  for (const p of pending) {
    const flags = { ignore: p.ignore, ...(softKeys.has(pointerOf(p.segs)) ? { soft: true } : {}), ...(p.takeover?.displaced !== undefined ? { displaced: p.takeover.displaced } : {}) }
    own(op, p.kind, p.hash, p.pointer, p.segs, true, createdFile, flags)
    if (p.takeover !== undefined) c.warnings.push(enforcedNote(`${op.path} ${p.pointer}`, p.takeover.why))
  }
  c.vfs.set(tp, withText(node, next))
  c.applied++
}

function ownedTomlValue(v: unknown, ignore: readonly string[] | undefined): unknown {
  if (ignore === undefined || ignore.length === 0 || !isRecord(v)) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) if (!ignore.includes(k)) out[k] = x
  return out
}

function withoutEmptyTables(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutEmptyTables)
  if (!isRecord(v) || v instanceof Date) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) {
    const y = withoutEmptyTables(x)
    if (isRecord(y) && !(y instanceof Date) && Object.keys(y).length === 0) continue
    out[k] = y
  }
  return out
}

function opTomlRekey(c: Computed, op: TomlRekeyOp): void {
  const tp = c.vfs.textPath(op.path)
  const node = c.vfs.get(tp)
  if (node.type === 'absent') { c.skipped.push({ op, reason: 'absent' }); return }
  const editable = editableText(node, op.path)
  if (!editable.ok) { c.conflicts.push({ op, detail: editable.reason }); return }
  const original = editable.text
  let text = original
  let parsed: Record<string, unknown>
  try { parsed = tomlParse(text) } catch (e) {
    c.conflicts.push({ op, detail: `${op.path} is not valid TOML (${errText(e)}); not touching it` })
    return
  }
  const holds = (doc: unknown, segs: readonly string[], value: Record<string, unknown>) => {
    const g = getIn(doc, [...segs])
    return g.found && valueHash(tomlNormalize(g.value)) === valueHash(tomlNormalize(value))
  }
  const notes: string[] = []
  const step = (label: string, edit: () => string, expect: (doc: unknown) => unknown) => {
    try {
      const next = edit()
      const doc = tomlParse(next)
      const want = expect(parsed)
      if (stableStringify(withoutEmptyTables(doc)) !== stableStringify(withoutEmptyTables(want))) throw new Error('other values would change')
      text = next
      parsed = doc
    } catch (e) {
      notes.push(`${label}: cannot change it in place (${errText(e)}); left as it is`)
    }
  }
  for (const d of op.drops ?? []) {
    const label = `${op.path} [${pointerOf(d.table)}]`
    if (!holds(parsed, d.table, d.value)) {
      if (getIn(parsed, [...d.table]).found) notes.push(`${label} changed since the plan was made; left as it is`)
      continue
    }
    step(label, () => tomlRemove(text, { tables: [pointerOf(d.table)] }), doc => withoutValueAt(doc, d.table))
  }
  for (const m of op.moves ?? []) {
    const label = `${op.path} [${pointerOf(m.from)}] → [${pointerOf(m.to)}]`
    if (!holds(parsed, m.from, m.value)) { notes.push(`${label}: the entry changed since the plan was made; left as it is`); continue }
    if (getIn(parsed, [...m.to]).found) { notes.push(`${label}: the target is already defined; left as it is`); continue }
    step(label, () => tomlRenameTable(text, m.from, m.to), doc => withValueAt(withoutValueAt(doc, m.from), m.to, getIn(doc, [...m.from]).value))
  }
  for (const n of notes) c.warnings.push(n)
  if (text === original) {
    c.skipped.push({ op, reason: notes.length > 0 ? 'nothing could be changed' : 'unchanged' })
    return
  }
  const ro = readOnlyReason(node, op.path)
  if (ro !== undefined) { c.conflicts.push({ op, detail: ro }); return }
  c.vfs.set(tp, withText(node, text))
  c.applied++
}

function normalizeBlock(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

function opMd(c: Computed, op: Extract<Op, { kind: 'md-block' }>, own: OwnFn): void {
  const tp = c.vfs.textPath(op.path)
  const node = c.vfs.get(tp)
  const editable = editableText(node, op.path)
  if (!editable.ok) { c.conflicts.push({ op, detail: editable.reason }); return }
  const pointer = `md:${op.id}`
  const want = normalizeBlock(op.content)
  const hash = sha256(want)
  let cur: string | undefined
  try { cur = mdBlockGet(editable.text, op.id) } catch (e) {
    c.conflicts.push({ op, detail: `${op.path}: ${e instanceof Error ? e.message : String(e)}; not touching it` })
    return
  }
  if (cur !== undefined && normalizeBlock(cur) === want) { own(op, 'md-block', hash, pointer, undefined, false); c.skipped.push({ op, reason: 'unchanged' }); return }
  const entry = c.ledger[ledgerKey(op.path, pointer)]
  if (cur !== undefined && !wroteThis(entry, sha256(normalizeBlock(cur)))) {
    c.conflicts.push({ op, detail: `${op.path} block ${op.id}: ${notOurs(entry, 'exists but is not owned by Buracle')}; keeping it` })
    return
  }
  if (cur === undefined && entry !== undefined && !c.opts.restore(op)) { c.conflicts.push({ op, detail: removedDetail(`${op.path} block ${op.id}`), removed: true }); return }
  const ro = readOnlyReason(node, op.path)
  if (ro !== undefined) { c.conflicts.push({ op, detail: ro }); return }
  c.vfs.set(tp, withText(node, mdBlockUpsert(editable.text, op.id, op.content)))
  own(op, 'md-block', hash, pointer, undefined, true, node.type === 'absent' ? [''] : undefined)
  c.applied++
}

const TEXT_KINDS: ReadonlySet<LedgerKind> = new Set<LedgerKind>(['md-block', 'toml-table', 'toml-key'])

function handOverFileCreated(c: Computed, from: LedgerEntry, fromKey: string, setEntry: SetEntryFn): void {
  const heir = Object.keys(c.ledger).filter(k => {
    const e = c.ledger[k] as LedgerEntry
    return k !== fromKey && e.path === from.path && e.adopted !== true && TEXT_KINDS.has(e.kind)
  }).sort()[0]
  if (heir === undefined) return
  const e = c.ledger[heir] as LedgerEntry
  setEntry(heir, { ...e, created: mergeCreated(e.created, ['']) })
}

type StructFormat = 'json' | 'jsonc' | 'yaml'

function structFormatOf(kind: LedgerKind): StructFormat | undefined {
  switch (kind) {
    case 'json': case 'json-list': return 'json'
    case 'jsonc': case 'jsonc-list': return 'jsonc'
    case 'yaml': return 'yaml'
    default: return undefined
  }
}

function formatOfPath(path: string): StructFormat {
  return /\.ya?ml$/i.test(path) ? 'yaml' : 'jsonc'
}

function setStructured(format: StructFormat, text: string, segs: readonly (string | number)[], value: unknown): string {
  return format === 'yaml' ? yamlSet(text, segs, value) : jsoncSet(text, segs, value)
}

function isEmptyContainer(v: unknown): boolean {
  return (isRecord(v) && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0)
}

function emptyDocumentText(format: StructFormat, text: string): boolean {
  const bare = text.replace(/\s+/g, '')
  return bare === '{}' || (format === 'yaml' && bare === '')
}

function climbCreated(value: unknown, segs: readonly string[], created: ReadonlySet<string>): string[] {
  let target = [...segs]
  while (target.length > 1) {
    const parent = target.slice(0, -1)
    if (!created.has(pointerOf(parent))) break
    const pv = getIn(value, parent).value
    if (!isRecord(pv) || Object.keys(pv).length !== 1) break
    target = parent
  }
  return target
}

interface Pruned { text: string; deleteFile: boolean; remaining: string[] }

function pruneCreated(format: StructFormat, text: string, created: readonly string[]): Pruned {
  const set = new Set(created)
  const nested = created.filter(p => p !== '').map(p => parseKeyPath(p).map(String))
  let cur = text
  for (let round = 0; round <= nested.length; round++) {
    const parsed = parseStructured(format, cur)
    if (!parsed.ok) break
    const empty = nested
      .filter(segs => { const g = getIn(parsed.value, segs); return g.found && isEmptyContainer(g.value) })
      .sort((a, b) => b.length - a.length)[0]
    if (empty === undefined) break
    const next = setStructured(format, cur, climbCreated(parsed.value, empty, set), undefined)
    if (next === cur) break
    cur = next
  }
  const parsed = parseStructured(format, cur)
  if (!parsed.ok) return { text: cur, deleteFile: false, remaining: [...created] }
  if (set.has('') && isRecord(parsed.value) && Object.keys(parsed.value).length === 0 && emptyDocumentText(format, cur)) return { text: cur, deleteFile: true, remaining: [] }
  return { text: cur, deleteFile: false, remaining: created.filter(p => p === '' || getIn(parsed.value, parseKeyPath(p).map(String)).found) }
}

function handOverCreated(c: Computed, from: LedgerEntry, fromKey: string, pointers: readonly string[], setEntry: SetEntryFn): void {
  if (pointers.length === 0) return
  const heirs = Object.keys(c.ledger).filter(k => {
    const e = c.ledger[k] as LedgerEntry
    return k !== fromKey && e.path === from.path && e.adopted !== true && structFormatOf(e.kind) !== undefined && Array.isArray(e.segs)
  }).sort()
  const gifts = new Map<string, string[]>()
  for (const p of pointers) {
    const ps = p === '' ? [] : parseKeyPath(p).map(String)
    const heir = heirs.find(k => { const s = (c.ledger[k] as LedgerEntry).segs as string[]; return s.length > ps.length && ps.every((x, i) => s[i] === x) })
    if (heir !== undefined) gifts.set(heir, [...(gifts.get(heir) ?? []), p])
  }
  for (const [k, ps] of gifts) {
    const e = c.ledger[k] as LedgerEntry
    setEntry(k, { ...e, created: mergeCreated(e.created, ps) })
  }
}

function commitPruned(c: Computed, path: string, node: Node, before: string, pruned: Pruned): boolean {
  if (pruned.deleteFile && node.type === 'file') { c.vfs.set(path, { type: 'absent' }); return true }
  if (pruned.text === before) return false
  c.vfs.set(path, withText(node, pruned.text))
  return true
}

function opList(c: Computed, op: JsonListMergeOp, setEntry: SetEntryFn, now: string): void {
  const format: 'json' | 'jsonc' = op.format ?? 'json'
  const kind: LedgerKind = format === 'jsonc' ? 'jsonc-list' : 'json-list'
  const segs = parseKeyPath(op.pointer).map(String)
  const pointer = listPointerOf(segs)
  const key = ledgerKey(op.path, pointer)
  const label = `${op.path} ${pointerOf(segs)}`
  const prev = c.ledger[key]
  if (prev !== undefined && prev.owner !== op.owner) { c.conflicts.push({ op, detail: `${label} is managed by ${prev.owner}, not ${op.owner}; not touching it` }); return }
  if (op.items.length === 0) {
    if (prev === undefined) c.skipped.push({ op, reason: 'unchanged' })
    else removeList(c, op, key, prev, setEntry)
    return
  }
  const tp = c.vfs.textPath(op.path)
  const node = c.vfs.get(tp)
  const editable = editableText(node, op.path)
  if (!editable.ok) { c.conflicts.push({ op, detail: editable.reason }); return }
  const text = editable.text
  const parsed = parseStructured(format, text)
  if (!parsed.ok) { c.conflicts.push({ op, detail: `${op.path} is not valid ${format.toUpperCase()} (${parsed.error}); not touching it` }); return }
  if (!isRecord(parsed.value)) { c.conflicts.push({ op, detail: `${op.path}: top-level value is not an object; not touching it` }); return }
  const cur = getIn(parsed.value, segs)
  if (cur.found && !Array.isArray(cur.value)) { c.conflicts.push({ op, detail: `${label} is not a list (the user's value); keeping it` }); return }
  const arr = cur.found ? cur.value as unknown[] : []
  const idOf = listIdentity(op.identity)
  const prevItems = prev?.items ?? []
  const prevById = new Map(prevItems.map(i => [i.id, i]))
  const ownedHashes = new Set(prevItems.filter(i => i.adopted !== true).map(i => i.sha256))
  const claimed = new Set<string>()
  const elems = arr.map((e, index) => {
    const hash = valueHash(e)
    const owned = ownedHashes.has(hash) && !claimed.has(hash)
    if (owned) claimed.add(hash)
    return { e, index, id: idOf(e), hash, owned }
  })
  const replace = new Map<number, unknown>()
  const matched = new Set<number>()
  const appends: unknown[] = []
  const items: LedgerListItem[] = []
  let conflicted = 0
  for (const item of op.items) {
    const id = idOf(item) as string
    const hash = valueHash(item)
    const mine = elems.find(el => el.owned && !matched.has(el.index) && el.id === id)
    if (mine) {
      matched.add(mine.index)
      if (mine.hash !== hash) replace.set(mine.index, item)
      items.push({ id, sha256: hash })
      continue
    }
    const theirs = elems.find(el => !el.owned && el.id === id)
    if (theirs) {
      if (theirs.hash === hash) { items.push(c.opts.takeOwnership ? { id, sha256: hash } : { id, sha256: hash, adopted: true }); continue }
      const before = prevById.get(id)
      conflicted++
      const why = before === undefined ? 'already defined by the user' : before.adopted === true ? 'set by the user before Buracle (never written by Buracle)' : 'modified outside Buracle'
      c.conflicts.push({ op, detail: `${label} item ${id}: ${why}; keeping the user's item` })
      if (before !== undefined) items.push(before)
      continue
    }
    const gone = prevById.get(id)
    if (gone !== undefined && !c.opts.restore(op)) {
      conflicted++
      c.conflicts.push({ op, detail: removedDetail(`${label} item ${id}`), removed: true })
      items.push(gone)
      continue
    }
    appends.push(item)
    items.push({ id, sha256: hash })
  }
  let removals = elems.filter(el => el.owned && !matched.has(el.index)).map(el => el.index)
  const pairs = Math.min(removals.length, appends.length)
  for (let k = 0; k < pairs; k++) replace.set(removals[k] as number, appends[k])
  removals = removals.slice(pairs)
  appends.splice(0, pairs)
  const expected = [...elems.filter(el => !removals.includes(el.index)).map(el => (replace.has(el.index) ? replace.get(el.index) : el.e)), ...appends]
  let next = text
  let created: string[] = []
  try {
    if (!cur.found) {
      if (appends.length > 0) {
        created = [...missingParents(parsed.value, segs), pointerOf(segs)]
        if (node.type === 'absent') created.unshift('')
        next = jsoncSet(text, segs, appends)
      }
    } else {
      for (const i of [...replace.keys(), ...removals].sort((a, b) => b - a)) next = jsoncSet(next, [...segs, i], replace.has(i) ? replace.get(i) : undefined)
      for (const item of appends) next = jsoncSet(next, [...segs, -1], item)
    }
    if (next !== text) {
      const check = parseStructured(format, next)
      if (!check.ok) throw new Error(check.error)
      const want = withValueAt(parsed.value, segs, expected)
      if (want === undefined || stableStringify(check.value) !== stableStringify(want)) throw new Error('the document did not read back as expected')
    }
  } catch (e) {
    c.conflicts.push({ op, detail: `${label}: cannot edit the list (${errText(e)}); not touching it` })
    return
  }
  if (next !== text) {
    const ro = readOnlyReason(node, op.path)
    if (ro !== undefined) { c.conflicts.push({ op, detail: ro }); return }
  }
  if (items.length > 0) {
    const entry: LedgerEntry = {
      owner: op.owner, sha256: valueHash(items), path: op.path, pointer, kind, segs, writtenAt: now,
      identity: typeof op.identity === 'string' ? op.identity : [...op.identity], items,
    }
    if (prev !== undefined && prev.sha256 === entry.sha256) entry.writtenAt = prev.writtenAt
    const all = mergeCreated(prev?.created, created)
    if (all.length > 0) entry.created = all
    setEntry(key, entry)
  } else if (prev !== undefined) {
    setEntry(key, undefined)
  }
  if (next !== text) {
    c.vfs.set(tp, withText(node, next))
    c.applied++
  } else if (conflicted === 0) c.skipped.push({ op, reason: 'unchanged' })
}

function removeList(c: Computed, op: Op, key: string, entry: LedgerEntry, setEntry: SetEntryFn): void {
  const format = structFormatOf(entry.kind) as 'json' | 'jsonc'
  const segs = entry.segs ?? parseKeyPath((entry.pointer ?? '').replace(/\[\]$/, '')).map(String)
  const arrayPtr = pointerOf(segs)
  const label = `${entry.path} ${arrayPtr}`
  const tp = c.vfs.textPath(entry.path)
  const node = c.vfs.get(tp)
  const editable = editableText(node, entry.path)
  if (!editable.ok || node.type === 'absent') { setEntry(key, undefined); c.skipped.push({ op, reason: 'already absent' }); return }
  const text = editable.text
  const parsed = parseStructured(format, text)
  if (!parsed.ok) { c.conflicts.push({ op, detail: `${entry.path} is not valid ${format.toUpperCase()} (${parsed.error}); not touching it` }); return }
  const cur = getIn(parsed.value, segs)
  const arr = cur.found && Array.isArray(cur.value) ? cur.value as unknown[] : undefined
  const idOf = listIdentity(entry.identity ?? LIST_IDENTITY_HASH)
  const removeIdx: number[] = []
  const kept: LedgerListItem[] = []
  for (const rec of entry.items ?? []) {
    if (rec.adopted === true) continue
    const idx = arr ? arr.findIndex((e, i) => !removeIdx.includes(i) && valueHash(e) === rec.sha256) : -1
    if (idx >= 0) { removeIdx.push(idx); continue }
    if (arr && arr.some(e => idOf(e) === rec.id)) {
      kept.push(rec)
      c.conflicts.push({ op, detail: `${label} item ${rec.id} was modified outside Buracle; not removing it` })
    }
  }
  if (arr && removeIdx.length > 0) {
    const ro = readOnlyReason(node, entry.path)
    if (ro !== undefined) { c.conflicts.push({ op, detail: ro }); return }
  }
  const created = entry.created ?? []
  const left = arr ? arr.filter((_, i) => !removeIdx.includes(i)) : []
  let next = text
  try {
    if (arr && removeIdx.length > 0) {
      let want: unknown
      if (left.length === 0 && kept.length === 0 && created.includes(arrayPtr)) {
        const target = climbCreated(parsed.value, segs, new Set(created))
        next = jsoncSet(next, target, undefined)
        want = withoutValueAt(parsed.value, target)
      } else {
        for (const i of [...removeIdx].sort((a, b) => b - a)) next = jsoncSet(next, [...segs, i], undefined)
        want = withValueAt(parsed.value, segs, left)
      }
      const check = parseStructured(format, next)
      if (!check.ok) throw new Error(check.error)
      if (stableStringify(check.value) !== stableStringify(want)) throw new Error('the document did not read back as expected')
    }
  } catch (e) {
    c.conflicts.push({ op, detail: `${label}: cannot remove Buracle's items (${errText(e)})` })
    return
  }
  if (kept.length > 0) {
    setEntry(key, { ...entry, items: kept, sha256: valueHash(kept) })
    if (next !== text) { c.vfs.set(tp, withText(node, next)); c.applied++ }
    return
  }
  const pruned = pruneCreated(format, next, left.length > 0 ? created.filter(p => p !== arrayPtr) : created)
  const changed = commitPruned(c, tp, node, text, pruned)
  setEntry(key, undefined)
  handOverCreated(c, entry, key, pruned.remaining, setEntry)
  if (changed) c.applied++
  else c.skipped.push({ op, reason: 'already absent' })
}

function removeCleanup(c: Computed, op: Extract<Op, { kind: 'remove' }>, entry: LedgerEntry, setEntry: SetEntryFn): void {
  setEntry(op.path, undefined)
  const segs = entry.segs ?? parseKeyPath((entry.pointer ?? '').replace(/^cleanup:/, '')).map(String)
  const tp = c.vfs.textPath(entry.path)
  const node = c.vfs.get(tp)
  const editable = editableText(node, entry.path)
  if (entry.absentBefore !== true || !editable.ok || node.type === 'absent' || readOnlyReason(node, entry.path) !== undefined) { c.skipped.push({ op, reason: 'left as it is' }); return }
  const format = formatOfPath(entry.path)
  const parsed = parseStructured(format, editable.text)
  if (!parsed.ok) { c.skipped.push({ op, reason: 'left as it is (the file does not parse)' }); return }
  if (segs.length === 0) {
    if (!isEmptyContainer(parsed.value) || !emptyDocumentText(format, editable.text)) { c.skipped.push({ op, reason: 'it holds something; left as it is' }); return }
    c.vfs.set(tp, { type: 'absent' })
    c.applied++
    return
  }
  const cur = getIn(parsed.value, segs)
  if (!cur.found || !isEmptyContainer(cur.value)) { c.skipped.push({ op, reason: cur.found ? 'it holds something; left as it is' : 'already absent' }); return }
  try {
    const next = setStructured(format, editable.text, segs, undefined)
    const check = parseStructured(format, next)
    if (!check.ok || getIn(check.value, segs).found) throw new Error('the key is still there')
    c.vfs.set(tp, withText(node, next))
    c.applied++
  } catch (e) {
    c.skipped.push({ op, reason: `left as it is (${errText(e)})` })
  }
}

const HELD_BEFORE = 'kept in place: it holds the value it had before Buracle'

function keepSoftValue(c: Computed, op: Extract<Op, { kind: 'remove' }>, entry: LedgerEntry, setEntry: SetEntryFn): void {
  setEntry(op.path, undefined)
  c.skipped.push({ op, reason: keptUserValue(entry.pointer ?? op.path) })
}

function opRemove(c: Computed, op: Extract<Op, { kind: 'remove' }>, setEntry: SetEntryFn): void {
  const entry = c.ledger[op.path]
  if (!entry) {
    const hash = op.path.indexOf('#')
    const node = c.vfs.get(hash >= 0 ? c.vfs.textPath(op.path.slice(0, hash)) : op.path)
    if (node.type === 'absent') { c.skipped.push({ op, reason: 'absent' }); return }
    c.conflicts.push({ op, detail: `${op.path} is not recorded as owned by Buracle; not removing it` })
    return
  }
  if (entry.owner !== op.owner) { c.conflicts.push({ op, detail: `${op.path} is owned by ${entry.owner}, not ${op.owner}; not removing it` }); return }
  if (op.forget === true) {
    setEntry(op.path, undefined)
    c.skipped.push({ op, reason: 'kept in place; it is yours now' })
    return
  }
  if (entry.kind === 'cleanup') { removeCleanup(c, op, entry, setEntry); return }
  if (entry.adopted === true) {
    setEntry(op.path, undefined)
    c.skipped.push({ op, reason: 'pre-existing value that Buracle never wrote; left in place' })
    return
  }
  if (entry.kind === 'json-list' || entry.kind === 'jsonc-list') { removeList(c, op, op.path, entry, setEntry); return }
  if (entry.pointer === undefined) {
    const node = c.vfs.get(entry.path)
    if (node.type === 'absent') { setEntry(op.path, undefined); c.skipped.push({ op, reason: 'already absent' }); return }
    if (fingerprint(node) !== entry.sha256) { c.conflicts.push({ op, detail: `${entry.path} was modified outside Buracle; not removing it` }); return }
    const ro = node.type === 'file' ? readOnlyReason(node, entry.path) : undefined
    if (ro !== undefined) { c.conflicts.push({ op, detail: ro }); return }
    c.vfs.set(entry.path, { type: 'absent' })
    setEntry(op.path, undefined)
    c.applied++
    return
  }
  const tp = c.vfs.textPath(entry.path)
  const node = c.vfs.get(tp)
  const editable = editableText(node, entry.path)
  if (!editable.ok || node.type === 'absent') { setEntry(op.path, undefined); c.skipped.push({ op, reason: 'already absent' }); return }
  const text = editable.text
  const ro = readOnlyReason(node, entry.path)
  const segs = entry.segs ?? parseKeyPath(entry.pointer.replace(/^\[(.*)\]$/, '$1').replace(/^md:/, '')).map(String)
  try {
    let next: string | undefined
    if (entry.kind === 'md-block') {
      const id = entry.pointer.replace(/^md:/, '')
      const cur = mdBlockGet(text, id)
      if (cur === undefined) { setEntry(op.path, undefined); c.skipped.push({ op, reason: 'already absent' }); return }
      if (sha256(normalizeBlock(cur)) !== entry.sha256) { c.conflicts.push({ op, detail: `${entry.path} block ${id} was modified outside Buracle; not removing it` }); return }
      if (ro !== undefined) { c.conflicts.push({ op, detail: ro }); return }
      next = mdBlockRemove(text, id)
      if (mdBlockGet(next, id) !== undefined) throw new Error(`block ${id} is still present after removal`)
    } else if (entry.kind === 'toml-table' || entry.kind === 'toml-key') {
      const cur = getIn(tomlParse(text), segs)
      if (!cur.found) { setEntry(op.path, undefined); c.skipped.push({ op, reason: 'already absent' }); return }
      if (valueHash(ownedTomlValue(cur.value, entry.ignore)) !== entry.sha256) {
        if (entry.soft === true) { keepSoftValue(c, op, entry, setEntry); return }
        c.conflicts.push({ op, detail: `${entry.path} ${entry.pointer} was modified outside Buracle; not removing it` })
        return
      }
      if (ro !== undefined) { c.conflicts.push({ op, detail: ro }); return }
      const name = pointerOf(segs)
      if (entry.displaced !== undefined) {
        const back = entry.displaced.value
        if (entry.kind === 'toml-table' && !isRecord(back)) throw new Error('the value recorded before Buracle is not a table')
        next = entry.kind === 'toml-table'
          ? tomlPatchTables(text, { [name]: back as Record<string, unknown> }, {}, entry.ignore !== undefined ? { [name]: entry.ignore } : {})
          : tomlPatchTables(text, {}, { [name]: back })
        const got = getIn(tomlParse(next), segs)
        if (!got.found || valueHash(ownedTomlValue(got.value, entry.ignore)) !== valueHash(tomlNormalize(back))) throw new Error(`${entry.pointer} did not read back as it was before Buracle`)
        if (next === text) { setEntry(op.path, undefined); c.skipped.push({ op, reason: HELD_BEFORE }); return }
      } else {
        next = tomlRemove(text, entry.kind === 'toml-table' ? { tables: [name] } : { keys: [name] })
        if (getIn(tomlParse(next), segs).found) throw new Error(`${entry.pointer} is defined in a form that cannot be removed surgically`)
      }
    } else if (entry.kind === 'json' || entry.kind === 'jsonc' || entry.kind === 'yaml') {
      const format = entry.kind
      const parsed = parseStructured(format, text)
      if (!parsed.ok) { c.conflicts.push({ op, detail: `${entry.path} is not valid ${format.toUpperCase()} (${parsed.error}); not touching it` }); return }
      const created = entry.created ?? []
      const cur = getIn(parsed.value, segs)
      if (cur.found && valueHash(cur.value) !== entry.sha256) {
        if (entry.soft === true) { keepSoftValue(c, op, entry, setEntry); return }
        c.conflicts.push({ op, detail: `${entry.path} ${entry.pointer} was modified outside Buracle; not removing it` })
        return
      }
      if (ro !== undefined) { c.conflicts.push({ op, detail: ro }); return }
      let removed = text
      if (cur.found && entry.displaced !== undefined) {
        const back = entry.displaced.value
        removed = setStructured(format, text, segs, back)
        const reparsed = parseStructured(format, removed)
        if (!reparsed.ok) throw new Error(`the result would not parse (${reparsed.error})`)
        if (stableStringify(reparsed.value) !== stableStringify(withValueAt(parsed.value, segs, back))) throw new Error('other values would change')
      } else if (cur.found) {
        removed = setStructured(format, text, climbCreated(parsed.value, segs, new Set(created)), undefined)
        const reparsed = parseStructured(format, removed)
        if (!reparsed.ok) throw new Error(`the result would not parse (${reparsed.error})`)
        if (getIn(reparsed.value, segs).found) throw new Error(`${entry.pointer} is still present after removal`)
        if (stableStringify(reparsed.value) !== stableStringify(pruneEmptyAlong(withoutValueAt(parsed.value, segs), segs, created))) throw new Error('other values would change')
      }
      const pruned = pruneCreated(format, removed, created)
      const changed = commitPruned(c, tp, node, text, pruned)
      setEntry(op.path, undefined)
      handOverCreated(c, entry, op.path, pruned.remaining, setEntry)
      if (changed) c.applied++
      else c.skipped.push({ op, reason: cur.found && entry.displaced !== undefined ? HELD_BEFORE : 'already absent' })
      return
    } else {
      c.conflicts.push({ op, detail: `${op.path}: unsupported ledger kind ${entry.kind}` })
      return
    }
    const createdFile = (entry.created ?? []).includes('')
    if (createdFile && node.type === 'file' && next.trim() === '') c.vfs.set(tp, { type: 'absent' })
    else {
      c.vfs.set(tp, withText(node, next))
      if (createdFile) handOverFileCreated(c, entry, op.path, setEntry)
    }
    setEntry(op.path, undefined)
    c.applied++
  } catch (e) {
    c.conflicts.push({ op, detail: `${entry.path}: cannot remove ${entry.pointer} (${e instanceof Error ? e.message : String(e)})` })
  }
}

function pruneEmptyAlong(value: unknown, segs: readonly string[], created: readonly string[]): unknown {
  let out = value
  for (let k = segs.length - 1; k >= 1; k--) {
    const parent = segs.slice(0, k)
    if (!created.includes(pointerOf(parent))) break
    const g = getIn(out, parent)
    if (!g.found || !isEmptyContainer(g.value)) break
    out = withoutValueAt(out, parent)
  }
  return out
}

function absentInOriginal(c: Computed, path: string, segs: readonly string[]): { absent: boolean, fileAbsent: boolean } | undefined {
  const node = c.vfs.original(c.vfs.textPath(path))
  if (node.type === 'absent') return { absent: true, fileAbsent: true }
  const editable = editableText(node, path)
  if (!editable.ok) return undefined
  const parsed = parseStructured(formatOfPath(path), editable.text)
  if (!parsed.ok) return undefined
  return { absent: !getIn(parsed.value, [...segs]).found, fileAbsent: false }
}

function absentBeforeFirstInstall(c: Computed, path: string, segs: readonly string[]): boolean {
  for (const j of listJournalsSync().reverse()) {
    const f = (j.files ?? []).find(x => x.path === path || (x.via ?? []).includes(path))
    if (f === undefined) continue
    if (f.before.type === 'absent') return true
    if (f.before.backup === undefined) return false
    try {
      const parsed = parseStructured(formatOfPath(path), readFileSync(join(paths.backupsDir(), j.txn, f.before.backup), 'utf8'))
      return parsed.ok && !getIn(parsed.value, [...segs]).found
    } catch { return false }
  }
  return absentInOriginal(c, path, segs)?.absent === true
}

function recordCleanup(c: Computed, t: CleanupTarget, setEntry: SetEntryFn, now: string): void {
  const here = absentInOriginal(c, t.path, t.segs)
  if (here !== undefined) c.cleanup.push({ path: t.path, segs: t.segs, absentBefore: here.absent, fileAbsentBefore: here.fileAbsent })
  const key = cleanupLedgerKey(t.path, t.segs)
  if (c.ledger[key] !== undefined) return
  const entry: LedgerEntry = { owner: t.owner, sha256: '', path: t.path, pointer: `cleanup:${pointerOf(t.segs)}`, kind: 'cleanup', segs: t.segs, writtenAt: now }
  if (absentBeforeFirstInstall(c, t.path, t.segs)) entry.absentBefore = true
  setEntry(key, entry)
}

export type TxnStatus = 'applying' | 'committed' | 'rolled-back' | 'rollback-failed'

interface NodeSnap { type: 'absent' | 'file' | 'symlink'; mode?: number; target?: string; sha256?: string; backup?: string }
interface JournalFile { path: string; before: NodeSnap; after: NodeSnap; via?: string[] }
interface JournalExec { argv: string[]; undo?: string[]; ran: boolean; started?: boolean; undone?: boolean; failed?: boolean; soft?: boolean; owner?: string }

export interface Journal {
  v: 1
  txn: string
  status: TxnStatus
  startedAt: string
  finishedAt?: string
  rolledBackAt?: string
  plans: Array<{ id: string; harness: string; ops: number }>
  files: JournalFile[]
  createdDirs: string[]
  execs: JournalExec[]
  ledger: LedgerChange[]
  error?: string
  run?: string
  cleanup?: JournalCleanup[]
  backupsPruned?: boolean
}

function snapOf(n: Node, linkOnly = false): NodeSnap {
  if (n.type === 'file') return { type: 'file', mode: n.mode, sha256: sha256(n.content) }
  if (n.type === 'symlink') {
    // The journal keeps the target as the file system spells it, so a rollback recreates exactly that link.
    const s: NodeSnap = { type: 'symlink', target: n.raw ?? n.target }
    if (linkOnly) return s
    if (n.content !== undefined) s.sha256 = sha256(n.content)
    if (n.mode !== undefined) s.mode = n.mode
    return s
  }
  return { type: 'absent' }
}

function editsThroughLink(before: Node, after: Node): boolean {
  return before.type === 'symlink' && after.type === 'symlink' && after.target === before.target
}

function unchangedSinceCompute(cur: Node, before: Node, after: Node): boolean {
  if (before.type === 'symlink' && !editsThroughLink(before, after)) return cur.type === 'symlink' && cur.target === before.target
  return sameNode(cur, before)
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700) } catch {  }
}

function writeJournal(j: Journal): void {
  ensurePrivateDir(paths.journalDir())
  atomicWriteSync(paths.journalFile(j.txn), JSON.stringify(j, null, 2) + '\n', { mode: 0o600 })
}

const TXN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function readJournal(txn: string): Promise<Journal> {
  if (!TXN_ID_RE.test(txn)) throw new Error(`invalid transaction id ${JSON.stringify(txn)}`)
  const r = readJsonSafeSync<Journal>(paths.journalFile(txn))
  if (!r.ok) throw new Error(r.code === 'missing' ? `unknown transaction ${txn}` : r.error)
  if (r.value === null || typeof r.value !== 'object' || typeof r.value.txn !== 'string') throw new Error(`unknown transaction ${txn}`)
  return r.value
}

function listJournalsSync(): Journal[] {
  let names: string[]
  try { names = readdirSync(paths.journalDir()) } catch { return [] }
  const out: Journal[] = []
  for (const n of names) {
    if (!n.endsWith('.json') || !TXN_ID_RE.test(n)) continue
    const r = readJsonSafeSync<Journal>(join(paths.journalDir(), n))
    if (r.ok && r.value && typeof r.value.txn === 'string') out.push(r.value)
  }
  return out.sort((a, b) => (a.txn < b.txn ? 1 : a.txn > b.txn ? -1 : 0))
}

export async function listTxns(): Promise<Journal[]> {
  return listJournalsSync()
}

function newTxnId(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}Z`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

export function newRunId(): string {
  return newTxnId()
}

interface LockInfo { pid: number; startedAt?: number }

function processStartMs(): number {
  return Math.round(Date.now() - process.uptime() * 1000)
}

// A live PID that no lookup can identify holds the lock only this long after the lock was written,
// so a stale lock whose PID was reused never blocks forever.
const UNIDENTIFIED_HOLDER_MS = 15 * 60_000

function parseLock(text: string): LockInfo {
  const t = text.trim()
  if (t.startsWith('{')) {
    try {
      const v = JSON.parse(t) as { pid?: unknown, startedAt?: unknown }
      const info: LockInfo = { pid: typeof v.pid === 'number' ? v.pid : NaN }
      if (typeof v.startedAt === 'number') info.startedAt = v.startedAt
      return info
    } catch { return { pid: NaN } }
  }
  return { pid: parseInt(t, 10) }
}

function lockHolderAlive(info: LockInfo, lockWrittenMs: number): boolean {
  if (!Number.isInteger(info.pid) || info.pid <= 0) return false
  try { process.kill(info.pid, 0) } catch { return false }
  const seen = lookUpProcess(info.pid)
  const recent = Date.now() - lockWrittenMs < UNIDENTIFIED_HOLDER_MS
  if (seen === undefined) return recent
  if (info.startedAt !== undefined) {
    if (seen.startedAt === undefined) return recent
    return Math.abs(seen.startedAt - info.startedAt) <= 5000
  }
  return /\b(bun|buracle)\b/.test(seen.command)
}

let lockHeldInProcess = false
let outerLockHeld = false
let nestedActive = false

function acquireLockFile(): () => void {
  if (lockHeldInProcess) throw new Error('another Buracle transaction is already running in this process')
  const lock = paths.txnLockFile()
  mkdirSync(dirname(lock), { recursive: true })
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      const text = JSON.stringify({ pid: process.pid, startedAt: processStartMs(), token: lockToken() }) + '\n'
      writeSync(fd, text)
      closeSync(fd)
      lockHeldInProcess = true
      return () => {
        lockHeldInProcess = false
        releaseLockFile(lock, text)
      }
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e
      const seen = lockSnapshot(lock)
      if (seen === undefined) continue
      const info = parseLock(seen.text)
      if (info.pid !== process.pid && lockHolderAlive(info, seen.mtimeMs)) {
        const since = info.startedAt !== undefined ? `, started ${new Date(info.startedAt).toISOString()}` : ''
        throw new Error(`another Buracle transaction is running (pid ${info.pid}${since}); lock ${lock}. If no buracle command is running, delete that file and try again.`)
      }
      if (breakStaleLock(lock, seen) === 'busy') Bun.sleepSync(10)
    }
  }
  throw new Error(`cannot acquire transaction lock ${lock}`)
}

function acquireLock(): () => void {
  if (outerLockHeld) {
    if (nestedActive) throw new Error('another Buracle transaction is already running in this process')
    nestedActive = true
    return () => { nestedActive = false }
  }
  return acquireLockFile()
}

export async function withTxnLock<T>(fn: () => Promise<T>): Promise<T> {
  if (outerLockHeld) return fn()
  const release = acquireLockFile()
  outerLockHeld = true
  try {
    return await fn()
  } finally {
    outerLockHeld = false
    nestedActive = false
    release()
  }
}

const TRAPPED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

interface Trap { readonly signal: string | undefined; readonly abort: AbortSignal; dispose(): void }

function trapSignals(): Trap {
  const controller = new AbortController()
  let got: string | undefined
  const handler = (sig: string) => {
    if (got === undefined) {
      got = sig
      controller.abort()
      log('warn', 'txn: signal received; rolling back the transaction', { signal: sig })
    } else log('warn', 'txn: signal ignored while the transaction rolls back', { signal: sig })
  }
  for (const s of TRAPPED_SIGNALS) process.on(s, handler)
  return {
    get signal() { return got },
    abort: controller.signal,
    dispose() { for (const s of TRAPPED_SIGNALS) process.off(s, handler) },
  }
}

function makeTicker(): (what: string) => void {
  const raw = process.env['BURACLE_TXN_FAIL_AT']
  const failAt = raw !== undefined && /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : 0
  let n = 0
  return (what: string) => {
    n++
    if (failAt > 0 && n === failAt) throw new Error(`BURACLE_TXN_FAIL_AT=${failAt}: injected failure at write #${n} (${what})`)
  }
}

function missingDirs(path: string): string[] {
  const out: string[] = []
  let d = dirname(path)
  for (;;) {
    try { lstatSync(d); break } catch { out.push(d) }
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return out
}

function writeNode(path: string, before: Node, after: Node, tick: (w: string) => void): void {
  if (after.type === 'absent') {
    if (before.type === 'file' || before.type === 'symlink') { tick(`remove ${path}`); unlinkSync(path) }
    return
  }
  if (after.type === 'file') {
    if (before.type === 'symlink') { tick(`unlink ${path}`); unlinkSync(path) }
    tick(`write ${path}`)
    atomicWriteSync(path, after.content, { mode: after.mode })
    return
  }
  if (after.type === 'symlink') {
    if (before.type === 'symlink' && before.target === after.target) {
      if (after.content !== undefined && after.content !== before.content) { tick(`write ${path}`); atomicWriteSync(path, after.content) }
      return
    }
    if (before.type === 'file' || before.type === 'symlink') { tick(`unlink ${path}`); unlinkSync(path) }
    mkdirSync(dirname(path), { recursive: true })
    tick(`symlink ${path}`)
    symlinkSync(nativeLinkTarget(after.target), path)
    if (after.content !== undefined) { tick(`write ${path}`); atomicWriteSync(path, after.content) }
  }
}

function nodeIs(got: Node, want: Node): boolean {
  return want.type === 'absent' ? got.type === 'absent'
    : want.type === 'file' ? got.type === 'file' && got.content === want.content && sameMode(got.mode, want.mode)
    : want.type === 'symlink' ? got.type === 'symlink' && got.target === want.target && (want.content === undefined || got.content === want.content)
    : true
}

function verifyNode(path: string, want: Node): void {
  if (!nodeIs(readNode(path), want)) throw new Error(`verification failed for ${path}: on-disk state differs from what was written`)
}

function entryHolds(e: LedgerEntry, node: Node): boolean {
  if (e.pointer === undefined) return fingerprint(node) === e.sha256
  if (node.type !== 'file' && node.type !== 'symlink') return false
  const editable = editableText(node, e.path)
  if (!editable.ok) return false
  const text = editable.text
  const segs = e.segs ?? parseKeyPath(e.pointer.replace(/\[\]$/, '').replace(/^\[(.*)\]$/, '$1').replace(/^md:/, '')).map(String)
  try {
    switch (e.kind) {
      case 'md-block': {
        const cur = mdBlockGet(text, e.pointer.replace(/^md:/, ''))
        return cur !== undefined && sha256(normalizeBlock(cur)) === e.sha256
      }
      case 'toml-table':
      case 'toml-key': {
        const cur = getIn(tomlParse(text), segs)
        return cur.found && valueHash(ownedTomlValue(cur.value, e.ignore)) === e.sha256
      }
      case 'json':
      case 'jsonc':
      case 'yaml': {
        const parsed = parseStructured(e.kind, text)
        if (!parsed.ok) return false
        const cur = getIn(parsed.value, segs)
        return cur.found && valueHash(cur.value) === e.sha256
      }
      case 'json-list':
      case 'jsonc-list': {
        const parsed = parseStructured(structFormatOf(e.kind) as 'json' | 'jsonc', text)
        if (!parsed.ok) return false
        const cur = getIn(parsed.value, segs)
        if (!cur.found || !Array.isArray(cur.value)) return false
        const hashes = cur.value.map(v => valueHash(v))
        for (const it of e.items ?? []) {
          if (it.adopted === true) continue
          const i = hashes.indexOf(it.sha256)
          if (i < 0) return false
          hashes.splice(i, 1)
        }
        return true
      }
      default:
        return false
    }
  } catch {
    return false
  }
}

function ownedPartsHold(aliases: ReadonlySet<string>, cur: Node, ledgerAfter: Ledger, ledgerChanges: readonly LedgerChange[]): boolean {
  const owned = Object.values(ledgerAfter).filter(e => aliases.has(e.path) && e.adopted !== true && e.kind !== 'cleanup')
  const removed = ledgerChanges.filter(ch => ch.after === undefined && ch.before !== undefined && aliases.has(ch.before.path) && ch.before.kind !== 'cleanup').map(ch => ch.before as LedgerEntry)
  if (owned.length === 0 && removed.length === 0) return false
  if (owned.some(e => e.pointer === undefined) || removed.some(e => e.pointer === undefined)) return false
  const staysInPlace = (e: LedgerEntry) => e.displaced !== undefined && valueHash(e.displaced.value) === e.sha256
  return owned.every(e => entryHolds(e, cur)) && removed.every(e => staysInPlace(e) || !entryHolds(e, cur))
}

function backupRel(i: number): string {
  return join('files', String(i))
}

function matchesSnap(n: Node, s: NodeSnap, withMode = false): boolean {
  if (s.type === 'absent') return n.type === 'absent'
  if (s.type === 'file') return n.type === 'file' && sha256(n.content) === s.sha256 && (!withMode || s.mode === undefined || sameMode(n.mode, s.mode))
  return n.type === 'symlink' && n.target === linkTarget(s.target ?? '') && (s.sha256 === undefined || (n.content !== undefined && sha256(n.content) === s.sha256))
}

function restoreFromJournal(txnDir: string, f: JournalFile): void {
  const cur = readNode(f.path)
  const b = f.before
  if (matchesSnap(cur, b, true)) return
  if (cur.type === 'dir' || cur.type === 'other') throw new Error(`${f.path}: cannot restore over a directory or special file`)
  if (b.type === 'absent') {
    if (cur.type === 'file' || cur.type === 'symlink') unlinkSync(f.path)
    return
  }
  if (b.type === 'file') {
    if (cur.type === 'symlink') unlinkSync(f.path)
    const data = readFileSync(join(txnDir, b.backup as string))
    atomicWriteSync(f.path, data, { mode: b.mode ?? 0o644 })
    return
  }
  if (!(cur.type === 'symlink' && cur.target === linkTarget(b.target ?? ''))) {
    if (cur.type === 'file' || cur.type === 'symlink') unlinkSync(f.path)
    mkdirSync(dirname(f.path), { recursive: true })
    symlinkSync(nativeLinkTarget(b.target as string), f.path)
  }
  if (b.backup !== undefined && !matchesSnap(readNode(f.path), b)) {
    atomicWriteSync(f.path, readFileSync(join(txnDir, b.backup)))
  }
}

function removeCreatedDirs(dirs: string[]): void {
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try { rmdirSync(d) } catch {  }
  }
}

async function runExec(argv: string[], signal?: AbortSignal): Promise<{ code: number, out: string }> {
  const r = await run(argv, signal !== undefined ? { timeoutMs: 300_000, signal } : { timeoutMs: 300_000 })
  return { code: r.code, out: `${r.stdout}${r.stderr}`.trim().slice(0, 2000) }
}

function applyLedgerChanges(base: Ledger, changes: LedgerChange[]): Ledger {
  const next: Ledger = { ...base }
  applyChanges(next, changes)
  return next
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function outputTail(out: string): string {
  const t = out.replace(/\s+/g, ' ').trim()
  return t.length > 300 ? `…${t.slice(-300)}` : t
}

interface FilesUndo {
  restored: string[]
  skipped: Array<{ path: string, reason: string }>
  errors: string[]
  warnings: string[]
  left: Set<string>
  untouched: Set<string>
}

function beforeText(txnDir: string, f: JournalFile): { ok: true, text: string } | { ok: false, error: string } {
  if (f.before.type === 'absent') return { ok: true, text: '' }
  if (f.before.backup === undefined) return { ok: false, error: 'no backup of its earlier content' }
  try { return { ok: true, text: readFileSync(join(txnDir, f.before.backup), 'utf8') } } catch (e) { return { ok: false, error: `its backup cannot be read (${errText(e)})` } }
}

function changesFor(journal: Journal, f: JournalFile): LedgerChange[] {
  const names = new Set([f.path, ...(f.via ?? [])])
  return (journal.ledger ?? []).filter(ch => { const e = ch.after ?? ch.before; return e !== undefined && names.has(e.path) })
}

function keyedChanges(journal: Journal, f: JournalFile): LedgerChange[] | undefined {
  const chs = changesFor(journal, f)
  if (chs.length === 0) return undefined
  if (chs.some(ch => (ch.after ?? ch.before)?.pointer === undefined)) return undefined
  return chs
}

export function repointPathsMissing(argv: readonly string[], undo: readonly string[]): string[] {
  if (undo.length !== argv.length || basename(undo[0] ?? '') !== basename(argv[0] ?? '')) return []
  const missing: string[] = []
  for (let i = 1; i < undo.length; i++) {
    const a = argv[i] as string
    const b = undo[i] as string
    if (a === b) continue
    if (!isAbsolute(b) || !isAbsolute(a)) return []
    try { lstatSync(b); return [] } catch { missing.push(b) }
  }
  return missing
}

export const UNDO_KEPT_EXIT = 3

export function undoKeptOnPurpose(undo: readonly string[], code: number): boolean {
  return code === UNDO_KEPT_EXIT && undo.some(a => /[\\/]src[\\/]adapters[\\/][a-z]+[\\/]check\.ts$/.test(a))
}

function minus(a: readonly string[], b: readonly string[]): string[] {
  const rest = [...b]
  const out: string[] = []
  for (const x of a) {
    const i = rest.indexOf(x)
    if (i >= 0) rest.splice(i, 1)
    else out.push(x)
  }
  return out
}

interface KeyUndo { text: string; done: boolean; kept?: string }

function undoKey(ch: LedgerChange, path: string, text: string, before: string): KeyUndo {
  const e = (ch.after ?? ch.before) as LedgerEntry
  const segs = e.segs ?? parseKeyPath((e.pointer ?? '').replace(/^cleanup:/, '').replace(/\[\]$/, '').replace(/^\[(.*)\]$/, '$1').replace(/^md:/, '')).map(String)
  const wrote = ch.after !== undefined && ch.after.adopted !== true && ch.after.kind !== 'cleanup'
  const removedOurs = ch.after === undefined && ch.before !== undefined && ch.before.adopted !== true
  if (!wrote && !removedOurs) return { text, done: true }
  const newCreated = minus(ch.after?.created ?? [], ch.before?.created ?? []).filter(p => p !== '')
  const label = `${path} ${e.pointer}`
  switch (e.kind) {
    case 'json': case 'jsonc': case 'yaml': case 'cleanup': {
      const format: StructFormat = e.kind === 'cleanup' ? formatOfPath(path) : e.kind
      const cur = parseStructured(format, text)
      const bef = parseStructured(format, before)
      if (!cur.ok) throw new Error(`${path} no longer parses (${cur.error})`)
      if (!bef.ok) throw new Error(`the backup of ${path} does not parse (${bef.error})`)
      const c = getIn(cur.value, segs)
      const b = getIn(bef.value, segs)
      if (e.kind === 'cleanup') return { text: !c.found && b.found ? setStructured(format, text, segs, b.value) : text, done: true }
      if (wrote) {
        const a = ch.after as LedgerEntry
        if (c.found && valueHash(c.value) !== a.sha256) return { text, done: false, kept: `${label} was changed after the transaction; kept` }
        let next = text
        if (c.found) {
          next = b.found ? setStructured(format, text, segs, b.value) : setStructured(format, text, climbCreated(cur.value, segs, new Set(newCreated)), undefined)
        }
        if (!b.found && newCreated.length > 0) next = pruneCreated(format, next, newCreated).text
        return { text: next, done: true }
      }
      if (c.found) {
        const back = (ch.before as LedgerEntry).displaced
        if (back !== undefined && b.found && valueHash(c.value) === valueHash(back.value)) return { text: setStructured(format, text, segs, b.value), done: true }
        return { text, done: false, kept: `${label} was set again after the transaction; kept` }
      }
      return { text: b.found ? setStructured(format, text, segs, b.value) : text, done: true }
    }
    case 'toml-table': case 'toml-key': {
      const name = pointerOf(segs)
      const c = getIn(tomlParse(text), segs)
      const b = getIn(tomlParse(before), segs)
      const ign = e.kind === 'toml-table' ? e.ignore : undefined
      const set = (v: unknown) => (e.kind === 'toml-table' ? tomlPatchTables(text, { [name]: ownedTomlValue(v, ign) as Record<string, unknown> }, {}, ign !== undefined ? { [name]: ign } : {}) : tomlPatchTables(text, {}, { [name]: v }))
      if (wrote) {
        if (c.found && valueHash(ownedTomlValue(c.value, ign)) !== (ch.after as LedgerEntry).sha256) return { text, done: false, kept: `${label} was changed after the transaction; kept` }
        if (!c.found) return { text, done: true }
        return { text: b.found ? set(b.value) : tomlRemove(text, e.kind === 'toml-table' ? { tables: [name] } : { keys: [name] }), done: true }
      }
      if (c.found) {
        const back = (ch.before as LedgerEntry).displaced
        if (back !== undefined && b.found && valueHash(ownedTomlValue(c.value, ign)) === valueHash(tomlNormalize(back.value))) return { text: set(b.value), done: true }
        return { text, done: false, kept: `${label} was set again after the transaction; kept` }
      }
      return { text: b.found ? set(b.value) : text, done: true }
    }
    case 'md-block': {
      const id = (e.pointer ?? '').replace(/^md:/, '')
      const c = mdBlockGet(text, id)
      const b = mdBlockGet(before, id)
      if (wrote) {
        if (c !== undefined && sha256(normalizeBlock(c)) !== (ch.after as LedgerEntry).sha256) return { text, done: false, kept: `${label} was changed after the transaction; kept` }
        if (c === undefined) return { text, done: true }
        return { text: b !== undefined ? mdBlockUpsert(text, id, b) : mdBlockRemove(text, id), done: true }
      }
      if (c !== undefined) return { text, done: false, kept: `${label} was set again after the transaction; kept` }
      return { text: b !== undefined ? mdBlockUpsert(text, id, b) : text, done: true }
    }
    case 'json-list': case 'jsonc-list': {
      const format = structFormatOf(e.kind) as StructFormat
      const cur = parseStructured(format, text)
      const bef = parseStructured(format, before)
      if (!cur.ok) throw new Error(`${path} no longer parses (${cur.error})`)
      if (!bef.ok) throw new Error(`the backup of ${path} does not parse (${bef.error})`)
      const cv = getIn(cur.value, segs)
      if (cv.found && !Array.isArray(cv.value)) return { text, done: false, kept: `${label} is no longer a list; kept` }
      const C = cv.found ? cv.value as unknown[] : []
      const bv = getIn(bef.value, segs)
      const B = bv.found && Array.isArray(bv.value) ? bv.value as unknown[] : []
      const owned = (it: LedgerEntry | undefined) => (it?.items ?? []).filter(i => i.adopted !== true).map(i => i.sha256)
      const added = minus(owned(ch.after), owned(ch.before))
      const dropped = minus(owned(ch.before), owned(ch.after))
      const result = [...C]
      for (const h of added) { const i = result.findIndex(x => valueHash(x) === h); if (i >= 0) result.splice(i, 1) }
      const restore: unknown[] = []
      for (const h of dropped) {
        if (result.some(x => valueHash(x) === h)) continue
        const bi = B.findIndex(x => valueHash(x) === h)
        if (bi >= 0) restore.push(B[bi])
      }
      if (stableStringify(result) === stableStringify(C) && restore.length === 0) return { text, done: true }
      let next = text
      if (result.length === 0 && restore.length === 0 && !bv.found && cv.found) {
        next = jsoncSet(next, climbCreated(cur.value, segs, new Set(newCreated)), undefined)
        if (newCreated.length > 0) next = pruneCreated(format, next, newCreated).text
        return { text: next, done: true }
      }
      const removeAt: number[] = []
      const pool = C.map((x, i) => ({ h: valueHash(x), i }))
      for (const h of added) { const k = pool.findIndex(p => p.h === h && !removeAt.includes(p.i)); if (k >= 0) removeAt.push((pool[k] as { i: number }).i) }
      for (const i of removeAt.sort((a, b) => b - a)) next = jsoncSet(next, [...segs, i], undefined)
      if (!cv.found && restore.length > 0) next = jsoncSet(next, segs, restore)
      else for (const item of restore) next = jsoncSet(next, [...segs, -1], item)
      return { text: next, done: true }
    }
    default:
      return { text, done: true }
  }
}

function emptyDocument(path: string, text: string, kinds: ReadonlySet<LedgerKind>): boolean {
  if (text.trim() === '') return true
  if ([...kinds].some(k => structFormatOf(k) !== undefined || k === 'cleanup')) return emptyDocumentText(formatOfPath(path), text) || text.replace(/\s+/g, '') === '{}'
  return false
}

function undoFiles(journal: Journal, txnDir: string, opts: { interrupted: boolean, only?: ReadonlySet<string> }): FilesUndo {
  const out: FilesUndo = { restored: [], skipped: [], errors: [], warnings: [], left: new Set(), untouched: new Set() }
  const leaveAll = (f: JournalFile) => {
    for (const ch of changesFor(journal, f)) if (ch.after !== undefined && ch.after.adopted !== true) out.left.add(ch.key)
  }
  for (let i = journal.files.length - 1; i >= 0; i--) {
    const f = journal.files[i] as JournalFile
    if (opts.only !== undefined && !opts.only.has(f.path)) continue
    const cur = readNode(f.path)
    if (matchesSnap(cur, f.before, true)) { out.restored.push(f.path); continue }
    const atAfter = matchesSnap(cur, f.after)
    const midway = opts.interrupted && cur.type === 'absent' && f.before.type !== 'absent' && f.after.type !== 'absent'
    if (atAfter || midway) {
      if (f.before.backup !== undefined && journal.backupsPruned === true) {
        out.errors.push(`${f.path}: the backup of this transaction was removed by retention; it cannot be restored`)
        leaveAll(f)
        continue
      }
      try { restoreFromJournal(txnDir, f); out.restored.push(f.path) } catch (e) { out.errors.push(`${f.path}: ${errText(e)}`); leaveAll(f) }
      continue
    }
    const keyed = keyedChanges(journal, f)
    const editable = editableText(cur, f.path)
    if (keyed === undefined || cur.type === 'absent' || !editable.ok) {
      out.skipped.push({ path: f.path, reason: 'changed after the transaction; left as is' })
      for (const p of [f.path, ...(f.via ?? [])]) out.untouched.add(p)
      continue
    }
    const bt = beforeText(txnDir, f)
    if (!bt.ok) { out.errors.push(`${f.path}: cannot undo Buracle's keys: ${bt.error}`); leaveAll(f); continue }
    let text = editable.text
    let failed = false
    const kinds = new Set<LedgerKind>()
    for (const ch of [...keyed].reverse()) {
      const e = (ch.after ?? ch.before) as LedgerEntry
      kinds.add(e.kind)
      try {
        const r = undoKey(ch, f.path, text, bt.text)
        text = r.text
        if (r.kept !== undefined) out.warnings.push(r.kept)
      } catch (err) {
        failed = true
        out.errors.push(`${f.path}: cannot undo ${e.pointer}: ${errText(err)}`)
        if (ch.after !== undefined && ch.after.adopted !== true) out.left.add(ch.key)
      }
    }
    if (text === editable.text) { if (!failed) out.restored.push(f.path); continue }
    try {
      if (f.before.type === 'absent' && emptyDocument(f.path, text, kinds) && cur.type === 'file') unlinkSync(f.path)
      else atomicWriteSync(f.path, text)
      out.restored.push(f.path)
      out.warnings.push(`${f.path} was changed after the transaction: only Buracle's keys were undone; the other changes were kept`)
    } catch (err) {
      out.errors.push(`${f.path}: ${errText(err)}`)
      leaveAll(f)
    }
  }
  return out
}

async function undoExecs(journal: Journal, persist: boolean): Promise<{ undone: string[], errors: string[], warnings: string[] }> {
  const out = { undone: [] as string[], errors: [] as string[], warnings: [] as string[] }
  for (let i = (journal.execs ?? []).length - 1; i >= 0; i--) {
    const ex = journal.execs[i] as JournalExec
    if (!ex.undo || ex.undone === true) continue
    const partial = ex.started === true && !ex.ran && ex.soft !== true
    if (!ex.ran && !partial) continue
    const gone = repointPathsMissing(ex.argv, ex.undo)
    if (gone.length > 0) {
      ex.undone = true
      out.warnings.push(`not run: \`${ex.undo.join(' ')}\` (${gone.join(', ')} no longer exist${gone.length === 1 ? 's' : ''}; nothing to put back)`)
      if (persist) { try { writeJournal(journal) } catch {  } }
      continue
    }
    const r = await runExec(ex.undo)
    if (r.code === 0) {
      ex.undone = true
      out.undone.push(ex.undo.join(' '))
      if (persist) { try { writeJournal(journal) } catch {  } }
    } else if (undoKeptOnPurpose(ex.undo, r.code)) {
      ex.undone = true
      out.warnings.push(`kept on purpose: \`${ex.undo.join(' ')}\` left it in place${r.out.trim() !== '' ? `: ${outputTail(r.out)}` : ''}`)
      if (persist) { try { writeJournal(journal) } catch {  } }
    } else if (ex.ran) out.errors.push(`undo failed (exit ${r.code}): ${ex.undo.join(' ')}`)
    else out.warnings.push(`undo of the unfinished \`${ex.argv.join(' ')}\` failed (exit ${r.code}); it may never have taken effect`)
  }
  return out
}

function cleanupAfterUndo(journal: Journal): string[] {
  const warnings: string[] = []
  for (const k of journal.cleanup ?? []) {
    if (!k.absentBefore) continue
    const node = readNode(k.path)
    const editable = editableText(node, k.path)
    if (node.type === 'absent' || !editable.ok) continue
    const format = formatOfPath(k.path)
    const parsed = parseStructured(format, editable.text)
    if (!parsed.ok) continue
    if (k.segs.length === 0) {
      if (k.fileAbsentBefore && node.type === 'file' && isEmptyContainer(parsed.value) && emptyDocumentText(format, editable.text)) {
        try { unlinkSync(k.path) } catch (e) { warnings.push(`${k.path}: the empty leftover could not be removed (${errText(e)})`) }
      }
      continue
    }
    const cur = getIn(parsed.value, k.segs)
    if (!cur.found || !isEmptyContainer(cur.value)) continue
    try {
      const next = setStructured(format, editable.text, k.segs, undefined)
      if (k.fileAbsentBefore && node.type === 'file' && emptyDocumentText(format, next)) unlinkSync(k.path)
      else atomicWriteSync(k.path, next)
    } catch (e) {
      warnings.push(`${k.path} ${k.segs.join('.')}: the empty leftover could not be removed (${errText(e)})`)
    }
  }
  return warnings
}

interface UndoOutcome { restored: string[]; skipped: Array<{ path: string, reason: string }>; undone: string[]; errors: string[]; warnings: string[] }

async function undoJournal(journal: Journal, interrupted: boolean): Promise<UndoOutcome> {
  const txnDir = join(paths.backupsDir(), journal.txn)
  const files = undoFiles(journal, txnDir, { interrupted })
  removeCreatedDirs(journal.createdDirs ?? [])
  const ex = await undoExecs(journal, true)
  const cleanupWarnings = cleanupAfterUndo(journal)
  removeCreatedDirs(journal.createdDirs ?? [])
  const ledger = loadLedger()
  let dirty = false
  for (const ch of journal.ledger ?? []) {
    if (files.left.has(ch.key)) {
      if (ch.after !== undefined && !entryEquals(ledger[ch.key], ch.after)) { ledger[ch.key] = ch.after; dirty = true }
      continue
    }
    const entryPath = (ch.after ?? ch.before)?.path
    if (entryPath !== undefined && files.untouched.has(entryPath)) continue
    if (!entryEquals(ledger[ch.key], ch.after)) continue
    if (ch.before) ledger[ch.key] = ch.before
    else delete ledger[ch.key]
    dirty = true
  }
  if (dirty) writeLedger(ledger)
  return {
    restored: files.restored,
    skipped: files.skipped,
    undone: ex.undone,
    errors: [...files.errors, ...ex.errors],
    warnings: [...files.warnings, ...ex.warnings, ...cleanupWarnings],
  }
}

async function recoverInterrupted(except?: string): Promise<string[]> {
  const recovered: string[] = []
  const failures: string[] = []
  for (const j of await listTxns()) {
    if (j.status !== 'applying' || j.txn === except) continue
    let outcome: UndoOutcome
    try { outcome = await undoJournal(j, true) } catch (e) { outcome = { restored: [], skipped: [], undone: [], errors: [errText(e)], warnings: [] } }
    const notes = [...outcome.errors, ...outcome.skipped.map(s => `${s.path}: ${s.reason}`), ...outcome.warnings]
    j.status = outcome.errors.length > 0 ? 'rollback-failed' : 'rolled-back'
    j.rolledBackAt = new Date().toISOString()
    j.error = [j.error, 'interrupted: the process ended while applying; rolled back at the next run', ...notes].filter(x => x !== undefined && x !== '').join('\n')
    try { writeJournal(j) } catch {  }
    log(outcome.errors.length > 0 ? 'error' : 'warn', 'interrupted txn recovered', { txn: j.txn, restored: outcome.restored.length, notes })
    if (outcome.errors.length > 0) failures.push(`${j.txn}:\n  - ${outcome.errors.join('\n  - ')}`)
    else recovered.push(j.txn)
  }
  if (failures.length > 0) {
    throw new Error(`an interrupted transaction could not be rolled back completely; fix the paths below, then run \`buracle rollback <txn>\`:\n${failures.join('\n')}`)
  }
  return recovered
}

export const txnTestHooks: { afterCompute?: () => void, beforeWrite?: (path: string) => void, keepsModes?: boolean, windowsLinks?: boolean } = {}

export const RETENTION = { backups: 20, backgroundBackups: 10, journals: 50 } as const

export const BACKGROUND_PLAN_PREFIXES: readonly string[] = ['memory-project-']

export function isBackgroundJournal(j: Pick<Journal, 'plans'>): boolean {
  return Array.isArray(j.plans) && j.plans.length > 0 && j.plans.every(p => typeof p?.id === 'string' && BACKGROUND_PLAN_PREFIXES.some(pre => p.id.startsWith(pre)))
}

export async function applyPlans(plans: Plan[], opts: ApplyOptions = {}): Promise<ApplyResult> {
  const ops = validateOps(plans)
  const cleanup = cleanupTargets(plans)
  const now = new Date().toISOString()
  const copts = computeOptions(opts)
  if (opts.dryRun) {
    const c = compute(ops, loadLedger(), now, copts, cleanup)
    let applied = c.applied
    for (const op of c.execs) {
      if (op.idempotentCheck && (await runExec(op.idempotentCheck)).code === 0) c.skipped.push({ op, reason: 'already done (idempotent check passed)' })
      else applied++
    }
    return { txn: '', applied, skipped: c.skipped, conflicts: c.conflicts, warnings: [...c.warnings] }
  }

  const release = acquireLock()
  const trap = trapSignals()
  try {
    const recovered = await recoverInterrupted()
    const warnings: string[] = []
    const withRecovered = (r: ApplyResult): ApplyResult => (recovered.length > 0 ? { ...r, recovered } : r)
    const stopIfInterrupted = (txn: string) => {
      if (trap.signal !== undefined) throw new TxnInterruptedError(trap.signal, txn, `interrupted by ${trap.signal} before anything was written`)
    }
    stopIfInterrupted('')

    const execSkips: Array<{ op: Op, reason: string }> = []
    const execOps: Array<Extract<Op, { kind: 'exec' }>> = []
    for (const op of ops) {
      if (op.kind !== 'exec') continue
      const done = op.idempotentCheck !== undefined && (await runExec(op.idempotentCheck, trap.abort)).code === 0
      stopIfInterrupted('')
      if (done) execSkips.push({ op, reason: 'already done (idempotent check passed)' })
      else execOps.push(op)
    }
    stopIfInterrupted('')

    const state = loadLedgerState()
    if (state.rebuilt !== undefined) {
      writeLedger(state.ledger)
      warnings.push(`the ownership ledger ${paths.ownedLedgerFile()} was missing; it was rebuilt from ${state.rebuilt.from} committed transaction(s)`)
      log('warn', 'txn: ownership ledger rebuilt from the journals', { from: state.rebuilt.from })
    }
    const ledgerFileExisted = state.existed || state.rebuilt !== undefined
    const ledgerBefore = state.ledger
    const c = compute(ops, ledgerBefore, now, copts, cleanup)
    c.skipped.push(...execSkips)
    warnings.push(...c.warnings)
    const changes = c.vfs.changes()
    const ledgerChanges = [...c.ledgerChanges.values()]
    const execs: JournalExec[] = execOps.map(op => {
      const ex: JournalExec = { argv: op.argv, ran: false, owner: op.owner }
      if (op.undo) ex.undo = op.undo
      if (op.soft === true) ex.soft = true
      return ex
    })
    if (changes.length === 0 && execs.length === 0 && ledgerChanges.length === 0) {
      return withRecovered({ txn: '', applied: c.applied, skipped: c.skipped, conflicts: c.conflicts, warnings })
    }
    txnTestHooks.afterCompute?.()

    const txn = newTxnId()
    ensurePrivateDir(paths.backupsDir())
    const txnDir = join(paths.backupsDir(), txn)
    ensurePrivateDir(join(txnDir, 'files'))
    const journal: Journal = {
      v: 1,
      txn,
      status: 'applying',
      startedAt: now,
      plans: plans.map(p => ({ id: String(p.id), harness: String(p.harness), ops: p.ops.length })),
      files: [],
      createdDirs: [],
      execs,
      ledger: ledgerChanges,
    }
    if (opts.run !== undefined) journal.run = opts.run
    if (c.cleanup.length > 0) journal.cleanup = c.cleanup
    try {
      changes.forEach((ch, i) => {
        const through = editsThroughLink(ch.before, ch.after)
        const before = snapOf(ch.before, ch.before.type === 'symlink' && !through)
        if (ch.before.type === 'file' || (through && ch.before.type === 'symlink' && ch.before.content !== undefined)) {
          const copy = join(txnDir, backupRel(i))
          copyFileSync(ch.path, copy)
          chmodSync(copy, 0o600)
          if (sha256(readFileSync(copy, 'utf8')) !== before.sha256) throw new Error(`${ch.path} changed on disk while the transaction was being prepared; nothing was written (run the command again)`)
          before.backup = backupRel(i)
        }
        const jf: JournalFile = { path: ch.path, before, after: snapOf(ch.after) }
        const via = c.vfs.via.get(ch.path)
        if (via !== undefined && via.length > 0) jf.via = [...via]
        journal.files.push(jf)
        for (const d of missingDirs(ch.path)) if (!journal.createdDirs.includes(d)) journal.createdDirs.push(d)
      })
      writeJournal(journal)
    } catch (e) {
      try { rmSync(txnDir, { recursive: true, force: true }) } catch {  }
      throw e
    }

    const tick = makeTicker()
    const written = new Set<string>()
    let ledgerWritten = false
    let execsRan = 0
    try {
      stopIfInterrupted(txn)
      for (const ch of changes) {
        txnTestHooks.beforeWrite?.(ch.path)
        if (!unchangedSinceCompute(readNode(ch.path), ch.before, ch.after)) throw new Error(`${ch.path} changed on disk during the transaction; it was not overwritten (run the command again)`)
        written.add(ch.path)
        writeNode(ch.path, ch.before, ch.after, tick)
      }
      for (const ch of changes) verifyNode(ch.path, ch.after)
      for (let i = 0; i < execs.length; i++) {
        const ex = execs[i] as JournalExec
        const op = execOps[i] as Extract<Op, { kind: 'exec' }>
        ex.started = true
        writeJournal(journal)
        const r = await runExec(ex.argv, trap.abort)
        if (trap.signal !== undefined) throw new TxnInterruptedError(trap.signal, txn, `interrupted by ${trap.signal}`)
        if (r.code !== 0) {
          ex.failed = true
          if (op.soft === true) {
            warnings.push(`\`${ex.argv.join(' ')}\` failed (exit ${r.code}); the rest of the transaction went ahead without it${r.out ? `: ${outputTail(r.out)}` : ''}`)
            writeJournal(journal)
            continue
          }
          throw new Error(`exec failed (exit ${r.code}): ${ex.argv.join(' ')}${r.out ? `\n${r.out}` : ''}`)
        }
        ex.ran = true
        execsRan++
        writeJournal(journal)
        const check = op.idempotentCheck
        if (check) {
          const v = await runExec(check, trap.abort)
          if (trap.signal !== undefined) throw new TxnInterruptedError(trap.signal, txn, `interrupted by ${trap.signal}`)
          if (v.code !== 0) {
            if (op.soft === true) { warnings.push(`\`${check.join(' ')}\` still reports not done after \`${ex.argv.join(' ')}\`; the rest of the transaction went ahead`); continue }
            throw new Error(`exec verification failed: ${check.join(' ')} still reports not done after ${ex.argv.join(' ')}`)
          }
        }
      }
      if (execs.some(e => e.started === true)) {
        const ledgerAfter = applyLedgerChanges(ledgerBefore, ledgerChanges)
        const rewritten: Array<{ path: string, cur: Node }> = []
        changes.forEach((ch, i) => {
          const cur = readNode(ch.path)
          if (nodeIs(cur, ch.after)) return
          ;(journal.files[i] as JournalFile).after = snapOf(cur)
          rewritten.push({ path: ch.path, cur })
        })
        if (rewritten.length > 0) writeJournal(journal)
        for (const { path, cur } of rewritten) {
          if (!ownedPartsHold(new Set(c.vfs.aliases(path)), cur, ledgerAfter, ledgerChanges)) throw new Error(`verification failed for ${path}: a command of this transaction changed what Buracle wrote there`)
          log('info', 'txn: a command rewrote a file Buracle merged into; Buracle\'s values are intact', { txn, path })
        }
      }
      if (ledgerChanges.length > 0) {
        tick(`write ${paths.ownedLedgerFile()}`)
        writeLedger(applyLedgerChanges(ledgerBefore, ledgerChanges))
        ledgerWritten = true
      }
      tick(`commit ${paths.journalFile(txn)}`)
      journal.status = 'committed'
      journal.finishedAt = new Date().toISOString()
      writeJournal(journal)
      log('info', 'txn committed', { txn, files: changes.length, execs: execsRan, conflicts: c.conflicts.length, warnings: warnings.length })
      try { pruneHistory() } catch (e) { log('warn', 'txn: retention failed', { error: e }) }
      return withRecovered({ txn, applied: c.applied + execsRan, skipped: c.skipped, conflicts: c.conflicts, warnings })
    } catch (err) {
      const signal = trap.signal
      const problems: string[] = []
      const notes: string[] = []
      const files = undoFiles(journal, txnDir, { interrupted: true, only: written })
      problems.push(...files.errors)
      notes.push(...files.skipped.map(s => `${s.path}: ${s.reason}`), ...files.warnings)
      removeCreatedDirs(journal.createdDirs)
      const ex = await undoExecs(journal, false)
      problems.push(...ex.errors)
      notes.push(...ex.warnings, ...cleanupAfterUndo(journal))
      removeCreatedDirs(journal.createdDirs)
      if (ledgerWritten || files.left.size > 0) {
        try {
          const target: Ledger = { ...ledgerBefore }
          for (const ch of ledgerChanges) if (files.left.has(ch.key) && ch.after !== undefined) target[ch.key] = ch.after
          if (!ledgerFileExisted && files.left.size === 0) unlinkSync(paths.ownedLedgerFile())
          else writeLedger(target)
        } catch (e) { problems.push(`ledger: ${errText(e)}`) }
      }
      const msg = errText(err)
      journal.status = problems.length > 0 ? 'rollback-failed' : 'rolled-back'
      journal.error = [msg, ...(problems.length > 0 ? ['rollback problems:', ...problems.map(p => `- ${p}`)] : []), ...notes].join('\n')
      journal.rolledBackAt = new Date().toISOString()
      try { writeJournal(journal) } catch {  }
      log('error', 'txn rolled back', { txn, error: msg, problems, notes })
      const tail = notes.length > 0 ? `\nleft as is:\n- ${notes.join('\n- ')}` : ''
      if (signal !== undefined) {
        throw new TxnInterruptedError(signal, txn, problems.length > 0
          ? `interrupted by ${signal}; transaction ${txn} was rolled back incompletely:\n- ${problems.join('\n- ')}${tail}`
          : `interrupted by ${signal}; transaction ${txn} was rolled back${tail}`)
      }
      const e = new Error(problems.length > 0
        ? `transaction ${txn} failed (${msg}) and rollback was incomplete:\n- ${problems.join('\n- ')}${tail}`
        : `transaction ${txn} failed and was rolled back: ${msg}${tail}`, { cause: err })
      throw e
    }
  } finally {
    trap.dispose()
    release()
  }
}

function pruneHistory(): void {
  const all = listJournalsSync()
  let commands = 0
  let background = 0
  let keepJournals: number = RETENTION.journals
  all.forEach((j, i) => {
    const bg = isBackgroundJournal(j)
    const rank = bg ? background++ : commands++
    if (!bg && rank < RETENTION.backups) keepJournals = Math.max(keepJournals, i + 1)
    if (rank < (bg ? RETENTION.backgroundBackups : RETENTION.backups) || j.backupsPruned === true || j.status === 'applying' || j.status === 'rollback-failed') return
    try { rmSync(join(paths.backupsDir(), j.txn), { recursive: true, force: true }) } catch { return }
    j.backupsPruned = true
    try { writeJournal(j) } catch {  }
  })
  const old = all.slice(keepJournals).reverse()
  if (old.length === 0) return
  const cp: Checkpoint = readCheckpoint() ?? { v: 1, through: '', ledger: {}, createdDirs: [] }
  const folded: Journal[] = []
  for (const j of old) {
    if (j.status === 'applying' || j.status === 'rollback-failed') break
    if (j.txn > cp.through) {
      if (j.status === 'committed') {
        applyChanges(cp.ledger, j.ledger)
        for (const d of j.createdDirs ?? []) if (typeof d === 'string' && !cp.createdDirs.includes(d)) cp.createdDirs.push(d)
      }
      cp.through = j.txn
    }
    folded.push(j)
  }
  if (folded.length === 0) return
  ensurePrivateDir(paths.journalDir())
  atomicWriteSync(checkpointFile(), JSON.stringify(cp, null, 2) + '\n', { mode: 0o600 })
  for (const j of folded) {
    if ((j.execs ?? []).some(e => e.ran === true)) continue
    try { unlinkSync(paths.journalFile(j.txn)) } catch {  }
    try { rmSync(join(paths.backupsDir(), j.txn), { recursive: true, force: true }) } catch {  }
  }
}

export interface RollbackReport { txn: string; restored: string[]; skipped: Array<{ path: string, reason: string }>; undone: string[]; errors: string[]; warnings: string[] }

export async function rollbackTxn(txn?: string): Promise<RollbackReport> {
  const release = acquireLock()
  try {
    let journal: Journal
    if (txn === undefined) {
      const latest = (await listTxns()).find(j => j.status !== 'rolled-back')
      if (!latest) throw new Error('no committed transaction to roll back')
      journal = latest
    } else {
      journal = await readJournal(txn)
    }
    if (journal.status === 'rolled-back') throw new Error(`transaction ${journal.txn} was already rolled back`)
    if (journal.backupsPruned === true && journal.files.some(f => f.before.backup !== undefined)) {
      throw new Error(`transaction ${journal.txn} is too old to roll back: its backups were removed (Buracle keeps the backups of the newest ${RETENTION.backups} transactions)`)
    }
    await recoverInterrupted(journal.txn)
    const outcome = await undoJournal(journal, journal.status !== 'committed')
    journal.status = outcome.errors.length > 0 ? 'rollback-failed' : 'rolled-back'
    journal.rolledBackAt = new Date().toISOString()
    if (outcome.errors.length > 0) journal.error = [journal.error, 'rollback problems:', ...outcome.errors.map(e => `- ${e}`)].filter(x => x !== undefined).join('\n')
    writeJournal(journal)
    log(outcome.errors.length > 0 ? 'error' : 'info', 'txn rolled back by request', { txn: journal.txn, restored: outcome.restored.length, skipped: outcome.skipped.length, errors: outcome.errors })
    return { txn: journal.txn, ...outcome }
  } finally {
    release()
  }
}

export async function rollback(txn?: string): Promise<void> {
  const r = await rollbackTxn(txn)
  const issues = [...r.skipped.map(s => `${s.path}: ${s.reason}`), ...r.errors]
  if (issues.length > 0) throw new Error(`rollback of ${r.txn} was partial:\n- ${issues.join('\n- ')}`)
}

export async function markExecsUndone(txn: string, argvs: ReadonlyArray<readonly string[]>): Promise<number> {
  const release = acquireLock()
  try {
    const journal = await readJournal(txn)
    const wanted = new Set(argvs.map(a => JSON.stringify([...a])))
    let marked = 0
    for (const ex of journal.execs ?? []) {
      if (ex.undone === true || (ex.ran !== true && ex.started !== true) || !wanted.has(JSON.stringify(ex.argv))) continue
      ex.undone = true
      marked++
    }
    if (marked > 0) {
      writeJournal(journal)
      log('info', 'txn execs marked undone', { txn, marked })
    }
    return marked
  } finally {
    release()
  }
}

export type TxnStepId = 'lock' | 'checks' | 'plan' | 'backup' | 'journal' | 'write' | 'exec' | 'verify' | 'ledger' | 'commit'
export interface TxnStep {
  id: TxnStepId
  title: string
  detail: string
}

export const TXN_STEPS: readonly TxnStep[] = [
  { id: 'lock', title: 'Lock', detail: 'Take the transaction lock (one transaction at a time; a lock whose process is gone, or whose PID now belongs to another program, is taken over) and roll back any transaction a killed process left `applying`.' },
  { id: 'checks', title: 'Idempotency checks', detail: 'Run the idempotency check of every exec op; commands already done are skipped.' },
  { id: 'plan', title: 'Plan', detail: 'Compute every op against the files and the ownership ledger (merge law; a missing ledger is rebuilt from the journals). Values the user changed or removed become conflicts and are kept, except keys a plan marks enforced (Buracle\'s value is written again with a warning, and removing the key later puts back what it held before Buracle took it over) or soft (the user\'s value is kept and reported as skipped). Read-only and unparsable files and YAML values inherited through merge keys or aliases are never written.' },
  { id: 'backup', title: 'Backup', detail: 'Copy every file about to change into ~/.buracle/backups/<txn>/ (private: 0700 directories, 0600 files) and check each copy against the planned content.' },
  { id: 'journal', title: 'Journal', detail: 'Write ~/.buracle/journal/<txn>.json (status applying) before the first change.' },
  { id: 'write', title: 'Atomic writes', detail: 'Write each file atomically (temporary file, then rename) and read it back: it must hold exactly what was written. A file someone else changed since the plan stops the transaction.' },
  { id: 'exec', title: 'Commands', detail: 'Run the exec ops (e.g. plugin registration) and re-run their idempotency checks; a failing command stops the transaction, except an optional (soft) one, which is reported as a warning.' },
  { id: 'verify', title: 'Verify', detail: 'After the commands, re-read every written path. A whole file or link must be exactly as written. A command may rewrite other parts of a file Buracle merged into (e.g. `claude plugin install` edits ~/.claude/settings.json): every value Buracle owns there must still read back as written, and the journal then records the file as the commands left it.' },
  { id: 'ledger', title: 'Ownership ledger', detail: 'Record what Buracle now owns in ~/.buracle/state/owned.json.' },
  { id: 'commit', title: 'Commit', detail: 'Mark the journal committed and prune old history (backups of all but the newest 20 command transactions and the newest 10 a hook applied on its own, such as a project\'s memory redirect; journals beyond the newest 50). A failure in any earlier step, or Ctrl-C (SIGINT), SIGTERM or SIGHUP, rolls everything back: a file is restored from its backup only while it still holds what was written (in a file someone else changed since, only Buracle\'s own keys are undone), every command that ran is undone (and, best effort, one that stopped half way), and the ledger is reverted.' },
]

function textOf(n: Node): string | undefined {
  if (n.type === 'file') return n.content
  if (n.type === 'symlink') return n.content
  return n.type === 'absent' ? '' : undefined
}

export const DIFF_PREVIEW_MAX_LINES = 400

function diffOrSummary(d: string, path: string, before: Node, after: Node): string {
  const lines = d.trimEnd().split('\n')
  if (lines.length <= DIFF_PREVIEW_MAX_LINES) return d.trimEnd()
  let added = 0
  let removed = 0
  let inHunk = false
  for (const l of lines) {
    if (l.startsWith('@@')) { inHunk = true; continue }
    if (!inHunk) continue
    if (l.startsWith('+')) added++
    else if (l.startsWith('-')) removed++
  }
  const what = before.type === 'absent' ? 'new file' : after.type === 'absent' ? 'remove' : 'update'
  return `# ${what} ${path}: +${added} -${removed} lines (diff of ${lines.length} lines not shown)`
}

export async function diffPlan(plan: Plan, opts: Pick<ApplyOptions, 'restore' | 'takeOwnership'> = {}): Promise<string> {
  const ops = validateOps([plan])
  const c = compute(ops, loadLedger(), new Date().toISOString(), computeOptions(opts), cleanupTargets([plan]))
  const out: string[] = []
  for (const ch of c.vfs.changes()) {
    const { path, before, after } = ch
    if (after.type === 'symlink' && !(before.type === 'symlink' && before.target === after.target)) {
      out.push(`# symlink ${path} -> ${after.target}${before.type !== 'absent' ? ` (replaces existing ${before.type})` : ''}`)
      continue
    }
    if (after.type === 'absent' && before.type === 'symlink') { out.push(`# remove symlink ${path}`); continue }
    const oldText = textOf(before) ?? ''
    const newText = textOf(after) ?? ''
    const oldLabel = before.type === 'absent' ? '/dev/null' : path
    const newLabel = after.type === 'absent' ? '/dev/null' : path
    const d = unifiedDiff(oldText, newText, { oldLabel, newLabel })
    if (d !== '') out.push(diffOrSummary(d, path, before, after))
    else if (before.type === 'file' && after.type === 'file' && !sameMode(before.mode, after.mode)) out.push(`# chmod ${after.mode.toString(8)} ${path}`)
    const via = c.vfs.via.get(path)
    if (via !== undefined && via.length > 0) out.push(`# (also reached through ${via.join(', ')})`)
  }
  for (const op of c.execs) out.push(`# exec: ${op.argv.join(' ')}${op.idempotentCheck ? `  (unless: ${op.idempotentCheck.join(' ')})` : ''}${op.soft === true ? '  (optional: a failure does not stop the install)' : ''}`)
  for (const w of c.warnings) out.push(`# warning: ${w}`)
  for (const k of c.conflicts) out.push(`# conflict: ${k.detail}`)
  return out.length > 0 ? out.join('\n') + '\n' : ''
}
