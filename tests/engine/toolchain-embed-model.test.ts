import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMBED_DIM, EMBED_MODEL_ID } from '../../src/core/memory/embed'
import { checkEmbedModel, EMBED_MODEL, embedModelFile, embedModelStagingLeft, embedModelUrl, embedTokenizerFile, installEmbedModel, type EmbedModelSource } from '../../src/engine/toolchain/embed-model'
import { sha256 } from '../../src/engine/fsx'
import { withSandbox } from '../helpers/sandbox'
import { encodeOnnxEmbedding, tokenizerJson } from '../helpers/onnx'

const PIECES = ['[PAD]', '[UNK]', 'hello', 'world', '##s', 'merhaba']
const COLS = 300

function synthetic(root: string): { local: { onnx: string, tokenizer: string }, pins: { onnx: EmbedModelSource, tokenizer: EmbedModelSource } } {
  mkdirSync(root, { recursive: true })
  const data = new Uint8Array(PIECES.length * COLS).map((_, i) => (i * 53 + 7) % 256)
  const onnx = encodeOnnxEmbedding({ rows: PIECES.length, cols: COLS, data, scale: 0.02, zeroPoint: 127 })
  const tok = new TextEncoder().encode(tokenizerJson(PIECES))
  const onnxPath = join(root, 'model_int8.onnx')
  const tokPath = join(root, 'tokenizer.json')
  writeFileSync(onnxPath, onnx)
  writeFileSync(tokPath, tok)
  return {
    local: { onnx: onnxPath, tokenizer: tokPath },
    pins: { onnx: { path: 'onnx/model_int8.onnx', sha256: sha256(onnx), bytes: onnx.byteLength }, tokenizer: { path: '0_StaticEmbedding/tokenizer.json', sha256: sha256(tok), bytes: tok.byteLength } },
  }
}

describe('the embedding model installer', () => {
  test('the pins name one commit of the model\'s repository, and the files are fetched from it', () => {
    expect(EMBED_MODEL.id).toBe(EMBED_MODEL_ID)
    expect(EMBED_MODEL.dim).toBe(EMBED_DIM)
    expect(EMBED_MODEL.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(embedModelUrl(EMBED_MODEL.files.onnx)).toBe(`https://huggingface.co/${EMBED_MODEL.repo}/resolve/${EMBED_MODEL.commit}/onnx/model_int8.onnx`)
    expect(EMBED_MODEL.files.onnx.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(EMBED_MODEL.files.tokenizer.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('install: checked files, converted to a 256-dimension model.bin beside the tokenizer; a second install keeps it', () => withSandbox(async ({ root }) => {
    expect(checkEmbedModel()).toMatchObject({ status: 'missing' })
    const s = synthetic(join(root, 'hub'))
    const r = await installEmbedModel({ local: s.local, pins: s.pins })
    expect(r).toMatchObject({ ok: true, changed: true, rows: PIECES.length, dim: EMBED_DIM })
    expect(existsSync(embedModelFile())).toBe(true)
    expect(existsSync(embedTokenizerFile())).toBe(true)
    expect(embedModelStagingLeft()).toBe(false)
    const check = checkEmbedModel()
    expect(check).toMatchObject({ status: 'ok', header: { model: EMBED_MODEL_ID, rows: PIECES.length, dim: EMBED_DIM, zeroPoint: 127 } })
    expect(check.status === 'ok' ? check.header.scale : 0).toBeCloseTo(0.02, 6)
    expect(statSync(embedModelFile()).size).toBeGreaterThan(PIECES.length * EMBED_DIM)
    expect(readFileSync(embedTokenizerFile(), 'utf8')).toContain('"merhaba"')
    const again = await installEmbedModel({ local: { onnx: '/nowhere', tokenizer: '/nowhere' }, pins: s.pins })
    expect(again).toMatchObject({ ok: true, changed: false, rows: PIECES.length })
  }))

  test('a file with the wrong size or sha256 is refused; a damaged model is reported and replaced', () => withSandbox(async ({ root }) => {
    const s = synthetic(join(root, 'hub'))
    const bad = await installEmbedModel({ local: s.local, pins: { ...s.pins, onnx: { ...s.pins.onnx, sha256: 'f'.repeat(64) } } })
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('sha256') })
    expect(existsSync(embedModelFile())).toBe(false)
    const short = await installEmbedModel({ local: s.local, pins: { ...s.pins, tokenizer: { ...s.pins.tokenizer, bytes: 1 } } })
    expect(short).toMatchObject({ ok: false, error: expect.stringContaining('bytes') })
    expect((await installEmbedModel({ local: s.local, pins: s.pins })).ok).toBe(true)
    truncateSync(embedModelFile(), 40)
    expect(checkEmbedModel()).toMatchObject({ status: 'damaged', detail: expect.stringContaining('reinstall') })
    expect(await installEmbedModel({ local: s.local, pins: s.pins })).toMatchObject({ ok: true, changed: true })
    expect(checkEmbedModel().status).toBe('ok')
  }))

  test('a tokenizer with more pieces than the model has vectors is refused', () => withSandbox(async ({ root }) => {
    const s = synthetic(join(root, 'hub'))
    const tok = new TextEncoder().encode(tokenizerJson([...PIECES, 'extra', 'pieces']))
    const tokPath = join(root, 'hub', 'big-tokenizer.json')
    writeFileSync(tokPath, tok)
    const r = await installEmbedModel({ local: { onnx: s.local.onnx, tokenizer: tokPath }, pins: { onnx: s.pins.onnx, tokenizer: { ...s.pins.tokenizer, sha256: sha256(tok), bytes: tok.byteLength } } })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('the tokenizer has 8 pieces') })
  }))
})
