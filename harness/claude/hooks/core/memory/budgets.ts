export const MEMORY_INJECT = { maxLines: 150, maxBytes: 12288 } as const

export interface Headroom {
  max5hPct: number
  max7dPct: number
}

export const HEADROOM: Headroom = { max5hPct: 75, max7dPct: 85 }

export interface DistillBudget {
  /** A candidate the model is at least this sure of (0..1) is filed as a memory of its kind; a less sure one waits as a capture. */
  promoteAt: number
  maxCandidates: number
  maxInputTokens: number
  maxOutputTokens: number
}

export const DISTILL_BUDGET: DistillBudget = { promoteAt: 0.6, maxCandidates: 3, maxInputTokens: 8000, maxOutputTokens: 1000 }

export interface CaptureBudget {
  /** How many other stale spools one session end takes care of besides its own. */
  pendingPerRun: number
  /** A spool this old, with no live session behind it, is pending. */
  pendingAfterMs: number
  /** After this many failed model calls the spool is kept for a human (`buracle mem capture`), not retried by session ends. */
  maxTries: number
}

export const CAPTURE_BUDGET: CaptureBudget = { pendingPerRun: 3, pendingAfterMs: 3 * 3600_000, maxTries: 3 }

export interface BackupBudget {
  keep: number
}

export const BACKUP_BUDGET: BackupBudget = { keep: 10 }
