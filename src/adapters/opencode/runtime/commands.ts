import type { CatalogSkill } from '../../../core/catalog'
import { COMMAND_ARGS, COMMAND_MARK, runTitle } from './routing'
import type { CommandDefinition, CommandEditor, PromptInput, ServerContext, SkillAttachment } from './types'

export function workflowCommandSkills(skills: readonly CatalogSkill[]): CatalogSkill[] {
  return skills.filter(s => s.userInvocable).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function workflowCommandDescription(skill: Pick<CatalogSkill, 'id' | 'short' | 'description'>): string {
  const short = oneLine(skill.short ?? '')
  if (short !== '') return short
  const desc = oneLine(skill.description) || skill.id
  const first = /^(.+?[.!?])(\s|$)/.exec(desc)?.[1] ?? desc
  return first.length > 120 ? `${first.slice(0, 117)}...` : first
}

export function workflowPromptText(id: string, args: string, attached: boolean): string {
  const request = args.trim()
  const note = attached
    ? `(Run this with the Buracle ${id} workflow: its skill is attached above; follow it.)`
    : `(Run this with the Buracle ${id} workflow: load the \`${id}\` skill with the \`skill\` tool first and follow it; if the tool does not offer it, read ~/.agents/skills/${id}/SKILL.md.)`
  if (request !== '') return `${request}\n\n${note}`
  return `${note.slice(1, -1)} Take the task from the conversation; if it is not clear, ask for it.`
}

export interface WorkflowCommandDeps {
  knownSkills(sessionID: string): Promise<ReadonlySet<string> | undefined>
  flowStart(sessionID: string, workflow: string, title: string | undefined): void
  prompt(input: PromptInput): Promise<unknown>
}

function skillsOf(x: unknown): SkillAttachment[] {
  if (!Array.isArray(x)) return []
  return x.filter((s): s is SkillAttachment => s !== null && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string')
}

export function workflowCommand(skill: CatalogSkill, deps: WorkflowCommandDeps): CommandDefinition {
  return {
    name: skill.id,
    description: workflowCommandDescription(skill),
    execute: async invocation => {
      const sessionID = invocation.sessionID
      const args = typeof invocation.prompt?.text === 'string' ? invocation.prompt.text : ''
      deps.flowStart(sessionID, skill.id, runTitle(args))
      const attached = (await deps.knownSkills(sessionID))?.has(skill.id) === true
      const input: PromptInput = {
        sessionID,
        text: workflowPromptText(skill.id, args, attached),
        delivery: invocation.delivery === 'queue' ? 'queue' : 'steer',
        metadata: { [COMMAND_MARK]: skill.id, [COMMAND_ARGS]: args },
      }
      const skills = [...(attached ? [{ id: skill.id }] : []), ...skillsOf(invocation.prompt?.skills).filter(s => s.id !== skill.id)]
      if (skills.length > 0) input.skills = skills
      const files = invocation.prompt?.files
      if (Array.isArray(files) && files.length > 0) input.files = files
      const agents = invocation.prompt?.agents
      if (Array.isArray(agents) && agents.length > 0) input.agents = agents
      await deps.prompt(input)
    },
  }
}

export async function registerWorkflowCommands(ctx: Pick<ServerContext, 'command'>, skills: readonly CatalogSkill[], deps: WorkflowCommandDeps): Promise<boolean> {
  const domain = ctx.command
  if (domain === undefined || typeof domain.transform !== 'function') return false
  const list = workflowCommandSkills(skills)
  await domain.transform((editor: CommandEditor) => { for (const s of list) editor.add(workflowCommand(s, deps)) })
  return true
}
