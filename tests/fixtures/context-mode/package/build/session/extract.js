function row(type, category, data, priority) {
  return { type, category, data: String(data ?? ''), priority }
}

function isError(input) {
  if (input.tool_output?.isError === true) return true
  return input.tool_name === 'Bash' && /exit code [1-9]|error:|Error:|FAIL|failed/i.test(String(input.tool_response ?? ''))
}

export function extractEvents(input) {
  try {
    const out = []
    const name = input.tool_name
    const ti = input.tool_input ?? {}
    if (name === 'Read') {
      const p = String(ti.file_path ?? '')
      if (/AGENTS\.md$/.test(p)) {
        out.push(row('rule', 'rule', p, 1))
        if (input.tool_response) out.push(row('rule_content', 'rule', input.tool_response, 1))
      }
      out.push(row('file_read', 'file', p, 1))
    }
    if (name === 'Edit') out.push(row('file_edit', 'file', ti.file_path, 1))
    if (name === 'Write') out.push(row('file_write', 'file', ti.file_path, 1))
    if (name === 'apply_patch' && !isError(input)) {
      for (const line of String(ti.command ?? '').split('\n')) {
        const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
        if (m) out.push(row(m[1] === 'Add' ? 'file_write' : 'file_edit', 'file', m[2].trim(), 1))
      }
    }
    if (name === 'Bash') {
      const cmd = String(ti.command ?? '')
      const cd = /\bcd\s+(\S+)/.exec(cmd)
      if (cd) out.push(row('cwd', 'cwd', cd[1], 2))
      const commit = /\bgit\s+commit\b.*?-m\s+"([^"]+)"/.exec(cmd)
      if (commit) out.push(row('git_commit', 'git', commit[1], 2))
      else if (/\bgit\s+\w+/.test(cmd)) out.push(row('git', 'git', /\bgit\s+(\w+)/.exec(cmd)[1], 2))
    }
    if (name === 'TodoWrite') out.push(row('task', 'task', JSON.stringify(ti), 1))
    if (name === 'TaskCreate') out.push(row('task_create', 'task', JSON.stringify(ti), 1))
    if (name === 'TaskUpdate') out.push(row('task_update', 'task', JSON.stringify(ti), 1))
    if (name === 'AskUserQuestion') {
      let answer = ''
      try { answer = Object.values(JSON.parse(String(input.tool_response ?? '')).answers ?? {}).join(' | ') } catch {  }
      out.push(row('decision_question', 'decision', `Q: ${ti.questions?.[0]?.question ?? ''} -> A: ${answer}`, 2))
    }
    if (name === 'Agent') out.push(row(input.tool_response ? 'subagent_completed' : 'subagent_launched', 'subagent', `[completed] ${ti.prompt ?? ''} -> ${input.tool_response ?? ''}`, 2))
    if (name === 'Skill') out.push(row('skill', 'skill', ti.skill, 2))
    if (isError(input)) {
      out.push(row('error_tool', 'error', input.tool_response, 2))
      if (/FAIL/i.test(String(input.tool_response ?? ''))) out.push(row('constraint_discovered', 'constraint', input.tool_response, 2))
    }
    return out
  } catch {
    return []
  }
}

export function extractUserEvents(message) {
  try {
    const out = []
    const t = String(message).trim()
    if (t.length >= 15 && t.length <= 500 && /[,;]/.test(t) && !t.includes('?')) out.push(row('decision', 'decision', t, 2))
    out.push(row('intent', 'intent', t.endsWith('?') ? 'investigate' : 'implement', 4))
    return out
  } catch {
    return []
  }
}
