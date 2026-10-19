import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fakeExe, IS_WINDOWS, pathOf } from '../helpers/fake-exe'
import { withSandbox } from '../helpers/sandbox'

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts')
const PYTHON = Bun.which('python3')
const q = (v: unknown): string => JSON.stringify(v)

// A POSIX gopls script, for the fcntl case (POSIX only).
function goplsScript(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'gopls'), `#!/bin/sh\n${body}`, { mode: 0o755 })
}

// A fake gopls that writes its pid, then waits for stdin to end and exits with `code`.
function goplsServer(dir: string, pidFile: string, code: number): void {
  fakeExe(join(dir, 'gopls'), `fs.writeFileSync(${q(pidFile)}, String(process.pid))\nawait Bun.stdin.text()\nprocess.exit(${code})`)
}

function launch(bin: string, env: Record<string, string | undefined> = {}) {
  return Bun.spawn([process.execPath, MAIN, 'lsp', 'run', 'gopls'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: pathOf(bin, process.env['PATH'] ?? ''), ...env },
  })
}

async function textIn(file: string): Promise<string> {
  for (let i = 0; i < 500; i++) {
    const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
    if (text !== '') return text
    await Bun.sleep(20)
  }
  throw new Error(`nothing in ${file}`)
}

// execve and POSIX signals: Windows has neither, so there the launcher runs the server as its child (the third case).
describe('buracle lsp run: the language server becomes the launcher process', () => {
  test.skipIf(IS_WINDOWS)('it keeps the launcher\'s pid, and its exit code is the exit code', async () => {
    await withSandbox(async ({ root }) => {
      const bin = join(root, 'bin')
      const pidFile = join(root, 'server.pid')
      goplsServer(bin, pidFile, 7)
      const proc = launch(bin)
      expect(Number(await textIn(pidFile))).toBe(proc.pid)
      proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
      await proc.stdin.end()
      expect(await proc.exited).toBe(7)
    })
  })

  test.skipIf(IS_WINDOWS)('the harness\'s signal reaches the server itself: SIGTERM ends the process by that signal', async () => {
    await withSandbox(async ({ root }) => {
      const bin = join(root, 'bin')
      const pidFile = join(root, 'server.pid')
      fakeExe(join(bin, 'gopls'), `fs.writeFileSync(${q(pidFile)}, String(process.pid))\nsetTimeout(() => {}, 30_000)`)
      const proc = launch(bin)
      expect(Number(await textIn(pidFile))).toBe(proc.pid)
      proc.kill('SIGTERM')
      await proc.exited
      expect(proc.signalCode).toBe('SIGTERM')
    })
  })

  test('without execve (Windows) it runs as the launcher\'s child and its exit code is passed on', async () => {
    await withSandbox(async ({ root }) => {
      const bin = join(root, 'bin')
      const pidFile = join(root, 'server.pid')
      goplsServer(bin, pidFile, 5)
      const proc = launch(bin, { BURACLE_PLATFORM: 'win32' })
      expect(Number(await textIn(pidFile))).not.toBe(proc.pid)
      proc.stdin.write('x\n')
      await proc.stdin.end()
      expect(await proc.exited).toBe(5)
    })
  })

  test.skipIf(PYTHON === null || IS_WINDOWS)('its stdio stays blocking (the launcher never opened its streams), as a child too', async () => {
    await withSandbox(async ({ root }) => {
      const code = 'import fcntl, os, sys\nflags = [bool(fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_NONBLOCK) for fd in (0, 1, 2)]\nopen(sys.argv[1], "w").write(" ".join(map(str, flags)))\nsys.stdin.readline()\n'
      for (const [i, env] of [{}, { BURACLE_PLATFORM: 'win32' }].entries()) {
        const bin = join(root, `bin-${i}`)
        const flagsFile = join(root, `flags-${i}.txt`)
        goplsScript(bin, `exec "${PYTHON ?? 'python3'}" -I -c '${code}' "${flagsFile}"\n`)
        const proc = launch(bin, env)
        try {
          expect({ env, flags: await textIn(flagsFile) }).toEqual({ env, flags: 'False False False' })
        } finally {
          proc.stdin.write('done\n')
          await proc.stdin.end()
        }
        expect(await proc.exited).toBe(0)
      }
    })
  })

  test.skipIf(process.platform === 'win32')('`buracle lsp mcp` answers MCP on stdio, runs gopls for a .go file in its module root, and stops it when stdin closes', async () => {
    await withSandbox(async ({ root }) => {
      const bin = join(root, 'bin')
      const log = join(root, 'stub.log')
      const stub = join(import.meta.dir, '..', 'fixtures', 'lsp', 'stub-lsp.ts')
      fakeExe(join(bin, 'gopls'), `process.argv.splice(2, process.argv.length, 'push')\nawait import(${q(pathToFileURL(stub).href)})`)
      const mod = join(root, 'svc')
      mkdirSync(mod, { recursive: true })
      writeFileSync(join(mod, 'go.mod'), 'module svc\n')
      writeFileSync(join(mod, 'main.go'), 'package main\n\nfunc main() { x := 1 } // ERROR: declared and not used: x\n')
      const proc = Bun.spawn([process.execPath, MAIN, 'lsp', 'mcp'], {
        cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: pathOf(bin, process.env['PATH'] ?? ''), STUB_LSP_LOG: log },
      })
      const send = (msg: unknown) => { proc.stdin.write(JSON.stringify(msg) + '\n'); void proc.stdin.flush() }
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'diagnostics', arguments: { file: 'svc/main.go' } } })
      const replies = new Map<number, any>()
      const reader = proc.stdout.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const deadline = Date.now() + 20_000
      while (replies.size < 3 && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl)) as { id: number }
          buf = buf.slice(nl + 1)
          replies.set(msg.id, msg)
        }
      }
      await proc.stdin.end()
      expect(await proc.exited).toBe(0)
      expect(replies.get(1)?.result?.serverInfo?.name).toBe('buracle-lsp')
      expect(replies.get(2)?.result?.tools?.map((t: { name: string }) => t.name)).toEqual(['diagnostics', 'hover', 'definition', 'references', 'symbols'])
      expect(replies.get(3)?.result?.content?.[0]?.text).toBe('svc/main.go (gopls): 1 error\n  3:27  error E1  declared and not used: x [stub]')
      const entries = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { method?: string, cwd?: string })
      expect(entries.find(e => e.method === 'initialize')?.cwd).toBe(mod)
      expect(entries.map(e => e.method)).toContain('exit')
    })
  })

  test('an unknown server is an error before anything starts', async () => {
    await withSandbox(async () => {
      const proc = Bun.spawn([process.execPath, MAIN, 'lsp', 'run', 'nope'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
      expect(await proc.exited).toBe(1)
      expect(await new Response(proc.stderr).text()).toContain("unknown language server 'nope'")
    })
  })
})
