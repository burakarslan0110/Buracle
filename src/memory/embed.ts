import { readFileSync, statSync } from 'node:fs'
import { cosine, decodeEmbedFile, EMBED_DIM, EMBED_MODEL_ID, embedText, parseWordPieceTokenizer, type EmbedFileHeader, type EmbedMatrix, type WordPieceVocab } from '../core/memory/embed'
import { loadConfigSync } from '../engine/config'
import { log } from '../engine/log'
import { checkEmbedModel, embedModelFile, embedTokenizerFile, type EmbedModelCheck } from '../engine/toolchain/embed-model'
import { liveUiRecord } from './ui-record'

export { cosine }

export const NO_EMBED_ENV = 'BURACLE_NO_EMBED'

export const EMBED_TIMEOUT_SECONDS = 20

export const EMBED_MAX_INPUTS = 256
export const EMBED_MAX_CHARS = 20_000

export type Env = Readonly<Record<string, string | undefined>>

export function embedOff(env: Env = process.env): boolean {
  return env[NO_EMBED_ENV] === '1'
}

export function embedPort(): number | undefined {
  const live = liveUiRecord()
  if (live !== undefined) return live.port
  try { return loadConfigSync().config.memory.ui.port } catch { return undefined }
}

export function embedChildEnv(o: { installed: boolean, port: number | undefined }): Record<string, string> {
  if (!o.installed || o.port === undefined) return {}
  return {
    CORTEXDB_EMBED_BASE_URL: `http://127.0.0.1:${o.port}/v1`,
    CORTEXDB_EMBED_MODEL: EMBED_MODEL_ID,
    CORTEXDB_EMBED_DIM: String(EMBED_DIM),
    CORTEXDB_EMBED_TIMEOUT_SECONDS: String(EMBED_TIMEOUT_SECONDS),
  }
}

export function embedChildEnvNow(env: Env = process.env): Record<string, string> {
  if (embedOff(env)) return {}
  try { return embedChildEnv({ installed: checkEmbedModel().status === 'ok', port: embedPort() }) } catch { return {} }
}

export function embedSemanticNow(env: Env = process.env): boolean {
  if (embedOff(env)) return false
  try { return checkEmbedModel().status === 'ok' } catch { return false }
}

export interface Embedder {
  header: EmbedFileHeader
  matrix: EmbedMatrix
  vocab: WordPieceVocab
  embed(texts: readonly string[]): Float32Array[]
}

export function loadEmbedder(): Embedder {
  const check = checkEmbedModel()
  if (check.status !== 'ok') throw new Error(check.detail)
  const { header, matrix } = decodeEmbedFile(new Uint8Array(readFileSync(embedModelFile())))
  const vocab = parseWordPieceTokenizer(JSON.parse(readFileSync(embedTokenizerFile(), 'utf8')))
  return { header, matrix, vocab, embed: texts => texts.map(t => embedText(matrix, vocab, t)) }
}

let cached: { embedder: Embedder, mtimeMs: number } | undefined

export function embedderNow(): Embedder | undefined {
  let mtimeMs: number
  try { mtimeMs = statSync(embedModelFile()).mtimeMs } catch { cached = undefined; return undefined }
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.embedder
  try {
    cached = { embedder: loadEmbedder(), mtimeMs }
    log('info', 'memory: the embedding model is loaded', { model: cached.embedder.header.model, rows: cached.embedder.header.rows, dim: cached.embedder.header.dim })
    return cached.embedder
  } catch (e) {
    log('warn', 'memory: the embedding model could not be loaded', { error: e })
    cached = undefined
    return undefined
  }
}

export interface EmbeddingsAnswer { status: number, body: Record<string, unknown> }

export function embeddingsResponse(body: unknown, embedder: Embedder | undefined = embedderNow()): EmbeddingsAnswer {
  const err = (status: number, message: string, type = 'invalid_request_error'): EmbeddingsAnswer => ({ status, body: { error: { message, type } } })
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return err(400, 'the body must be a JSON object with "input"')
  const raw = (body as { input?: unknown }).input
  const inputs = typeof raw === 'string' ? [raw] : Array.isArray(raw) && raw.every(x => typeof x === 'string') ? raw as string[] : undefined
  if (inputs === undefined) return err(400, '"input" must be a string or an array of strings')
  if (inputs.length > EMBED_MAX_INPUTS) return err(400, `at most ${EMBED_MAX_INPUTS} inputs per request`)
  if (inputs.some(t => t.length > EMBED_MAX_CHARS)) return err(400, `an input is longer than ${EMBED_MAX_CHARS} characters`)
  if (embedder === undefined) return err(503, 'the embedding model is not installed (buracle install)', 'server_error')
  const vectors = embedder.embed(inputs)
  const tokens = inputs.reduce((n, t) => n + Math.max(1, Math.ceil(t.length / 4)), 0)
  return {
    status: 200,
    body: {
      object: 'list',
      data: vectors.map((v, index) => ({ object: 'embedding', index, embedding: Array.from(v) })),
      model: embedder.header.model,
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    },
  }
}

export interface EmbedStatus {
  model: string
  dim: number
  installed: boolean
  check: EmbedModelCheck
  endpoint?: string
  off: boolean
}

export function embedStatus(env: Env = process.env): EmbedStatus {
  const check = checkEmbedModel()
  const live = liveUiRecord()
  return {
    model: EMBED_MODEL_ID, dim: EMBED_DIM, installed: check.status === 'ok', check,
    ...(live !== undefined ? { endpoint: `http://127.0.0.1:${live.port}/v1/embeddings` } : {}),
    off: embedOff(env),
  }
}
