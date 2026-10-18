import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const mode = process.argv[2] ?? 'push'
const logFile = process.env['STUB_LSP_LOG']
const record = (entry: Record<string, unknown>) => { if (logFile !== undefined && logFile !== '') appendFileSync(logFile, JSON.stringify(entry) + '\n') }

if (mode === 'crash') {
  console.error('stub-lsp: cannot find its runtime')
  process.exit(3)
}

type Msg = { jsonrpc: '2.0', id?: number | string, method?: string, params?: any, result?: unknown, error?: unknown }

const docs = new Map<string, { text: string, version: number }>()
const disk = new Map<string, string>()
const published = new Map<string, string>()
let nextId = 1000
let watch = false

const send = (o: unknown) => {
  const b = JSON.stringify(o)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`)
}

function dependency(uri: string, name: string): string {
  const dep = pathToFileURL(join(dirname(fileURLToPath(uri)), name)).href
  const open = docs.get(dep)
  if (open !== undefined) return open.text
  if (!disk.has(dep)) {
    let text = ''
    try { text = readFileSync(fileURLToPath(dep), 'utf8') } catch { text = '' }
    disk.set(dep, text)
  }
  return disk.get(dep) ?? ''
}

function diagnosticsOf(text: string, uri = ''): unknown[] {
  const out: unknown[] = []
  text.split('\n').forEach((line, i) => {
    const uses = /USES: (\S+)/.exec(line)
    if (uses?.[1] !== undefined && dependency(uri, uses[1]).includes('BROKEN')) out.push({ range: { start: { line: i, character: uses.index }, end: { line: i, character: line.length } }, severity: 1, code: 'E2', source: 'stub', message: `${uses[1]} is broken` })
    const at = line.indexOf('ERROR:')
    if (at >= 0) out.push({ range: { start: { line: i, character: at }, end: { line: i, character: line.length } }, severity: 1, code: 'E1', source: 'stub', message: line.slice(at + 6).trim() })
    const w = line.indexOf('WARN:')
    if (w >= 0) out.push({ range: { start: { line: i, character: w }, end: { line: i, character: line.length } }, severity: 2, source: 'stub', message: line.slice(w + 5).trim() })
  })
  return out
}

function publish(uri: string): void {
  const d = docs.get(uri)
  if (d === undefined) return
  if (mode === 'pull' || mode === 'mute') return
  if (mode === 'quiet' && published.get(uri) === d.text) return
  published.set(uri, d.text)
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: d.version, diagnostics: [] } })
  setTimeout(() => {
    const now = docs.get(uri)
    if (now === undefined || now.version !== d.version) return
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: d.version, diagnostics: diagnosticsOf(d.text, uri) } })
  }, 120)
}

function wordAt(uri: string, line: number, character: number): string {
  const text = docs.get(uri)?.text.split('\n')[line] ?? ''
  let s = character
  let e = character
  while (s > 0 && /\w/.test(text[s - 1] ?? '')) s--
  while (e < text.length && /\w/.test(text[e] ?? '')) e++
  return text.slice(s, e)
}

function occurrences(word: string): Array<{ uri: string, range: unknown }> {
  const out: Array<{ uri: string, range: unknown }> = []
  for (const [uri, d] of docs) {
    d.text.split('\n').forEach((line, i) => {
      const re = new RegExp(`\\b${word}\\b`, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) out.push({ uri, range: { start: { line: i, character: m.index }, end: { line: i, character: m.index + word.length } } })
    })
  }
  return out
}

function symbols(uri: string): unknown[] {
  const lines = docs.get(uri)?.text.split('\n') ?? []
  const out: Array<{ name: string, kind: number, range: unknown, selectionRange: unknown, children: unknown[] }> = []
  lines.forEach((line, i) => {
    const f = /^function (\w+)/.exec(line)
    const m = /^ {2}method (\w+)/.exec(line)
    const range = { start: { line: i, character: 0 }, end: { line: i + 1, character: 0 } }
    if (f?.[1] !== undefined) out.push({ name: f[1], kind: 12, range, selectionRange: range, children: [] })
    else if (m?.[1] !== undefined) out[out.length - 1]?.children.push({ name: m[1], kind: 6, range, selectionRange: range })
  })
  return out
}

function handle(msg: Msg): void {
  record({ method: msg.method, id: msg.id, params: msg.params, result: msg.result, cwd: process.cwd() })
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize': {
      watch = msg.params?.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true
      const answer = () => reply({
        capabilities: {
          textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
          hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true,
          ...(mode === 'pull' ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}),
        },
        serverInfo: { name: 'stub-lsp', version: '1.0.0' },
      })
      if (mode === 'slow') setTimeout(answer, 1500)
      else answer()
      return
    }
    case 'initialized':
      send({ jsonrpc: '2.0', id: nextId++, method: 'workspace/configuration', params: { items: [{ section: 'stub' }, { section: 'other' }] } })
      send({ jsonrpc: '2.0', id: nextId++, method: 'window/workDoneProgress/create', params: { token: 't1' } })
      if (watch) send({ jsonrpc: '2.0', id: nextId++, method: 'client/registerCapability', params: { registrations: [{ id: 'watch-ts', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [{ globPattern: '**/*.ts' }] } }] } })
      if (mode === 'warn') send({ jsonrpc: '2.0', method: 'window/showMessage', params: { type: 1, message: 'Failed to load the workspace: cargo not found\nmore detail' } })
      return
    case 'textDocument/didOpen': {
      const td = msg.params.textDocument
      docs.set(td.uri, { text: td.text, version: td.version })
      publish(td.uri)
      return
    }
    case 'textDocument/didChange': {
      const td = msg.params.textDocument
      docs.set(td.uri, { text: msg.params.contentChanges[0].text, version: td.version })
      publish(td.uri)
      return
    }
    case 'workspace/didChangeWatchedFiles':
      for (const c of msg.params.changes) disk.delete(c.uri)
      return
    case 'textDocument/didClose':
      docs.delete(msg.params.textDocument.uri)
      return
    case 'textDocument/diagnostic': {
      const d = docs.get(msg.params.textDocument.uri)
      reply({ kind: 'full', items: d !== undefined ? diagnosticsOf(d.text, msg.params.textDocument.uri) : [] })
      return
    }
    case 'textDocument/hover': {
      const w = wordAt(msg.params.textDocument.uri, msg.params.position.line, msg.params.position.character)
      reply(w === '' ? null : { contents: { kind: 'markdown', value: `\`\`\`ts\nfunction ${w}(): number\n\`\`\`\nDocs for ${w}.` } })
      return
    }
    case 'textDocument/definition': {
      const w = wordAt(msg.params.textDocument.uri, msg.params.position.line, msg.params.position.character)
      const hit = occurrences(w).find(o => (docs.get(o.uri)?.text.split('\n')[(o.range as any).start.line] ?? '').startsWith(`function ${w}`))
      reply(hit === undefined ? null : [{ targetUri: hit.uri, targetRange: hit.range, targetSelectionRange: hit.range }])
      return
    }
    case 'textDocument/references': {
      const w = wordAt(msg.params.textDocument.uri, msg.params.position.line, msg.params.position.character)
      reply(w === '' ? [] : occurrences(w))
      return
    }
    case 'textDocument/documentSymbol':
      reply(symbols(msg.params.textDocument.uri))
      return
    case 'workspace/symbol': {
      const out: unknown[] = []
      for (const uri of docs.keys()) for (const s of symbols(uri) as Array<{ name: string, kind: number, range: unknown }>) if (s.name.includes(msg.params.query)) out.push({ name: s.name, kind: s.kind, location: { uri, range: s.range } })
      reply(out)
      return
    }
    case 'shutdown':
      reply(null)
      return
    case 'exit':
      process.exit(0)
  }
  if (msg.id !== undefined && msg.method !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } })
}

let buf = Buffer.alloc(0)
for await (const chunk of Bun.stdin.stream()) {
  buf = Buffer.concat([buf, Buffer.from(chunk)])
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n')
    if (sep < 0) break
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString())?.[1])
    if (buf.length < sep + 4 + len) break
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString()) as Msg
    buf = buf.subarray(sep + 4 + len)
    handle(msg)
  }
}
record({ method: '(stdin closed)' })
