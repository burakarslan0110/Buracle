import type { BandView } from '../../../core/flow/band'
import { bandSummary, resumeSuggestion } from '../../../core/flow/band'
import { NoticeReader } from './notice-board'
import type { TuiToastVariant } from './types'

export interface TuiNoticeHost {
  now(): number
  toast(message: string, variant: TuiToastVariant): void
  band(sid: string): BandView
  bandOn(): boolean
  busy(sid: string): boolean
}

export function resumeText(view: BandView): string | undefined {
  const suggestion = resumeSuggestion(view)
  return suggestion !== undefined ? `This session has an unfinished workflow run (${bandSummary(view)}). To go on, say: ${suggestion}` : undefined
}

export class TuiNotices {
  private readonly reader = new NoticeReader()
  private readonly hinted = new Set<string>()

  constructor(private readonly host: TuiNoticeHost) {}

  poll(sid: string | undefined): number {
    const items = this.reader.take(sid, this.host.now())
    for (const n of items) this.host.toast(n.text, n.variant)
    return items.length
  }

  sessionShown(sid: string | undefined): boolean {
    if (sid === undefined || this.hinted.has(sid)) return false
    if (this.hinted.size >= 64) this.hinted.clear()
    this.hinted.add(sid)
    const text = !this.host.bandOn() || this.host.busy(sid) ? undefined : resumeText(this.host.band(sid))
    if (text === undefined) return false
    this.host.toast(text, 'info')
    return true
  }
}
