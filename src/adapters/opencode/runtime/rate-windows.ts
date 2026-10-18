import type { RateWindow } from '../../../core/status/model'
import { windowsFromFrame, windowsFromHeaders } from '../../../usage/headers'
import type { ServerContext, SessionHttpResponseEvent, SessionWsReceiveEvent } from './types'
import { errText } from './util'

export const HEADER_PROVIDERS: readonly string[] = ['anthropic', 'openai']
export const FRAME_PROVIDERS: readonly string[] = ['openai']

export type WindowsSink = (sessionID: string, windows: RateWindow[]) => void

export function responseWindows(e: SessionHttpResponseEvent, nowMs: number): RateWindow[] {
  const headers = e.response?.headers
  if (headers === undefined || typeof headers.get !== 'function') return []
  return windowsFromHeaders(name => headers.get(name), nowMs)
}

export async function registerRateWindows(ctx: ServerContext, sink: WindowsSink, opts: { now: () => number, log: (msg: string, data?: unknown) => void }): Promise<number> {
  let hooks = 0
  const deliver = (sid: unknown, windows: RateWindow[]) => {
    if (windows.length > 0 && typeof sid === 'string' && sid !== '') sink(sid, windows)
  }
  for (const providerID of HEADER_PROVIDERS) {
    try {
      await ctx.session.hook('http.response', (e: SessionHttpResponseEvent) => {
        try { deliver(e.sessionID, responseWindows(e, opts.now())) } catch (err) { opts.log('rate windows from headers failed', { error: errText(err) }) }
      }, { providerID })
      hooks++
    } catch (err) { opts.log('http.response hook not registered', { providerID, error: errText(err) }) }
  }
  for (const providerID of FRAME_PROVIDERS) {
    try {
      await ctx.session.hook('experimental.ws.receive', (e: SessionWsReceiveEvent) => {
        try { deliver(e.sessionID, windowsFromFrame(e.frame)) } catch (err) { opts.log('rate windows from a websocket frame failed', { error: errText(err) }) }
      }, { providerID })
      hooks++
    } catch (err) { opts.log('experimental.ws.receive hook not registered', { providerID, error: errText(err) }) }
  }
  return hooks
}
