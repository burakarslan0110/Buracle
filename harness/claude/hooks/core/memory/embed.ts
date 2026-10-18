export const EMBED_MODEL_ID = 'static-similarity-mrl-multilingual-v1'
export const EMBED_DIM = 256

export interface EmbedMatrix {
  rows: number
  dim: number
  scale: number
  zeroPoint: number
  data: Uint8Array
}

export interface WordPieceVocab {
  ids: ReadonlyMap<string, number>
  unkId: number
  prefix: string
  maxChars: number
  lowercase: boolean
  stripAccents: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function parseWordPieceTokenizer(json: unknown): WordPieceVocab {
  if (!isRecord(json) || !isRecord(json['model'])) throw new Error('tokenizer.json: no model')
  const model = json['model']
  if (model['type'] !== 'WordPiece') throw new Error(`tokenizer.json: the model is ${String(model['type'])}, not WordPiece`)
  const vocab = model['vocab']
  if (!isRecord(vocab)) throw new Error('tokenizer.json: no vocab')
  const ids = new Map<string, number>()
  for (const [piece, id] of Object.entries(vocab)) if (typeof id === 'number' && Number.isInteger(id) && id >= 0) ids.set(piece, id)
  if (ids.size === 0) throw new Error('tokenizer.json: the vocab is empty')
  const unk = typeof model['unk_token'] === 'string' ? model['unk_token'] : '[UNK]'
  const unkId = ids.get(unk)
  if (unkId === undefined) throw new Error(`tokenizer.json: the unknown piece ${unk} is not in the vocab`)
  const normalizer = isRecord(json['normalizer']) ? json['normalizer'] : {}
  if (normalizer['type'] !== undefined && normalizer['type'] !== 'BertNormalizer') throw new Error(`tokenizer.json: the normalizer is ${String(normalizer['type'])}, not BertNormalizer`)
  const lowercase = normalizer['lowercase'] !== false
  const stripAccents = typeof normalizer['strip_accents'] === 'boolean' ? normalizer['strip_accents'] : lowercase
  return {
    ids, unkId,
    prefix: typeof model['continuing_subword_prefix'] === 'string' ? model['continuing_subword_prefix'] : '##',
    maxChars: typeof model['max_input_chars_per_word'] === 'number' ? model['max_input_chars_per_word'] : 100,
    lowercase, stripAccents,
  }
}

function isCjk(cp: number): boolean {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0x2A700 && cp <= 0x2B73F)
    || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F)
}

const CONTROL_RE = /^[\p{Cc}\p{Cf}]$/u
const WHITESPACE_RE = /^[\s\p{Zs}]$/u
const PUNCT_RE = /^[\p{P}\p{S}]$/u
const MARK_RE = /\p{Mn}/gu

function isPunct(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true
  return cp > 127 && /^\p{P}$/u.test(ch)
}

export function bertNormalize(text: string, rules: { lowercase: boolean, stripAccents: boolean }): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0 || cp === 0xFFFD) continue
    if (ch === '\t' || ch === '\n' || ch === '\r' || WHITESPACE_RE.test(ch)) { out += ' '; continue }
    if (CONTROL_RE.test(ch)) continue
    out += isCjk(cp) ? ` ${ch} ` : ch
  }
  if (rules.stripAccents) out = out.normalize('NFD').replace(MARK_RE, '')
  if (rules.lowercase) out = out.toLowerCase()
  return out
}

export function bertPreTokenize(text: string): string[] {
  const words: string[] = []
  let cur = ''
  const flush = (): void => { if (cur !== '') { words.push(cur); cur = '' } }
  for (const ch of text) {
    if (ch === ' ' || WHITESPACE_RE.test(ch)) { flush(); continue }
    if (isPunct(ch) || PUNCT_RE.test(ch) && isPunct(ch)) { flush(); words.push(ch); continue }
    cur += ch
  }
  flush()
  return words
}

export function wordPieceIds(words: readonly string[], v: WordPieceVocab): number[] {
  const out: number[] = []
  for (const word of words) {
    const chars = Array.from(word)
    if (chars.length > v.maxChars) { out.push(v.unkId); continue }
    const pieces: number[] = []
    let start = 0
    let bad = false
    while (start < chars.length) {
      let end = chars.length
      let found: number | undefined
      while (start < end) {
        const piece = (start > 0 ? v.prefix : '') + chars.slice(start, end).join('')
        const id = v.ids.get(piece)
        if (id !== undefined) { found = id; break }
        end--
      }
      if (found === undefined) { bad = true; break }
      pieces.push(found)
      start = end
    }
    if (bad) out.push(v.unkId)
    else out.push(...pieces)
  }
  return out
}

export function tokenIds(text: string, v: WordPieceVocab): number[] {
  return wordPieceIds(bertPreTokenize(bertNormalize(text, v)), v)
}

export function embedTokens(m: EmbedMatrix, ids: readonly number[]): Float32Array {
  const out = new Float32Array(m.dim)
  let n = 0
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id >= m.rows) continue
    const off = id * m.dim
    for (let j = 0; j < m.dim; j++) out[j] = (out[j] as number) + (m.data[off + j] as number)
    n++
  }
  if (n === 0) return out
  let norm = 0
  for (let j = 0; j < m.dim; j++) {
    const v = ((out[j] as number) / n - m.zeroPoint) * m.scale
    out[j] = v
    norm += v * v
  }
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm)
    for (let j = 0; j < m.dim; j++) out[j] = (out[j] as number) * inv
  }
  return out
}

export function embedText(m: EmbedMatrix, v: WordPieceVocab, text: string): Float32Array {
  return embedTokens(m, tokenIds(text, v))
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

export interface OnnxEmbedding {
  rows: number
  cols: number
  scale: number
  zeroPoint: number
  data: Uint8Array
}

interface Field { num: number, wire: number, start: number, end: number, value: number }

function varint(b: Uint8Array, i: number, end: number): { value: number, next: number } {
  let value = 0
  let mul = 1
  let n = i
  for (;;) {
    if (n >= end) throw new Error('onnx: a varint runs past its message')
    const c = b[n] as number
    n++
    value += (c & 0x7f) * mul
    if ((c & 0x80) === 0) break
    mul *= 128
  }
  return { value, next: n }
}

function* fields(b: Uint8Array, start: number, end: number): Generator<Field> {
  let i = start
  while (i < end) {
    const key = varint(b, i, end)
    const num = Math.floor(key.value / 8)
    const wire = key.value % 8
    i = key.next
    switch (wire) {
      case 0: { const v = varint(b, i, end); yield { num, wire, start: i, end: v.next, value: v.value }; i = v.next; break }
      case 1: yield { num, wire, start: i, end: i + 8, value: 0 }; i += 8; break
      case 2: { const len = varint(b, i, end); yield { num, wire, start: len.next, end: len.next + len.value, value: len.value }; i = len.next + len.value; break }
      case 5: yield { num, wire, start: i, end: i + 4, value: 0 }; i += 4; break
      default: throw new Error(`onnx: wire type ${wire} is not known`)
    }
    if (i > end) throw new Error('onnx: a field runs past its message')
  }
}

function ascii(b: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i] as number)
  return s
}

function float32At(b: Uint8Array, i: number): number {
  return new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0, true)
}

interface Tensor { name: string, dims: number[], type: number, raw?: { start: number, end: number }, floats: number[], ints: number[] }

function tensor(b: Uint8Array, start: number, end: number): Tensor {
  const t: Tensor = { name: '', dims: [], type: 0, floats: [], ints: [] }
  for (const f of fields(b, start, end)) {
    switch (f.num) {
      case 1:
        if (f.wire === 0) t.dims.push(f.value)
        else if (f.wire === 2) { let i = f.start; while (i < f.end) { const v = varint(b, i, f.end); t.dims.push(v.value); i = v.next } }
        break
      case 2: if (f.wire === 0) t.type = f.value; break
      case 4:
        if (f.wire === 5) t.floats.push(float32At(b, f.start))
        else if (f.wire === 2) for (let i = f.start; i + 4 <= f.end; i += 4) t.floats.push(float32At(b, i))
        break
      case 5:
        if (f.wire === 0) t.ints.push(f.value)
        else if (f.wire === 2) { let i = f.start; while (i < f.end) { const v = varint(b, i, f.end); t.ints.push(v.value); i = v.next } }
        break
      case 8: if (f.wire === 2) t.name = ascii(b, f.start, f.end); break
      case 9: if (f.wire === 2) t.raw = { start: f.start, end: f.end }; break
      default: break
    }
  }
  return t
}

const ONNX_FLOAT = 1
const ONNX_UINT8 = 2
const ONNX_INT8 = 3

export function onnxQuantizedEmbedding(bytes: Uint8Array): OnnxEmbedding {
  let graph: { start: number, end: number } | undefined
  for (const f of fields(bytes, 0, bytes.length)) if (f.num === 7 && f.wire === 2) graph = { start: f.start, end: f.end }
  if (graph === undefined) throw new Error('onnx: the file holds no graph')
  const tensors: Tensor[] = []
  for (const f of fields(bytes, graph.start, graph.end)) if (f.num === 5 && f.wire === 2) tensors.push(tensor(bytes, f.start, f.end))
  const weight = tensors.find(t => t.dims.length === 2 && (t.type === ONNX_UINT8 || t.type === ONNX_INT8) && t.raw !== undefined && t.raw.end - t.raw.start === (t.dims[0] as number) * (t.dims[1] as number))
  if (weight === undefined || weight.raw === undefined) throw new Error('onnx: no quantized two-dimensional embedding tensor')
  const base = weight.name.replace(/_quantized$/u, '')
  const scaleT = tensors.find(t => t.name === `${base}_scale` && t.type === ONNX_FLOAT)
  const zeroT = tensors.find(t => t.name === `${base}_zero_point`)
  const scale = scaleT === undefined ? undefined : scaleT.floats[0] ?? (scaleT.raw !== undefined && scaleT.raw.end - scaleT.raw.start >= 4 ? float32At(bytes, scaleT.raw.start) : undefined)
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0) throw new Error(`onnx: no scale for ${weight.name}`)
  let zeroPoint = zeroT === undefined ? 0 : zeroT.ints[0] ?? (zeroT.raw !== undefined && zeroT.raw.end > zeroT.raw.start ? (bytes[zeroT.raw.start] as number) : 0)
  let data = bytes.subarray(weight.raw.start, weight.raw.end)
  if (weight.type === ONNX_INT8) {
    const shifted = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) shifted[i] = (((data[i] as number) << 24) >> 24) + 128
    data = shifted
    zeroPoint = (((zeroPoint & 0xff) << 24) >> 24) + 128
  }
  return { rows: weight.dims[0] as number, cols: weight.dims[1] as number, scale, zeroPoint, data }
}

export function truncateMatrix(m: OnnxEmbedding, dim: number): EmbedMatrix {
  if (dim <= 0 || dim > m.cols) throw new Error(`cannot keep ${dim} of ${m.cols} dimensions`)
  const data = new Uint8Array(m.rows * dim)
  for (let r = 0; r < m.rows; r++) data.set(m.data.subarray(r * m.cols, r * m.cols + dim), r * dim)
  return { rows: m.rows, dim, scale: m.scale, zeroPoint: m.zeroPoint, data }
}

export interface EmbedFileHeader {
  v: 1
  model: string
  rows: number
  dim: number
  scale: number
  zeroPoint: number
  source: string
}

export function encodeEmbedFile(m: EmbedMatrix, meta: { model: string, source: string }): Uint8Array {
  const header: EmbedFileHeader = { v: 1, model: meta.model, rows: m.rows, dim: m.dim, scale: m.scale, zeroPoint: m.zeroPoint, source: meta.source }
  const line = JSON.stringify(header) + '\n'
  const out = new Uint8Array(line.length + m.data.length)
  for (let i = 0; i < line.length; i++) out[i] = line.charCodeAt(i) & 0x7f
  out.set(m.data, line.length)
  return out
}

export function decodeEmbedHeader(bytes: Uint8Array): { header: EmbedFileHeader, dataStart: number } {
  let nl = -1
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) if (bytes[i] === 10) { nl = i; break }
  if (nl < 0) throw new Error('model.bin: no header line')
  let json: unknown
  try { json = JSON.parse(ascii(bytes, 0, nl)) } catch { throw new Error('model.bin: the header is not JSON') }
  if (!isRecord(json) || json['v'] !== 1 || typeof json['model'] !== 'string' || typeof json['rows'] !== 'number' || typeof json['dim'] !== 'number' || typeof json['scale'] !== 'number' || typeof json['zeroPoint'] !== 'number') throw new Error('model.bin: the header is not a v1 header')
  const header: EmbedFileHeader = { v: 1, model: json['model'], rows: json['rows'], dim: json['dim'], scale: json['scale'], zeroPoint: json['zeroPoint'], source: typeof json['source'] === 'string' ? json['source'] : '' }
  return { header, dataStart: nl + 1 }
}

export function decodeEmbedFile(bytes: Uint8Array): { header: EmbedFileHeader, matrix: EmbedMatrix } {
  const { header, dataStart } = decodeEmbedHeader(bytes)
  const want = header.rows * header.dim
  if (bytes.length - dataStart !== want) throw new Error(`model.bin: ${bytes.length - dataStart} bytes of vectors, ${want} expected`)
  return { header, matrix: { rows: header.rows, dim: header.dim, scale: header.scale, zeroPoint: header.zeroPoint, data: bytes.subarray(dataStart) } }
}
