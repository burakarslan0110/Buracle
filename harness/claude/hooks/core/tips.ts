// Short usage tips the harnesses show while the user waits: Claude Code's spinner rotation and OpenCode's home
// screen footer. canonical/tips.yaml holds the one list; every harness that has a place for them reads it.

export interface Tip {
  id: string
  text: string
}

export interface TipCatalog { tips: Tip[] }

export const TIPS_LABEL = 'Buracle'
// Claude Code accepts ids of up to 64 letters, digits, '.', '_' or '-'; Buracle keeps them lower case.
export const TIP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
// Claude Code allows 500 characters; a tip stays one short line so it fits a spinner row.
export const TIP_TEXT_MAX = 160
// Claude Code reads at most 200 tips across all settings files; Buracle leaves room for the user's own.
export const TIPS_MAX = 100

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function validateTips(x: unknown): string[] {
  if (!isObj(x) || !Array.isArray(x['tips'])) return ['(root): expected { tips: [...] }']
  const errors: string[] = []
  for (const k of Object.keys(x)) if (k !== 'tips') errors.push(`(root).${k}: unknown key`)
  const list = x['tips'] as unknown[]
  if (list.length > TIPS_MAX) errors.push(`(root).tips: at most ${TIPS_MAX} tips`)
  const seen = new Set<string>()
  list.forEach((t, i) => {
    const at = `tips[${i}]`
    if (!isObj(t)) { errors.push(`${at}: expected a mapping`); return }
    for (const k of Object.keys(t)) if (k !== 'id' && k !== 'text') errors.push(`${at}.${k}: unknown key`)
    const id = t['id']
    if (typeof id !== 'string' || !TIP_ID.test(id)) errors.push(`${at}.id: expected lower-case letters, digits, '.', '_' and '-'`)
    else if (seen.has(id)) errors.push(`${at}.id: duplicate ${id}`)
    else seen.add(id)
    const text = t['text']
    if (typeof text !== 'string' || text.trim() === '') errors.push(`${at}.text: expected the tip`)
    else if (/[\r\n]/.test(text)) errors.push(`${at}.text: one line only`)
    else if (text.length > TIP_TEXT_MAX) errors.push(`${at}.text: at most ${TIP_TEXT_MAX} characters`)
  })
  return errors
}

/** The tip for one draw: `n` is any integer the caller picks (a session counter, a time bucket). */
export function pickTip(tips: readonly Tip[] | undefined, n: number): Tip | undefined {
  const list = (tips ?? []).filter(t => isObj(t) && typeof t.text === 'string' && t.text.trim() !== '')
  if (list.length === 0) return undefined
  const i = ((Math.trunc(n) % list.length) + list.length) % list.length
  return list[i]
}
