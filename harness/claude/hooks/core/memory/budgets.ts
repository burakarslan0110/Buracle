export const MEMORY_INJECT = { maxLines: 150, maxBytes: 12288 } as const

export interface Headroom {
  max5hPct: number
  max7dPct: number
}

export const HEADROOM: Headroom = { max5hPct: 75, max7dPct: 85 }

export interface DistillBudget {
  promote: 'high' | 'medium'
  maxInputTokens: number
  maxOutputTokens: number
}

export const DISTILL_BUDGET: DistillBudget = { promote: 'medium', maxInputTokens: 8000, maxOutputTokens: 1000 }

export interface ReflectBudget {
  maxOpsPerRun: number
  maxSubQueries: number
  maxRounds: number
  maxInputTokens: number
  maxOutputTokens: number
  relateEveryMs: number
}

export const REFLECT_BUDGET: ReflectBudget = { maxOpsPerRun: 8, maxSubQueries: 6, maxRounds: 2, maxInputTokens: 6000, maxOutputTokens: 700, relateEveryMs: 6 * 3600_000 }

export interface VerifyBudget {
  maxPerRun: number
  maxInputTokens: number
  maxOutputTokens: number
}

export const VERIFY_BUDGET: VerifyBudget = { maxPerRun: 4, maxInputTokens: 8000, maxOutputTokens: 900 }

export interface BackupBudget {
  keep: number
  everyMs: number
}

export const BACKUP_BUDGET: BackupBudget = { keep: 10, everyMs: 24 * 3600_000 }
