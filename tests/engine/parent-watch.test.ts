import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PARENT_POLL_MS, parentPollMs, watchParent } from '../../src/engine/parent-watch'
import { withSandbox } from '../helpers/sandbox'

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts')

function readPid1Name(): string {
  try { return readFileSync('/proc/1/comm', 'utf8').trim() } catch { return '' }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (ok()) return true
    await Bun.sleep(50)
  }
  return ok()
}

const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`

// A `sh` parent that starts `buracle <args>` in the background, prints the child's pid and waits. The
// child reads its stdin from a FIFO that a separate `sleep` holds open, so the stdin stays open after the
// parent dies (Bun closes a subprocess's own stdin pipe when that subprocess exits): only the parent
// watch can stop the child.
async function startUnderParent(args: readonly string[], env: Record<string, string | undefined>, dir: string, tag: string): Promise<{ parent: ReturnType<typeof Bun.spawn>, child: number, holder: number }> {
  const fifo = join(dir, `stdin-${tag}`)
  expect(Bun.spawnSync(['mkfifo', fifo], { env: { ...process.env } }).exitCode).toBe(0)
  const cmd = [process.execPath, MAIN, ...args].map(q).join(' ')
  const script = `sleep 120 > ${q(fifo)} & S=$!; ${cmd} < ${q(fifo)} >/dev/null 2>&1 & echo "$! $S"; wait`
  const parent = Bun.spawn(['/bin/sh', '-c', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env })
  const reader = (parent.stdout as ReadableStream<Uint8Array>).getReader()
  let text = ''
  while (!text.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  const [child, holder] = text.trim().split(/\s+/).map(Number) as [number, number]
  expect(Number.isInteger(child) && child > 1 && Number.isInteger(holder) && holder > 1).toBe(true)
  return { parent, child, holder }
}

describe('watchParent', () => {
  test('reports once when the parent pid changes, and never while it stays the same', async () => {
    const seq = [10, 10, 10, 1, 1, 1]
    let i = 0
    let gone = 0
    watchParent({ onGone: () => { gone++ }, intervalMs: 5, ppid: () => seq[Math.min(i++, seq.length - 1)] as number })
    await until(() => i >= seq.length + 2, 2_000)
    expect(gone).toBe(1)
    let calls = 0
    const w = watchParent({ onGone: () => { calls++ }, intervalMs: 5, ppid: () => 42 })
    await Bun.sleep(60)
    w.stop()
    expect(calls).toBe(0)
  })

  test('a parent that is already pid 1 when the watch starts counts as gone: the harness died while the server was still starting', async () => {
    let gone = 0
    watchParent({ onGone: () => { gone++ }, intervalMs: 5, ppid: () => 1, pid1IsInit: () => true })
    await until(() => gone > 0, 1_000)
    await Bun.sleep(30)
    expect(gone).toBe(1)
  })

  test('a harness that is pid 1 itself (a container without an init) keeps its servers', async () => {
    let gone = 0
    const w = watchParent({ onGone: () => { gone++ }, intervalMs: 5, ppid: () => 1, pid1IsInit: () => false })
    await Bun.sleep(60)
    w.stop()
    expect(gone).toBe(0)
  })

  // Only where pid 1 is known: a test run inside a container may be pid 1 itself, or run under another init.
  const pid1Known = process.platform === 'darwin' || (process.platform === 'linux' && ['systemd', 'init'].includes(readPid1Name()))
  test.if(pid1Known)('on this host pid 1 is an init (launchd on macOS; systemd or init on Linux and WSL 2)', async () => {
    let gone = 0
    watchParent({ onGone: () => { gone++ }, intervalMs: 5, ppid: () => 1 })
    expect(await until(() => gone > 0, 1_000)).toBe(true)
  })

  test('stop() ends the polling before a change is seen', async () => {
    let reads = 0
    const w = watchParent({ onGone: () => { throw new Error('must not fire') }, intervalMs: 5, ppid: () => (reads++ < 2 ? 7 : 1) })
    w.stop()
    await Bun.sleep(40)
    expect(reads).toBeLessThanOrEqual(1)
  })

  test('the poll interval: 2 s by default, BURACLE_MCP_PARENT_POLL_MS in milliseconds, anything that is not a positive number ignored', () => {
    expect(PARENT_POLL_MS).toBe(2_000)
    expect(parentPollMs({})).toBe(2_000)
    expect(parentPollMs({ BURACLE_MCP_PARENT_POLL_MS: '250' })).toBe(250)
    expect(parentPollMs({ BURACLE_MCP_PARENT_POLL_MS: '0' })).toBe(2_000)
    expect(parentPollMs({ BURACLE_MCP_PARENT_POLL_MS: 'soon' })).toBe(2_000)
  })
})

describe('per-session servers stop when the harness dies (R8)', () => {
  for (const [name, args] of [['buracle mcp memory', ['mcp', 'memory']], ['buracle lsp mcp', ['lsp', 'mcp']]] as const) {
    test(`${name} exits within 10 s after a SIGKILL of its parent, with stdin still open; a child whose parent lives keeps running`, async () => {
      await withSandbox(async ({ root }) => {
        const env = { ...process.env }
        const killed = await startUnderParent(args, env, root, 'killed')
        const kept = await startUnderParent(args, env, root, 'kept')
        try {
          expect(await until(() => alive(killed.child) && alive(kept.child), 5_000)).toBe(true)
          // Let both servers start and watch their parent; a parent that dies earlier is the pid-1 case above.
          await Bun.sleep(1_500)
          const t0 = Date.now()
          killed.parent.kill('SIGKILL')
          expect(await until(() => !alive(killed.child), 10_000)).toBe(true)
          expect(Date.now() - t0).toBeLessThan(10_000)
          await until(() => false, Math.max(0, 5_000 - (Date.now() - t0)))
          expect(alive(kept.child)).toBe(true)
        } finally {
          for (const p of [killed.child, kept.child, killed.holder, kept.holder]) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
          for (const p of [killed.parent, kept.parent]) { try { p.kill('SIGKILL') } catch { /* gone */ } }
        }
      })
    }, 40_000)
  }
})
