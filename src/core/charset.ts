const CODE = 0
const STRING = 1
const COMMENT = 2
const PROSE = 3

interface Lang {
  line: readonly string[]
  block: ReadonlyArray<readonly [string, string]>
  quotes: string
  multiline?: boolean
  triple?: boolean
  backtick?: boolean
  template?: boolean
  regex?: boolean
  rustChar?: boolean
  verbatim?: boolean
  jsx?: boolean
  markup?: boolean
  hashAtWord?: boolean
  heredoc?: boolean
  typographic: boolean
}

const C: Lang = { line: ['//'], block: [['/*', '*/']], quotes: `"'`, typographic: true }
const JS: Lang = { ...C, backtick: true, template: true, regex: true }
const HASH: Lang = { line: ['#'], block: [], quotes: `"'`, typographic: true }
const SHELL: Lang = { ...HASH, multiline: true, hashAtWord: true, heredoc: true }
const DASH: Lang = { line: ['--'], block: [['/*', '*/'], ['{-', '-}'], ['--[[', ']]']], quotes: `"'`, typographic: true }
const MARKUP: Lang = { line: [], block: [['<!--', '-->']], quotes: `"'`, markup: true, multiline: true, typographic: true }
const DATA: Lang = { line: ['#', ';'], block: [], quotes: `"'`, typographic: false }
const PLAIN: Lang = { line: [], block: [], quotes: '"', typographic: true }

const LANGS: Readonly<Record<string, Lang>> = {
  ts: JS, mts: JS, cts: JS, js: JS, mjs: JS, cjs: JS, tsx: { ...JS, jsx: true }, jsx: { ...JS, jsx: true },
  go: { ...C, backtick: true }, rs: { ...C, rustChar: true }, cs: { ...C, triple: true, verbatim: true },
  java: { ...C, triple: true }, kt: { ...C, triple: true }, kts: { ...C, triple: true }, swift: { ...C, triple: true }, scala: { ...C, triple: true },
  dart: { ...C, triple: true }, groovy: { ...C, triple: true }, gradle: { ...C, triple: true },
  c: C, h: C, cc: C, cpp: C, cxx: C, hpp: C, m: C, mm: C, php: { ...C, line: ['//', '#'] }, zig: C,
  css: C, scss: C, sass: C, less: C, json: { ...C, quotes: '"' }, jsonc: { ...C, quotes: '"' }, json5: C,
  py: { ...HASH, triple: true }, pyi: { ...HASH, triple: true }, rb: HASH, pl: HASH, pm: HASH, r: HASH, jl: { ...HASH, triple: true }, nim: { ...HASH, triple: true },
  ex: { ...HASH, triple: true }, exs: { ...HASH, triple: true }, toml: { ...HASH, triple: true }, tf: { ...HASH, line: ['#', '//'], block: [['/*', '*/']] }, hcl: { ...HASH, line: ['#', '//'], block: [['/*', '*/']] },
  sh: SHELL, bash: SHELL, zsh: SHELL, fish: SHELL, ps1: { ...SHELL, block: [['<#', '#>']] }, mk: SHELL,
  sql: DASH, lua: DASH, hs: DASH, elm: DASH,
  ml: { ...PLAIN, block: [['(*', '*)']] }, clj: { ...PLAIN, line: [';'] },
  html: MARKUP, htm: MARKUP, xml: MARKUP, svg: MARKUP, xaml: MARKUP, vue: MARKUP, svelte: MARKUP,
  yaml: DATA, yml: DATA, ini: DATA, cfg: DATA, conf: DATA, properties: DATA,
}

const BY_NAME: Readonly<Record<string, Lang>> = { dockerfile: SHELL, containerfile: SHELL, makefile: SHELL, justfile: SHELL, gnumakefile: SHELL }

function baseOf(p: string): string { return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1) }

function langOf(path: string): Lang | undefined {
  const b = baseOf(path)
  const named = BY_NAME[b.toLowerCase()]
  if (named !== undefined) return named
  const i = b.lastIndexOf('.')
  return i <= 0 ? undefined : LANGS[b.slice(i + 1).toLowerCase()]
}

const JSX_TEXT_MAX = 4000
const REGEX_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
const REGEX_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|else|do|yield|await)\s*$/

function contexts(text: string, lang: Lang): Uint8Array {
  const n = text.length
  const out = new Uint8Array(n)
  let i = 0
  const mark = (from: number, to: number, kind: number): void => { out.fill(kind, from, Math.min(to, n)) }
  const tagAhead = (at: number): number => {
    for (let j = at; j < n && j < at + JSX_TEXT_MAX; j++) {
      const c = text[j] as string
      if (c === '<') return /[A-Za-z/>]/.test(text[j + 1] ?? '') ? j : -1
      if (c === '>' || c === '{' || c === '}' || c === ';' || c === '=') return -1
    }
    return -1
  }
  const prose = (from: number): number => {
    const end = tagAhead(from)
    if (end < 0) return from
    mark(from, end, PROSE)
    return end
  }
  const holes: number[] = []
  const templateFrom = (start: number, k: number): number => {
    let j = k
    while (j < n) {
      const d = text[j] as string
      if (d === '\\') { j += 2; continue }
      if (d === '`') { mark(start, j + 1, STRING); return j + 1 }
      if (d === '$' && text[j + 1] === '{') { mark(start, j + 2, STRING); holes.push(0); return j + 2 }
      j++
    }
    mark(start, n, STRING)
    return n
  }
  const regexEnd = (k: number): number => {
    let inClass = false
    for (let j = k + 1; j < n; j++) {
      const d = text[j] as string
      if (d === '\\') { j++; continue }
      if (d === '\n') return -1
      if (d === '[') inClass = true
      else if (d === ']') inClass = false
      else if (d === '/' && !inClass) {
        let e = j + 1
        while (e < n && /[a-z]/.test(text[e] as string)) e++
        return e
      }
    }
    return -1
  }
  let prev = ''
  if (lang.markup) {
    const end = text.indexOf('<')
    i = end < 0 ? n : end
    mark(0, i, PROSE)
  } else if (lang.jsx) i = prose(0)
  while (i < n) {
    const c = text[i] as string
    if (lang.template && holes.length > 0 && (c === '{' || c === '}')) {
      const top = holes.length - 1
      if (c === '{') holes[top] = (holes[top] as number) + 1
      else if (holes[top] === 0) { holes.pop(); i = templateFrom(i, i + 1); prev = 'a'; continue }
      else holes[top] = (holes[top] as number) - 1
      prev = c
      i++
      continue
    }
    if (lang.markup && c === '>') {
      const end = text.indexOf('<', i + 1)
      const stop = end < 0 ? n : end
      mark(i + 1, stop, PROSE)
      i = stop
      continue
    }
    if (lang.jsx && (c === '>' || c === '}')) { prev = c; i = prose(i + 1); continue }
    const block = lang.block.find(([open]) => text.startsWith(open, i))
    if (block !== undefined) {
      const end = text.indexOf(block[1], i + block[0].length)
      const stop = end < 0 ? n : end + block[1].length
      mark(i, stop, COMMENT)
      i = stop
      continue
    }
    const line = lang.line.find(open => text.startsWith(open, i) && (!lang.hashAtWord || open !== '#' || i === 0 || /\s/.test(text[i - 1] ?? '')))
    if (line !== undefined) {
      const end = text.indexOf('\n', i)
      const stop = end < 0 ? n : end
      mark(i, stop, COMMENT)
      i = stop
      continue
    }
    if (lang.heredoc && text.startsWith('<<', i) && text[i + 2] !== '<') {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(text.slice(i, i + 80))
      const eol = m !== null ? text.indexOf('\n', i) : -1
      if (m !== null && eol >= 0) {
        const word = m[3] as string
        let j = eol + 1
        while (j < n) {
          const next = text.indexOf('\n', j)
          const row = text.slice(j, next < 0 ? n : next)
          if ((m[1] === '-' ? row.trim() : row) === word) break
          j = next < 0 ? n : next + 1
        }
        mark(eol + 1, j, PROSE)
        i = j
        continue
      }
    }
    if (lang.regex && c === '/' && (REGEX_BEFORE.has(prev) || REGEX_KEYWORD.test(text.slice(Math.max(0, i - 12), i)))) {
      const end = regexEnd(i)
      if (end > 0) { mark(i, end, STRING); prev = 'a'; i = end; continue }
    }
    if (lang.template && c === '`') { i = templateFrom(i, i + 1); prev = 'a'; continue }
    const triple = lang.triple && (text.startsWith('"""', i) || text.startsWith("'''", i)) ? text.slice(i, i + 3) : undefined
    if (triple !== undefined) {
      const end = text.indexOf(triple, i + 3)
      const stop = end < 0 ? n : end + 3
      mark(i, stop, STRING)
      i = stop
      continue
    }
    const verbatim = lang.verbatim && c === '@' && text[i + 1] === '"'
    const quote = verbatim ? '"' : lang.quotes.includes(c) || (lang.backtick && c === '`') ? c : undefined
    if (quote !== undefined && !(lang.rustChar && quote === "'" && !/^'(?:\\.|[^\\'\n])'/.test(text.slice(i, i + 12)))) {
      const multi = quote === '`' || lang.multiline === true
      let j = i + (verbatim ? 2 : 1)
      while (j < n) {
        const d = text[j] as string
        if (d === '\\' && !verbatim && !(lang.hashAtWord && quote === "'")) { j += 2; continue }
        if (d === quote) { if (verbatim && text[j + 1] === '"') { j += 2; continue } j++; break }
        if (d === '\n' && !multi) break
        j++
      }
      mark(i, j, STRING)
      prev = 'a'
      i = j
      continue
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out
}

interface CharClass { re: RegExp, label: string, hint: string, strict?: boolean, soft?: string }

type Code = number | readonly [number, number]

function chars(codes: readonly Code[]): string {
  return codes.map(c => (typeof c === 'number' ? String.fromCodePoint(c) : `${String.fromCodePoint(c[0])}-${String.fromCodePoint(c[1])}`)).join('')
}

function charSet(...codes: Code[]): RegExp {
  return new RegExp(`[${chars(codes)}]`, 'u')
}

const BIDI_CODES: Code[] = [[0x202a, 0x202e], [0x2066, 0x2069]]
const ZERO_WIDTH_CODES: Code[] = [0x200b, 0x2060, 0xfeff, 0x180e]
const JOINER_CODES: Code[] = [0x200c, 0x200d]
const SPACE_CODES: Code[] = [0xa0, 0x1680, [0x2000, 0x200a], 0x202f, 0x205f, 0x3000]

const BIDI = charSet(...BIDI_CODES)
const ZERO_WIDTH = charSet(...ZERO_WIDTH_CODES)
const JOINER = charSet(...JOINER_CODES)
const SPACE = charSet(...SPACE_CODES)
const INVISIBLE = charSet(...BIDI_CODES, ...ZERO_WIDTH_CODES, ...JOINER_CODES, ...SPACE_CODES)

const CHAR_CLASSES: CharClass[] = [
  { re: BIDI, label: 'bidirectional control character', hint: 'remove it (it can hide code)', strict: true, soft: 'remove it (it can hide code), or write it as an escape sequence if the text needs it' },
  { re: ZERO_WIDTH, label: 'zero-width character', hint: 'remove it', strict: true, soft: 'remove it, or write it as an escape sequence if the text needs it' },
  { re: JOINER, label: 'zero-width joiner or non-joiner', hint: 'remove it unless it joins the letters or emoji around it', strict: true },
  { re: SPACE, label: 'non-breaking or unusual space', hint: 'use a plain space', strict: true, soft: 'use a plain space unless the text needs a non-breaking one' },
  { re: charSet(0x2018, 0x2019, 0x201a, 0x201b, 0x2032), label: 'smart single quote', hint: "use a plain '" },
  { re: charSet(0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0xab, 0xbb), label: 'smart double quote', hint: 'use a plain "' },
  { re: charSet([0x2010, 0x2015], 0x2212), label: 'typographic dash or minus', hint: 'use a plain -' },
  { re: charSet(0x2026), label: 'ellipsis', hint: 'use three dots' },
  { re: charSet(0x2264, 0x2265, 0x2260), label: 'math comparison symbol', hint: 'use <=, >= or !=' },
  { re: charSet([0x2190, 0x21ff], [0x27f0, 0x27ff], [0x2900, 0x297f]), label: 'arrow symbol', hint: 'use -> or plain words' },
  { re: charSet(0x2022, [0x25a0, 0x25ff], [0x2500, 0x259f]), label: 'decorative symbol', hint: 'use plain ASCII' },
  { re: new RegExp(`\\p{Extended_Pictographic}|[${chars([[0x2600, 0x27bf]])}]`, 'u'), label: 'emoji or pictograph', hint: 'remove it from code' },
]

const TYPOGRAPHY_NEIGHBOR = new RegExp(`[${chars([0xab, 0xbb, 0x20ac, 0x2030])}:;!?%$\\d]`, 'u')

function intended(cls: CharClass, prev: string | undefined, next: string | undefined): boolean {
  const nonAscii = (s: string | undefined): boolean => s !== undefined && (s.codePointAt(0) ?? 0) >= 0x80 && !INVISIBLE.test(s)
  if (cls.re === JOINER) return nonAscii(prev) && nonAscii(next)
  if (cls.re === SPACE) return (prev !== undefined && TYPOGRAPHY_NEIGHBOR.test(prev)) || (next !== undefined && TYPOGRAPHY_NEIGHBOR.test(next))
  return false
}

export const CHARSET_MAX_FINDINGS = 10
const CHARSET_CONTEXT_MAX = 2_000_000

export function charsetFindings(addedText: string, path: string, fileText?: string): string[] {
  if (typeof addedText !== 'string' || addedText === '' || !/[^\x00-\x7F]/.test(addedText)) return []
  const lang = langOf(typeof path === 'string' ? path : '')
  if (lang === undefined) return []
  const lines = addedText.split('\n')
  const full = typeof fileText === 'string' && fileText !== '' && fileText.length <= CHARSET_CONTEXT_MAX ? fileText : undefined
  const fileCtx = full !== undefined ? contexts(full, lang) : undefined
  let ownCtx: Uint8Array | undefined
  const starts: number[] = []
  let at = 0
  for (const l of lines) { starts.push(at); at += l.length + 1 }
  let cursor = 0
  const out: string[] = []
  let extra = 0
  for (const [i, line] of lines.entries()) {
    if (!/[^\x00-\x7F]/.test(line)) continue
    let base: Uint8Array
    let offset: number
    const found = full !== undefined && line.trim() !== '' ? (() => { const k = full.indexOf(line, cursor); return k >= 0 ? k : full.indexOf(line) })() : -1
    if (found >= 0 && fileCtx !== undefined) {
      base = fileCtx
      offset = found
      cursor = found + line.length
    } else {
      ownCtx ??= contexts(addedText, lang)
      base = ownCtx
      offset = starts[i] as number
    }
    const cps = [...line]
    let u16 = 0
    for (const [k, ch] of cps.entries()) {
      const pos = offset + u16
      u16 += ch.length
      const code = ch.codePointAt(0) ?? 0
      if (code < 0x80 || code === 0xA9 || code === 0xAE || code === 0x2122) continue
      const cls = CHAR_CLASSES.find(c => c.re.test(ch))
      if (!cls) continue
      const where = base[pos] ?? CODE
      if (where !== CODE) {
        if (!cls.strict) continue
        if (intended(cls, cps[k - 1], cps[k + 1])) continue
      } else if (!cls.strict && !lang.typographic) continue
      if (out.length >= CHARSET_MAX_FINDINGS) { extra++; continue }
      const hex = code.toString(16).toUpperCase().padStart(4, '0')
      const visible = INVISIBLE.test(ch) ? '' : ` ${ch}`
      const hint = where !== CODE && cls.soft !== undefined ? cls.soft : cls.hint
      out.push(`added line ${i + 1}, column ${k + 1}: ${cls.label}${visible} (U+${hex}); ${hint}`)
    }
  }
  if (extra > 0) out.push(`${String.fromCodePoint(0x2026)} ${extra} more unusual characters in this edit`)
  return out
}
