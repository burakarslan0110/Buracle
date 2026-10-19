import { join } from 'node:path'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import * as paths from '../../engine/paths'

const H = 'claude' as const

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function addedText(tool: string, input: Record<string, unknown>, paths: readonly string[]): Record<string, string> {
  const outText: Record<string, string> = {}
  const path = paths[0]
  if (path === undefined) return outText
  if (tool === 'Write' && typeof input['content'] === 'string') outText[path] = input['content']
  else if (tool === 'Edit' && typeof input['new_string'] === 'string') outText[path] = input['new_string']
  else if (tool === 'NotebookEdit' && typeof input['new_source'] === 'string') outText[path] = input['new_source']
  else if (tool === 'MultiEdit' && Array.isArray(input['edits'])) outText[path] = input['edits'].map(e => (isObj(e) && typeof e['new_string'] === 'string' ? e['new_string'] : '')).join('\n')
  return outText
}

export function removedText(tool: string, input: Record<string, unknown>, paths: readonly string[]): Record<string, string> {
  const outText: Record<string, string> = {}
  const path = paths[0]
  if (path === undefined) return outText
  if (tool === 'Edit' && typeof input['old_string'] === 'string') outText[path] = input['old_string']
  else if (tool === 'MultiEdit' && Array.isArray(input['edits'])) outText[path] = input['edits'].map(e => (isObj(e) && typeof e['old_string'] === 'string' ? e['old_string'] : '')).join('\n')
  return outText
}

export function failed(response: unknown): boolean {
  if (isObj(response)) return response['success'] === false || response['is_error'] === true || typeof response['error'] === 'string'
  return typeof response === 'string' && /^\s*(?:Error|Failed)\b/u.test(response)
}

export function exitCodeOf(response: unknown): number | undefined {
  if (isObj(response)) {
    for (const k of ['exit_code', 'exitCode', 'code']) if (typeof response[k] === 'number') return response[k] as number
    if (response['interrupted'] === true) return 130
  }
  return undefined
}

export function workPath(sid: string): string {
  return join(paths.sessionDir(H, sid), 'work.json')
}

interface Work { todos: string[]; tasks: Record<string, string> }

function readWork(sid: string): Work {
  const r = readJsonSafeSync<Partial<Work>>(workPath(sid))
  const v = r.ok && isObj(r.value) ? r.value : {}
  return { todos: Array.isArray(v.todos) ? v.todos.filter((x): x is string => typeof x === 'string') : [], tasks: isObj(v.tasks) ? Object.fromEntries(Object.entries(v.tasks).filter((e): e is [string, string] => typeof e[1] === 'string')) : {} }
}

export function openWork(sid: string): string[] {
  const w = readWork(sid)
  const outList = [...w.todos]
  for (const s of Object.values(w.tasks)) if (!outList.includes(s)) outList.push(s)
  return outList.slice(0, 20)
}

export function noteWork(sid: string, tool: string, input: Record<string, unknown>, response: unknown): void {
  const w = readWork(sid)
  if (tool === 'TodoWrite') {
    const todos = Array.isArray(input['todos']) ? input['todos'] : []
    w.todos = todos.filter(isObj).filter(t => t['status'] !== 'completed').map(t => String(t['content'] ?? t['activeForm'] ?? '').trim()).filter(t => t !== '').map(t => t.slice(0, 200))
  } else if (tool === 'TaskCreate') {
    const task = isObj(response) && isObj(response['task']) ? response['task'] : undefined
    const id = str(task?.['id'])
    const subject = (str(input['subject']) ?? str(task?.['subject']))?.trim()
    if (id !== undefined && subject !== undefined && subject !== '') w.tasks[id] = subject.slice(0, 200)
  } else if (tool === 'TaskUpdate') {
    const id = str(input['taskId'])
    if (id === undefined) return
    const status = str(input['status'])
    if (status === 'completed' || status === 'deleted') delete w.tasks[id]
    else {
      const subject = str(input['subject'])?.trim()
      if (subject !== undefined && subject !== '') w.tasks[id] = subject.slice(0, 200)
    }
  } else return
  ensureDirSync(paths.sessionDir(H, sid))
  atomicWriteSync(workPath(sid), JSON.stringify(w) + '\n')
}
