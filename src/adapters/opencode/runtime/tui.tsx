/** @jsx h */

import type { Segment } from '../../../core/status/model'
import { run } from '../../../engine/proc'
import type { BakedData } from './baked'
import { bandLines, BandFeeder, estimatedWidth } from './band'
import { workflowCommandSkills } from './commands'
import { effortLevel } from './effort'
import { applyEnv, resolveEnv, runtimeConfigCache } from './env'
import type { LiveInputs } from './status'
import { barSegments, contextUsage, layoutFor, StatusFeeder, statusSegments } from './status'
import type { UtilityHost } from './tui-commands'
import { defaultCli, PANE_REFRESH_MS, utilityCommands, utilityNames } from './tui-commands'
import { startConsentRelay } from './tui-consent'
import { TuiNotices } from './tui-notices'
import { createMemo, createSignal, h, onCleanup, useTerminalDimensions } from './tui-runtime'
import type { TuiComposerInput, TuiContext, TuiPluginDefinition, TuiPromptFooterInput, TuiTheme } from './types'
import { profileWarning } from './workspace'

declare const BURACLE_BAKED: BakedData

const REFRESH_MS = 5_000
const BAND_TICK_MS = 1_000
const SEPARATOR = ' │ '
const BOLD = 1
const DIM = 2

function colorOf(theme: TuiTheme, seg: Segment, fallback: unknown = theme.text.muted): unknown {
  if (seg.dim === true) return theme.text.muted
  switch (seg.color) {
    case 'green': return theme.text.feedback.success.base
    case 'yellow': return theme.text.feedback.warning.base
    case 'red': return theme.text.feedback.error.base
    case 'blue': return theme.text.feedback.info.base
    case 'magenta': return theme.hue.accent[500] ?? theme.text.base
    case 'cyan': return theme.hue.interactive[500] ?? theme.text.base
    case 'gray': return theme.text.muted
    case 'white': return theme.text.base
    default: return fallback
  }
}

function attributesOf(seg: Segment): number {
  return (seg.bold === true ? BOLD : 0) | (seg.dim === true ? DIM : 0)
}

interface Line { key: string; segments: Segment[];  joined?: boolean }

function takenNames(ctx: TuiContext): ReadonlySet<string> {
  try {
    const list = ctx.data.location.command?.list(ctx.location)
    return new Set((list ?? []).map(c => c.name))
  } catch {
    return new Set()
  }
}

export function createTuiPlugin(baked: BakedData, pluginDir: string | undefined): TuiPluginDefinition {
  return {
    id: 'buracle',
    setup(ctx: TuiContext) {
      const env = resolveEnv(pluginDir)
      applyEnv(env)
      const config = runtimeConfigCache(baked.defaults)
      const band = new BandFeeder()
      const feeder = new StatusFeeder({ memoryUi: () => config.get().config.memory.ui, config: () => config.get().config, band })
      const [version, setVersion] = createSignal(0)
      let current: { cwd: string, sessionID?: string } = { cwd: ctx.location?.directory ?? process.cwd() }
      let stopped = false
      const notices = new TuiNotices({
        now: () => Date.now(),
        toast: (message, variant) => { ctx.ui.toast?.show({ title: 'Buracle', message, variant, duration: variant === 'warning' ? 10_000 : 8_000 }) },
        band: sid => band.view(sid, config.get().config.workflow.foldAfterSec),
        bandOn: () => config.get().config.workflow.band,
        busy: sid => { const last = ctx.data.session.message.list(sid).at(-1); return last?.type === 'assistant' && last.status !== undefined && last.status !== 'completed' },
      })
      const tick = async (): Promise<void> => {
        if (stopped) return
        try {
          if (await feeder.refresh(current.cwd, current.sessionID)) setVersion(v => v + 1)
        } catch {  }
        try { notices.poll(current.sessionID) } catch {  }
      }
      const timer = setInterval(() => { void tick() }, REFRESH_MS)
      void tick()

      const compute = (input: TuiPromptFooterInput, width: number): Line => {
        version()
        if (input.mode === 'shell') return { key: '', segments: [] }
        const sid = input.sessionID
        const session = sid !== undefined ? ctx.data.session.get(sid) : undefined
        const cwd = session?.location?.directory ?? ctx.location?.directory ?? current.cwd
        if (sid !== current.sessionID || cwd !== current.cwd) {
          current = sid !== undefined ? { cwd, sessionID: sid } : { cwd }
          try { notices.sessionShown(sid) } catch {  }
          void tick()
        }
        const live: LiveInputs = sid !== undefined ? { cwd, sessionID: sid } : { cwd }
        const cfg = config.get().config
        const model = ctx.ui.model.current()
        if (model !== undefined) {
          live.model = model
          const level = model.variant === undefined ? effortLevel(cfg) : undefined
          if (level !== undefined && (ctx.ui.model.variant?.list() ?? []).includes(level)) live.model = { ...model, variant: level }
        }
        if (sid !== undefined) {
          const usage = contextUsage(ctx.data.session.message.list(sid), ctx.data.location.model.list(session?.location), session?.revert?.messageID)
          if (usage !== undefined) live.ctx = usage
          live.costUsd = ctx.data.session.cost(sid)
        }
        const statusline = cfg.statusline
        const layout = layoutFor(baked.layout, statusline)
        if (statusline.style === 'buracle') {
          const segments = barSegments(feeder.bar(live), layout, feeder.barInfo(), width, Date.now())
          return { key: JSON.stringify(segments), segments, joined: true }
        }
        const segments = statusSegments(feeder.bar(live), layout, width, Date.now())
        return { key: JSON.stringify(segments), segments }
      }

      const offs: Array<() => void> = []
      offs.push(ctx.ui.slot({
        append: 'prompt.footer.status',
        render: (input: TuiPromptFooterInput) => {
          const dims = useTerminalDimensions()
          const line = createMemo<Line>(() => {
            try {
              return compute(input, Math.max(20, Math.floor(dims().width * 0.6)))
            } catch {
              return { key: '', segments: [] }
            }
          }, (a, b) => a.key === b.key)
          const spans = () => line().segments.flatMap((seg, i) => [
            ...(i > 0 && line().joined !== true ? [<span style={{ fg: ctx.theme.text.muted }}>{SEPARATOR}</span>] : []),
            <span style={{ fg: colorOf(ctx.theme, seg) }}>{seg.text}</span>,
          ])
          return (
            <box flexShrink={1} minWidth={0} paddingLeft={1}>
              <text wrapMode="none" truncate={true}>{spans}</text>
            </box>
          )
        },
      }))

      offs.push(ctx.ui.slot({
        append: 'session.composer.top',
        render: (input: TuiComposerInput) => {
          const dims = useTerminalDimensions()
          const [measured, setMeasured] = createSignal<number | undefined>(undefined)
          const [beat, setBeat] = createSignal(0)
          const ticker = setInterval(() => setBeat(b => b + 1), BAND_TICK_MS)
          onCleanup(() => clearInterval(ticker))
          const rows = createMemo<{ key: string, rows: Segment[][] }>(() => {
            beat()
            try {
              const cfg = config.get().config
              if (!cfg.workflow.band) return { key: '', rows: [] }
              const view = band.view(input.sessionID, cfg.workflow.foldAfterSec)
              const out = bandLines(view, measured() ?? estimatedWidth(dims().width))
              return { key: JSON.stringify(out), rows: out }
            } catch {
              return { key: '', rows: [] }
            }
          }, (a, b) => a.key === b.key)
          const lines = () => rows().rows.map(row => (
            <text wrapMode="none">{row.map(seg => <span style={{ fg: colorOf(ctx.theme, seg, ctx.theme.text.base), attributes: attributesOf(seg) }}>{seg.text}</span>)}</text>
          ))
          return (
            <box flexDirection="column" flexShrink={0} onSizeChange={function (this: { width?: number }) { if (typeof this.width === 'number' && this.width > 0) setMeasured(this.width) }}>
              {lines}
            </box>
          )
        },
      }))

      const host: UtilityHost = {
        cli: defaultCli,
        run: async (argv, timeoutMs) => {
          const r = await run(argv, { timeoutMs, cwd: ctx.location?.directory ?? process.cwd() })
          return { code: r.code, stdout: r.stdout, stderr: r.stderr }
        },
        cfg: () => config.get().config,
        sessionID: () => {
          const route = ctx.ui.router?.current()
          return route?.type === 'session' ? route.sessionID : undefined
        },
        toast: (message, variant, title) => { ctx.ui.toast?.show({ ...(title !== undefined ? { title } : {}), message, variant, duration: variant === 'error' ? 10_000 : 6_000 }) },
        alert: async (title, message) => {
          if (ctx.ui.dialog !== undefined) await ctx.ui.dialog.alert({ title, message })
          else ctx.ui.toast?.show({ title, message, variant: 'info', duration: 15_000 })
        },
        band: sid => band.view(sid, config.get().config.workflow.foldAfterSec),
        about: () => ({ ...(ctx.app?.version !== undefined ? { opencode: ctx.app.version } : {}), testedWith: baked.testedWith, workflows: workflowCommandSkills(baked.skills).map(s => s.id) }),
        pane: (title, lines) => {
          const dialog = ctx.ui.dialog
          if (dialog?.show === undefined) return false
          dialog.show(() => {
            const [beat, setBeat] = createSignal(0)
            const ticker = setInterval(() => setBeat(b => b + 1), PANE_REFRESH_MS)
            onCleanup(() => clearInterval(ticker))
            const rows = createMemo<string[]>(() => {
              beat()
              try { return lines() } catch { return ['Buracle could not read this view.'] }
            }, (a, b) => a.join('\n') === b.join('\n'))
            return (
              <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
                <text><span style={{ fg: ctx.theme.text.base, attributes: BOLD }}>{title}</span></text>
                {() => rows().map(line => <text><span style={{ fg: ctx.theme.text.base }}>{line}</span></text>)}
                <text><span style={{ fg: ctx.theme.text.muted }}>Live view, updated every few seconds. Esc closes it.</span></text>
              </box>
            )
          })
          return true
        },
        slashCommand: name => {
          const found = (ctx.keymap?.commands?.() ?? []).find(c => c.id?.startsWith('buracle.') !== true && (c.slash?.name === name || c.slash?.aliases?.includes(name) === true))
          return found === undefined ? undefined : input => found.run(input)
        },
      }
      const dialog = ctx.ui.dialog
      if (dialog?.select !== undefined) {
        offs.push(startConsentRelay({ sessionID: host.sessionID, select: o => dialog.select?.(o) ?? Promise.resolve(undefined), clear: () => dialog.clear?.(), now: () => Date.now(), pid: process.pid }))
      }
      try {
        void ctx.data.location.command?.sync?.(ctx.location)?.catch(() => undefined)
        ctx.keymap?.layer(() => ({ mode: 'global', commands: utilityCommands(host, utilityNames(takenNames(ctx))) }))
      } catch {  }

      const profile = setTimeout(() => {
        try {
          const warning = profileWarning(pluginDir, config.get(), env.home)
          if (warning !== undefined) ctx.ui.toast?.show({ title: 'Buracle', message: warning, variant: 'warning', duration: 20_000 })
        } catch {  }
      }, 1500)

      return () => {
        stopped = true
        clearInterval(timer)
        clearTimeout(profile)
        for (const off of offs) off()
      }
    },
  }
}

export default createTuiPlugin(BURACLE_BAKED, import.meta.dir)
