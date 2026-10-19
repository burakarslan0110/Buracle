import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeEmbedHeader, EMBED_DIM, EMBED_MODEL_ID, encodeEmbedFile, onnxQuantizedEmbedding, parseWordPieceTokenizer, truncateMatrix, type EmbedFileHeader } from '../../core/memory/embed'
import { renameRetrySync, sha256 } from '../fsx'
import * as paths from '../paths'

export interface EmbedModelSource { path: string, sha256: string, bytes: number }

export const EMBED_MODEL = {
  id: EMBED_MODEL_ID,
  repo: 'sentence-transformers/static-similarity-mrl-multilingual-v1',
  commit: 'b68f4122911bcffcd6e1f695f2d99cd6788972d8',
  license: 'Apache-2.0',
  dim: EMBED_DIM,
  files: {
    onnx: { path: 'onnx/model_int8.onnx', sha256: '9eaf678438a0c2669e7388e90fd8ef25c3138dd3155cb0d62fd8114760405a3a', bytes: 108_424_888 } as EmbedModelSource,
    tokenizer: { path: '0_StaticEmbedding/tokenizer.json', sha256: '11aaf894a4ccf3d95e8830e27c0f8152791fbbff2b988e29a265580b86edd216', bytes: 2_563_370 } as EmbedModelSource,
  },
} as const

const HUB_URL = 'https://huggingface.co'
const DOWNLOAD_TIMEOUT_MS = 600_000
const MAX_BYTES = 160 * 1024 * 1024

export function embedModelDir(): string { return join(paths.toolchainDir(), 'embed', EMBED_MODEL.id) }
export function embedModelFile(): string { return join(embedModelDir(), 'model.bin') }
export function embedTokenizerFile(): string { return join(embedModelDir(), 'tokenizer.json') }

export function embedModelUrl(file: EmbedModelSource): string {
  return `${HUB_URL}/${EMBED_MODEL.repo}/resolve/${EMBED_MODEL.commit}/${file.path}`
}

export type EmbedModelCheck =
  | { status: 'ok', path: string, header: EmbedFileHeader, bytes: number }
  | { status: 'missing' | 'damaged', detail: string }

function headBytes(file: string, n = 4096): Uint8Array {
  const fd = openSync(file, 'r')
  try {
    const buf = new Uint8Array(n)
    const got = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, got)
  } finally {
    try { require('node:fs').closeSync(fd) } catch {  }
  }
}

export function checkEmbedModel(): EmbedModelCheck {
  const file = embedModelFile()
  if (!existsSync(file)) return { status: 'missing', detail: `the embedding model is not in the toolchain (buracle install)` }
  if (!existsSync(embedTokenizerFile())) return { status: 'damaged', detail: `${embedTokenizerFile()} is missing (reinstall: buracle install)` }
  try {
    const bytes = statSync(file).size
    const { header, dataStart } = decodeEmbedHeader(headBytes(file))
    if (header.model !== EMBED_MODEL.id || header.dim !== EMBED_MODEL.dim) return { status: 'damaged', detail: `${file} holds ${header.model} with ${header.dim} dimensions, not ${EMBED_MODEL.id} with ${EMBED_MODEL.dim} (reinstall: buracle install)` }
    if (bytes - dataStart !== header.rows * header.dim) return { status: 'damaged', detail: `${file} is ${bytes} bytes, ${dataStart + header.rows * header.dim} expected (reinstall: buracle install)` }
    return { status: 'ok', path: file, header, bytes }
  } catch (e) {
    return { status: 'damaged', detail: `${file}: ${(e as Error).message} (reinstall: buracle install)` }
  }
}

export type EmbedModelInstall = { ok: true, path: string, changed: boolean, rows: number, dim: number } | { ok: false, error: string }

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface EmbedInstallOptions {
  fetch?: FetchFn
  timeoutMs?: number
  local?: { onnx?: string, tokenizer?: string }
  pins?: { onnx: EmbedModelSource, tokenizer: EmbedModelSource }
}

async function getFile(src: EmbedModelSource, local: string | undefined, opts: EmbedInstallOptions): Promise<{ ok: true, bytes: Uint8Array } | { ok: false, error: string }> {
  let bytes: Uint8Array
  if (local !== undefined) {
    try { bytes = new Uint8Array(readFileSync(local)) } catch (e) { return { ok: false, error: `cannot read ${local}: ${(e as Error).message}` } }
  } else {
    const url = embedModelUrl(src)
    const doFetch: FetchFn = opts.fetch ?? fetch
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS), headers: { 'user-agent': 'buracle-toolchain' }, redirect: 'follow' })
      if (!res.ok) return { ok: false, error: `download of ${url} failed: HTTP ${res.status}` }
      const len = Number(res.headers.get('content-length') ?? '0')
      if (len > MAX_BYTES) return { ok: false, error: `${url} is ${len} bytes, more than the pinned file` }
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch (e) {
      return { ok: false, error: `download of ${url} failed: ${(e as Error).message}` }
    }
  }
  if (bytes.byteLength !== src.bytes) return { ok: false, error: `${src.path}: ${bytes.byteLength} bytes, the pinned file has ${src.bytes}` }
  const got = sha256(bytes)
  if (got !== src.sha256) return { ok: false, error: `${src.path}: sha256 ${got} does not match the pinned ${src.sha256}` }
  return { ok: true, bytes }
}

export async function installEmbedModel(opts: EmbedInstallOptions = {}): Promise<EmbedModelInstall> {
  const have = checkEmbedModel()
  if (have.status === 'ok') return { ok: true, path: have.path, changed: false, rows: have.header.rows, dim: have.header.dim }
  const pins = opts.pins ?? EMBED_MODEL.files
  const tok = await getFile(pins.tokenizer, opts.local?.tokenizer, opts)
  if (!tok.ok) return tok
  let vocabSize: number
  try {
    const text = new TextDecoder().decode(tok.bytes)
    vocabSize = parseWordPieceTokenizer(JSON.parse(text)).ids.size
  } catch (e) { return { ok: false, error: `${pins.tokenizer.path}: ${(e as Error).message}` } }
  const onnx = await getFile(pins.onnx, opts.local?.onnx, opts)
  if (!onnx.ok) return onnx
  let encoded: Uint8Array
  let rows: number
  try {
    const q = onnxQuantizedEmbedding(onnx.bytes)
    if (q.rows < vocabSize) return { ok: false, error: `${pins.onnx.path} holds ${q.rows} vectors, the tokenizer has ${vocabSize} pieces` }
    const m = truncateMatrix(q, EMBED_MODEL.dim)
    rows = m.rows
    encoded = encodeEmbedFile(m, { model: EMBED_MODEL.id, source: `${EMBED_MODEL.repo}@${EMBED_MODEL.commit}/${pins.onnx.path} sha256 ${pins.onnx.sha256}` })
  } catch (e) { return { ok: false, error: `${pins.onnx.path}: ${(e as Error).message}` } }
  const dir = embedModelDir()
  const target = embedModelFile()
  const tokTarget = embedTokenizerFile()
  const staging = `${target}.staging-${process.pid}`
  const tokStaging = `${tokTarget}.staging-${process.pid}`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tokStaging, tok.bytes, { mode: 0o644 })
    writeFileSync(staging, encoded, { mode: 0o644 })
    chmodSync(staging, 0o644)
    renameRetrySync(tokStaging, tokTarget)
    renameRetrySync(staging, target)
  } catch (e) {
    for (const f of [staging, tokStaging]) { try { rmSync(f, { force: true }) } catch {  } }
    return { ok: false, error: `cannot write ${target}: ${(e as Error).message}` }
  }
  const check = checkEmbedModel()
  if (check.status !== 'ok') return { ok: false, error: check.detail }
  return { ok: true, path: target, changed: true, rows, dim: EMBED_MODEL.dim }
}

export function embedModelStagingLeft(): boolean {
  const dir = embedModelDir()
  if (!existsSync(dir)) return false
  try { return require('node:fs').readdirSync(dir).some((n: string) => n.includes('.staging-')) } catch { return false }
}
