import type { BuracleConfig } from '../../../core/config'
import type { CatalogMcp, CatalogSkill } from '../../../core/catalog'
import type { Notice } from '../../../core/notices'
import type { RoutingPolicy } from '../../../core/policy/routing'
import type { StatusLayout } from '../../../core/status/model'

export type OmpMode = 'tui' | 'rpc' | 'json' | 'print'

export interface OmpAgentIdentity { kind: 'main' | 'sub'; id: string; name: string; depth: number; parentId?: string }

export interface OmpUI {
  notify(message: string, type?: 'info' | 'warning' | 'error'): void
  setStatus(key: string, text: string | undefined): void
  setWidget(key: string, content: string[] | undefined, options?: { placement?: 'aboveEditor' | 'belowEditor' }): void
  select?(title: string, options: string[]): Promise<string | undefined>
  confirm?(title: string, message: string): Promise<boolean>
}

export interface OmpSessionManager {
  getSessionId(): string
  getCwd?(): string
  getSessionFile?(): string | undefined
  getBranch?(): unknown[]
  getArtifactsDir?(): string | null | undefined
}

export interface OmpContextUsage { tokens: number; contextWindow: number; percent: number }

export interface OmpEphemeralTurnOptions { promptText: string; tools?: false; maxTokens?: number; signal?: AbortSignal }
export interface OmpEphemeralTurnResult { replyText: string }

export type OmpTimer = unknown

export interface OmpContext {
  ui: OmpUI
  mode: OmpMode
  hasUI: boolean
  cwd: string
  sessionManager: OmpSessionManager
  model?: { id?: string; name?: string; provider?: string } | undefined
  agent?: OmpAgentIdentity
  getContextUsage?(): OmpContextUsage | undefined
  isIdle?(): boolean
  hasPendingMessages?(): boolean
  runEphemeralTurn?(options: OmpEphemeralTurnOptions): Promise<OmpEphemeralTurnResult>
  setInterval?(callback: (...args: unknown[]) => void, ms?: number): OmpTimer
  setTimeout?(callback: (...args: unknown[]) => void, ms?: number): OmpTimer
  clearTimer?(timer: OmpTimer): void
}

export interface OmpTextBlock { type: string; text?: string }
export interface OmpMessage { role?: string; content?: unknown }

export interface OmpToolCallEvent { type: 'tool_call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
export interface OmpToolCallResult { block?: boolean; reason?: string; input?: Record<string, unknown>; additionalContext?: string }

export interface OmpToolResultEvent {
  type: 'tool_result'; toolCallId: string; toolName: string; input: Record<string, unknown>
  content: OmpTextBlock[]; isError: boolean; details?: unknown
}
export interface OmpToolResultResult { additionalContext?: string; content?: OmpTextBlock[] }

export interface OmpInputEvent { type: 'input'; text: string; source: 'interactive' | 'rpc' | 'extension' }

export interface OmpBeforeAgentStartEvent { type: 'before_agent_start'; prompt: string; systemPrompt: string[] }
export interface OmpCustomMessage { customType: string; content: string; display?: boolean; details?: unknown }
export interface OmpBeforeAgentStartResult { message?: OmpCustomMessage; systemPrompt?: string[] }

export interface OmpTurnEndEvent { type: 'turn_end'; turnIndex: number; message?: OmpMessage; toolResults?: unknown[] }

export interface OmpSessionStopEvent {
  type: 'session_stop'; turn_id: number; session_id: string; stop_hook_active: boolean
  last_assistant_message?: OmpMessage; messages?: OmpMessage[]
}
export interface OmpSessionStopResult { decision?: 'block'; reason?: string; continue?: boolean; additionalContext?: string }

export interface OmpSessionSwitchEvent { type: 'session_switch'; reason?: 'new' | 'resume' | 'fork'; previousSessionFile?: string }

export interface OmpCompactingEvent { type: 'session.compacting'; sessionId: string }
export interface OmpCompactingResult { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }
export interface OmpCompactEvent { type: 'session_compact'; compactionEntry?: { summary?: string; preserveData?: Record<string, unknown> }; fromExtension?: boolean }

export interface OmpCommandOptions { description?: string; handler: (args: string, ctx: OmpContext) => Promise<void> }

export interface OmpExtensionAPI {
  on(event: string, handler: (event: any, ctx: OmpContext) => unknown): void
  registerCommand(name: string, options: OmpCommandOptions): void
  sendMessage(message: OmpCustomMessage, options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' | 'aside' }): void
  getThinkingLevel?(): string | undefined
  setLabel?(label: string): void
  getActiveTools?(): string[]
  setActiveTools?(names: string[]): Promise<void> | void
}

export interface OmpGenerated {
  v: 1
  buracleVersion: string
  testedWith: string
  minOmp: string
  config: BuracleConfig
  routing: RoutingPolicy
  mcp: CatalogMcp[]
  mcpIds: string[]
  skills: CatalogSkill[]
  plugins: string[]
  commands: string[]
  status: { layout: StatusLayout; setStatus: Record<string, string[]> }
  notices?: Notice[]
}
