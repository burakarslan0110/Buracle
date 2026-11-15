import type { CanonicalBundle } from '../../core/catalog'
import type { Harness } from '../../core/events'
import { harnessProfile } from '../../core/harness/index'

/**
 * A tip as one harness shows it: `canonical/tips.yaml` writes a skill as `/<id>`, and the profile says how the host
 * invokes a skill (`/skill:<id>` on Pi), so each `/<id>` that names an installed skill is respelled. Other text stays.
 */
export function tipText(text: string, harness: Harness, skillIds: ReadonlySet<string>): string {
  const mention = harnessProfile(harness).skills.mention
  return text.replace(/(^|[\s("])\/([a-z][a-z0-9-]*)(?![\w/-])/g, (whole, lead: string, id: string) => (skillIds.has(id) ? `${lead}${mention(id, true)}` : whole))
}

/** The tips of the canonical bundle, worded for one harness. */
export function tipsFor(c: Pick<CanonicalBundle, 'tips' | 'skills'>, harness: Harness): Array<{ id: string, text: string }> {
  const ids = new Set(c.skills.map(s => s.id))
  return (c.tips ?? []).map(t => ({ id: t.id, text: tipText(t.text, harness, ids) }))
}
