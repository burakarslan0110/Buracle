import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolSpec } from '../../src/core/catalog'
import { type LspServer, lspRoot, lspServerFor, lspServers, readToolsCatalog } from '../../src/engine/toolchain/lsp'
import { encodeMessage, fileUri, MessageReader } from '../../src/engine/toolchain/lsp-client'
import { symbolColumn, toCharacter, toColumn } from '../../src/engine/toolchain/lsp-format'
import { createLspBridge, LSP_TOOL_NAMES, type LspBridge } from '../../src/engine/toolchain/lsp-mcp'
import { scanMatcher, watchersOf, watcherWants, WorkspaceScan } from '../../src/engine/toolchain/lsp-watch'
import { withEnv, withSandbox } from '../helpers/sandbox'

const STUB = join(import.meta.dir, '..', 'fixtures', 'lsp', 'stub-lsp.ts')

function stubServer(markers: string[] = ['tsconfig.json']): LspServer {
  const tool: ToolSpec = { name: 'stub-ls', check: ['stub-ls'], version_regex: '(x)', required: false, lsp: { id: 'stub', extensions: { '.ts': 'typescript', '.py': 'python' }, root_markers: markers } }
  return lspServers({ tools: [tool] })[0] as LspServer
}

function bridge(root: string, mode = 'push', extra: Partial<Parameters<typeof createLspBridge>[0]> = {}): LspBridge {
  return createLspBridge({ cwd: root, servers: [stubServer()], launch: () => ({ argv: [process.execPath, STUB, mode], source: 'path' }), budgetMs: 15_000, initWaitMs: 8_000, ...extra })
}

function text(r: Record<string, unknown>): string {
  return ((r['content'] as Array<{ text: string }>)[0]?.text) ?? ''
}

function logged(file: string): Array<Record<string, any>> {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(l => l !== '').map(l => JSON.parse(l) as Record<string, any>) : []
}

async function eventually(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await Bun.sleep(25)
  }
}

describe('lsp mcp bridge: positions, roots and framing', () => {
  test('columns count characters from 1 and become UTF-16 offsets; a symbol is found as a whole word', () => {
    const line = 'const s = "\u{2000B}"; foo(foobar)'
    const col = symbolColumn(line, 'foo')
    expect(col).toBe(16)
    expect(toCharacter(line, col as number)).toBe(16)
    expect(toColumn(line, 16)).toBe(16)
    expect(toCharacter('\u{2000B}\u{2000B}x', 3)).toBe(4)
    expect(symbolColumn(line, 'foobar')).toBe(20)
    expect(symbolColumn(line, 'nope')).toBeUndefined()
    expect(symbolColumn('a.b(c)', 'b(')).toBe(3)
  })

  test('the root is the nearest folder with a marker of the server, in marker order, up to the git top level', () => withSandbox(async ({ root }) => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'pkg', 'src', 'deep'), { recursive: true })
    writeFileSync(join(repo, 'go.work'), '')
    writeFileSync(join(repo, 'pkg', 'go.mod'), '')
    const file = join(repo, 'pkg', 'src', 'deep', 'a.go')
    writeFileSync(file, '')
    expect(lspRoot(stubServer(['go.work', 'go.mod']), file)).toBe(repo)
    expect(lspRoot(stubServer(['go.mod']), file)).toBe(join(repo, 'pkg'))
    expect(lspRoot(stubServer(['Cargo.toml']), file)).toBe(repo)
    writeFileSync(join(root, 'tsconfig.json'), '{}')
    expect(lspRoot(stubServer(['tsconfig.json']), file)).toBe(repo)
    writeFileSync(join(repo, 'pkg', 'App.csproj'), '')
    expect(lspRoot(stubServer(['*.sln', '*.csproj']), file)).toBe(join(repo, 'pkg'))
    const loose = join(root, 'loose', 'x.py')
    mkdirSync(join(root, 'loose'))
    writeFileSync(loose, '')
    expect(lspRoot(stubServer(['pyproject.toml']), loose)).toBe(join(root, 'loose'))
  }))

  test('without a git repository the root stays inside the folder the harness started in, and never reaches the home folder', () => withSandbox(async ({ home }) => {
    writeFileSync(join(home, 'package.json'), '{}')
    const scratch = join(home, 'scratch', 'deep')
    mkdirSync(scratch, { recursive: true })
    const loose = join(scratch, 'x.ts')
    writeFileSync(loose, '')
    expect(lspRoot(stubServer(['package.json']), loose, { home })).toBe(scratch)
    expect(lspRoot(stubServer(['package.json']), loose, { home, cwd: home })).toBe(scratch)
    writeFileSync(join(home, 'scratch', 'package.json'), '{}')
    expect(lspRoot(stubServer(['package.json']), loose, { home })).toBe(join(home, 'scratch'))
    expect(lspRoot(stubServer(['package.json']), loose, { home, cwd: scratch })).toBe(scratch)
    mkdirSync(join(home, '.git'))
    expect(lspRoot(stubServer(['package.json']), loose, { home, cwd: join(home, 'scratch') })).toBe(join(home, 'scratch'))
    const repo = join(home, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'a.ts'), '')
    expect(lspRoot(stubServer(['package.json']), join(repo, 'src', 'a.ts'), { home, cwd: join(repo, 'src') })).toBe(repo)
  }))

  test('the workspace scan reports created, changed and deleted files of the server, skipping hidden, dependency and build folders', () => withSandbox(async ({ root }) => {
    const ws = join(root, 'ws')
    for (const d of ['src', 'node_modules/x', '.git', 'build', 'deep/er']) mkdirSync(join(ws, d), { recursive: true })
    for (const f of ['src/a.ts', 'src/b.ts', 'node_modules/x/i.ts', '.git/h.ts', 'build/o.ts', 'deep/er/c.ts', 'notes.md']) writeFileSync(join(ws, f), 'x\n')
    writeFileSync(join(ws, 'tsconfig.json'), '{}')
    writeFileSync(join(ws, 'App.csproj'), '')
    const wanted = scanMatcher({ extensions: { '.ts': 'typescript' }, root_markers: ['tsconfig.json', '*.csproj'] })
    const scan = new WorkspaceScan(ws, wanted)
    expect(scan.size).toBe(5)
    expect(scan.changes()).toEqual([])
    writeFileSync(join(ws, 'src', 'a.ts'), 'changed\n')
    writeFileSync(join(ws, 'src', 'n.ts'), 'new\n')
    writeFileSync(join(ws, 'node_modules', 'x', 'i.ts'), 'skipped\n')
    writeFileSync(join(ws, 'notes.md'), 'not watched\n')
    rmSync(join(ws, 'deep', 'er', 'c.ts'))
    expect(scan.changes()).toEqual([
      { path: join(ws, 'deep', 'er', 'c.ts'), type: 3 },
      { path: join(ws, 'src', 'a.ts'), type: 2 },
      { path: join(ws, 'src', 'n.ts'), type: 1 },
    ])
    expect(scan.changes()).toEqual([])
    const capped = new WorkspaceScan(ws, wanted, 3)
    expect(capped.partial).toBe(true)
    const known = capped.size
    expect(capped.changes().filter(c => c.type === 3)).toEqual([])
    expect(capped.size).toBe(known)
    const [ts, rel] = watchersOf({ watchers: [{ globPattern: '**/*.ts', kind: 2 }, { globPattern: { baseUri: { uri: fileUri(join(ws, 'src')), name: 'src' }, pattern: '*.ts' } }] })
    expect(watcherWants(ts!, { path: join(ws, 'src', 'a.ts'), type: 2 })).toBe(true)
    expect(watcherWants(ts!, { path: join(ws, 'src', 'a.ts'), type: 1 })).toBe(false)
    expect(watcherWants(rel!, { path: join(ws, 'src', 'n.ts'), type: 1 })).toBe(true)
    expect(watcherWants(rel!, { path: join(ws, 'deep', 'er', 'c.ts'), type: 3 })).toBe(false)
  }))

  test('canonical servers: every language server names its project markers; a file picks its server by extension', () => {
    const servers = lspServers(readToolsCatalog())
    expect(servers.map(s => [s.id, (s.spec.root_markers ?? []).length > 0])).toEqual(servers.map(s => [s.id, true]))
    expect(lspServerFor(servers, '/x/a.tsx')).toMatchObject({ server: { id: 'typescript' }, languageId: 'typescriptreact' })
    expect(lspServerFor(servers, '/x/A.PY')).toMatchObject({ server: { id: 'pyright' }, languageId: 'python' })
    expect(lspServerFor(servers, '/x/Main.java')?.server.id).toBe('jdtls')
    expect(lspServerFor(servers, '/x/notes.md')).toBeUndefined()
  })

  test('Content-Length framing survives split chunks and multi-byte bodies', () => {
    const bytes = new Uint8Array([...encodeMessage({ a: 'ü\u{2000B}' }), ...encodeMessage({ b: 2 })])
    const r = new MessageReader()
    const out: unknown[] = []
    for (let i = 0; i < bytes.length; i += 7) out.push(...r.push(bytes.subarray(i, i + 7)))
    expect(out).toEqual([{ a: 'ü\u{2000B}' }, { b: 2 }])
  })
})

describe('lsp mcp bridge: the MCP surface', () => {
  test('initialize names the server and its instructions; tools/list has the five read-only tools', () => withSandbox(async ({ root }) => {
    const b = bridge(root)
    const init = JSON.parse((await b.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '1' } } })))!)
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'buracle-lsp' }, capabilities: { tools: { listChanged: false } } })
    expect(init.result.instructions).toContain('diagnostics after you edit a file')
    expect(await b.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeUndefined()
    const list = JSON.parse((await b.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })))!)
    const tools = list.result.tools as Array<{ name: string, annotations: { readOnlyHint: boolean }, inputSchema: { required: string[] } }>
    expect(tools.map(t => t.name)).toEqual([...LSP_TOOL_NAMES])
    expect(tools.every(t => t.annotations.readOnlyHint && t.inputSchema.required.includes('file'))).toBe(true)
    const bad = JSON.parse((await b.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rename', arguments: {} } })))!)
    expect(bad.error.code).toBe(-32602)
    expect(b.running()).toEqual([])
    await b.close()
  }))

  test('a file without a server, a missing file and a server that is not installed are tool errors that say what to do', () => withSandbox(async ({ root }) => {
    writeFileSync(join(root, 'notes.md'), '# x\n')
    writeFileSync(join(root, 'a.ts'), 'x\n')
    const b = bridge(root)
    const md = await b.callTool('diagnostics', { file: 'notes.md' })
    expect(md['isError']).toBe(true)
    expect(text(md)).toContain('no Buracle language server handles .md files; covered: .py .ts (stub)')
    expect(text(await b.callTool('hover', { file: 'gone.ts', line: 1, symbol: 'x' }))).toContain('gone.ts does not exist or is not a file')
    const missing = createLspBridge({ cwd: root, servers: [stubServer()], launch: () => ({ error: 'stub: stub-ls is not installed (run `buracle install`)' }) })
    const r = await missing.callTool('diagnostics', { file: 'a.ts' })
    expect(r).toMatchObject({ isError: true })
    expect(text(r)).toContain('buracle install')
  }))
})

describe('lsp mcp bridge: a language server behind it (stub)', () => {
  test('diagnostics wait for the settled report, follow edits on disk and start the server once in the project root', () => withSandbox(async ({ root }) => {
    const log = join(root, 'stub.log')
    const proj = join(root, 'proj')
    mkdirSync(join(proj, 'src'), { recursive: true })
    writeFileSync(join(proj, 'tsconfig.json'), '{}')
    const file = join(proj, 'src', 'a.ts')
    writeFileSync(file, 'const a = 1\nlet b = 2 // ERROR: Type string is not assignable\n  WARN: unused\n')
    await withEnv({ STUB_LSP_LOG: log }, async () => {
      const b = bridge(root)
      try {
        const first = text(await b.callTool('diagnostics', { file: 'proj/src/a.ts' }))
        expect(first).toBe([
          'proj/src/a.ts (stub): 1 error, 1 warning',
          '  2:14  error E1  Type string is not assignable [stub]',
          '  3:3  warning  unused [stub]',
        ].join('\n'))
        writeFileSync(file, 'const a = 1\n')
        utimesSync(file, new Date(), new Date(Date.now() + 5000))
        expect(text(await b.callTool('diagnostics', { file }))).toBe('proj/src/a.ts (stub): no problems')
        const entries = logged(log)
        const init = entries.find(e => e['method'] === 'initialize')
        expect(init?.['params']['rootUri']).toBe(fileUri(proj))
        expect(init?.['cwd']).toBe(proj)
        expect(init?.['params']['capabilities']['textDocument']['publishDiagnostics']['versionSupport']).toBe(true)
        expect(entries.filter(e => e['method'] === 'initialize').length).toBe(1)
        expect(entries.find(e => e['method'] === 'textDocument/didChange')?.['params']['textDocument']['version']).toBe(2)
        expect(entries.find(e => e['method'] === 'textDocument/didSave')).toBeDefined()
        expect(entries.find(e => e['id'] === 1000 && e['method'] === undefined)?.['result']).toEqual([null, null])
        expect(b.running()).toMatchObject([{ id: 'stub', root: proj, state: 'ready' }])
      } finally {
        await b.close()
      }
      await eventually(() => logged(log).some(e => e['method'] === 'exit'))
      expect(logged(log).some(e => e['method'] === 'shutdown')).toBe(true)
    })
  }), 30_000)

  test('a server with pull diagnostics is asked for its report; several files come back in the order given, a missing one among them', () => withSandbox(async ({ root }) => {
    writeFileSync(join(root, 'a.ts'), 'ok\n')
    writeFileSync(join(root, 'b.py'), 'x = 1  # ERROR: undefined name\n')
    const b = bridge(root, 'pull')
    try {
      const out = text(await b.callTool('diagnostics', { file: 'b.py', files: ['a.ts', 'gone.ts', 'b.py'] }))
      expect(out).toBe('b.py (stub): 1 error\n  1:10  error E1  undefined name [stub]\n\na.ts (stub): no problems\n\ngone.ts does not exist or is not a file')
    } finally {
      await b.close()
    }
  }), 30_000)

  test('a file changed on disk that the bridge never opened reaches the server, and a file that uses it is reported afresh', () => withSandbox(async ({ root }) => {
    const log = join(root, 'stub.log')
    const proj = join(root, 'proj')
    mkdirSync(proj)
    writeFileSync(join(proj, 'tsconfig.json'), '{}')
    writeFileSync(join(proj, 'a.ts'), 'import b // USES: b.ts\n')
    writeFileSync(join(proj, 'b.ts'), 'export const ok = 1\n')
    writeFileSync(join(proj, 'c.py'), 'x = 1\n')
    await withEnv({ STUB_LSP_LOG: log }, async () => {
      const b = bridge(proj)
      try {
        expect(text(await b.callTool('diagnostics', { file: 'a.ts' }))).toBe('a.ts (stub): no problems')
        writeFileSync(join(proj, 'b.ts'), 'BROKEN\n')
        utimesSync(join(proj, 'b.ts'), new Date(), new Date(Date.now() + 5000))
        writeFileSync(join(proj, 'c.py'), 'x = 2\n')
        utimesSync(join(proj, 'c.py'), new Date(), new Date(Date.now() + 5000))
        writeFileSync(join(proj, 'd.ts'), 'new\n')
        expect(text(await b.callTool('diagnostics', { file: 'a.ts' }))).toBe('a.ts (stub): 1 error\n  1:13  error E2  b.ts is broken [stub]')
        const entries = logged(log)
        expect(entries.find(e => e['method'] === 'initialize')?.['params']['capabilities']['workspace']['didChangeWatchedFiles']).toEqual({ dynamicRegistration: true, relativePatternSupport: true })
        const watched = entries.filter(e => e['method'] === 'workspace/didChangeWatchedFiles').flatMap(e => e['params']['changes'] as unknown[])
        expect(watched).toEqual([{ uri: fileUri(join(proj, 'b.ts')), type: 2 }, { uri: fileUri(join(proj, 'd.ts')), type: 1 }])
        expect(entries.filter(e => e['method'] === 'textDocument/didChange').map(e => e['params']['textDocument']['version'])).toEqual([2])
        expect(text(await b.callTool('hover', { file: 'b.ts', line: 1, symbol: 'BROKEN' }))).toContain('Docs for BROKEN.')
        writeFileSync(join(proj, 'b.ts'), 'export const ok = 2\n')
        utimesSync(join(proj, 'b.ts'), new Date(), new Date(Date.now() + 10_000))
        expect(text(await b.callTool('diagnostics', { file: 'a.ts' }))).toBe('a.ts (stub): no problems')
        rmSync(join(proj, 'b.ts'))
        expect(text(await b.callTool('diagnostics', { file: 'a.ts' }))).toBe('a.ts (stub): no problems')
        const later = logged(log)
        expect(later.filter(e => e['method'] === 'textDocument/didClose').map(e => e['params']['textDocument']['uri'])).toEqual([fileUri(join(proj, 'b.ts'))])
        expect(later.filter(e => e['method'] === 'workspace/didChangeWatchedFiles').flatMap(e => e['params']['changes'] as unknown[]).at(-1)).toEqual({ uri: fileUri(join(proj, 'b.ts')), type: 3 })
      } finally {
        await b.close()
      }
    })
  }), 30_000)

  test('when the server sends no new report after other files changed, the last one comes back marked as possibly older', () => withSandbox(async ({ root }) => {
    writeFileSync(join(root, 'a.ts'), 'x // ERROR: still wrong\n')
    writeFileSync(join(root, 'b.ts'), 'ok\n')
    const b = bridge(root, 'quiet')
    try {
      expect(text(await b.callTool('diagnostics', { file: 'a.ts' }))).toBe('a.ts (stub): 1 error\n  1:6  error E1  still wrong [stub]')
      writeFileSync(join(root, 'b.ts'), 'changed\n')
      utimesSync(join(root, 'b.ts'), new Date(), new Date(Date.now() + 5000))
      const started = Date.now()
      expect(text(await b.callTool('diagnostics', { file: 'a.ts', wait_ms: 1000 }))).toBe('a.ts (stub): 1 error (no new report after other files changed, so this one may be older than those edits)\n  1:6  error E1  still wrong [stub]')
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      await b.close()
    }
  }), 30_000)

  test('hover, definition, references and symbols answer at a line and symbol, in characters past a character outside the BMP', () => withSandbox(async ({ root }) => {
    writeFileSync(join(root, 'lib.ts'), 'function foo() {\n  method run\n}\nfunction bar() {}\n')
    writeFileSync(join(root, 'main.ts'), 'const s = "\u{2000B}"; foo(1)\nfoo(2)\n')
    const b = bridge(root)
    try {
      await b.callTool('symbols', { file: 'lib.ts' })
      const hover = text(await b.callTool('hover', { file: 'main.ts', line: 1, symbol: 'foo' }))
      expect(hover).toBe('main.ts:1:16 (`foo`)\n```ts\nfunction foo(): number\n```\nDocs for foo.')
      expect(text(await b.callTool('hover', { file: 'main.ts', line: 1, column: 18 }))).toContain('function foo(): number')
      const def = text(await b.callTool('definition', { file: 'main.ts', line: 2, symbol: 'foo' }))
      expect(def).toBe('1 location (definition) for main.ts:2:1 (`foo`):\nlib.ts:1:10  function foo() {')
      const refs = text(await b.callTool('references', { file: 'main.ts', line: 2, symbol: 'foo', limit: 2 }))
      expect(refs).toBe('3 references to main.ts:2:1 (`foo`) (the first 2; raise limit for more):\nlib.ts:1:10  function foo() {\nmain.ts:1:16  const s = "\u{2000B}"; foo(1)')
      expect(text(await b.callTool('symbols', { file: 'lib.ts' }))).toBe('lib.ts: 3 symbols\nfunction foo  1-2\n  method run  2-3\nfunction bar  4-5')
      expect(text(await b.callTool('symbols', { file: 'main.ts', query: 'ba' }))).toBe(`1 symbol matching "ba" in ${root} (stub):\nfunction bar  lib.ts:4`)
      const off = await b.callTool('definition', { file: 'main.ts', line: 2, symbol: 'nothere' })
      expect(off['isError']).toBe(true)
      expect(text(off)).toContain("'nothere' is not on line 2 of main.ts: foo(2)")
      expect(text(await b.callTool('hover', { file: 'main.ts', line: 9, symbol: 'foo' }))).toContain('line 9 is past the end of main.ts (3 lines)')
      expect(text(await b.callTool('hover', { file: 'main.ts', line: 1 }))).toContain('give symbol')
      expect(text(await b.callTool('definition', { file: 'main.ts', line: 1, symbol: 'foo', kind: 'declaration' }))).toContain('does not offer declarations')
    } finally {
      await b.close()
    }
  }), 30_000)

  test('an error the server shows the user comes with its diagnostics', () => withSandbox(async ({ root }) => {
    writeFileSync(join(root, 'a.ts'), 'ok\n')
    const b = bridge(root, 'warn')
    try {
      expect(text(await b.callTool('diagnostics', { file: 'a.ts' }))).toBe('a.ts (stub): no problems\n  the server says: Failed to load the workspace: cargo not found')
    } finally {
      await b.close()
    }
  }), 30_000)

  test('a slow start answers "still starting" without an error, and the next call gets the answer', () => withSandbox(async ({ root }) => {
    writeFileSync(join(root, 'a.ts'), 'function foo() {}\n')
    const b = bridge(root, 'slow', { initWaitMs: 200 })
    try {
      const first = await b.callTool('hover', { file: 'a.ts', line: 1, symbol: 'foo' })
      expect(first['isError']).toBeUndefined()
      expect(text(first)).toMatch(/^The stub language server is still starting for .+ Call this tool again in a few seconds\.$/)
      await Bun.sleep(1800)
      expect(text(await b.callTool('hover', { file: 'a.ts', line: 1, symbol: 'foo' }))).toContain('Docs for foo.')
    } finally {
      await b.close()
    }
  }), 30_000)

  test('a server that crashes is reported with its stderr and restarted at most a few times; idle servers are stopped', () => withSandbox(async ({ root }) => {
    writeFileSync(join(root, 'a.ts'), 'x\n')
    const crash = bridge(root, 'crash')
    const messages: string[] = []
    for (let i = 0; i < 5; i++) messages.push(text(await crash.callTool('diagnostics', { file: 'a.ts' })))
    expect(messages[0]).toContain('stub-lsp: cannot find its runtime')
    expect(messages[4]).toContain('stopped 4 times in 10 minutes')
    await crash.close()
    const idle = bridge(root, 'push', { idleMs: 0 })
    await idle.callTool('symbols', { file: 'a.ts' })
    expect(idle.running().length).toBe(1)
    expect(await idle.sweep()).toBe(1)
    expect(idle.running()).toEqual([])
  }), 30_000)

  test('at the server limit, two calls at once for a new project start one server there', () => withSandbox(async ({ root }) => {
    const log = join(root, 'stub.log')
    for (const p of ['one', 'two']) {
      mkdirSync(join(root, p))
      writeFileSync(join(root, p, 'tsconfig.json'), '{}')
      writeFileSync(join(root, p, 'a.ts'), 'function foo() {}\n')
    }
    await withEnv({ STUB_LSP_LOG: log }, async () => {
      const b = bridge(root, 'push', { maxClients: 1 })
      try {
        await b.callTool('symbols', { file: 'one/a.ts' })
        const both = await Promise.all([b.callTool('symbols', { file: 'two/a.ts' }), b.callTool('hover', { file: 'two/a.ts', line: 1, symbol: 'foo' })])
        expect(both.map(r => r['isError'])).toEqual([undefined, undefined])
        expect(b.running()).toMatchObject([{ root: join(root, 'two'), state: 'ready' }])
        expect(logged(log).filter(e => e['method'] === 'initialize' && e['params']['rootUri'] === fileUri(join(root, 'two'))).length).toBe(1)
      } finally {
        await b.close()
      }
    })
  }), 30_000)
})
