import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMBED_DIM, EMBED_MODEL_ID } from '../../src/core/memory/embed'
import { memDoctor } from '../../src/memory/doctor'
import { computeStatus } from '../../src/memory/status'
import { cortexEnv } from '../../src/memory/cortex'
import { cosine, embedChildEnv, embedChildEnvNow, embedderNow, embeddingsResponse, embedSemanticNow, embedStatus, loadEmbedder, NO_EMBED_ENV } from '../../src/memory/embed'
import { handle, uiContext } from '../../src/memory/ui'
import { installEmbedModel, type EmbedModelSource } from '../../src/engine/toolchain/embed-model'
import { sha256 } from '../../src/engine/fsx'
import * as paths from '../../src/engine/paths'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { encodeOnnxEmbedding, tokenizerJson } from '../helpers/onnx'
import { withBrain } from './helpers'

const PIECES = ['[PAD]', '[UNK]', 'hello', 'world', '##s', 'merhaba', 'dunya', 'orders', 'service', 'cockroachdb', 'postgres', 'flaky', 'test']
const COLS = 300

async function installSynthetic(root: string): Promise<void> {
  const hub = join(root, 'hub')
  mkdirSync(hub, { recursive: true })
  const data = new Uint8Array(PIECES.length * COLS)
  for (let r = 0; r < PIECES.length; r++) for (let c = 0; c < COLS; c++) data[r * COLS + c] = (c % PIECES.length === r ? 250 : 128)
  const onnx = encodeOnnxEmbedding({ rows: PIECES.length, cols: COLS, data, scale: 0.01, zeroPoint: 128 })
  const tok = new TextEncoder().encode(tokenizerJson(PIECES))
  writeFileSync(join(hub, 'm.onnx'), onnx)
  writeFileSync(join(hub, 'tok.json'), tok)
  const pins: { onnx: EmbedModelSource, tokenizer: EmbedModelSource } = {
    onnx: { path: 'onnx/model_int8.onnx', sha256: sha256(onnx), bytes: onnx.byteLength },
    tokenizer: { path: '0_StaticEmbedding/tokenizer.json', sha256: sha256(tok), bytes: tok.byteLength },
  }
  const r = await installEmbedModel({ local: { onnx: join(hub, 'm.onnx'), tokenizer: join(hub, 'tok.json') }, pins })
  if (!r.ok) throw new Error(r.error)
}

function recordUi(port: number): void {
  mkdirSync(paths.stateDir(), { recursive: true })
  writeFileSync(paths.memoryUiStateFile(), JSON.stringify({ v: 1, pid: process.pid, port, host: '127.0.0.1', url: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString(), version: '9.9.9', brain: paths.brainDir() }))
}

describe('the child variables', () => {
  test('the UI endpoint while the model is installed and a UI runs; nothing while the switch is on, the model is missing or no UI is recorded', async () => {
    await withSandbox(async ({ root }) => {
      expect(embedChildEnvNow()).toEqual({})
      expect(embedSemanticNow()).toBe(false)
      await withEnv({ [NO_EMBED_ENV]: undefined }, async () => {
        expect(embedChildEnvNow()).toEqual({})
        expect(embedSemanticNow()).toBe(false)
        await installSynthetic(root)
        expect(embedSemanticNow()).toBe(true)
        expect(embedChildEnvNow()).toEqual({ CORTEXDB_EMBED_BASE_URL: 'http://127.0.0.1:41777/v1', CORTEXDB_EMBED_MODEL: EMBED_MODEL_ID, CORTEXDB_EMBED_DIM: String(EMBED_DIM), CORTEXDB_EMBED_TIMEOUT_SECONDS: '20' })
        recordUi(41999)
        expect(embedChildEnvNow()['CORTEXDB_EMBED_BASE_URL']).toBe('http://127.0.0.1:41999/v1')
        const env = cortexEnv('/tmp/x.db', { PATH: '/bin', CORTEXDB_REMOTE: 'host:1', CORTEXDB_EMBED_API_KEY: 'leak' })
        expect(env).toEqual({ PATH: '/bin', CORTEXDB_EMBED_BASE_URL: 'http://127.0.0.1:41999/v1', CORTEXDB_EMBED_MODEL: EMBED_MODEL_ID, CORTEXDB_EMBED_DIM: '256', CORTEXDB_EMBED_TIMEOUT_SECONDS: '20', CORTEXDB_PATH: '/tmp/x.db' })
      })
      expect(embedChildEnv({ installed: true, port: undefined })).toEqual({})
      expect(embedChildEnv({ installed: false, port: 41777 })).toEqual({})
    })
  })
})

describe('the embedder', () => {
  test('loads the model once, embeds any text into 256 normalized dimensions, and answers in OpenAI\'s shape', async () => {
    await withSandbox(async ({ root }) => {
      await withEnv({ [NO_EMBED_ENV]: undefined }, async () => {
        expect(embedderNow()).toBeUndefined()
        expect(embeddingsResponse({ input: 'x' })).toMatchObject({ status: 503, body: { error: { type: 'server_error' } } })
        await installSynthetic(root)
        const e = loadEmbedder()
        expect(e.header).toMatchObject({ model: EMBED_MODEL_ID, rows: PIECES.length, dim: EMBED_DIM })
        const [a, b, c] = e.embed(['Orders service on CockroachDB', 'the orders service moved to cockroachdb', 'a flaky test'])
        expect(a?.length).toBe(EMBED_DIM)
        expect(Math.abs(Math.hypot(...(a as Float32Array)) - 1)).toBeLessThan(1e-5)
        expect(cosine(a as Float32Array, b as Float32Array)).toBeGreaterThan(cosine(a as Float32Array, c as Float32Array))
        expect(Math.hypot(...e.embed(['Merhaba dünya'])[0] as Float32Array)).toBeGreaterThan(0.99)
        expect(embedderNow()).toBe(embedderNow())
        const ok = embeddingsResponse({ model: 'ignored', input: ['hello world', 'merhaba'] })
        expect(ok.status).toBe(200)
        const data = ok.body['data'] as Array<{ object: string, index: number, embedding: number[] }>
        expect(ok.body).toMatchObject({ object: 'list', model: EMBED_MODEL_ID, usage: { prompt_tokens: 5, total_tokens: 5 } })
        expect(data.map(d => [d.object, d.index, d.embedding.length])).toEqual([['embedding', 0, EMBED_DIM], ['embedding', 1, EMBED_DIM]])
        expect(embeddingsResponse({ input: 'one' }).body['data']).toHaveLength(1)
        expect(embeddingsResponse({ input: 5 })).toMatchObject({ status: 400 })
        expect(embeddingsResponse([])).toMatchObject({ status: 400 })
        expect(embeddingsResponse({ input: Array.from({ length: 257 }, () => 'x') })).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('at most 256') } } })
        expect(embeddingsResponse({ input: 'x'.repeat(20_001) })).toMatchObject({ status: 400 })
      })
    })
  })

  test('the brain web UI serves it at POST /v1/embeddings without a token; GET is refused; the status and the doctor say its state', async () => {
    await withBrain(async ({ root, repo }) => {
      await withEnv({ [NO_EMBED_ENV]: undefined }, async () => {
        const c = uiContext({ version: '9.9.9', port: 41999 })
        const req = (init: RequestInit & { method: string }, body?: unknown) => handle(new Request('http://127.0.0.1:41999/v1/embeddings', { ...init, headers: { host: '127.0.0.1:41999', 'content-type': 'application/json', ...(init.headers ?? {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), c)
        expect((await computeStatus({ slug: 'demo' })).reasons).toContain('embed_missing')
        expect((await memDoctor({ cwd: repo, mcp: false, leak: false })).find(x => x.check === 'embeddings')).toMatchObject({ level: 'warn', detail: expect.stringContaining('by words') })
        expect((await req({ method: 'POST' }, { input: 'x' })).status).toBe(503)
        await installSynthetic(root)
        expect((await computeStatus({ slug: 'demo' })).reasons).not.toContain('embed_missing')
        const r = await req({ method: 'POST' }, { input: ['hello world'] })
        expect(r.status).toBe(200)
        const j = await r.json() as { data: Array<{ embedding: number[] }>, model: string }
        expect(j.model).toBe(EMBED_MODEL_ID)
        expect(j.data[0]?.embedding).toHaveLength(EMBED_DIM)
        expect((await req({ method: 'GET' })).status).toBe(405)
        expect((await req({ method: 'POST' }, 'not an object')).status).toBe(400)
        expect((await handle(new Request('http://127.0.0.1:41999/v1/embeddings', { method: 'POST', headers: { host: '127.0.0.1:41999' }, body: '{' }), c)).status).toBe(400)
        expect((await handle(new Request('http://evil.example/v1/embeddings', { method: 'POST', headers: { host: 'evil.example' }, body: '{}' }), c)).status).toBe(403)
        const s = embedStatus()
        expect(s).toMatchObject({ model: EMBED_MODEL_ID, dim: EMBED_DIM, installed: true, off: false })
        recordUi(41999)
        expect(embedStatus().endpoint).toBe('http://127.0.0.1:41999/v1/embeddings')
        expect((await memDoctor({ cwd: repo, mcp: false, leak: false })).find(x => x.check === 'embeddings')).toMatchObject({ level: 'ok', detail: expect.stringContaining(`${PIECES.length} word pieces`) })
      })
      expect((await memDoctor({ cwd: repo, mcp: false, leak: false })).find(x => x.check === 'embeddings')).toMatchObject({ level: 'info' })
      expect((await computeStatus({ slug: 'demo' })).reasons).not.toContain('embed_missing')
    })
  })
})
