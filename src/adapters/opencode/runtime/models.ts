import type { ModelRef, ServerContext } from './types'
import { asRecord, errText, num, str } from './util'

export class ModelFacts {
  private limits: Map<string, number> | undefined
  private loading: Promise<void> | undefined

  constructor(private readonly ctx: Pick<ServerContext, 'model' | 'location'>, private readonly log: (msg: string, data?: unknown) => void) {}

  invalidate(): void {
    this.limits = undefined
  }

  effortOf(model: ModelRef | undefined): string | undefined {
    if (model === undefined) return undefined
    return model.variant !== undefined && model.variant !== '' && model.variant !== 'default' ? model.variant : undefined
  }

  async limit(ref: ModelRef): Promise<number | undefined> {
    if (this.limits === undefined) {
      this.loading ??= (async () => {
        const map = new Map<string, number>()
        try {
          const res = await this.ctx.model.list({ location: { directory: this.ctx.location.directory } })
          const list = Array.isArray(res) ? res : asRecord(res)['data']
          if (Array.isArray(list)) {
            for (const m of list) {
              const r = asRecord(m)
              const id = str(r['id'])
              const provider = str(r['providerID'])
              const ctxLimit = num(asRecord(r['limit'])['context'])
              if (id !== undefined && provider !== undefined && ctxLimit !== undefined) map.set(`${provider}/${id}`, ctxLimit)
            }
          }
        } catch (e) { this.log('model list unavailable', { error: errText(e) }) }
        this.limits = map
        this.loading = undefined
      })()
      await this.loading
    }
    return this.limits?.get(`${ref.providerID}/${ref.id}`)
  }
}
