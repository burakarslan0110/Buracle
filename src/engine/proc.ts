export interface RunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  stdin?: string | Uint8Array
  signal?: AbortSignal
  processGroup?: boolean
}

export interface RunResult { code: number; stdout: string; stderr: string; timedOut: boolean; aborted?: boolean }

interface Collector { done: Promise<void>; text(): string }

function collect(stream: ReadableStream<Uint8Array> | undefined | null): Collector {
  const decoder = new TextDecoder()
  let acc = ''
  if (!stream) return { done: Promise.resolve(), text: () => '' }
  const reader = stream.getReader()
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: end } = await reader.read()
        if (end) break
        if (value) acc += decoder.decode(value, { stream: true })
      }
      acc += decoder.decode()
    } catch {  }
  })()
  return { done, text: () => acc }
}

function delay(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (argv.length === 0 || argv[0] === undefined || argv[0] === '') return { code: 127, stdout: '', stderr: 'run: empty argv', timedOut: false }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  if (opts.env) for (const [k, v] of Object.entries(opts.env)) { if (v === undefined) delete env[k]; else env[k] = v }
  const group = opts.processGroup === true && process.platform !== 'win32'
  let proc
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env,
      stdin: opts.stdin === undefined ? 'ignore' : typeof opts.stdin === 'string' ? new TextEncoder().encode(opts.stdin) : opts.stdin,
      stdout: 'pipe',
      stderr: 'pipe',
      ...(group ? { detached: true } : {}),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { code: 127, stdout: '', stderr: msg, timedOut: false }
  }
  const out = collect(proc.stdout)
  const err = collect(proc.stderr)
  let timedOut = false
  let aborted = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let hardTimer: ReturnType<typeof setTimeout> | undefined
  const p = proc
  const send = (sig: 'SIGTERM' | 'SIGKILL') => {
    if (group) {
      try { process.kill(-p.pid, sig); return } catch {  }
    }
    try { p.kill(sig) } catch {  }
  }
  const stop = () => {
    send('SIGTERM')
    if (hardTimer === undefined) hardTimer = setTimeout(() => { send('SIGKILL') }, 2000)
  }
  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    killTimer = setTimeout(() => { timedOut = true; stop() }, opts.timeoutMs)
  }
  const onAbort = () => { aborted = true; stop() }
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const code = await proc.exited
    await Promise.race([Promise.all([out.done, err.done]), delay(timedOut || aborted ? 200 : 1000)])
    const res: RunResult = { code: timedOut ? 124 : code, stdout: out.text(), stderr: err.text(), timedOut }
    if (aborted) res.aborted = true
    return res
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer)
    if (hardTimer !== undefined) clearTimeout(hardTimer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

export function which(name: string): string | undefined {
  const PATH = process.env['PATH']
  return (PATH !== undefined ? Bun.which(name, { PATH }) : Bun.which(name)) ?? undefined
}

export function parseVersion(text: string): string | undefined {
  const full = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/.exec(text)
  if (full) return full[1]
  return /(\d+\.\d+)/.exec(text)?.[1]
}

export async function detectBinary(name: string, versionArgs: string[] = ['--version']): Promise<{ installed: boolean, version?: string, path?: string }> {
  const path = which(name)
  if (path === undefined) return { installed: false }
  const r = await run([path, ...versionArgs], { timeoutMs: 5000 })
  const version = r.code === 0 ? parseVersion(`${r.stdout}\n${r.stderr}`) : undefined
  return version !== undefined ? { installed: true, version, path } : { installed: true, path }
}
