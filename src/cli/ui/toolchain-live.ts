import type { CommandIO } from '../router'
import { loadBundle } from '../../engine/update/context'
import { opsDeps } from '../../engine/update/deps'
import type { ToolchainEvent, ToolchainItem, ToolchainOptions, ToolchainResult } from '../../engine/toolchain/index'
import { heading, styleFor, type Style } from './style'
import { liveList, type LiveList, type Outcome } from './live'

const GROUP_TITLE: Readonly<Record<ToolchainItem['group'], string>> = {
  runtime: 'Runtimes', cli: 'Tools', mcp: 'MCP servers', lsp: 'Language servers (LSP)',
}

export function outcomeOf(i: ToolchainItem): Outcome {
  switch (i.status) {
    case 'ok': case 'installed': case 'upgraded': return 'ok'
    case 'outdated': return 'warn'
    case 'skipped': return 'skip'
    case 'missing': return i.required ? 'err' : 'warn'
    case 'failed': return 'err'
  }
}

export function itemText(st: Style, i: ToolchainItem): string {
  const tag = i.status === 'installed' ? st.ok(' installed') : i.status === 'upgraded' ? st.ok(' upgraded') : i.status === 'outdated' ? st.warn(' outdated') : i.status === 'missing' ? (i.required ? st.err(' missing') : st.warn(' missing (optional)')) : i.status === 'failed' ? st.err(' failed') : ''
  return `${st.bold(i.label)}${tag}${i.detail !== '' ? st.muted(`  ${i.detail}`) : ''}`
}

// With `live`, the items go into that list (the one the command's own steps use), and stop() leaves it to its owner.
export function toolchainProgress(io: CommandIO, view: { quiet: boolean, title?: boolean, live?: LiveList }): { onEvent: (e: ToolchainEvent) => void, stop: () => void } {
  const st = styleFor(process.stderr)
  const tty = !view.quiet && !io.flags.json && Boolean(process.stderr.isTTY)
  const live = view.live ?? liveList(io.stderr, st, { tty, columns: process.stderr.columns ?? 100 })
  let group: string | undefined
  const onEvent = (e: ToolchainEvent): void => {
    if (view.quiet || io.flags.json) return
    if (e.phase === 'start') { live.start(e.item.id, `${e.item.label}${e.item.source !== undefined ? st.muted(`  ${e.item.source}`) : ''}`); return }
    if (view.title !== false && group !== e.item.group) {
      group = e.item.group
      live.note(heading(st, GROUP_TITLE[e.item.group]))
    }
    live.finish(e.item.id, outcomeOf(e.item), itemText(st, e.item))
  }
  return { onEvent, stop: () => { if (view.live === undefined) live.stop() } }
}

export async function runToolchainLive(opts: Omit<ToolchainOptions, 'onEvent' | 'nowMs'>, io: CommandIO, view: { quiet: boolean, title?: boolean, live?: LiveList }): Promise<ToolchainResult | { error: string }> {
  const b = loadBundle(opsDeps.repoRoot())
  if (!('bundle' in b)) return { error: `canonical/ could not be loaded: ${b.error}` }
  const progress = toolchainProgress(io, view)
  try {
    const r = await opsDeps.runToolchain(b.bundle, { ...opts, onEvent: progress.onEvent, nowMs: opsDeps.now })
    if (r === undefined) return { error: 'another Buracle process is installing the toolchain; try again in a moment' }
    return r
  } finally {
    progress.stop()
  }
}
