export interface FlowPhaseDef {
  id: string
  label: string
  short: string
}

export interface FlowDef {
  id: string
  phases: readonly FlowPhaseDef[]
  topLevel: boolean
}

function phases(list: ReadonlyArray<readonly [string, string, string]>): FlowPhaseDef[] {
  return list.map(([id, label, short]) => ({ id, label, short }))
}

export const FLOW_CATALOG: Readonly<Record<string, FlowDef>> = {
  'plan-build': {
    id: 'plan-build', topLevel: true,
    phases: phases([['plan', 'Plan', 'Plan'], ['approve', 'Approve', 'Appr'], ['implement', 'Implement', 'Impl'], ['verify', 'Verify', 'Verify']]),
  },
  'goal-build': {
    id: 'goal-build', topLevel: true,
    phases: phases([['goal', 'Goal', 'Goal'], ['contract', 'Contract', 'Contr'], ['build', 'Build', 'Build'], ['judge', 'Judge', 'Judge'], ['verify', 'Verify', 'Verify'], ['handback', 'Hand back', 'Hand']]),
  },
  bugfix: {
    id: 'bugfix', topLevel: true,
    phases: phases([['investigate', 'Investigate', 'Inv'], ['red', 'RED', 'RED'], ['fix', 'Fix', 'Fix'], ['prove', 'Prove', 'Prove'], ['gate', 'Quality gate', 'Gate'], ['finish', 'Finish', 'Finish']]),
  },
  requirements: {
    id: 'requirements', topLevel: true,
    phases: phases([['understand', 'Understand', 'Under'], ['research', 'Research', 'Res'], ['ideate', 'Ideate', 'Ideate'], ['clarify', 'Clarify', 'Clar'], ['propose', 'Propose', 'Prop'], ['converge', 'Converge', 'Conv'], ['write', 'Write', 'Write'], ['handoff', 'Hand off', 'Hand']]),
  },
  research: {
    id: 'research', topLevel: false,
    phases: phases([['frame', 'Frame', 'Frame'], ['recall', 'Recall', 'Recall'], ['plan', 'Plan', 'Plan'], ['gather', 'Gather', 'Gather'], ['verify', 'Verify', 'Verify'], ['write', 'Write', 'Write']]),
  },
  inspect: {
    id: 'inspect', topLevel: true,
    phases: phases([['frame', 'Frame', 'Frame'], ['locate', 'Locate', 'Locate'], ['trace', 'Trace', 'Trace'], ['challenge', 'Challenge', 'Chall'], ['report', 'Report', 'Report']]),
  },
  'dead-code': {
    id: 'dead-code', topLevel: true,
    phases: phases([['collect', 'Collect', 'Coll'], ['check', 'Check', 'Check'], ['classify', 'Classify', 'Class'], ['plan', 'Plan', 'Plan'], ['report', 'Report', 'Report']]),
  },
  'project-rules': {
    id: 'project-rules', topLevel: false,
    phases: phases([['inventory', 'Inventory', 'Inv'], ['discover', 'Discover', 'Disc'], ['verify', 'Verify', 'Verify'], ['audit', 'Audit', 'Audit'], ['write', 'Write', 'Write'], ['validate', 'Validate', 'Valid'], ['sync', 'Sync', 'Sync'], ['report', 'Report', 'Report']]),
  },
  'new-skill': {
    id: 'new-skill', topLevel: false,
    phases: phases([['capture', 'Capture', 'Capt'], ['overlap', 'Overlap', 'Ovrlap'], ['design', 'Design', 'Design'], ['write', 'Write', 'Write'], ['evals', 'Evals', 'Evals'], ['lint', 'Lint', 'Lint'], ['test', 'Test', 'Test'], ['publish', 'Publish', 'Pub']]),
  },
  'ab-test': {
    id: 'ab-test', topLevel: false,
    phases: phases([['frame', 'Frame', 'Frame'], ['cases', 'Cases', 'Cases'], ['budget', 'Budget', 'Budget'], ['arms', 'Arms', 'Arms'], ['smoke', 'Smoke', 'Smoke'], ['run', 'Run', 'Run'], ['score', 'Score', 'Score'], ['report', 'Report', 'Report']]),
  },
}

export const FLOW_WORKFLOWS: readonly string[] = Object.keys(FLOW_CATALOG)

export const FLOW_ID_RE = /^[a-z][a-z0-9-]{0,39}$/

export function flowDef(workflow: string): FlowDef | undefined {
  return Object.prototype.hasOwnProperty.call(FLOW_CATALOG, workflow) ? FLOW_CATALOG[workflow] : undefined
}

export function flowPhaseDef(workflow: string, phase: string): FlowPhaseDef | undefined {
  return flowDef(workflow)?.phases.find(p => p.id === phase)
}

export function flowPhaseLabel(workflow: string, phase: string): string {
  return flowPhaseDef(workflow, phase)?.label ?? phase
}

export function isTopLevelFlow(workflow: string): boolean {
  return flowDef(workflow)?.topLevel ?? false
}

export function flowPhaseProblem(workflow: string, phase: string): string | undefined {
  if (!FLOW_ID_RE.test(phase)) return `'${phase}' is not a phase id (lower-case kebab-case, 1-40 characters)`
  const def = flowDef(workflow)
  if (def === undefined || def.phases.some(p => p.id === phase)) return undefined
  return `'${phase}' is not a phase of ${workflow} (phases: ${def.phases.map(p => p.id).join(', ')})`
}

export function workflowOfSkill(name: string): string | undefined {
  const m = /^\/?buracle:([a-z][a-z0-9-]{0,39})$/.exec(name.trim())
  const id = m?.[1]
  return id !== undefined && flowDef(id) !== undefined ? id : undefined
}

export function workflowOfPrompt(text: string): { workflow: string; args: string } | undefined {
  const t = typeof text === 'string' ? text.trimStart() : ''
  const tagged = /<command-name>\s*\/?(buracle:[a-z][a-z0-9-]*)\s*<\/command-name>/.exec(t.slice(0, 400))
  if (tagged !== null) {
    const workflow = workflowOfSkill(tagged[1] ?? '')
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1] ?? ''
    return workflow !== undefined ? { workflow, args: args.trim() } : undefined
  }
  const typed = /^\/(buracle:[a-z][a-z0-9-]*)(?=\s|$)[ \t]*([^\n]*)/.exec(t)
  const workflow = typed !== null ? workflowOfSkill(typed[1] ?? '') : undefined
  return workflow !== undefined ? { workflow, args: (typed?.[2] ?? '').trim() } : undefined
}
