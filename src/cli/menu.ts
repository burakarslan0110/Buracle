import { join } from 'node:path'
import { initialMenu, menuStep, renderMenu } from './ui/menu'
import { colorLevel, makeStyle, type Style } from './ui/style'
import type { Terminal } from './ui/terminal'

export const MIN_SIZE = { columns: 40, rows: 10 } as const

export interface MenuDeps {
  terminal: Terminal
  version: string
  updates?: number
  checkedAt?: string
  style?: Style
  // Runs a Buracle command with the terminal inherited and resolves with its exit code.
  run(argv: readonly string[]): Promise<number>
}

function ago(iso: string | undefined, nowMs: number): string | undefined {
  const at = iso === undefined ? NaN : Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const min = Math.max(0, Math.round((nowMs - at) / 60_000))
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`
}

export function menuFits(o: { stdinTTY: boolean, stdoutTTY: boolean, json: boolean, term: string | undefined, columns: number | undefined, rows: number | undefined }): boolean {
  return o.stdinTTY && o.stdoutTTY && !o.json && o.term !== 'dumb'
    && (o.columns ?? 0) >= MIN_SIZE.columns && (o.rows ?? 0) >= MIN_SIZE.rows
}

function menuStyle(): Style {
  const level = colorLevel(process.stdout)
  return makeStyle(level, { unicode: level > 0 })
}

/** The main menu: a choice closes the menu and runs its command in the terminal; the command's exit code is the menu's. */
export async function runMenu(d: MenuDeps): Promise<number> {
  const st = d.style ?? menuStyle()
  let argv: readonly string[] | undefined
  // Every way out gives the terminal back before a command writes to it.
  try {
    let menu = initialMenu(d.version, { updates: d.updates ?? 0, problems: 0, ...(d.checkedAt !== undefined ? { checkedAt: d.checkedAt } : {}) }, d.terminal.size())
    const draw = (): void => { d.terminal.draw(renderMenu(st, menu)) }
    d.terminal.onResize(() => { menu = { ...menu, ...d.terminal.size() }; draw() })
    draw()
    for (;;) {
      const step = menuStep(menu, await d.terminal.nextKey())
      menu = step.view
      if (step.action === undefined) { draw(); continue }
      if (step.action.kind === 'quit') return 0
      argv = step.action.argv
      break
    }
  } finally {
    d.terminal.close()
  }
  return d.run(argv)
}

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }

async function runCommand(argv: readonly string[]): Promise<number> {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, 'main.ts'), ...argv], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: { ...process.env } })
  // Ctrl-C belongs to the command while it runs.
  const onInt = (): void => {  }
  process.on('SIGINT', onInt)
  try {
    const code = await p.exited
    return p.signalCode ? 128 + (SIGNAL_NUMBERS[p.signalCode] ?? 15) : code
  } finally {
    process.off('SIGINT', onInt)
  }
}

export async function openMenu(): Promise<number> {
  const [{ openTerminal }, { readUpdatesCache }, { cliVersion }] = await Promise.all([import('./ui/terminal'), import('../engine/update/updates-cache'), import('./router')])
  const cache = readUpdatesCache()
  const checkedAt = ago(cache?.checked_at, Date.now())
  return runMenu({
    terminal: openTerminal({ input: process.stdin, output: process.stdout }),
    version: cliVersion(),
    updates: cache?.items.length ?? 0,
    ...(checkedAt !== undefined ? { checkedAt } : {}),
    run: runCommand,
  })
}
