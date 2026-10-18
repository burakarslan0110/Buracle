type Edit = { op: ' ' | '-' | '+'; line: string }

const NO_EOL = '\u0000noeol'

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  else lines[lines.length - 1] = (lines[lines.length - 1] ?? '') + NO_EOL
  return lines
}

function myers(a: string[], b: string[]): Edit[] {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  if (n * m > 25_000_000) return [...a.map(line => ({ op: '-' as const, line })), ...b.map(line => ({ op: '+' as const, line }))]
  const off = max
  let v: Int32Array = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (v[k - 1 + off] as number) < (v[k + 1 + off] as number))) x = v[k + 1 + off] as number
      else x = (v[k - 1 + off] as number) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[k + off] = x
      if (x >= n && y >= m) break outer
    }
  }
  const edits: Edit[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    v = trace[d] as Int32Array
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && (v[k - 1 + off] as number) < (v[k + 1 + off] as number))) prevK = k + 1
    else prevK = k - 1
    const prevX = v[prevK + off] as number
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { edits.push({ op: ' ', line: a[x - 1] as string }); x--; y-- }
    if (d > 0) {
      if (x === prevX) edits.push({ op: '+', line: b[y - 1] as string })
      else edits.push({ op: '-', line: a[x - 1] as string })
    }
    x = prevX
    y = prevY
  }
  return edits.reverse()
}

function renderLine(e: Edit): string {
  if (e.line.endsWith(NO_EOL)) return `${e.op}${e.line.slice(0, -NO_EOL.length)}\n\\ No newline at end of file`
  return `${e.op}${e.line}`
}

export function unifiedDiff(oldText: string, newText: string, opts: { oldLabel: string, newLabel: string, context?: number }): string {
  if (oldText === newText) return ''
  const ctx = opts.context ?? 3
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const edits = myers(a, b)
  const out: string[] = [`--- ${opts.oldLabel}`, `+++ ${opts.newLabel}`]
  const pos: Array<{ ai: number, bi: number }> = []
  let ai = 0
  let bi = 0
  for (const e of edits) {
    pos.push({ ai, bi })
    if (e.op !== '+') ai++
    if (e.op !== '-') bi++
  }
  let i = 0
  while (i < edits.length) {
    if ((edits[i] as Edit).op === ' ') { i++; continue }
    let start = i
    let back = 0
    while (start > 0 && back < ctx && (edits[start - 1] as Edit).op === ' ') { start--; back++ }
    let end = i
    for (;;) {
      while (end < edits.length && (edits[end] as Edit).op !== ' ') end++
      let run = 0
      let j = end
      while (j < edits.length && (edits[j] as Edit).op === ' ') { run++; j++ }
      if (j < edits.length && run <= 2 * ctx) { end = j; continue }
      end = Math.min(edits.length, end + Math.min(run, ctx))
      break
    }
    const first = pos[start] as { ai: number, bi: number }
    let aLen = 0
    let bLen = 0
    for (let k = start; k < end; k++) {
      const op = (edits[k] as Edit).op
      if (op !== '+') aLen++
      if (op !== '-') bLen++
    }
    const aStart = aLen === 0 ? first.ai : first.ai + 1
    const bStart = bLen === 0 ? first.bi : first.bi + 1
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`)
    for (let k = start; k < end; k++) out.push(renderLine(edits[k] as Edit))
    i = end
  }
  return out.join('\n') + '\n'
}
