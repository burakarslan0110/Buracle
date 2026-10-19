import type { Harness } from './events'

export interface EffortScale {
  readonly levels: readonly string[]
  readonly top: string
  readonly persistable: readonly string[]
}

export const EFFORT_SCALES: Readonly<Record<Harness, EffortScale>> = {
  claude: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], top: 'max', persistable: ['low', 'medium', 'high', 'xhigh'] },
  codex: {
    levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    top: 'max',
    persistable: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  opencode: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], top: 'max', persistable: ['low', 'medium', 'high', 'xhigh', 'max'] },
  omp: {
    levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    top: 'max',
    persistable: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'],
  },
}

const LABEL: Readonly<Record<Harness, string>> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', omp: 'Oh My Pi' }

export const OMP_CLASSIFIER = 'classifier'

export function effortBelowTop(h: Harness): string {
  const s = EFFORT_SCALES[h]
  return s.levels[s.levels.indexOf(s.top) - 1] ?? s.top
}

export function effortConfigValues(h: Harness): string[] {
  return ['auto', 'keep', ...EFFORT_SCALES[h].persistable.map(v => (h === 'omp' && v === 'auto' ? OMP_CLASSIFIER : v))]
}

export function effortRank(h: Harness, level: string): number | undefined {
  const i = EFFORT_SCALES[h].levels.indexOf(level.trim().toLowerCase())
  return i < 0 ? undefined : i
}

export type EffortResolution = { level: string } | { off: true } | { invalid: string }

export function resolveEffort(h: Harness, value: string): EffortResolution {
  const v = value.trim().toLowerCase()
  if (v === 'auto') return { level: effortBelowTop(h) }
  if (v === 'keep') return { off: true }
  if (h === 'omp' && v === OMP_CLASSIFIER) return { level: 'auto' }
  const scale = EFFORT_SCALES[h]
  if (scale.persistable.includes(v)) return { level: v }
  if (h === 'claude' && v === 'max') {
    return { invalid: "Claude Code does not keep 'max' in its settings (it lasts one session: /effort max); xhigh is the highest level it saves" }
  }
  if (h === 'codex' && v === 'ultra') return { invalid: "'ultra' is Codex's delegation mode, not a reasoning level; use max or xhigh" }
  if (h === 'omp' && v === 'off') {
    return { invalid: "Oh My Pi's settings cannot hold 'off' (it ignores it and runs at high); minimal is the least thinking it saves" }
  }
  return { invalid: `'${value.trim()}' is not an effort value for ${LABEL[h]}; use one of ${effortConfigValues(h).join(', ')}` }
}
