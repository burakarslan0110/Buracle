import { isLive, type MemItem, type MemKind } from './brain'
import { PROFILE_CATEGORIES, profileCategory, type ProfileCategory } from './signals'

export type PersonRegion = 'communication' | 'collaboration' | 'workflow' | 'engineering' | 'avoid' | 'lessons' | 'inbox'

export interface PersonRegionInfo {
  id: PersonRegion
  label: string
  area: string
  categories: readonly ProfileCategory[]
}

export const PERSON_REGIONS: readonly PersonRegionInfo[] = [
  { id: 'communication', label: 'Communication', area: 'left frontal lobe', categories: ['communication'] },
  { id: 'collaboration', label: 'Autonomy & feedback', area: 'left parietal lobe', categories: ['autonomy', 'other'] },
  { id: 'workflow', label: 'Workflow & tools', area: 'left occipital lobe', categories: ['workflow'] },
  { id: 'engineering', label: 'Engineering & quality', area: 'right frontal lobe', categories: ['engineering', 'quality'] },
  { id: 'avoid', label: 'Things to avoid', area: 'right parietal lobe', categories: ['avoid'] },
  { id: 'lessons', label: 'Lessons across projects', area: 'right occipital lobe', categories: [] },
  { id: 'inbox', label: 'Notes to file', area: 'corpus callosum', categories: [] },
]

export const PERSON_REGION_IDS: readonly PersonRegion[] = PERSON_REGIONS.map(r => r.id)

export function isPersonRegion(v: unknown): v is PersonRegion {
  return typeof v === 'string' && (PERSON_REGION_IDS as readonly string[]).includes(v)
}

const NOTE_KINDS: ReadonlySet<MemKind> = new Set<MemKind>(['capture', 'session', 'handoff'])

const FORBIDS = /\b(?:never|don'?t|do not|does not want|avoid|avoids|rejects?|refuses?|no longer|stop)\b|^no\b/i

function categoryRegion(c: ProfileCategory): PersonRegion {
  return PERSON_REGIONS.find(r => r.categories.includes(c))?.id ?? 'collaboration'
}

export function profileFactCategory(i: Pick<MemItem, 'tags' | 'summary'>): ProfileCategory {
  const tag = i.tags.find(t => (PROFILE_CATEGORIES as readonly string[]).includes(t))
  if (tag !== undefined) return tag as ProfileCategory
  const head = (i.summary.split(' · ')[0] ?? '').trim()
  return (PROFILE_CATEGORIES as readonly string[]).includes(head) ? head as ProfileCategory : 'other'
}

export function personRegionOf(i: Pick<MemItem, 'kind' | 'title' | 'summary' | 'tags'>): PersonRegion {
  if (i.kind === 'profile') return categoryRegion(profileFactCategory(i))
  if (i.kind === 'preference') {
    const text = `${i.title} ${i.summary}`
    return FORBIDS.test(text) ? 'avoid' : categoryRegion(profileCategory(text))
  }
  if (NOTE_KINDS.has(i.kind)) return 'inbox'
  return 'lessons'
}

export function personRegionOfKind(kind: MemKind): PersonRegion | undefined {
  if (kind === 'profile' || kind === 'preference') return undefined
  return NOTE_KINDS.has(kind) ? 'inbox' : 'lessons'
}

function topicTag(t: string): boolean {
  return !t.startsWith('rank-') && t !== 'hypothesis' && t !== 'stated' && !(PROFILE_CATEGORIES as readonly string[]).includes(t)
}

export interface PersonRegionSummary {
  region: PersonRegion
  count: number
  groups: number
  topTags: string[]
  hypotheses: number
  stated: number
}

export function personRegionSummaries(items: readonly MemItem[], nowMs: number): PersonRegionSummary[] {
  const live = items.filter(i => isLive(i, nowMs))
  return PERSON_REGIONS.map(r => {
    const mine = live.filter(i => personRegionOf(i) === r.id)
    const tags = new Map<string, number>()
    for (const i of mine) for (const t of i.tags.filter(topicTag)) tags.set(t, (tags.get(t) ?? 0) + 1)
    const topTags = [...tags.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([t]) => t)
    return {
      region: r.id,
      count: mine.length,
      groups: tags.size,
      topTags: topTags.slice(0, 3),
      hypotheses: mine.filter(i => i.kind === 'profile' && i.tags.includes('hypothesis')).length,
      stated: mine.filter(i => i.kind === 'preference' || (i.kind === 'profile' && i.tags.includes('stated'))).length,
    }
  })
}
