import type { SessionEndDecision, SessionEndInput } from '../../../core/events'
import type { PipelineDeps } from './types'

export interface SessionEndPorts {
  /** What the harness does when the memory layer has no finalizer to start. */
  noFinalizer?(sid: string): void | Promise<void>
}

/** sessionEnd (H14): close the memory UI's session record and start the detached memory finalizer. */
export async function sessionEnd(input: SessionEndInput, d: PipelineDeps & SessionEndPorts): Promise<SessionEndDecision> {
  const { harness: H, sessionId: sid } = input
  await d.step('H14 memory UI', undefined, () => d.ui.ended(H, sid))
  if (d.captureOff) return { finalized: false }
  return d.step('H14 finalizer', { finalized: false }, async () => {
    const spawn = await d.memory('spawnFinalizer')
    if (spawn === undefined) { await d.noFinalizer?.(sid); return { finalized: false } }
    await spawn(H, sid)
    return { finalized: true }
  })
}
