export interface FetchOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface FetchResult {
  ok: boolean
  status: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
  error?: string
}

export type Fetcher = (url: string, opts?: FetchOptions) => Promise<FetchResult>

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const MAX_TEXT = 1024 * 1024

function userAgent(): string {
  return 'buracle-update (+local personal harness)'
}

export const defaultFetch: Fetcher = async (url, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  try {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers: { 'user-agent': userAgent(), accept: 'application/json', ...(opts.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    }
    if (opts.body !== undefined) init.body = opts.body
    const res = await fetch(url, init)
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
    const text = await res.text()
    let json: unknown
    let parsed = false
    if (text.trim() !== '') {
      try { json = JSON.parse(text) as unknown; parsed = true } catch {  }
    }
    const out: FetchResult = { ok: res.ok, status: res.status, headers }
    if (parsed) out.json = json
    else out.text = text.slice(0, MAX_TEXT)
    if (!res.ok) out.error = `HTTP ${res.status}`
    return out
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    const msg = name === 'TimeoutError' || name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e instanceof Error ? e.message : String(e)
    return { ok: false, status: 0, error: msg }
  }
}
