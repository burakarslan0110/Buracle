export interface Registration { dispose(): Promise<void> }
export type HookRegistrar<Spec> = <Name extends keyof Spec & string>(name: Name, callback: (event: Spec[Name]) => Promise<void> | void, options?: { providerID?: string }) => Promise<Registration>
export type TransformRegistrar<Editor> = (callback: (editor: Editor) => void) => Promise<Registration>

export interface LocationInfo { directory: string; workspaceID?: string; project: { id: string; directory: string; canonical: string } }

export type PermissionEffect = 'allow' | 'deny' | 'ask'
export interface PermissionEvaluation {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: { type: 'tool'; messageID: string; id: string }
  effect: PermissionEffect
  message?: string
}

export interface ToolContent { type: 'text'; text: string }
export interface ToolFileContent { type: 'file'; uri: string; mime: string; name?: string }
export interface ToolResultShape { output?: unknown; content?: string | ReadonlyArray<ToolContent | ToolFileContent>; metadata?: Record<string, unknown> }
export interface ToolExecuteBefore { tool: string; readonly sessionID: string; readonly agent: string; readonly messageID: string; readonly id: string; input: unknown }
export type ToolExecuteAfter = {
  readonly tool: string; readonly sessionID: string; readonly agent: string; readonly messageID: string; readonly id: string; readonly input: unknown
} & ({ readonly status: 'completed'; result: ToolResultShape } | { readonly status: 'error'; error: { message: string } })

export interface ModelRef { id: string; providerID: string; variant?: string }
export interface SystemPart { type: 'text'; text: string; cache?: unknown; metadata?: Record<string, unknown> }
export interface SessionContextEvent {
  readonly sessionID: string
  readonly model: ModelRef
  readonly agent: string
  system: SystemPart[]
  messages: unknown[]
  options: Record<string, unknown>
  tools: Record<string, unknown>
}
export interface SessionCompactionEvent extends SessionContextEvent { result?: { summary: string } }
export interface SessionHttpResponseEvent { readonly sessionID: string; readonly agent?: string; readonly model?: ModelRef; readonly kind?: string; readonly request?: unknown; response: { readonly status?: number; readonly headers: { get(name: string): string | null } } }
export interface SessionWsReceiveEvent { readonly sessionID: string; readonly model?: ModelRef; frame: unknown }

export interface SkillAttachment { id: string; mention?: { start: number; end: number; text: string } }
export interface PromptBody { text: string; files?: unknown[]; agents?: unknown[]; skills?: SkillAttachment[] }
export interface SessionPromptEvent {
  readonly sessionID: string
  readonly messageID: string
  prompt: PromptBody
  metadata?: Record<string, unknown>
  delivery: 'steer' | 'queue'
}
export interface ShellCreateBefore { command: string; cwd: string; timeout: number; shell: string; env: Record<string, string | undefined> }

export interface OpenCodeEvent { id?: string; type: string; created?: number; data?: Record<string, unknown>; location?: { directory: string } }

export interface PromptInput {
  sessionID: string
  text: string
  files?: unknown[]
  agents?: unknown[]
  skills?: SkillAttachment[]
  metadata?: Record<string, unknown>
  delivery?: 'steer' | 'queue'
  resume?: boolean
}

export interface CommandInvocation { readonly sessionID: string; readonly prompt: PromptBody; readonly delivery: 'steer' | 'queue' }
export interface CommandDefinition { readonly name: string; readonly description?: string; readonly execute: (input: CommandInvocation) => Promise<void> }
export interface CommandEditor { add(definition: CommandDefinition): void }

export interface ModelOverlay { settings?: Record<string, unknown>; headers?: Record<string, string>; body?: Record<string, unknown> }
export interface ModelVariant extends ModelOverlay { id: string }
export interface EditableModel extends ModelOverlay { id: string; providerID: string; variants?: ModelVariant[] }
export interface ModelEditor {
  list(providerID?: string): EditableModel[]
  update(providerID: string, modelID: string, update: (model: EditableModel) => void): void
}

export interface ServerContext {
  readonly app: { name?: string; version: string; channel?: string }
  readonly location: LocationInfo
  readonly options: Readonly<Record<string, unknown>>
  readonly permission: { hook: HookRegistrar<{ evaluate: PermissionEvaluation }> }
  readonly tool: { hook: HookRegistrar<{ 'execute.before': ToolExecuteBefore, 'execute.after': ToolExecuteAfter }> }
  readonly session: {
    hook: HookRegistrar<{ prompt: SessionPromptEvent, context: SessionContextEvent, compaction: SessionCompactionEvent, 'http.response': SessionHttpResponseEvent, 'experimental.ws.receive': SessionWsReceiveEvent }>
    prompt(input: PromptInput): Promise<unknown>
    get(input: { sessionID: string }): Promise<unknown>
  }
  readonly shell: { hook: HookRegistrar<{ 'create.before': ShellCreateBefore }> }
  readonly event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<OpenCodeEvent> }
  readonly model: { list(input?: unknown): Promise<unknown>; transform?: TransformRegistrar<ModelEditor> }
  readonly command?: { transform: TransformRegistrar<CommandEditor> }
  readonly skill?: { list(input?: { location?: { directory?: string } }): Promise<unknown> }
}
export type Cleanup = () => Promise<void> | void
export interface ServerPluginDefinition { readonly id: string; readonly setup: (ctx: ServerContext) => Promise<Cleanup | void> }

export interface TuiMessageTokens { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
export interface TuiSessionMessage { id: string; type: string; status?: string; tokens?: TuiMessageTokens; model?: { providerID: string; id: string; variant?: string } }
export interface TuiModelInfo { id: string; providerID: string; name?: string; limit?: { context?: number } }
export interface TuiPromptFooterInput { readonly sessionID?: string; readonly mode: 'normal' | 'shell'; readonly showDetails: boolean }
export interface TuiComposerInput { readonly sessionID: string }
export type TuiSlotClaim =
  | { readonly append: 'prompt.footer.status'; readonly render: (input: TuiPromptFooterInput) => unknown }
  | { readonly append: 'session.composer.top'; readonly render: (input: TuiComposerInput) => unknown }
export type TuiColor = unknown
export interface TuiTheme {
  readonly text: { readonly base: TuiColor; readonly muted: TuiColor; readonly feedback: Readonly<Record<'error' | 'warning' | 'success' | 'info', { readonly base: TuiColor }>> }
  readonly hue: Readonly<Record<'accent' | 'interactive' | 'neutral', Readonly<Record<number, TuiColor>>>>
}
export interface TuiKeymapCommand {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly group?: string
  readonly palette?: true
  readonly slash?: { readonly name: string; readonly aliases?: string[]; readonly arguments?: true }
  readonly run: (input?: string) => void | false | Promise<void>
}
export interface TuiKeymapLayer { readonly mode?: string; readonly commands?: readonly TuiKeymapCommand[] }
export type TuiToastVariant = 'info' | 'success' | 'warning' | 'error'
export interface TuiRoute { readonly type: string; readonly sessionID?: string }
export interface TuiDataEvent { readonly details?: { readonly type?: string; readonly data?: Record<string, unknown> } }
export interface TuiSelectOption { title: string; value: string; description?: string }
export type TuiDialogSelect = (options: { title: string; options: TuiSelectOption[]; placeholder?: string }) => Promise<string | undefined>
export interface TuiContext {
  readonly app?: { readonly version?: string }
  readonly location: { directory: string } | undefined
  readonly theme: TuiTheme
  readonly data: {
    readonly session: {
      get(sessionID: string): { id: string; location?: { directory: string }; revert?: { messageID?: string }; parentID?: string } | undefined
      cost(sessionID: string): number
      readonly message: { list(sessionID: string): ReadonlyArray<TuiSessionMessage> }
    }
    readonly location: {
      readonly model: { list(location?: { directory: string }): ReadonlyArray<TuiModelInfo> | undefined }
      readonly command?: { list(location?: { directory: string }): ReadonlyArray<{ name: string }> | undefined; sync?(location?: { directory: string }): Promise<void> }
    }
    readonly listen?: (handler: (event: TuiDataEvent) => void) => () => void
  }
  readonly keymap?: {
    layer(factory: () => TuiKeymapLayer): void
    commands?(): ReadonlyArray<TuiKeymapCommand>
  }
  readonly ui: {
    slot(claim: TuiSlotClaim): () => void
    readonly model: {
      current(): { providerID: string; modelID: string; variant?: string } | undefined
      readonly variant?: { list(): readonly string[] }
    }
    readonly toast?: { show(options: { title?: string; message: string; variant?: TuiToastVariant; duration?: number }): void }
    readonly dialog?: { alert(options: { title: string; message: string }): Promise<void>; select?: TuiDialogSelect; show?(render: () => unknown, onClose?: () => void): void; clear?(): void }
    readonly router?: { current(): TuiRoute }
  }
}
export interface TuiPluginDefinition { readonly id: string; readonly setup: (ctx: TuiContext) => Promise<Cleanup | void> | Cleanup | void }
