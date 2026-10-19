export type Key = 'up' | 'down' | 'left' | 'right' | 'pageup' | 'pagedown' | 'home' | 'end' | 'enter' | 'escape' | 'ctrl-c' | 'tab' | 'backspace' | { char: string }

export interface KeyDecoder {
  feed(chunk: string, nowMs?: number): Key[]
  // Ends the wait for what is pending: a lone ESC becomes 'escape', an unfinished sequence is dropped.
  // With nowMs it does nothing until ESC_WAIT_MS has passed since the pending input arrived.
  flush(nowMs?: number): Key[]
  pending(): boolean
}

// How long a lone ESC waits for the rest of a sequence before it counts as the Escape key.
export const ESC_WAIT_MS = 30

const ESC = '\u001b'

const CONTROL: ReadonlyMap<string, Key> = new Map<string, Key>([
  ['\r', 'enter'], ['\n', 'enter'], ['\t', 'tab'], ['\u007f', 'backspace'], ['\b', 'backspace'], ['\u0003', 'ctrl-c'], ['\u0004', 'ctrl-c'],
])

// The final byte of `ESC [ ... X` and `ESC O X`; modifiers in the parameters (`ESC[1;5A`) are ignored.
const FINAL: ReadonlyMap<string, Key> = new Map<string, Key>([['A', 'up'], ['B', 'down'], ['C', 'right'], ['D', 'left'], ['H', 'home'], ['F', 'end']])

// The first parameter of `ESC [ n ~`.
const TILDE: ReadonlyMap<string, Key> = new Map<string, Key>([['1', 'home'], ['7', 'home'], ['4', 'end'], ['8', 'end'], ['5', 'pageup'], ['6', 'pagedown']])

const isFinalByte = (code: number): boolean => code >= 0x40 && code <= 0x7e
const isCsiBody = (code: number): boolean => code >= 0x20 && code <= 0x3f

function csiKey(params: string, final: string): Key | undefined {
  return final === '~' ? TILDE.get(params.split(';')[0] ?? '') : FINAL.get(final)
}

// Decodes what it can; `rest` is the index where an unfinished sequence starts (s.length when none).
function scan(s: string): { keys: Key[], rest: number } {
  const keys: Key[] = []
  let i = 0
  while (i < s.length) {
    const c = s.charAt(i)
    if (c === ESC) {
      if (i + 1 >= s.length) return { keys, rest: i }
      const next = s.charAt(i + 1)
      if (next === '[') {
        let j = i + 2
        while (j < s.length && isCsiBody(s.charCodeAt(j))) j++
        if (j >= s.length) return { keys, rest: i }
        if (isFinalByte(s.charCodeAt(j))) {
          const key = csiKey(s.slice(i + 2, j), s.charAt(j))
          if (key !== undefined) keys.push(key)
          i = j + 1
        } else i = j // a broken sequence: drop it and read the offending character again
        continue
      }
      if (next === 'O') {
        if (i + 2 >= s.length) return { keys, rest: i }
        if (isFinalByte(s.charCodeAt(i + 2))) {
          const key = FINAL.get(s.charAt(i + 2))
          if (key !== undefined) keys.push(key)
          i += 3
        } else i += 2
        continue
      }
      const after = s.codePointAt(i + 1) ?? 0
      if (next !== ESC && after >= 0x20 && after !== 0x7f) {
        // An Alt or Option chord (Option+Left sends ESC b): no key of ours. Only one read makes a chord; a
        // chord split across two reads still arrives as Escape, the price of a quick lone Escape staying one.
        i += 1 + String.fromCodePoint(after).length
        continue
      }
      keys.push('escape')
      i += 1
      continue
    }
    const control = CONTROL.get(c)
    if (control !== undefined) {
      keys.push(control)
      i += 1
      continue
    }
    const text = String.fromCodePoint(s.codePointAt(i) ?? 0)
    if (!/^[\u0000-\u001f\u007f-\u009f]$/u.test(text)) keys.push({ char: text })
    i += text.length
  }
  return { keys, rest: s.length }
}

export function createKeyDecoder(opts: { now?: () => number } = {}): KeyDecoder {
  const clock = opts.now ?? Date.now
  let buf = ''
  let since = 0
  return {
    feed(chunk, nowMs) {
      const now = nowMs ?? clock()
      const keys: Key[] = []
      // A lone ESC from an earlier read is Escape when it waited long enough or a plain key follows it;
      // only ESC and a character in one read make an Alt chord.
      const first = chunk.charAt(0)
      if (buf === ESC && (now - since >= ESC_WAIT_MS || (chunk !== '' && first !== '[' && first !== 'O' && first !== ESC))) {
        keys.push('escape')
        buf = ''
      }
      const s = buf + chunk
      const r = scan(s)
      keys.push(...r.keys)
      if (r.rest < s.length) {
        if (r.rest !== 0 || buf === '') since = now
        buf = s.slice(r.rest)
      } else buf = ''
      return keys
    },
    flush(nowMs) {
      if (buf === '' || (nowMs !== undefined && nowMs - since < ESC_WAIT_MS)) return []
      const lone = buf === ESC
      buf = ''
      return lone ? ['escape'] : []
    },
    pending: () => buf !== '',
  }
}
