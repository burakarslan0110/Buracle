import { plugin } from 'bun'

plugin({
  name: 'buracle-test-tui-host',
  setup(build) {
    build.module('solid-js', () => ({
      loader: 'object',
      exports: {
        createSignal: <T>(v: T) => {
          let value = v
          return [() => value, (n: T | ((p: T) => T)) => { value = typeof n === 'function' ? (n as (p: T) => T)(value) : n }]
        },
        createMemo: <T>(fn: () => T) => () => fn(),
        onCleanup: () => undefined,
      },
    }))
    build.module('@opentui/solid', () => ({
      loader: 'object',
      exports: { useTerminalDimensions: () => () => ({ width: 200, height: 40 }) },
    }))
    build.module('@opentui/solid/jsx-runtime', () => ({
      loader: 'object',
      exports: { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }) },
    }))
  },
})

interface Node { type: unknown, props: Record<string, unknown> }

function texts(x: unknown): string[] {
  if (typeof x === 'function') return texts((x as () => unknown)())
  if (Array.isArray(x)) return x.flatMap(texts)
  if (typeof x === 'string') return [x]
  if (x !== null && typeof x === 'object' && 'props' in x) return texts((x as Node).props['children'])
  return []
}

function rows(x: unknown): string[] {
  const kids = (x as Node | undefined)?.props['children']
  const list = typeof kids === 'function' ? (kids as () => unknown)() : kids
  return (Array.isArray(list) ? list : list === undefined ? [] : [list]).map(r => texts(r).join(''))
}

const file = process.argv[2] as string
const bandSession = process.argv[3]
const runCommand = process.argv[4]
const runInput = process.argv[5]
const mod = await import(file) as { default: { id: string, setup: (ctx: unknown) => unknown } }
const claims: Array<{ append?: string, render: (input: unknown) => unknown }> = []
type Command = { id?: string, slash?: { name: string, aliases?: string[], arguments?: boolean }, run: (input?: string) => unknown }
const layers: Array<() => { commands?: Command[] }> = []
const toasts: Array<{ title?: string, message: string, variant?: string }> = []
const alerts: Array<{ title: string, message: string }> = []
const btw: Array<string | undefined> = []
const btwCommand: Command = { id: 'session.aside', slash: { name: 'btw', arguments: true }, run: (input?: string) => { btw.push(input) } }
const color = (name: string) => ({ name })
const ctx = {
  app: { version: '2.0.24' },
  location: { directory: process.cwd() },
  theme: {
    text: { base: color('base'), muted: color('muted'), feedback: { error: { base: color('red') }, warning: { base: color('yellow') }, success: { base: color('green') }, info: { base: color('blue') } } },
    hue: { accent: { 500: color('magenta') }, interactive: { 500: color('cyan') }, neutral: { 500: color('gray') } },
  },
  data: {
    session: {
      get: (id: string) => ({ id, location: { directory: process.cwd() } }),
      cost: () => 1.5,
      message: { list: () => [{ id: 'm1', type: 'assistant', tokens: { input: 300000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } }, model: { providerID: 'p', id: 'big' } }] },
    },
    location: {
      model: { list: () => [{ id: 'big', providerID: 'p', limit: { context: 1000000 } }] },
      command: { list: () => [{ name: 'plan-build' }, { name: 'brain' }], sync: async () => undefined },
    },
  },
  keymap: { layer: (factory: () => never) => { layers.push(factory) }, commands: () => [...layers.flatMap(f => f().commands ?? []), btwCommand] },
  ui: {
    slot: (claim: { append?: string, render: (input: unknown) => unknown }) => { claims.push(claim); return () => undefined },
    model: { current: () => ({ providerID: 'p', modelID: 'big', variant: 'high' }), variant: { list: () => ['high', 'xhigh', 'max'] } },
    toast: { show: (o: { title?: string, message: string, variant?: string }) => { toasts.push(o) } },
    dialog: { alert: async (o: { title: string, message: string }) => { alerts.push(o) } },
    router: { current: () => (bandSession !== undefined ? { type: 'session', sessionID: bandSession } : { type: 'home' }) },
  },
}
const cleanup = await mod.default.setup(ctx)
const footer = claims.find(c => c.append === 'prompt.footer.status')
const tree = footer?.render({ sessionID: 'ses_tui1', mode: 'normal', showDetails: true }) as Node | undefined
const line = texts(tree).join('')
const composer = claims.find(c => c.append === 'session.composer.top')
const band = composer !== undefined && bandSession !== undefined ? rows(composer.render({ sessionID: bandSession })) : []
const commands = layers.flatMap(f => f().commands ?? []).map(c => ({ id: c.id, slash: c.slash }))
if (runCommand !== undefined) {
  const cmd = layers.flatMap(f => f().commands ?? []).find(c => c.slash?.name === runCommand || c.slash?.aliases?.includes(runCommand) === true)
  await cmd?.run(runInput)
}
if (typeof cleanup === 'function') await (cleanup as () => unknown)()
process.stdout.write(JSON.stringify({ id: mod.default.id, slots: claims.map(c => c.append), root: tree?.type, line, band, commands, toasts, alerts, btw }) + '\n')
process.exit(0)
