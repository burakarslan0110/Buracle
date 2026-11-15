import { agentDirConflict } from '../shared/agent-dir'
import { stubAdapter } from '../shared/stub'

export const adapter = stubAdapter('pi', async ctx => {
  const conflict = await agentDirConflict(ctx.paths)
  return conflict === undefined ? [] : [{ level: 'warn', check: 'pi.agent-dir', detail: conflict.message }]
})
export default adapter
