import type { BuracleConfig } from '../../../core/config'
import type { CatalogMcp, CatalogSkill } from '../../../core/catalog'
import type { Notice } from '../../../core/notices'
import type { StatusLayout } from '../../../core/status/model'
import type { RoutingPolicy } from '../../../core/policy/routing'

// The part of Pi's extension API this extension uses (docs/extensions.md of the pi-coding-agent package).

export interface PiUI {
  notify(message: string, type?: 'info' | 'warning' | 'error'): void
  select?(title: string, options: string[]): Promise<string | undefined>
  confirm?(title: string, message: string): Promise<boolean>
  setStatus?(key: string, text: string | undefined): void
  setWidget?(key: string, content: string[] | undefined, options?: { placement?: 'aboveEditor' | 'belowEditor' }): void
  setWorkingMessage?(message?: string): void
}

export interface PiContext {
  ui: PiUI
  mode: 'tui' | 'rpc' | 'json' | 'print'
  hasUI: boolean
  cwd: string
  sessionManager: { getSessionId(): string }
  model?: { id?: string } | undefined
  getContextUsage?(): { tokens?: number, percent?: number } | undefined
}

export interface PiTextBlock { type: string, text?: string }
export interface PiMessage { role?: string, content?: unknown }

export interface PiToolCallEvent { toolCallId: string, toolName: string, input: Record<string, unknown> }
export interface PiToolCallResult { block: true, reason: string }

export interface PiToolResultEvent {
  toolCallId: string, toolName: string, input: Record<string, unknown>
  content: PiTextBlock[], isError: boolean, parentToolCallId?: string
}
export interface PiToolResultPatch { content: PiTextBlock[] }

export interface PiInputEvent { text: string, source?: 'interactive' | 'rpc' | 'extension' }

export interface PiCustomMessage { customType: string, content: string, display: boolean }
export interface PiBeforeAgentStartEvent { messageType?: 'user' | 'custom', prompt?: string, systemPrompt: string }
export interface PiBeforeAgentStartResult { message?: PiCustomMessage, systemPrompt?: string }

export interface PiTurnEndEvent { message?: PiMessage }

export interface PiSettleEvent { entries: unknown[], aborted?: boolean }
export interface PiSettleResult { entries: unknown[], continue: true }

export interface PiCompactEvent { compactionEntry?: { summary?: string } }

export interface PiExtensionAPI {
  on(event: string, handler: (event: any, ctx: PiContext) => unknown): void
  sendMessage(message: PiCustomMessage, options?: { triggerTurn?: boolean, deliverAs?: 'steer' | 'followUp' | 'nextTurn' }): void
}

/** The canonical data `buracle build` bakes into the extension file. */
export interface PiGenerated {
  v: 1
  buracleVersion: string
  config: BuracleConfig
  routing: RoutingPolicy
  mcp: CatalogMcp[]
  mcpIds: string[]
  skills: CatalogSkill[]
  notices?: Notice[]
  /** The canonical usage tips, shown as the working message. */
  tips?: Array<{ id: string, text: string }>
  /** The footer entries (`ui.setStatus`): key to segment ids, with the layout they render by. */
  status?: { layout: StatusLayout, setStatus: Record<string, string[]> }
}
