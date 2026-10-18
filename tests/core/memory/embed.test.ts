import { describe, expect, test } from 'bun:test'
import {
  bertNormalize, bertPreTokenize, cosine, decodeEmbedFile, decodeEmbedHeader, embedText, embedTokens, encodeEmbedFile,
  onnxQuantizedEmbedding, parseWordPieceTokenizer, tokenIds, truncateMatrix, wordPieceIds, type EmbedMatrix,
} from '../../../src/core/memory/embed'
import { encodeOnnxEmbedding, tokenizerJson } from '../../helpers/onnx'

const PIECES = ['[PAD]', '[UNK]', 'hello', 'world', '##s', 'merhaba', 'dunya', ',', '!', 'ab', '##cd', 'i', '##stanbul', '你', '好', 'über'] as const
const vocab = parseWordPieceTokenizer(JSON.parse(tokenizerJson(PIECES)))
const id = (p: string) => PIECES.indexOf(p as typeof PIECES[number])

describe('the tokenizer', () => {
  test('tokenizer.json: the WordPiece vocab, the unknown piece and the BERT rules; other shapes are refused', () => {
    expect(vocab.ids.get('hello')).toBe(2)
    expect(vocab).toMatchObject({ unkId: 1, prefix: '##', maxChars: 100, lowercase: true, stripAccents: true })
    expect(parseWordPieceTokenizer(JSON.parse(tokenizerJson(PIECES, { lowercase: false })))).toMatchObject({ lowercase: false, stripAccents: false })
    expect(() => parseWordPieceTokenizer({ model: { type: 'Unigram', vocab: [] } })).toThrow('not WordPiece')
    expect(() => parseWordPieceTokenizer({ model: { type: 'WordPiece', vocab: { a: 0 } } })).toThrow('[UNK]')
    expect(() => parseWordPieceTokenizer('x')).toThrow('no model')
  })

  test('the normalizer: whitespace, control characters, accents, case, the Turkish dotted I and CJK spacing', () => {
    const rules = { lowercase: true, stripAccents: true }
    expect(bertNormalize('Héllo  WORLD\tİstanbul\u0000​', rules)).toBe('hello  world istanbul')
    expect(bertNormalize('über Ünïcode', rules)).toBe('uber unicode')
    expect(bertNormalize('你好', rules)).toBe(' 你  好 ')
    expect(bertNormalize('Héllo', { lowercase: false, stripAccents: false })).toBe('Héllo')
  })

  test('the pre-tokenizer: words on whitespace, every punctuation character on its own', () => {
    expect(bertPreTokenize('hello, world!  foo-bar (x)')).toEqual(['hello', ',', 'world', '!', 'foo', '-', 'bar', '(', 'x', ')'])
    expect(bertPreTokenize(' 你  好 ')).toEqual(['你', '好'])
    expect(bertPreTokenize('')).toEqual([])
  })

  test('WordPiece: the longest known pieces, the rest with ##; an unknown word is one unknown piece; a long word too', () => {
    expect(wordPieceIds(['worlds', 'abcd', 'zzz', 'hello'], vocab)).toEqual([id('world'), id('##s'), id('ab'), id('##cd'), 1, id('hello')])
    expect(wordPieceIds(['a'.repeat(101)], vocab)).toEqual([1])
    expect(tokenIds('Hello, Worlds! Merhaba DÜNYA', vocab)).toEqual([id('hello'), id(','), id('world'), id('##s'), id('!'), id('merhaba'), id('dunya')])
    expect(tokenIds('İstanbul', vocab)).toEqual([id('i'), id('##stanbul')])
    expect(tokenIds('你好', vocab)).toEqual([id('你'), id('好')])
  })
})

describe('the vectors', () => {
  const m: EmbedMatrix = { rows: 4, dim: 3, scale: 0.5, zeroPoint: 128, data: new Uint8Array([128, 128, 128, 130, 128, 128, 128, 132, 128, 126, 128, 128]) }

  test('the mean of the pieces, dequantized and L2-normalized; the zero vector for no piece', () => {
    expect([...embedTokens(m, [])]).toEqual([0, 0, 0])
    expect([...embedTokens(m, [0])]).toEqual([0, 0, 0])
    const one = embedTokens(m, [1])
    expect([...one].map(x => Math.round(x * 1000) / 1000)).toEqual([1, 0, 0])
    const two = embedTokens(m, [1, 2])
    expect([...two].map(x => Math.round(x * 1000) / 1000)).toEqual([0.447, 0.894, 0])
    expect([...embedTokens(m, [1, 3])]).toEqual([0, 0, 0])
    expect([...embedTokens(m, [1, 99, -1])]).toEqual([...one])
  })

  test('cosine similarity and embedText', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1)
    expect(cosine([1, 0], [0, 1])).toBe(0)
    expect(cosine([1, 0], [-1, 0])).toBe(-1)
    expect(cosine([0, 0], [1, 0])).toBe(0)
    const matrix: EmbedMatrix = { rows: PIECES.length, dim: 2, scale: 1, zeroPoint: 0, data: new Uint8Array(PIECES.length * 2).map((_, i) => (i % 2 === 0 ? (i / 2) % 7 : 7 - ((i / 2) % 7)) + 1) }
    const a = embedText(matrix, vocab, 'hello world')
    const b = embedText(matrix, vocab, 'Hello, World!')
    expect(a.length).toBe(2)
    expect(cosine(a, b)).toBeGreaterThan(0.9)
  })
})

describe('the ONNX file and the model file', () => {
  const rows = 6
  const cols = 8
  const data = new Uint8Array(rows * cols).map((_, i) => (i * 37) % 256)

  test('the quantized embedding is found with its scale and zero point; int8 tensors are shifted; the first columns are kept', () => {
    const bytes = encodeOnnxEmbedding({ rows, cols, data, scale: 0.0123, zeroPoint: 130 })
    const q = onnxQuantizedEmbedding(bytes)
    expect(q).toMatchObject({ rows, cols, zeroPoint: 130 })
    expect(Math.abs(q.scale - 0.0123)).toBeLessThan(1e-6)
    expect([...q.data]).toEqual([...data])
    const m = truncateMatrix(q, 3)
    expect(m).toMatchObject({ rows, dim: 3, zeroPoint: 130 })
    expect([...m.data.subarray(0, 3)]).toEqual([...data.subarray(0, 3)])
    expect([...m.data.subarray(3, 6)]).toEqual([...data.subarray(cols, cols + 3)])
    expect(() => truncateMatrix(q, 9)).toThrow('cannot keep')
    expect(() => onnxQuantizedEmbedding(new Uint8Array([8, 7]))).toThrow('onnx')
  })

  test('encode and decode Buracle\'s model file; a damaged file is refused', () => {
    const m = truncateMatrix(onnxQuantizedEmbedding(encodeOnnxEmbedding({ rows, cols, data, scale: 0.5, zeroPoint: 128 })), 4)
    const file = encodeEmbedFile(m, { model: 'tiny', source: 'test' })
    const { header, dataStart } = decodeEmbedHeader(file)
    expect(header).toEqual({ v: 1, model: 'tiny', rows, dim: 4, scale: 0.5, zeroPoint: 128, source: 'test' })
    expect(file.length - dataStart).toBe(rows * 4)
    const back = decodeEmbedFile(file)
    expect([...back.matrix.data]).toEqual([...m.data])
    expect(() => decodeEmbedFile(file.subarray(0, file.length - 1))).toThrow('expected')
    expect(() => decodeEmbedHeader(new Uint8Array([123, 125]))).toThrow('no header line')
    expect(() => decodeEmbedHeader(new Uint8Array([...'{"v":2}\n'].map(c => c.charCodeAt(0))))).toThrow('v1 header')
  })
})
