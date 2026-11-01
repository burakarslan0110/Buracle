import { join } from 'node:path'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import type { AdapterContext } from '../../../src/adapters/registry'
import type { BakedData } from '../../../src/adapters/opencode/runtime/baked'
import type { HandoffRequest, MemoryBridge, SpoolEntry } from '../../../src/adapters/opencode/runtime/memory-bridge'
import type { CommandDefinition, EditableModel, ModelEditor, OpenCodeEvent, PromptInput, ServerContext } from '../../../src/adapters/opencode/runtime/types'
import { bakedData } from '../../../src/adapters/opencode/render'

export const REPO = paths.repoRoot()

let canonicalCache: ReturnType<typeof loadCanonicalSync> | undefined
export function canonical(): ReturnType<typeof loadCanonicalSync> {
  canonicalCache ??= loadCanonicalSync(join(REPO, 'canonical'))
  return canonicalCache
}

export function adapterContext(): AdapterContext {
  const c = canonical()
  return { repoRoot: REPO, config: c.config, canonical: c, paths, buracleBin: paths.shimPath() }
}

export function testBaked(over: Partial<BakedData> = {}): BakedData {
  return { ...bakedData(canonical(), { withLayout: true }), ...over }
}

export class EventQueue {
  private items: OpenCodeEvent[] = []
  private waiters: Array<(v: IteratorResult<OpenCodeEvent>) => void> = []
  private closed = false
  push(e: OpenCodeEvent): void {
    const w = this.waiters.shift()
    if (w) w({ value: e, done: false })
    else this.items.push(e)
  }
  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true })
  }
  iterable(signal?: AbortSignal): AsyncIterable<OpenCodeEvent> {
    signal?.addEventListener('abort', () => this.close(), { once: true })
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const item = this.items.shift()
          if (item !== undefined) return Promise.resolve({ value: item, done: false })
          if (this.closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise<IteratorResult<OpenCodeEvent>>(res => { this.waiters.push(res) })
        },
        return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }) },
      }),
    }
  }
}

export interface FakeContext {
  ctx: ServerContext
  events: EventQueue
  prompts: PromptInput[]
  hooks: Map<string, Array<(e: unknown) => unknown>>
  parents: Record<string, string | undefined>
  created: Record<string, number | undefined>
  commands: Map<string, CommandDefinition>
  modelTransforms: Array<(editor: ModelEditor) => void>
  skills: string[] | undefined
  trigger<T>(key: string, event: T): Promise<T>
}

export interface FakeContextOptions {
  models?: unknown[]
  skills?: string[] | undefined
  legacy?: boolean
}

export function fakeServerContext(directory: string, opts: FakeContextOptions = {}): FakeContext {
  const hooks = new Map<string, Array<(e: unknown) => unknown>>()
  const events = new EventQueue()
  const prompts: PromptInput[] = []
  const parents: Record<string, string | undefined> = {}
  const created: Record<string, number | undefined> = {}
  const commands = new Map<string, CommandDefinition>()
  const modelTransforms: Array<(editor: ModelEditor) => void> = []
  const reg = (domain: string) => async (name: string, cb: (e: unknown) => unknown) => {
    const key = `${domain}.${name}`
    hooks.set(key, [...(hooks.get(key) ?? []), cb])
    return { dispose: async () => { hooks.set(key, (hooks.get(key) ?? []).filter(x => x !== cb)) } }
  }
  const fake: FakeContext = {
    ctx: undefined as unknown as ServerContext,
    events, prompts, hooks, parents, created, commands, modelTransforms,
    skills: 'skills' in opts ? opts.skills : [],
    async trigger<T>(key: string, event: T): Promise<T> {
      for (const cb of hooks.get(key) ?? []) await cb(event)
      return event
    },
  }
  const modern = opts.legacy === true ? {} : {
    command: { transform: async (cb: (editor: { add(d: CommandDefinition): void }) => void) => { cb({ add: d => { commands.set(d.name, d) } }); return { dispose: async () => undefined } } },
    skill: {
      list: async () => {
        if (fake.skills === undefined) throw new Error('skill list unavailable')
        return { location: { directory }, data: fake.skills.map(id => ({ id, name: id })) }
      },
    },
  }
  fake.ctx = {
    app: { name: 'cli', version: '2.0.24', channel: 'latest' },
    location: { directory, project: { id: 'p1', directory, canonical: directory } },
    options: {},
    permission: { hook: reg('permission') },
    tool: { hook: reg('tool') },
    session: {
      hook: reg('session'),
      prompt: async (input: PromptInput) => { prompts.push(input); return { id: 'msg_x' } },
      get: async (input: { sessionID: string }) => {
        const at = created[input.sessionID]
        return { data: { id: input.sessionID, ...(parents[input.sessionID] !== undefined ? { parentID: parents[input.sessionID] } : {}), location: { directory }, ...(at !== undefined ? { time: { created: at, updated: at } } : {}) } }
      },
    },
    shell: { hook: reg('shell') },
    event: { subscribe: (o?: { signal?: AbortSignal }) => events.iterable(o?.signal) },
    model: {
      list: async () => ({ location: { directory }, data: opts.models ?? [{ id: 'm1', providerID: 'p', limit: { context: 1000, output: 100 } }] }),
      ...(opts.legacy === true ? {} : { transform: async (cb: (editor: ModelEditor) => void) => { modelTransforms.push(cb); return { dispose: async () => undefined } } }),
    },
    ...modern,
  } as unknown as ServerContext
  return fake
}

export function fakeModelEditor(models: EditableModel[]): ModelEditor & { models: EditableModel[] } {
  return {
    models,
    list: () => models,
    update: (providerID, modelID, update) => {
      const m = models.find(x => x.providerID === providerID && x.id === modelID)
      if (m !== undefined) update(m)
    },
  }
}

export interface FakeMemory extends MemoryBridge {
  appended: Array<{ sid: string, entries: SpoolEntry[] }>
  started: Array<{ sid: string, cwd: string }>
  prompts: string[]
  finalized: string[]
  handoffs: HandoffRequest[]
  contexts: Array<{ cwd: string, maxBytes: number }>
  /** The memory UI's session calls, as `started <sid>`, `seen <sid>`, `ended <sid>`. */
  uiCalls: string[]
}

export function fakeMemory(context?: string): FakeMemory {
  const m: FakeMemory = {
    appended: [], started: [], prompts: [], finalized: [], handoffs: [], contexts: [], uiCalls: [],
    ui: {
      started: sid => { m.uiCalls.push(`started ${sid}`) },
      seen: sid => { m.uiCalls.push(`seen ${sid}`) },
      ended: sid => { m.uiCalls.push(`ended ${sid}`) },
    },
    append(sid, entries) { m.appended.push({ sid, entries }) },
    start(sid, cwd) { m.started.push({ sid, cwd }) },
    prompt(sid) { m.prompts.push(sid) },
    finalize(sid) { m.finalized.push(sid) },
    async context(cwd, maxBytes) { m.contexts.push({ cwd, maxBytes }); return context },
    async handoff(req) { m.handoffs.push(req); return `handoff-${req.project ?? 'none'}` },
  }
  return m
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached in time')
    await Bun.sleep(5)
  }
}
