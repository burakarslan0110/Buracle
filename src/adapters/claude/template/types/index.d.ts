export type BandFlowSource = 'command' | 'prompt' | 'skill' | 'cli' | 'plan'
export type BandFlowOutcome = 'done' | 'failed' | 'cancelled'

export type BandFlowEntry = {
  workflow: string
  title?: string
  source: BandFlowSource
  startedAt: number
  phase?: { id: string; since: number; note?: string }
  step?: { text: string; done?: number; total?: number; at: number }
  ended?: { outcome: BandFlowOutcome; at: number }
}

export type BandFlowRecord = {
  v: 1
  stack: BandFlowEntry[]
  updatedAt: number
}

export type BandCriterion = { id: string; status: 'open' | 'pass' | 'fail'; oracle: boolean }

export type BandPlan = {
  path: string
  type: 'Feature' | 'Bugfix' | 'Build' | 'Plan'
  status: 'PENDING' | 'APPROVED' | 'IN_PROGRESS' | 'COMPLETE' | 'VERIFIED' | 'SAVED'
  phase: 'plan' | 'implement' | 'verify' | 'done'
  approved: boolean
  since: number
  title?: string
  done: number
  total: number
  current?: string
  rounds?: number
  criteria?: BandCriterion[]
}

export type BandTodo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string; id?: string }

export type BandAgent = { id: string; agentId?: string; label: string; startedAt: number }

export type BandInteraction = { state: 'running' | 'paused'; kind?: 'discussion' | 'decision' | 'manual'; reason?: string }

export type BandState = {
  v: 1
  sid: string
  stamp: number
  flow?: BandFlowRecord
  plan?: BandPlan
  interaction?: BandInteraction
  todos: BandTodo[]
  agents: BandAgent[]
  hidden?: number
  off?: boolean
  foldAfterSec: number
}

declare module 'claude-code' {
  interface PluginState {
    buracle: {
      band: BandState
    }
  }
}
