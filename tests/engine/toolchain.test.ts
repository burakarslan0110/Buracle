import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerSpec, ToolSpec } from '../../src/core/catalog'
import * as paths from '../../src/engine/paths'
import { serverRequest } from '../../src/engine/toolchain/index'
import { fallbackNpmCache, launchPlan, serverEnvFor } from '../../src/engine/toolchain/launch'
import { toolchainLinks } from '../../src/engine/toolchain/links'
import { claudeLspJson, lspLaunch, lspServers, probeLsp, readToolsCatalog, shortVersion } from '../../src/engine/toolchain/lsp'
import { binArgv, installNpm, isNodeScript, npmBins, npmInstalledVersion, npmPrefix, npmStagingPrefix, pypiSpec, safeName, toolchainEnv, toolRequest, UV_PYTHON } from '../../src/engine/toolchain/packages'
import { opsDeps } from '../../src/engine/update/deps'
import { emptyToolchainState, packageKey, readToolchainState, updateToolchainState, writeToolchainState } from '../../src/engine/toolchain/state'
import { installAdvice, installSources, installTool, toolApplies, toolchainBinDirs } from '../../src/engine/toolchain/system'
import { exePath, fakeExe, IS_WINDOWS, onlyPath, pathOf, unwrapCmd } from '../helpers/fake-exe'
import { withEnv, withSandbox } from '../helpers/sandbox'

function exe(path: string, text: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
  return path
}

describe('state', () => {
  test('round trip, a damaged file reads as an empty toolchain, updates are atomic rewrites', () => withSandbox(async () => {
    expect(readToolchainState()).toEqual(emptyToolchainState())
    const s = emptyToolchainState()
    s.packages[packageKey('npm', '@upstash/context7-mcp')] = { registry: 'npm', name: '@upstash/context7-mcp', version: '4.3.0', dir: '/x', bins: { 'context7-mcp': '/x/cli.js' }, installed_at: 't' }
    writeToolchainState(s, '2026-10-08T00:00:00.000Z')
    expect(readToolchainState().packages['npm:@upstash/context7-mcp']?.version).toBe('4.3.0')
    const after = updateToolchainState(st => { st.system['tmux'] = { via: 'brew', version: '3.7c', installed_at: 't' } }, '2026-10-08T01:00:00.000Z')
    expect(after.system['tmux']?.via).toBe('brew')
    expect(readToolchainState().updated_at).toBe('2026-10-08T01:00:00.000Z')
    writeFileSync(paths.toolchainStateFile(), '{ broken')
    expect(readToolchainState()).toEqual(emptyToolchainState())
  }))
})

describe('packages', () => {
  test('names, specs and requests', () => {
    expect(safeName('@colbymchenry/codegraph')).toBe('colbymchenry__codegraph')
    expect(pypiSpec('semble', ['mcp'], 'latest')).toBe('semble[mcp]')
    expect(pypiSpec('semble', ['mcp'], '0.6.2')).toBe('semble[mcp]==0.6.2')
    const ts: ToolSpec = { name: 'typescript-language-server', check: ['x'], version_regex: '(x)', required: true, npm: 'typescript-language-server', npm_with: ['typescript@6'] }
    expect(toolRequest(ts)).toEqual({ registry: 'npm', name: 'typescript-language-server', version: 'latest', bins: ['typescript-language-server'], with: ['typescript@6'] })
    const pinned: ToolSpec = { name: 'codegraph', check: ['x'], version_regex: '(x)', required: true, npm: '@colbymchenry/codegraph@1.6.2' }
    expect(toolRequest(pinned)).toMatchObject({ name: '@colbymchenry/codegraph', version: '1.6.2' })
    const py: ToolSpec = { name: 'semble', check: ['x'], version_regex: '(x)', required: true, pypi: 'semble[mcp]' }
    expect(toolRequest(py)).toEqual({ registry: 'pypi', name: 'semble', version: 'latest', bins: ['semble'], extras: ['mcp'] })
    expect(UV_PYTHON).toBe('3.12')
  })

  test('npm bins resolve inside the prefix; a node script runs through node, a native binary itself', () => withSandbox(async ({ root }) => {
    const prefix = join(root, 'prefix')
    const dir = join(prefix, 'node_modules', '@acme', 'tool')
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/tool', version: '2.1.0', bin: { tool: 'bin/tool.js', 'tool-lsp': 'bin/lsp' } }))
    writeFileSync(join(dir, 'bin', 'tool.js'), 'console.log(1)\n')
    exe(join(dir, 'bin', 'lsp'), '#!/usr/bin/env node\nconsole.log(1)\n')
    const native = exe(join(root, 'native'), '#!/bin/sh\necho hi\n')
    expect(npmBins(prefix, '@acme/tool')).toEqual({ tool: join(dir, 'bin', 'tool.js'), 'tool-lsp': join(dir, 'bin', 'lsp') })
    expect(npmInstalledVersion(prefix, '@acme/tool')).toBe('2.1.0')
    expect(npmInstalledVersion(prefix, '@acme/none')).toBeUndefined()
    expect(isNodeScript(join(dir, 'bin', 'lsp'))).toBe(true)
    expect(binArgv(join(dir, 'bin', 'tool.js'), '/n/node')).toEqual(['/n/node', join(dir, 'bin', 'tool.js')])
    expect(binArgv(native, '/n/node')).toEqual([native])
    expect(binArgv(join(root, 'gone'), '/n/node')).toBeUndefined()
  }))
})

describe('launch (buracle mcp run)', () => {
  const npmSpec: McpServerSpec = { description: 'd', transport: 'stdio', package: { registry: 'npm', name: '@upstash/context7-mcp', version: 'latest', bin: 'context7-mcp' }, args: ['--x'], harnesses: ['claude'], pin: 'latest', critical: true, routing: [], env: { MODE: 'stdio', TOKEN: '${ENV:CTX_TOKEN}' } } as McpServerSpec
  const pySpec: McpServerSpec = { description: 'd', transport: 'stdio', package: { registry: 'pypi', name: 'semble', version: 'latest', bin: 'semble', extras: ['mcp'] }, harnesses: ['claude'], pin: 'latest', critical: true, routing: [] } as McpServerSpec

  test('from the toolchain: node with the installed entry, the server env, the version', () => withSandbox(async ({ root }) => {
    const entry = join(root, 'cli.js')
    writeFileSync(entry, 'console.log(1)\n')
    const s = emptyToolchainState()
    s.packages['npm:@upstash/context7-mcp'] = { registry: 'npm', name: '@upstash/context7-mcp', version: '4.3.0', dir: root, bins: { 'context7-mcp': entry }, installed_at: 't' }
    expect(launchPlan('context7', npmSpec, s, { node: '/n/node' })).toEqual({ argv: ['/n/node', entry, '--x'], env: { MODE: 'stdio' }, source: 'toolchain', version: '4.3.0' })
    expect(serverEnvFor(npmSpec, { CTX_TOKEN: 'abc' })).toEqual({ MODE: 'stdio', TOKEN: 'abc' })
  }))

  test('not installed yet: npx with Buracle\'s own cache, uvx on Python 3.12; a missing runner is an error', () => withSandbox(async () => {
    const s = emptyToolchainState()
    const npx = launchPlan('context7', npmSpec, s, { npx: '/n/npx' })
    expect(npx).toMatchObject({ argv: ['/n/npx', '--yes', '--package=@upstash/context7-mcp@latest', 'context7-mcp', '--x'], source: 'fallback' })
    expect('env' in npx ? npx.env['npm_config_cache'] : undefined).toBe(fallbackNpmCache())
    expect('env' in npx ? npx.env['npm_config_ignore_scripts'] : 'x').toBeUndefined()
    const uvx = launchPlan('semble', pySpec, s, { uvx: '/u/uvx' })
    expect(uvx).toMatchObject({ argv: ['/u/uvx', '--python', '3.12', '--from', 'semble[mcp]', 'semble'], source: 'fallback' })
    expect(launchPlan('x', { ...npmSpec, transport: 'http', url: 'https://x' } as McpServerSpec, s)).toEqual({ error: 'x is not a package server' })
  }))
})

describe('installing a package server', () => {
  test('npm installs into the staging prefix with its lifecycle scripts; the version is then read from the prefix', () => withSandbox(async ({ root }) => {
    const spec: McpServerSpec = { description: 'd', transport: 'stdio', package: { registry: 'npm', name: 'open-websearch', version: 'latest', bin: 'open-websearch' }, harnesses: ['claude'], pin: 'latest', critical: true, routing: [] }
    expect(serverRequest(spec)).toEqual({ registry: 'npm', name: 'open-websearch', version: 'latest', bins: ['open-websearch'] })
    const bin = join(root, 'bin')
    fakeExe(join(bin, 'npm'), 'process.exit(1)')
    const calls: string[][] = []
    const savedRun = opsDeps.run
    const savedPath = process.env['PATH']
    process.env['PATH'] = pathOf(bin, savedPath ?? '')
    opsDeps.run = async (argv, opts) => {
      calls.push(unwrapCmd(argv))
      const dir = join(opts?.cwd ?? '', 'node_modules', 'open-websearch')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'open-websearch', version: '9.9.9', bin: { 'open-websearch': './cli.js' } }))
      writeFileSync(join(dir, 'cli.js'), 'console.log(1)\n')
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    try {
      const r = await installNpm(serverRequest(spec), '9.9.9', 't')
      expect(r.ok).toBe(true)
    } finally {
      opsDeps.run = savedRun
      if (savedPath === undefined) delete process.env['PATH']
      else process.env['PATH'] = savedPath
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.slice(1, 4)).toEqual(['install', '--prefix', npmStagingPrefix('open-websearch')])
    expect(calls[0]).not.toContain('--ignore-scripts')
    expect(npmInstalledVersion(npmPrefix('open-websearch'), 'open-websearch')).toBe('9.9.9')
  }))
})

describe('install sources', () => {
  const t: ToolSpec = { name: 'rg', check: ['rg', '--version'], version_regex: 'ripgrep (\\d+)', required: true, brew: 'ripgrep', winget: 'BurntSushi.ripgrep.MSVC', scoop: 'ripgrep' }
  test('macOS uses Homebrew; Windows winget, then scoop; the pinned download last; advice when none is there', () => {
    expect(installSources(t, 'darwin', () => true, 'arm64').map(s => s.kind)).toEqual(['brew', 'download'])
    expect(installSources(t, 'darwin', () => true, 'arm64')[0]?.label).toBe('brew install ripgrep')
    expect(installSources(t, 'win32', () => true, 'x64').map(s => s.kind)).toEqual(['winget', 'scoop', 'download'])
    expect(installSources(t, 'win32', c => c === 'scoop', 'x64').map(s => s.kind)).toEqual(['scoop', 'download'])
    expect(installSources(t, 'darwin', () => false, 'arm64').map(s => s.kind)).toEqual(['download'])
    expect(installSources(t, 'win32', () => false, 'arm64')).toEqual([])
    expect(installAdvice(t, 'win32')).toBe('winget install --id BurntSushi.ripgrep.MSVC -e --scope user')
    expect(installAdvice(t, 'darwin')).toBe('brew install ripgrep')
    expect(toolApplies({ ...t, platforms: ['win32'] }, 'darwin')).toBe(false)
    expect(toolApplies(t, 'darwin')).toBe(true)
  })

  test('a tool that needs another command (requires) is installed only where that command is', () => {
    const lint: ToolSpec = { name: 'golangci-lint', check: ['golangci-lint', '--version'], version_regex: 'version v?(\\d+\\.\\d+\\.\\d+)', required: false, brew: 'golangci-lint', winget: 'GolangCI.golangci-lint', go: 'github.com/golangci/golangci-lint/v2/cmd/golangci-lint', requires: ['go'] }
    expect(installSources(lint, 'darwin', c => c !== 'go')).toEqual([])
    expect(installSources(lint, 'win32', c => c !== 'go')).toEqual([])
    expect(installSources(lint, 'darwin', () => true).map(s => s.kind)).toEqual(['brew', 'go'])
    expect(installAdvice(lint, 'darwin', c => c !== 'go')).toBe('golangci-lint needs go on PATH; install it first, then run `buracle install`')
    expect(installAdvice(lint, 'darwin', () => true)).toBe('brew install golangci-lint')
  })

  test('a .NET tool installs with `dotnet tool install` into the toolchain, only where dotnet is', () => withSandbox(async () => {
    const cs: ToolSpec = { name: 'csharp-ls', check: ['csharp-ls', '--version'], version_regex: '(\\d+\\.\\d+\\.\\d+)', required: false, dotnet: 'csharp-ls', install: 'Install the .NET SDK' }
    expect(installSources(cs, 'darwin', () => true).map(s => s.label)).toEqual(['dotnet tool install csharp-ls (Buracle toolchain)'])
    expect(installSources(cs, 'win32', () => true).map(s => s.kind)).toEqual(['dotnet'])
    expect(installSources(cs, 'darwin', c => c !== 'dotnet')).toEqual([])
    expect(installAdvice(cs, 'darwin')).toBe('Install the .NET SDK')
    const toolPath = join(paths.toolchainDir(), 'dotnet', 'tools')
    expect(toolchainBinDirs()).toContain(toolPath)
    const calls: string[][] = []
    const savedRun = opsDeps.run
    opsDeps.run = async spawned => {
      const argv = unwrapCmd(spawned)
      calls.push(argv)
      if (argv.includes('tool')) fakeExe(join(toolPath, 'csharp-ls'), "console.log('0.21.0')")
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const bin = join(paths.toolchainDir(), 'fake-bin')
    const dotnet = fakeExe(join(bin, 'dotnet'), '')
    try {
      await withEnv({ PATH: onlyPath(bin) }, async () => {
        const r = await installTool(cs, Date.parse('2026-10-12T00:00:00Z'))
        expect(r).toMatchObject({ ok: true, source: { kind: 'dotnet' }, record: { via: 'dotnet', path: exePath(join(toolPath, 'csharp-ls')) } })
      })
    } finally {
      opsDeps.run = savedRun
    }
    expect(calls).toEqual([[dotnet, 'tool', 'install', '--tool-path', toolPath, 'csharp-ls']])
  }))

  test('a rustup component installs with `rustup component add` before any package manager, only where rustup is', () => withSandbox(async () => {
    const ra: ToolSpec = { name: 'rust-analyzer', check: ['rust-analyzer', '--version'], version_regex: '(\\d+)', required: false, rustup: 'rust-analyzer', brew: 'rust-analyzer', scoop: 'rust-analyzer' }
    expect(installSources(ra, 'darwin', () => true).map(s => s.kind)).toEqual(['rustup', 'brew'])
    expect(installSources(ra, 'win32', c => c === 'rustup').map(s => s.label)).toEqual(['rustup component add rust-analyzer'])
    expect(installSources(ra, 'win32', () => false)).toEqual([])
    expect(installAdvice(ra, 'win32', c => c === 'rustup')).toBe('rustup component add rust-analyzer')
    expect(installAdvice(ra, 'win32', () => false)).toBe('scoop install rust-analyzer')
    const calls: string[][] = []
    const savedRun = opsDeps.run
    opsDeps.run = async spawned => { calls.push(unwrapCmd(spawned)); return { code: 0, stdout: '', stderr: '', timedOut: false } }
    const bin = join(paths.toolchainDir(), 'fake-bin')
    const rustup = fakeExe(join(bin, 'rustup'), '')
    try {
      await withEnv({ PATH: onlyPath(bin) }, async () => {
        const r = await installTool(ra, Date.parse('2026-10-12T00:00:00Z'))
        expect(r).toMatchObject({ ok: true, source: { kind: 'rustup' }, record: { via: 'rustup' } })
      })
    } finally {
      opsDeps.run = savedRun
    }
    expect(calls).toEqual([[rustup, 'component', 'add', 'rust-analyzer']])
  }))

  test('winget installs for the user only (--scope user), so no install needs administrator rights', () => withSandbox(async () => {
    const calls: string[][] = []
    const savedRun = opsDeps.run
    opsDeps.run = async spawned => { calls.push(unwrapCmd(spawned)); return { code: 0, stdout: '', stderr: '', timedOut: false } }
    const bin = join(paths.toolchainDir(), 'fake-bin')
    const winget = fakeExe(join(bin, 'winget'), '')
    try {
      await withEnv({ PATH: onlyPath(bin), BURACLE_PLATFORM: 'win32' }, async () => {
        const r = await installTool({ ...t, scoop: undefined }, Date.parse('2026-10-12T00:00:00Z'))
        expect(r).toMatchObject({ ok: true, source: { kind: 'winget' }, record: { via: 'winget' } })
      })
    } finally {
      opsDeps.run = savedRun
    }
    expect(calls).toEqual([[winget, 'install', '--id', 'BurntSushi.ripgrep.MSVC', '--exact', '--scope', 'user', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']])
  }))

  test('ast-grep never comes from winget, whose package installs only sg, so Windows gets the ast-grep command from scoop or the toolchain', () => {
    const astGrep = readToolsCatalog(join(import.meta.dir, '..', '..', 'canonical', 'tools.yaml')).tools.find(t => t.name === 'ast-grep') as ToolSpec
    expect(installSources(astGrep, 'win32', () => true).map(s => s.kind)).toEqual(['scoop', 'npm'])
    expect(installSources(astGrep, 'win32', c => c !== 'scoop').map(s => s.kind)).toEqual(['npm'])
  })
})

const FAKE_LSP = `
const mode = process.argv[2] ?? 'ok'
if (mode === 'crash') { console.error('cannot find tsserver'); process.exit(1) }
let buf = Buffer.alloc(0)
for await (const chunk of Bun.stdin.stream()) {
  buf = Buffer.concat([buf, Buffer.from(chunk)])
  for (;;) {
    const sep = buf.indexOf('\\r\\n\\r\\n')
    if (sep < 0) break
    const len = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, sep).toString())?.[1])
    if (buf.length < sep + 4 + len) break
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString())
    buf = buf.subarray(sep + 4 + len)
    if (mode === 'silent') continue
    const reply = (o) => { const b = JSON.stringify(o); process.stdout.write('Content-Length: ' + Buffer.byteLength(b) + '\\r\\n\\r\\n' + b) }
    if (msg.method === 'initialize') reply({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true }, serverInfo: { name: 'fake-lsp', version: '1.2.3' } } })
    if (msg.method === 'shutdown') reply({ jsonrpc: '2.0', id: msg.id, result: null })
    if (msg.method === 'exit') process.exit(0)
  }
}
`

describe('language servers', () => {
  test.skipIf(process.platform === 'win32')('PATH links: an npm bin, and what `go install` and `dotnet tool install` put into the toolchain folders (omp and the shell find them on PATH)', () => withSandbox(async ({ root }) => {
    const s = emptyToolchainState()
    const npmDir = join(paths.toolchainDir(), 'npm', 'pyright')
    const npmBin = exe(join(npmDir, 'node_modules', '.bin', 'pyright-langserver'), '#!/bin/sh\n')
    s.packages['npm:pyright'] = { registry: 'npm', name: 'pyright', version: '1.1.400', dir: npmDir, bins: { 'pyright-langserver': npmBin }, links: ['pyright-langserver'], installed_at: 't' }
    const gopls = exe(join(paths.toolchainDir(), 'go', 'bin', 'gopls'), '#!/bin/sh\n')
    const csharp = exe(join(paths.toolchainDir(), 'dotnet', 'tools', 'csharp-ls'), '#!/bin/sh\n')
    s.system['gopls'] = { via: 'go', path: gopls, installed_at: 't' }
    s.system['csharp-ls'] = { via: 'dotnet', path: csharp, installed_at: 't' }
    s.system['rg'] = { via: 'brew', path: exe(join(root, 'brew', 'rg'), '#!/bin/sh\n'), installed_at: 't' }
    s.system['outside'] = { via: 'go', path: exe(join(root, 'go', 'bin', 'outside'), '#!/bin/sh\n'), installed_at: 't' }
    s.system['gone'] = { via: 'go', path: join(paths.toolchainDir(), 'go', 'bin', 'gone'), installed_at: 't' }
    const bin = paths.localBinDir()
    expect(toolchainLinks(s)).toEqual([
      { bin: 'csharp-ls', path: join(bin, 'csharp-ls'), target: csharp },
      { bin: 'gopls', path: join(bin, 'gopls'), target: gopls },
      { bin: 'pyright-langserver', path: join(bin, 'pyright-langserver'), target: npmBin },
    ])
  }))

  test('toolchain first for prefer: toolchain, PATH otherwise; the error names the install command', () => withSandbox(async ({ root }) => {
    const ts: ToolSpec = { name: 'typescript-language-server', check: ['x'], version_regex: '(x)', required: true, npm: 'typescript-language-server', prefer: 'toolchain', lsp: { id: 'typescript', args: ['--stdio'], extensions: { '.ts': 'typescript', '.js': 'javascript' } } } as ToolSpec
    const [server] = lspServers({ tools: [ts] })
    expect(server?.id).toBe('typescript')
    const s = emptyToolchainState()
    const ghost: ToolSpec = { ...ts, name: 'buracle-ghost-ls', lsp: { id: 'ghost', extensions: { '.gh': 'ghost' } } } as ToolSpec
    const missing = lspLaunch(lspServers({ tools: [ghost] })[0]!, s)
    expect('error' in missing ? missing.error : '').toContain('buracle install')
    const entry = join(root, 'lsp.js')
    writeFileSync(entry, 'console.log(1)\n')
    s.packages['npm:typescript-language-server'] = { registry: 'npm', name: 'typescript-language-server', version: '6.0.1', dir: root, bins: { 'typescript-language-server': entry }, installed_at: 't' }
    expect(lspLaunch(server!, s, { node: '/n/node' })).toEqual({ argv: ['/n/node', entry, '--stdio'], source: 'toolchain', version: '6.0.1' })
    expect(claudeLspJson([server!], { command: 'bun', args: ['${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts'] })).toEqual({
      typescript: { command: 'bun', args: ['${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts', 'lsp', 'run', 'typescript'], extensionToLanguage: { '.js': 'javascript', '.ts': 'typescript' }, restartOnCrash: true, maxRestarts: 3 },
    })
  }))

  test('a server from `dotnet tool install` starts from the toolchain folder; a startup timeout reaches .lsp.json', () => withSandbox(async () => {
    const cs: ToolSpec = { name: 'csharp-ls', check: ['csharp-ls', '--version'], version_regex: '(x)', required: false, dotnet: 'csharp-ls', lsp: { id: 'csharp-ls', extensions: { '.cs': 'csharp' } } }
    const [server] = lspServers({ tools: [cs] })
    const entry = fakeExe(join(paths.toolchainDir(), 'dotnet', 'tools', 'csharp-ls'), '')
    await withEnv({ PATH: '' }, () => {
      expect(lspLaunch(server!, emptyToolchainState())).toEqual({ argv: [entry], source: 'dotnet' })
    })
    const java: ToolSpec = { name: 'jdtls', check: ['jdtls', '--help'], version_regex: '(x)', required: false, lsp: { id: 'jdtls', extensions: { '.java': 'java' }, startup_timeout_ms: 120000 } }
    expect(claudeLspJson(lspServers({ tools: [java] }), { command: 'bun', args: ['b.ts'] })).toEqual({
      jdtls: { command: 'bun', args: ['b.ts', 'lsp', 'run', 'jdtls'], extensionToLanguage: { '.java': 'java' }, restartOnCrash: true, maxRestarts: 3, startupTimeout: 120000 },
    })
  }))

  test('the LSP handshake: an answer is ok with its name and version; a crash and silence are down', () => withSandbox(async ({ root }) => {
    const script = join(root, 'fake-lsp.ts')
    writeFileSync(script, FAKE_LSP)
    const ok = await probeLsp([process.execPath, script, 'ok'], { rootDir: root, timeoutMs: 10_000 })
    expect(ok).toMatchObject({ status: 'ok', serverName: 'fake-lsp', version: '1.2.3' })
    const crash = await probeLsp([process.execPath, script, 'crash'], { rootDir: root, timeoutMs: 10_000 })
    expect(crash.status).toBe('down')
    expect(crash.error).toContain('cannot find tsserver')
    const silent = await probeLsp([process.execPath, script, 'silent'], { rootDir: root, timeoutMs: 800 })
    expect(silent).toMatchObject({ status: 'down', error: 'no answer to initialize within 800 ms' })
    expect(shortVersion('{"Version":"v0.23.0","Deps":[]}')).toBe('v0.23.0')
  }), 30_000)
})

describe('the tools Buracle downloaded', () => {
  test('toolchainEnv puts their folders first on PATH, only the ones that exist', () => withSandbox(async () => {
    const [nodeBin, uvDir] = paths.systemToolBinDirs() as [string, string]
    mkdirSync(nodeBin, { recursive: true })
    const parts = (toolchainEnv().PATH as string).split(IS_WINDOWS ? ';' : ':')
    expect(parts[0]).toBe(nodeBin)
    expect(parts).not.toContain(uvDir)
  }))

  test('the MCP launcher and the LSP launcher run node scripts with the downloaded node when PATH has none', () => withSandbox(async ({ root }) => {
    const node = fakeExe(join(paths.systemToolBinDirs()[0] as string, 'node'), 'console.log("v26.13.0")')
    const entry = join(root, 'server.js')
    writeFileSync(entry, 'console.log(1)\n')
    const state = emptyToolchainState()
    state.packages['npm:open-websearch'] = { registry: 'npm', name: 'open-websearch', version: '1.0.0', dir: root, bins: { 'open-websearch': entry }, installed_at: 't' }
    const empty = join(root, 'empty-bin')
    mkdirSync(empty, { recursive: true })
    await withEnv({ PATH: onlyPath(empty), HOME: root }, async () => {
      const plan = launchPlan('web-search', { description: 'd', transport: 'stdio', package: { registry: 'npm', name: 'open-websearch', version: 'latest', bin: 'open-websearch' }, harnesses: ['claude'], pin: 'latest', critical: true } as McpServerSpec, state)
      expect(plan).toMatchObject({ source: 'toolchain', argv: [node, entry] })
      expect(binArgv(entry)).toEqual([node, entry])
    })
  }))

  test('npm in the downloaded node folder is used when PATH has none', () => withSandbox(async ({ root }) => {
    fakeExe(join(paths.systemToolBinDirs()[0] as string, 'npm'), 'process.exit(3)')
    const empty = join(root, 'empty-bin')
    mkdirSync(empty, { recursive: true })
    await withEnv({ PATH: onlyPath(empty), HOME: root }, async () => {
      const r = await installNpm({ registry: 'npm', name: 'open-websearch', version: '1.0.0' }, '1.0.0', 't')
      expect(r.ok).toBe(false)
      expect(r.ok ? '' : r.error).toContain('npm install open-websearch@1.0.0 failed (exit 3)')
    })
  }))

  test('the downloaded programs are linked into ~/.local/bin, only for a download record', () => withSandbox(async () => {
    const nodeDir = join(paths.systemToolsDir(), 'node')
    const bins = IS_WINDOWS ? ['node.exe', 'npm.cmd', 'npx.cmd'] : ['bin/node', 'bin/npm', 'bin/npx']
    for (const b of bins) exe(join(nodeDir, b), 'x')
    const state = emptyToolchainState()
    state.system['node'] = { via: 'download', version: '26.13.0', path: join(nodeDir, bins[0] as string), installed_at: 't' }
    expect(toolchainLinks(state).map(l => l.bin).sort()).toEqual(['node', 'npm', 'npx'])
    expect(toolchainLinks(state).map(l => l.target).sort()).toEqual(bins.map(b => join(nodeDir, b)).sort())
    state.system['node'] = { via: 'brew', version: '26.13.0', path: join(nodeDir, bins[0] as string), installed_at: 't' }
    expect(toolchainLinks(state)).toEqual([])
  }))
})
