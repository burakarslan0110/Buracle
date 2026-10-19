function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  do {
    let b = v % 128
    v = Math.floor(v / 128)
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return out
}

function key(field: number, wire: number): number[] {
  return varint(field * 8 + wire)
}

function bytesField(field: number, payload: Uint8Array | number[]): number[] {
  const p = payload instanceof Uint8Array ? [...payload] : payload
  return [...key(field, 2), ...varint(p.length), ...p]
}

function varintField(field: number, value: number): number[] {
  return [...key(field, 0), ...varint(value)]
}

function tensor(fields: number[][]): number[] {
  return fields.flat()
}

export interface SyntheticEmbedding { rows: number, cols: number, data: Uint8Array, scale: number, zeroPoint: number, name?: string }

export function encodeOnnxEmbedding(e: SyntheticEmbedding): Uint8Array {
  const name = e.name ?? 'embedding.weight'
  const ascii = (s: string) => [...s].map(c => c.charCodeAt(0))
  const scaleBytes = new Uint8Array(4)
  new DataView(scaleBytes.buffer).setFloat32(0, e.scale, true)
  const weight = tensor([bytesField(1, [...varint(e.rows), ...varint(e.cols)]), varintField(2, 2), bytesField(8, ascii(`${name}_quantized`)), bytesField(9, e.data)])
  const scale = tensor([varintField(2, 1), bytesField(4, scaleBytes), bytesField(8, ascii(`${name}_scale`))])
  const zero = tensor([varintField(2, 2), bytesField(5, varint(e.zeroPoint)), bytesField(8, ascii(`${name}_zero_point`))])
  const constant = tensor([bytesField(1, varint(1)), varintField(2, 7), bytesField(8, ascii('/Constant_output_0')), bytesField(9, [1, 0, 0, 0, 0, 0, 0, 0])])
  const node = [...bytesField(1, ascii('input_ids')), ...bytesField(2, ascii('out')), ...bytesField(4, ascii('Gather'))]
  const graph = [...bytesField(1, node), ...bytesField(2, ascii('main_graph')), ...bytesField(5, constant), ...bytesField(5, weight), ...bytesField(5, scale), ...bytesField(5, zero)]
  return new Uint8Array([...varintField(1, 7), ...bytesField(7, graph)])
}

export function tokenizerJson(pieces: readonly string[], opts: { lowercase?: boolean, stripAccents?: boolean | null } = {}): string {
  const vocab: Record<string, number> = {}
  pieces.forEach((p, i) => { vocab[p] = i })
  return JSON.stringify({
    version: '1.0',
    added_tokens: [{ id: pieces.indexOf('[UNK]'), content: '[UNK]', special: true }],
    normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: opts.stripAccents === undefined ? null : opts.stripAccents, lowercase: opts.lowercase ?? true },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100, vocab },
  })
}
