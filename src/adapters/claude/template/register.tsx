import type { CommandSpec, EngineInterface, Register, Timer, ToolCallResult } from 'claude-code'
import { atom, read, update } from 'claude-code'

import * as Core from './core/index'
import { CATALOG } from './generated/catalog'
import { META } from './generated/meta'

type Cfg = Core.BuracleConfig

const MEMORY_PANE = 'buracle-memory'
const PLAN_PANE = 'buracle-plan'
const SID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const CRITICAL: readonly RegExp[] = CATALOG.criticalToolPatterns.map(patternOf)
const ALLOW_ONCE = 'Allow once'
const ALLOW_SESSION = 'Allow for this session'
const REFUSE = 'Refuse'
const SESSION_GRANT_MS = 8 * 60 * 60_000
const MASK_MAX_CHARS = 400_000
const BAND = atom({ plugin: 'buracle', key: 'band' } as const, Core.emptyBand())
const BAND_POLL_MS = 15_000
const BAND_BUTTONS = 14
const CHECK_SUGGESTION = 'run the checks for the files changed in the last turn (tests, typecheck, lint) and show the results'

interface Runtime {
  home: string
  buracleHome: string
  brain: string
  shim: string
  bun: string
  cli: string[]
  cfg: Cfg
}

interface ModState {
  sid: string
  interactive: boolean
  registered: Set<string>
  rt?: { path: string; mtimeMs: number; checkedAt: number; value: Runtime }
  home?: string
  receipt: Core.ReceiptState
  warned: 'ok' | 'warn' | 'critical'
  touched: string[]
  planPath?: string
  poll?: Timer
  seen: string
  fold?: { at: number; timer: Timer }
  suggest?: { text: string; until: number }
}

function newState(): ModState {
  return { sid: '', interactive: false, registered: new Set(), receipt: Core.emptyReceipt(), warned: 'ok', touched: [], seen: '' }
}

export const register: Register = on => {
  const S = newState()

  on('session.start', async ($, e, next) => {
    try {
      S.interactive = e.isInteractive
      const sid = await $.session.id().catch(() => '')
      if (SID_RE.test(sid)) S.sid = sid
      await registerCommands($, S)
      await refreshBand($, S)
      await resumeHint($, S)
    } catch (err) {
      debug($, `session start: ${errText(err)}`)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    S.suggest = undefined
    const typed = Core.workflowOfPrompt(e.text)
    if (typed !== undefined) await recordStart($, S, typed.workflow, typed.args, 'prompt')
    else await refreshBand($, S)
    return started
  }).catch(($, e, next) => next(e))

  on('command.run', { command: ['buracle-ping', 'buracle-status', 'buracle', 'remember', 'buracle-remember', 'brain', 'buracle-brain', 'aside', 'buracle-aside'] }, async ($, e, next) => {
    if (!S.registered.has(e.command)) return next(e)
    const name = e.command === 'buracle' ? 'buracle-status' : e.command.replace(/^buracle-(?=remember|brain|aside)/, '')
    try {
      return { text: await ownCommand($, S, name, e.args) }
    } catch (err) {
      return { text: `${name === 'remember' ? 'Not saved' : name === 'brain' ? 'Could not open the memory UI' : 'buracle'}: ${errText(err)}` }
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'buracle:buracle' }, async ($, e) => {
    try {
      return { text: await statusCommand($, S, e.args) }
    } catch (err) {
      return { text: `buracle: ${errText(err)}` }
    }
  }).catch(($, e, next) => next(e))
  on('command.describe', { command: 'buracle:buracle' }, async ($, e, next) => ({
    ...(await next(e)), description: 'Buracle status: status, memory, plan or flow (also /buracle-status)', argumentHint: '[status|memory|plan|flow]', isHidden: false,
  })).catch(($, e, next) => next(e))

  on('command.run', { command: /^buracle:[a-z][a-z0-9-]*$/ }, async ($, e, next) => {
    const workflow = Core.workflowOfSkill(e.command)
    if (workflow !== undefined) await recordStart($, S, workflow, e.args, 'command')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.describe', { tool: /^mcp__plugin_buracle_/ }, async ($, e, next) => {
    const described = await next(e)
    return CRITICAL.some(p => p.test(e.tool)) ? { ...described, isDeferred: false } : described
  })

  on('tool.call', { tool: ['Bash', 'Monitor', 'PowerShell'] }, async ($, e, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    if (command !== '' && e.agentId === undefined && S.interactive) {
      const refused = await consentDialog($, S, [command])
      if (refused !== undefined) return { deny: refused }
    }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    if (e.agentId === undefined && command !== '') noteCommandRan($, S, command, ran.isError === true || Core.shellFailed(ran.result))
    if (/\bburacle\b[^\n]*\b(?:flow|plan)\b/.test(command)) await refreshBand($, S)
    return await masked($, S, e.tool_use_id, ran)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(?:Edit|Write|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && e.agentId === undefined) {
      const path = noteEditRan($, S, e.tool, e)
      if (path !== undefined && path === S.planPath) await refreshBand($, S)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(?:Read|Grep|Glob|mcp__.+)$/ }, async ($, e, next) => {
    const ran = await next(e)
    return ran.deny !== undefined ? ran : await masked($, S, e.tool_use_id, ran)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(?:Skill|Agent|TodoWrite|TaskCreate|TaskUpdate)$/ }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (tool === 'Agent') await agentStarted($, e.tool_use_id, input)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      if (tool === 'Agent') await bandWrite($, b => Core.bandAgentEnd(b, e.tool_use_id))
      return ran
    }
    await workToolRan($, S, tool, input, ran.result, e.tool_use_id)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      const id = e.agentId
      await bandWrite($, b => Core.bandAgentEnd(b, id))
      return done
    }
    try {
      await turnEnded($, S, e.answer, e.durationMs, e.reason)
    } catch (err) {
      debug($, `turn: ${errText(err)}`)
    }
    return done
  }).catch(($, e, next) => next(e))

  on('prompt.suggest', async ($, e, next) => {
    const mine = S.suggest
    if (mine === undefined || e.origin.kind !== 'suggestion' || e.text === mine.text) return next(e)
    if ((await nowMs($)) >= mine.until) {
      S.suggest = undefined
      return next(e)
    }
    return next({ ...e, text: mine.text })
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    try {
      const window = e.context.window
      const tokens = e.context.tokens
      const pct = e.context.percent ?? (tokens !== undefined && window > 0 ? Math.round((tokens * 100) / window) : undefined)
      await contextToast($, S, pct)
    } catch (err) {
      debug($, `measure: ${errText(err)}`)
    }
    return measured
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    let instructions = e.instructions
    try {
      instructions = await compactInstructions($, S, e.instructions)
    } catch (err) {
      debug($, `compact: ${errText(err)}`)
    }
    S.warned = 'ok'
    return next(instructions === e.instructions ? e : { ...e, instructions })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const view = Core.bandViewOf(await read($, BAND))
    const wide = e.props.bodyColumns >= 96
    const rows = Core.bandRows(view, e.props.bodyColumns, Math.min(3, e.props.maxRows), true, { reserve: wide ? BAND_BUTTONS : 0 })
    if (rows.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const drawn = rows.map((row, i) => {
      const cells = row.map(s => <Box key={s.id}><Text {...segmentStyle(s)} wrap="truncate-end">{s.text}</Text></Box>)
      if (i === 0 && wide) {
        cells.push(
          <Box key="band-buttons" flexDirection="row" gap={1} marginLeft={1}>
            <Button key="band-details" label="details" plain onPress={() => void openPane($, PLAN_PANE)} />
            <Button key="band-hide" label="hide" plain onPress={() => void update($, BAND, Core.bandHide)} />
          </Box>,
        )
      }
      return <Box key={`band-row-${i}`} flexDirection="row">{cells}</Box>
    })
    const below = await next(e)
    return <Box key="band" flexDirection="column">{drawn}{below}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: [MEMORY_PANE, PLAN_PANE] }, async ($, e) => {
    const memory = e.requestId === MEMORY_PANE
    const lines = memory ? await memoryLines($, S) : await planLines($, S)
    const { Box, Text, Button } = $.ui.resolve(e)
    const buttons = [<Button key="close" label="close" hotkey="x" plain role="dismiss" onPress={() => void openPane($, e.requestId, true)} />]
    if (memory) buttons.unshift(<Button key="web" label="web UI" hotkey="w" plain onPress={() => void openMemoryUi($, S)} />)
    return (
      <Box flexDirection="column">
        {lines.map(line => <Text {...lineStyle(line)}>{line.text}</Text>)}
        <Box flexDirection="row" gap={2} marginTop={1}>{buttons}</Box>
      </Box>
    )
  })
}

async function registerCommand($: EngineInterface, S: ModState, spec: CommandSpec): Promise<boolean> {
  try {
    await $.command.register(spec)
    S.registered.add(spec.name)
    return true
  } catch (err) {
    debug($, `command /${spec.name} not registered: ${errText(err)}`)
    return false
  }
}

async function registerCommands($: EngineInterface, S: ModState): Promise<void> {
  await registerCommand($, S, { name: 'buracle-ping', description: 'Buracle: liveness check (no model call)' })
  await registerCommand($, S, { name: 'buracle-status', description: 'Buracle status: status, memory, plan or flow', argumentHint: '[status|memory|plan|flow]' })
  await registerCommand($, S, { name: 'buracle', description: 'Buracle status (short name of /buracle-status)', argumentHint: '[status|memory|plan|flow]' })
  const specs: CommandSpec[] = [
    { name: 'remember', description: 'Buracle: save the text to memory as a capture the next harness files', argumentHint: '<text>' },
    { name: 'brain', description: 'Buracle: open the memory web UI in the browser (review: the plan and change review page)', argumentHint: '[review]' },
    { name: 'aside', description: 'Buracle: ask a side question without touching the session (read-only)', argumentHint: '<question>' },
  ]
  for (const spec of specs) {
    if (!(await registerCommand($, S, spec))) await registerCommand($, S, { ...spec, name: `buracle-${spec.name}` })
  }
}

async function ownCommand($: EngineInterface, S: ModState, name: string, args: string): Promise<string> {
  if (name === 'buracle-ping') return 'pong'
  if (name === 'remember') return await rememberCommand($, S, args)
  if (name === 'brain') {
    const page = Core.brainPageArg(args)
    if (page === undefined) return 'Usage: /brain [review]'
    const url = await openMemoryUi($, S, page)
    return url !== undefined ? `${page === 'review' ? 'Review page' : 'Memory UI'}: ${url}` : 'The memory web UI did not start (run: buracle mem ui --serve).'
  }
  if (name === 'aside') {
    await asideCommand($, args)
    return ''
  }
  return await statusCommand($, S, args)
}

async function statusCommand($: EngineInterface, S: ModState, args: string): Promise<string> {
  const what = (args.trim().split(/\s+/)[0] ?? '').toLowerCase()
  if (what === 'memory' || what === 'mem') {
    await openPane($, MEMORY_PANE)
    return (await memoryLines($, S)).map(l => l.text).join('\n')
  }
  if (what === 'plan') {
    await openPane($, PLAN_PANE)
    return (await planLines($, S)).map(l => l.text).join('\n')
  }
  if (what === 'flow') {
    await refreshBand($, S)
    return Core.bandText(Core.bandView(Core.bandInputOf(await read($, BAND)))).join('\n')
  }
  if (what !== '' && what !== 'status') return 'Usage: /buracle-status [status|memory|plan|flow]'
  const { cfg } = await runtime($, S)
  const info: Core.ModStatusInfo = {
    version: META.buracleVersion, testedWith: META.testedWith, minClaude: META.minClaude, sid: S.sid, interactive: S.interactive,
    bypass: cfg.permissions.bypass, strictness: cfg.routing.strictness, redact: cfg.guards.redact, band: cfg.workflow.band, commands: [...S.registered],
  }
  const url = await memoryUiUrl($, S)
  if (url !== undefined) info.uiUrl = url
  return Core.modStatusLines(info).join('\n')
}

async function rememberCommand($: EngineInterface, S: ModState, args: string): Promise<string> {
  const text = args.trim()
  if (text === '') return 'Usage: /remember <text>'
  const rt = await runtime($, S)
  if (rt.shim === '' || !(await $.fs.exists(rt.shim).catch(() => false))) {
    return 'The Buracle CLI was not found (~/.buracle/bin/buracle); run `buracle install` first.'
  }
  const ran = await $.process.run([...rt.cli, 'mem', 'remember', '--', text], { timeoutMs: 20_000 })
  if (ran.exitCode === 0) {
    const said = firstLine(ran.stdout).replace(/^saved as a capture:\s*/i, '').replace(/\s*\(.*\)$/, '')
    return said !== '' ? `Remembered: ${said}` : 'Remembered.'
  }
  return `Not saved (exit code ${ran.exitCode}): ${firstLine(ran.stderr) || firstLine(ran.stdout)}`
}

async function memoryUiUrl($: EngineInterface, S: ModState): Promise<string | undefined> {
  const rt = await runtime($, S)
  if (rt.buracleHome === '') return undefined
  const raw = await readJson($, `${rt.buracleHome}/state/memory-ui.json`)
  // No record means no web UI is running (a session start or `buracle mem ui` starts one), so there is no address to name.
  return isObj(raw) ? str(raw['url']) : undefined
}

async function openMemoryUi($: EngineInterface, S: ModState, page: 'brain' | 'review' = 'brain'): Promise<string | undefined> {
  const rt = await runtime($, S)
  if (rt.shim === '') return undefined
  const ran = await $.process.run([...rt.cli, 'mem', 'ui', '--open', ...(page === 'review' ? ['--page', 'review'] : []), '--json'], { timeoutMs: 15_000 })
  if (ran.exitCode !== 0) throw new Error(firstLine(ran.stderr) || `exit ${ran.exitCode}`)
  try {
    const j = JSON.parse(ran.stdout) as { url?: unknown, page?: unknown }
    return page === 'review' && typeof j.page === 'string' ? j.page : typeof j.url === 'string' ? j.url : await memoryUiUrl($, S)
  } catch {
    return await memoryUiUrl($, S)
  }
}

async function asideCommand($: EngineInterface, args: string): Promise<void> {
  const q = args.trim()
  if (q === '') { $.ui.log('Usage: /aside <question>'); return }
  try {
    const r = await $.model.fork({ prompt: `Answer briefly, from this conversation alone, without changing anything: ${q}` })
    $.ui.log(r.isAnswered ? `aside: ${r.text}` : `aside: no answer (${r.reason})`)
  } catch (err) {
    $.ui.log(`aside: ${errText(err)}`)
  }
}

async function bandWrite($: EngineInterface, fn: (b: Core.BandState) => Core.BandState): Promise<void> {
  const prev = await read($, BAND)
  if (JSON.stringify(fn(prev)) === JSON.stringify(prev)) return
  await update($, BAND, fn)
}

async function refreshBand($: EngineInterface, S: ModState, force = false): Promise<void> {
  try {
    const sid = await sessionId($, S)
    const rt = await runtime($, S)
    if (sid === '' || rt.buracleHome === '') return
    const raw = await readText($, `${rt.buracleHome}/sessions/claude/${sid}/flow.json`)
    const state = await loadSessionState($, rt, sid)
    S.planPath = state.plan?.path
    const files: Core.BandFiles = {
      sid, now: await nowMs($), state, band: rt.cfg.workflow.band, foldAfterSec: rt.cfg.workflow.foldAfterSec,
      flow: raw === undefined ? undefined : Core.parseFlow(parseJson(raw)) ?? 'keep',
    }
    const planText = state.plan !== undefined ? await readText($, state.plan.path) : undefined
    if (planText !== undefined) files.planText = planText
    const prev = await read($, BAND)
    const next = Core.bandRefresh(prev, files)
    if (force || Core.bandChanged(prev, next)) await update($, BAND, cur => Core.bandRefresh(cur, files))
    watchBand($, S, next)
  } catch (err) {
    debug($, `band: ${errText(err)}`)
  }
}

function watchBand($: EngineInterface, S: ModState, b: Core.BandState): void {
  if (!S.interactive) return
  if (Core.bandActive(b)) S.poll ??= $.clock.every(BAND_POLL_MS, () => void pollBand($, S))
  else if (S.poll !== undefined) { S.poll.cancel(); S.poll = undefined }
  const at = Core.bandFoldAt(b)
  if (at === S.fold?.at) return
  S.fold?.timer.cancel()
  S.fold = at === undefined ? undefined : { at, timer: $.clock.after(Math.max(0, at - b.stamp), () => { S.fold = undefined; void refreshBand($, S, true) }) }
}

async function pollBand($: EngineInterface, S: ModState): Promise<void> {
  const dir = `${(await runtime($, S)).buracleHome}/sessions/claude/${S.sid}`
  const marks = [Math.floor((await nowMs($)) / 60_000), await mtimeOf($, `${dir}/flow.json`), await mtimeOf($, `${dir}/state.json`), S.planPath !== undefined ? await mtimeOf($, S.planPath) : 0].join('|')
  if (marks !== S.seen) {
    S.seen = marks
    await refreshBand($, S)
  }
}

async function recordStart($: EngineInterface, S: ModState, workflow: string, args: string, source: Core.FlowSource): Promise<void> {
  try {
    const sid = await sessionId($, S)
    const rt = await runtime($, S)
    if (sid !== '' && rt.buracleHome !== '') {
      const path = `${rt.buracleHome}/sessions/claude/${sid}/flow.json`
      const raw = await readText($, path)
      const rec = raw === undefined ? undefined : Core.parseFlow(parseJson(raw))
      if (raw === undefined || rec !== undefined) {
        const title = args.split('\n')[0]?.trim() ?? ''
        const r = Core.flowStart(rec, title !== '' ? { workflow, title, source } : { workflow, source }, await nowMs($))
        if (r.changed) await $.fs.write(path, `${JSON.stringify(r.record, null, 2)}\n`)
      }
    }
  } catch (err) {
    debug($, `flow start: ${errText(err)}`)
  }
  await refreshBand($, S)
}

async function agentStarted($: EngineInterface, id: string, input: Record<string, unknown>): Promise<void> {
  const label = str(input['subagent_type']) ?? str(input['description']) ?? 'agent'
  const now = await nowMs($)
  await bandWrite($, b => Core.bandAgentStart(b, { id, label }, now))
}

async function workToolRan($: EngineInterface, S: ModState, tool: string, input: Record<string, unknown>, result: unknown, id: string): Promise<void> {
  try {
    const res = isObj(result) ? result : {}
    if (tool === 'Skill') {
      const workflow = Core.workflowOfSkill(str(input['skill']) ?? '')
      if (workflow !== undefined) await recordStart($, S, workflow, str(input['args']) ?? '', 'skill')
    } else if (tool === 'Agent') {
      const agentId = str(res['agentId'])
      let running = false
      if (agentId !== undefined) {
        try {
          running = (await $.agent.list()).some(a => a.id === agentId && (a.status === 'running' || a.status === 'pending' || a.status === 'waiting'))
        } catch { running = false }
      }
      await bandWrite($, b => (running && agentId !== undefined ? Core.bandAgentBind(b, id, agentId) : Core.bandAgentEnd(b, id)))
    } else {
      await bandWrite($, b => Core.bandTodoTool(b, tool, input, result))
    }
  } catch (err) {
    debug($, `band ${tool}: ${errText(err)}`)
  }
}

async function turnEnded($: EngineInterface, S: ModState, answer: string, durationMs: number, reason: string): Promise<void> {
  const summary = Core.receiptLine(S.receipt, answer)
  if (summary !== undefined && summary.warn) $.ui.toast(summary.line, { timeoutMs: 8_000 })
  else if (summary !== undefined) $.ui.log(summary.line, { to: 'debug' })
  const unverified = Core.unverified(S.receipt)
  S.receipt = Core.emptyReceipt()
  await refreshBand($, S)
  if (!S.interactive) return
  const now = await nowMs($)
  if (unverified && reason === 'answer') {
    S.suggest = { text: CHECK_SUGGESTION, until: now + 60_000 }
    $.clock.after(1_500, () => void suggestNow($, S))
  }
  const after = (await runtime($, S)).cfg.workflow.notifyAfterSec
  if (after > 0 && durationMs >= after * 1000 && reason !== 'aborted') {
    const run = Core.bandSummary(Core.bandView(Core.bandInputOf(await read($, BAND))))
    const text = Core.longTurnText(durationMs, after, run)
    if (text !== undefined) {
      try { await $.ui.notify(text, { title: 'Buracle' }) } catch (err) { debug($, `notify: ${errText(err)}`) }
    }
  }
}

async function resumeHint($: EngineInterface, S: ModState): Promise<void> {
  if (!S.interactive) return
  const hint = Core.resumeSuggestion(Core.bandViewOf(await read($, BAND)))
  if (hint === undefined) return
  S.suggest = { text: hint, until: (await nowMs($)) + 10 * 60_000 }
  await suggestNow($, S)
}

async function suggestNow($: EngineInterface, S: ModState): Promise<void> {
  const s = S.suggest
  if (s === undefined || (await nowMs($)) >= s.until) return
  try { await $.prompt.suggest({ text: s.text }) } catch (err) { debug($, `suggest: ${errText(err)}`) }
}

function segmentStyle(s: Core.Segment): { color?: string; dimColor?: boolean; bold?: boolean } {
  const color = Core.themeOf(s.color)
  return lineStyle({ text: s.text, ...(color !== undefined ? { color } : {}), ...(s.dim === true ? { dim: true } : {}), ...(s.bold === true ? { bold: true } : {}) })
}

async function consentDialog($: EngineInterface, S: ModState, commands: readonly string[]): Promise<string | undefined> {
  if (commands.length === 0) return undefined
  const rt = await runtime($, S)
  const sid = await sessionId($, S)
  if (sid === '' || rt.buracleHome === '') return undefined
  const path = `${rt.buracleHome}/sessions/claude/${sid}/consent.json`
  let state = Core.parseConsent(await readJson($, path))
  const now = await nowMs($)
  const added: Core.ConsentGrant[] = []
  for (let asked = 0; asked < Core.CONSENT_KINDS.length; asked++) {
    const v = Core.consentVerdictAll(commands, state, now)
    if (v.allow || v.need === undefined) break
    const need = v.need
    const shown = need.command.length > 120 ? `${need.command.slice(0, 117)}...` : need.command
    let answer: string
    try {
      answer = await $.ui.ask(`Buracle consent: \`${shown}\` ${need.summary}. Run it?`, { header: 'Consent', options: [ALLOW_ONCE, ALLOW_SESSION, REFUSE] })
    } catch {
      break
    }
    if (answer !== ALLOW_ONCE && answer !== ALLOW_SESSION) {
      return `Buracle H20 (consent.gate): the user refused \`${shown}\` in the consent dialog. Do not run it or anything that does the same; ask the user what they want instead.`
    }
    const uses = commands.filter(c => Core.consentNeeds(c).some(n => n.kind === need.kind || (need.kind === 'force-push' && n.kind === 'push'))).length
    const grant: Core.ConsentGrant = answer === ALLOW_SESSION
      ? { kind: need.kind, until: now + SESSION_GRANT_MS, uses: 1_000, source: 'ask' }
      : { kind: need.kind, until: now + 5 * 60_000, uses: Math.max(1, uses), source: 'ask' }
    state = Core.addConsentGrants(state, [grant], now)
    added.push(grant)
  }
  if (added.length > 0) await recordDialogGrants($, rt, path, added, now)
  return undefined
}

const MOD_LOCK = '{"holder":"claude-mod"}'
const MOD_LOCK_TRIES = 25
// $.fs has no exclusive create or delete: bun does both, on every platform (the last arguments are the text and the lock path).
const LOCK_TAKE = "require('node:fs').writeFileSync(process.argv.at(-1), process.argv.at(-2), { flag: 'wx' })"
const LOCK_DROP = "require('node:fs').rmSync(process.argv.at(-1), { force: true })"

async function recordDialogGrants($: EngineInterface, rt: Runtime, path: string, grants: readonly Core.ConsentGrant[], now: number): Promise<void> {
  const lock = `${path}.lock`
  const held = await takeConsentLock($, rt, lock)
  try {
    const fresh = Core.parseConsent(await readJson($, path))
    await $.fs.write(path, JSON.stringify(Core.addConsentGrants(fresh, grants, now)) + '\n')
  } finally {
    if (held) {
      try { await $.process.run([rt.bun, '-e', LOCK_DROP, lock], { timeoutMs: 3_000 }) } catch (err) { debug($, `consent unlock: ${errText(err)}`) }
    }
  }
}

async function takeConsentLock($: EngineInterface, rt: Runtime, lock: string): Promise<boolean> {
  for (let attempt = 0; attempt < MOD_LOCK_TRIES; attempt++) {
    try {
      const made = await $.process.run([rt.bun, '-e', LOCK_TAKE, MOD_LOCK, lock], { timeoutMs: 3_000 })
      if (made.exitCode === 0) return true
      if (!(await $.fs.exists(lock).catch(() => false))) return false
    } catch (err) {
      debug($, `consent lock: ${errText(err)}`)
      return false
    }
  }
  return false
}

function noteCommandRan($: EngineInterface, S: ModState, command: string, failed: boolean): void {
  const r = Core.noteCommand(S.receipt, command, failed)
  S.receipt = r.state
  if (r.alarm !== undefined) $.ui.toast(`Buracle: ${r.alarm}`, { timeoutMs: 10_000 })
}

function noteEditRan($: EngineInterface, S: ModState, tool: string, e: object): string | undefined {
  const edit = Core.editOf(tool, e as Record<string, unknown>)
  if (edit === undefined) return undefined
  S.touched = [edit.path, ...S.touched.filter(p => p !== edit.path)].slice(0, 40)
  const delta = Core.lineDelta(edit.removed, edit.added)
  const r = Core.noteEdit(S.receipt, { path: edit.path, added: delta.added, removed: delta.removed, removedText: edit.removed.slice(0, 2_000), addedText: edit.added.slice(0, 2_000) })
  S.receipt = r.state
  if (r.alarm !== undefined) $.ui.toast(`Buracle: ${r.alarm}`, { timeoutMs: 10_000 })
  return edit.path
}

async function masked($: EngineInterface, S: ModState, toolUseId: string, ran: ToolCallResult): Promise<ToolCallResult> {
  try {
    if (ran.deny !== undefined) return ran
    const rt = await runtime($, S)
    if (!rt.cfg.guards.redact) return ran
    const r = Core.maskSecrets(ran.result, MASK_MAX_CHARS)
    if (r.count === 0) return ran
    try { $.ui.notice(toolUseId, `Buracle: ${r.count === 1 ? '1 secret value' : `${r.count} secret values`} hidden from the model`) } catch {  }
    return { ...ran, result: r.value } as ToolCallResult
  } catch (err) {
    debug($, `mask: ${errText(err)}`)
    return ran
  }
}

async function contextToast($: EngineInterface, S: ModState, pct: number | undefined): Promise<void> {
  const w = Core.contextWatch(S.warned, pct, (await runtime($, S)).cfg.context)
  S.warned = w.warned
  if (w.warn === undefined || pct === undefined) return
  const critical = w.band === 'critical'
  $.ui.toast(`Context ${Math.round(pct)}% full${critical ? ' (critical). Auto-compaction is near; run /compact now.' : '. Run /compact at a good moment.'}`, { timeoutMs: critical ? 8_000 : 6_000 })
}

async function compactInstructions($: EngineInterface, S: ModState, base: string | undefined): Promise<string | undefined> {
  const sid = await sessionId($, S)
  const rt = await runtime($, S)
  if (sid === '' || rt.buracleHome === '') return base
  const state = await loadSessionState($, rt, sid)
  await refreshBand($, S)
  const band = await read($, BAND)
  const view = Core.bandView(Core.bandInputOf(band))
  const extra: Core.CompactExtra = { touched: S.touched, background: band.agents.map(a => `${a.label} (subagent)`) }
  if (view.visible && view.endedAt === undefined) extra.flow = Core.bandSummary(view)
  return Core.compactInstructionsWith(base, state, extra)
}

async function memoryLines($: EngineInterface, S: ModState): Promise<Core.FlowPaneLine[]> {
  const rt = await runtime($, S)
  const status = rt.buracleHome !== '' ? await readJson($, `${rt.buracleHome}/state/memory/status/_global.json`) : undefined
  return Core.memoryPaneLines(status, await memoryUiUrl($, S), rt.brain)
}

async function planLines($: EngineInterface, S: ModState): Promise<Core.FlowPaneLine[]> {
  const rt = await runtime($, S)
  const sid = await sessionId($, S)
  if (sid === '' || rt.buracleHome === '') return [{ text: 'No session information.', dim: true }]
  return Core.planPaneLines(Core.bandView(Core.bandInputOf(await read($, BAND))), await loadSessionState($, rt, sid))
}

async function openPane($: EngineInterface, id: string, close = false): Promise<void> {
  try {
    if (close) await $.ui.close({ id })
    else await $.ui.open({ id, title: id === MEMORY_PANE ? 'Buracle \u00B7 memory' : 'Buracle \u00B7 plan', focus: true, closeOnEscape: true })
  } catch (err) {
    debug($, `pane ${id}: ${errText(err)}`)
  }
}

function lineStyle(line: Core.FlowPaneLine): { color?: string; dimColor?: boolean; bold?: boolean } {
  return { ...(line.color !== undefined ? { color: line.color } : {}), ...(line.dim === true ? { dimColor: true } : {}), ...(line.bold === true ? { bold: true } : {}) }
}

async function runtime($: EngineInterface, S: ModState): Promise<Runtime> {
  const now = Date.now()
  const cached = S.rt
  if (cached !== undefined && now - cached.checkedAt < 2_000) return cached.value
  const home = S.home ??= trimSlash(str(await $.env.get('HOME').catch(() => undefined)) ?? str(await $.env.get('USERPROFILE').catch(() => undefined)) ?? '')
  const bh = str(await $.env.get('BURACLE_HOME').catch(() => undefined))
  const buracleHome = bh !== undefined ? trimSlash(expandHome(bh, home)) : home !== '' ? `${home}/.buracle` : ''
  const path = buracleHome !== '' ? `${buracleHome}/state/runtime-config.json` : ''
  let mtimeMs = -1
  if (path !== '') mtimeMs = await mtimeOf($, path)
  if (cached !== undefined && cached.path === path && cached.mtimeMs === mtimeMs) {
    cached.checkedAt = now
    return cached.value
  }
  let cfg = Core.defaultConfig()
  let resolved: Record<string, unknown> = {}
  if (mtimeMs >= 0) {
    try {
      const raw = JSON.parse(await $.fs.read(path)) as unknown
      const snap = Core.runtimeSnapshotConfig(raw, cfg)
      cfg = snap.config
      for (const w of snap.warnings) debug($, w)
      if (snap.errors.length > 0) debug($, `runtime config: invalid values kept their defaults (${snap.errors.join('; ')})`)
      if (isObj(raw) && raw['v'] === Core.RUNTIME_SNAPSHOT_VERSION && isObj(raw['resolved'])) resolved = raw['resolved']
    } catch (err) {
      debug($, `runtime config unreadable (${errText(err)}); using the defaults`)
    }
  }
  const brain = str(resolved['brain']) ?? (buracleHome !== '' ? `${buracleHome}/brain` : '')
  const shim = str(resolved['shim']) ?? (buracleHome !== '' ? `${buracleHome}/bin/buracle` : '')
  const bun = str(resolved['bun']) ?? 'bun'
  // The process API runs argv without a shell and the Windows shim (buracle.cmd) needs cmd.exe: the plugin's bun launcher
  // (in the checkout's harness/claude, where Claude Code reads the plugin) runs the same CLI.
  const repo = str(resolved['repoRoot'])
  const cli = /\.(?:cmd|bat)$/i.test(shim) && repo !== undefined ? [bun, `${trimSlash(repo)}/harness/claude/bin/buracle.ts`] : [shim]
  const value: Runtime = { home, buracleHome, brain: trimSlash(brain), shim, bun, cli, cfg }
  S.rt = { path, mtimeMs, checkedAt: now, value }
  return value
}

async function sessionId($: EngineInterface, S: ModState): Promise<string> {
  try {
    const id = await $.session.id()
    if (SID_RE.test(id) && id !== S.sid) {
      S.sid = id
      S.receipt = Core.emptyReceipt()
      S.warned = 'ok'
      S.touched = []
    }
  } catch {  }
  return S.sid
}

async function nowMs($: EngineInterface): Promise<number> {
  try { return await $.clock.now() } catch { return Date.now() }
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try { return await $.fs.read(path) } catch { return undefined }
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  const text = await readText($, path)
  return text === undefined ? undefined : parseJson(text)
}

async function mtimeOf($: EngineInterface, path: string): Promise<number> {
  try { return (await $.fs.stat(path)).mtimeMs } catch { return -1 }
}

async function loadSessionState($: EngineInterface, rt: Runtime, sid: string): Promise<Core.SessionState> {
  const raw = await readJson($, `${rt.buracleHome}/sessions/claude/${sid}/state.json`)
  if (isObj(raw) && raw['v'] === 1 && isObj(raw['guard'])) return raw as unknown as Core.SessionState
  return { v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 } }
}

function debug($: EngineInterface, text: string): void {
  try { $.ui.log(`buracle: ${text}`, { to: 'debug' }) } catch {  }
}

function patternOf(source: string): RegExp {
  try { return new RegExp(source) } catch { return /$^/ }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}

function expandHome(path: string, home: string): string {
  if (home === '') return path
  if (path === '~') return home
  return path.startsWith('~/') ? `${home}/${path.slice(2)}` : path
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function firstLine(text: string): string {
  return (text.split('\n').find(l => l.trim() !== '') ?? '').trim().slice(0, 300)
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
