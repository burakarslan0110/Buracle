import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// One standard on every harness (PRD 2026-11-04): the texts the agents and the users read name the
// document folders requirements, plan-build, goal-build and dead-code. The old folders (prd, plans,
// builds, cleanup) appear only where a sentence explains that they stay readable.

const REPO = join(import.meta.dir, '..', '..')

const LEGACY_PATH = /docs\/(?:prd|plans|builds|cleanup)\b/
const LEGACY_REGEX_FORM = /docs\\\/\(\?:/
const LEGACY_TERNARY = /'builds' : 'plans'/

// Lines that name an old folder on purpose: the folder table, the readers that accept both folder
// sets, and the sentences that tell the user the old folders still work.
const LEGACY_EXPLAINED: ReadonlyArray<{ file: string, re: RegExp, why: string }> = [
  { file: 'src/core/plan/doc-dirs.ts', re: /./, why: 'the folder table itself' },
  { file: 'src/workflow/plan-notes.ts', re: /or under the old folders docs\/plans, docs\/builds, docs\/prd and docs\/cleanup/, why: 'the error text names the old folders as still readable' },
  { file: 'src/workflow/worktree.ts', re: /'docs\/plan-build', 'docs\/goal-build', 'docs\/plans', 'docs\/builds'/, why: 'the slug lookup reads both folder sets' },
  { file: 'src/cli/commands/worktree.ts', re: /docs\/plan-build, docs\/goal-build, docs\/plans and docs\/builds/, why: 'the help text names every folder the stash keeps out' },
  { file: 'canonical/hooks.yaml', re: /or one of the old folders docs\/plans, docs\/builds, docs\/prd and docs\/cleanup/, why: 'the H03 description names the exemption list' },
  { file: 'canonical/notices.yaml', re: /the old folders docs\/prd\/, docs\/plans\/, docs\/builds\/ and docs\/cleanup\/ stay readable/, why: 'the 0.7.0 release notice tells the user the old folders still work' },
  { file: 'src/engine/update/reference.ts', re: /A path under an old document folder \(`docs\/prd\/`, `docs\/plans\/`, `docs\/builds\/`, `docs\/cleanup\/`\)/, why: 'the reference explains the legacy-folder check' },
  { file: 'canonical/skills/buracle/references/commands.md', re: /or an old folder: docs\/plans, docs\/builds, docs\/prd or docs\/cleanup/, why: 'the notes command accepts a file in an old folder' },
  { file: 'canonical/skills/plan-build/SKILL.md', re: /or the old `docs\/prd\/\*\.md`/, why: 'a PRD in the old folder is still an input' },
  { file: 'canonical/skills/plan-build/references/plan.md', re: /or the old `docs\/prd\/\*\.md`/, why: 'a PRD in the old folder is still an input' },
  { file: 'canonical/skills/goal-build/SKILL.md', re: /or the old `docs\/(?:prd|builds)\/\*\.md`/, why: 'a PRD or a run file in the old folder is still an input' },
]

function files(dir: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = []
  let names: string[] = []
  try { names = readdirSync(dir).sort() } catch { return out }
  for (const n of names) {
    if (n === 'node_modules' || n.startsWith('.')) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...files(p, keep))
    else if (keep(relative(REPO, p).split(sep).join('/'))) out.push(p)
  }
  return out
}

function scanned(): string[] {
  return [
    ...files(join(REPO, 'canonical'), r => /\.(?:md|yaml|json)$/.test(r)),
    ...files(join(REPO, 'src'), r => /\.(?:ts|tsx|js|md)$/.test(r) && !r.startsWith('src/adapters/claude/template/tests/')),
    join(REPO, 'README.md'),
    join(REPO, 'README.tr.md'),
  ]
}

function explained(rel: string, line: string): number {
  return LEGACY_EXPLAINED.findIndex(a => a.file === rel && a.re.test(line))
}

// Sentences that bound a document, a heading, a report or a review to English, or that asked for a
// diagram in a chat reply. A document, a report and a review follow the user's language with only the
// markers Buracle reads in English (PRD 2026-11-06), and a reply shows a flow as a list or a table.
const DOCUMENT_BINDINGS: ReadonlyArray<RegExp> = [
  /\bis English\b/,
  /English section titles/,
  /section titles (?:below )?as they are,? in\s+English/,
  /Write (?:the (?:plan|PRD|run file) )?in English/,
  /the English (?:plan|contract|PRD)/,
  /an English file/,
  /all prose in English/,
  /Turkish prose/,
]
const DIAGRAMS_IN_REPLIES: ReadonlyArray<RegExp> = [
  /buracle diagram/,
  /--ascii/,
  /fenced `text` block/,
  /draw it instead/,
  /`sequenceDiagram` of the failure path/,
  /trace as a `?flowchart/,
  /diagram of the built flow/,
  /diagram of the change's flow when it touches/,
  /with a diagram when the answer is a flow/,
  /flowchart when it has more than/,
]

// The release notices tell the user what went away, so they may name the removed command.
function canonicalTexts(): string[] {
  return files(join(REPO, 'canonical'), r => /\.(?:md|yaml)$/.test(r) && r !== 'canonical/notices.yaml')
}

describe('the standard: documents in the user\'s language, no diagram in a chat reply', () => {
  test('no rule, skill, agent or template binds a document, a report or a review to English or asks for a diagram in a reply', () => {
    const hits: string[] = []
    for (const f of canonicalTexts()) {
      const rel = relative(REPO, f).split(sep).join('/')
      const text = readFileSync(f, 'utf8')
      for (const re of [...DOCUMENT_BINDINGS, ...DIAGRAMS_IN_REPLIES]) {
        const m = re.exec(text)
        if (m === null) continue
        const line = text.slice(0, m.index).split('\n').length
        hits.push(`${rel}:${line}: ${re.source}`)
      }
    }
    expect(hits).toEqual([])
  })
})

describe('the standard: one set of document folders', () => {
  test('no rule, skill, agent, hook text, README or source line names an old document folder, except where it explains the old folders', () => {
    const hits: string[] = []
    for (const f of scanned()) {
      const rel = relative(REPO, f).split(sep).join('/')
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!LEGACY_PATH.test(line) && !LEGACY_REGEX_FORM.test(line) && !LEGACY_TERNARY.test(line)) return
        if (explained(rel, line) >= 0) return
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(hits).toEqual([])
  })

  test('every allowlisted sentence still exists, so a stale entry cannot hide a new mention', () => {
    const used = new Set<number>()
    for (const f of scanned()) {
      const rel = relative(REPO, f).split(sep).join('/')
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const i = explained(rel, line)
        if (i >= 0) used.add(i)
      }
    }
    expect(LEGACY_EXPLAINED.map((a, i) => (used.has(i) ? 'used' : `unused: ${a.file} (${a.why})`))).toEqual(LEGACY_EXPLAINED.map(() => 'used'))
  })
})
