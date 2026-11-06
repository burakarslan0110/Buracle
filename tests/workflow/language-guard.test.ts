import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { finalize } from '../../src/memory/finalize'
import { projectInit } from '../../src/memory/project-init'
import { sessionStart } from '../../src/memory/session-record'
import { appendSpool } from '../../src/memory/spool'
import { listAll, personRef, projectRef } from '../../src/memory/store'
import { withBrain } from '../memory/helpers'

const REPO = join(import.meta.dir, '..', '..')

const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/u
const TURKISH_WORDS = /\b(?:hafiza|kaydet|dosya|komut|ayar|oturum|devam|lutfen|degil|kullanici|bildirim|gonder|vazgec|gorev|guncelle|sunucu|calistir|duzelt|hatirla|unutma|nasil|icin|bunu|sonra|evet|hayir|tamam|simdi|iptal|ozet)[a-z]*\b/i

interface Allowed { why: string, only?: RegExp }

const ALLOWED: Readonly<Record<string, Allowed>> = {
  'canonical/skill-triggers.yaml': { why: "the skill router's trigger phrases" },
  'src/core/policy/intents.ts': { why: 'H10 whole-message control words and the result-review approval' },
  'src/core/policy/consent.ts': { why: 'H20 consent and approval phrases' },
  'src/core/policy/consent-words.ts': { why: 'H20 approval words and the requests that name a gated operation' },
  'src/core/policy/text.ts': { why: 'case folding' },
  'src/core/memory/brain.ts': { why: 'search folding of the terms line CortexDB indexes', only: /ı→i|`yanıtları` →|the dotless ı/ },
  'src/core/memory/signals.ts': { why: 'the topic words that sort a person preference into its region' },
  'src/core/memory/query.ts': { why: 'memory query stopwords' },
  'src/core/memory/stem.ts': { why: 'Turkish inflection endings that memory search strips from query words' },
  'src/core/memory/text.ts': { why: 'secret-word redaction and case folding' },
  'src/core/plan/state.ts': { why: 'the plan approval question', only: /onayl\[ıi\]yor musun/ },
  'src/engine/git.ts': { why: 'slug folding', only: /\.replace\(\/[İıçğöşü]\/g/ },
  'src/engine/update/deps.ts': { why: "the update prompt's Turkish yes", only: /\|evet\)/ },
  'src/workflow/plan-file.ts': { why: 'slug folding', only: /Turkish folding \(|\.replace\(\/[İıçğöşü]\/g/ },
  'src/workflow/worktree.ts': { why: 'lower-casing a Turkish capital', only: /"Ödeme |c === 'İ'/ },
  'src/adapters/claude/template/tests/register.test.tsx': { why: "the mod test's own Turkish-letter check", only: /\[çğıöşüÇĞİÖŞÜ\]/ },
  'harness/claude/hooks/generated/catalog.ts': { why: 'canonical data with the trigger phrases' },
  'harness/hook-data.json': { why: 'canonical data for the Claude and Codex command hooks, with the trigger phrases' },
  'src/adapters/omp/runtime/generated-data.ts': { why: 'canonical data baked into the omp bundle' },
  'src/adapters/opencode/runtime/server.ts': { why: 'canonical data baked into the OpenCode bundle', only: /contentHash: "/ },
  'src/adapters/opencode/runtime/tui.tsx': { why: 'canonical data baked into the OpenCode TUI bundle', only: /contentHash: "/ },
  // The ab-test fixture of PRD 2026-11-04 R9: Turkish prompts and plans in the format before the standard are the
  // measured input of the comparison, not text Buracle ships.
  'tests/fixtures/ab-test/plan-format/cases.json': { why: 'ab-test fixture: Turkish prompts, typed the way the user types' },
  ...Object.fromEntries(['slugify', 'duration', 'window', 'bytes', 'frontmatter'].map(c => [`tests/fixtures/ab-test/plan-format/fixtures/${c}/docs/plan-build/baseline.md`, { why: 'ab-test fixture: a plan in the prompt-language format before the standard, the baseline arm of PRD R9' }])),
  ...Object.fromEntries(['slugify', 'duration', 'window', 'bytes', 'frontmatter'].map(c => [`tests/fixtures/ab-test/plan-format/fixtures/${c}/docs/plan-build/candidate.md`, { why: 'ab-test fixture: the English plan quotes the Turkish input its test uses', only: /Kurulum Başlar|ı, ş, ğ, ü, ö, ç and İ/ }])),
  ...Object.fromEntries(['slugify'].map(c => [`tests/fixtures/ab-test/plan-format/fixtures/${c}/tests/${c}.test.ts`, { why: 'ab-test fixture: the slug test folds Turkish letters' }])),
  // The ab-test fixture of PRD 2026-11-06 G1 to G5: prompts in the user's languages (Turkish, German with
  // its ü and ö, Japanese, Arabic) are the measured input, not text Buracle ships.
  'tests/fixtures/ab-test/user-language/cases.json': { why: 'ab-test fixture: prompts in the user\'s languages, typed the way users type' },
}

const EVAL_CASES = /(?:^|\/)skills\/[^/]+\/evals\/cases\.json$/

function allowed(path: string): Allowed | undefined {
  if (EVAL_CASES.test(path)) return { why: 'skill eval prompts' }
  const source = path
    .replace(/^harness\/claude\/hooks\/core\//, 'src/core/')
    .replace(/^harness\/claude\/tests\//, 'src/adapters/claude/template/tests/')
  return ALLOWED[source]
}

function decodeEscapes(text: string): string {
  return text.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (m: string, a?: string, b?: string, c?: string) => {
    const cp = parseInt(a ?? b ?? c ?? '', 16)
    return Number.isNaN(cp) || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? m : String.fromCodePoint(cp)
  })
}

const CODE = /\.(?:[cm]?[jt]sx?)$/

function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[\s;,(){}[\]])\/\/[^\n]*/g, '$1')
}

export function findings(path: string, raw: string): string[] {
  const text = decodeEscapes(raw)
  const lines = text.split('\n')
  const code = CODE.test(path) ? withoutComments(text).split('\n') : lines
  const out: string[] = []
  let unit = path
  let rule = allowed(path)
  lines.forEach((line, i) => {
    const marker = path.endsWith('.js') ? /^\/\/ ((?:src|node_modules)\/\S+)$/.exec(line) : null
    if (marker) {
      unit = marker[1] as string
      rule = allowed(unit)
      return
    }
    if (!TURKISH_LETTERS.test(line) && !TURKISH_WORDS.test(code[i] ?? '')) return
    if (rule !== undefined && (rule.only === undefined || rule.only.test(line))) return
    out.push(`${unit === path ? path : `${path} :: ${unit}`}:${i + 1}: ${line.trim().slice(0, 120)}`)
  })
  return out
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git' || name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function scan(dir: string, base: string): { files: number, hits: string[] } {
  const hits: string[] = []
  let files = 0
  for (const file of walk(dir)) {
    const buf = readFileSync(file)
    if (buf.includes(0)) continue
    files++
    hits.push(...findings(relative(base, file).split(sep).join('/'), buf.toString('utf8')))
  }
  return { files, hits }
}

describe('language guard (R1): what Buracle ships is English', () => {
  test('canonical/ carries Turkish only in the trigger phrases and the eval prompts', () => {
    const r = scan(join(REPO, 'canonical'), REPO)
    expect(r.files).toBeGreaterThanOrEqual(60)
    expect(r.hits).toEqual([])
  })

  test('src/ carries Turkish only in the category D modules', () => {
    const r = scan(join(REPO, 'src'), REPO)
    expect(r.files).toBeGreaterThanOrEqual(250)
    expect(r.hits).toEqual([])
  })

  test('the ab-test plan-format fixture carries Turkish only in its prompts, its baseline plans and the slug test', () => {
    const r = scan(join(REPO, 'tests', 'fixtures', 'ab-test', 'plan-format'), REPO)
    // cases.json, four files per fixture repo and the ten plans under their docs/plan-build/ folders
    expect(r.files).toBeGreaterThanOrEqual(30)
    expect(r.hits).toEqual([])
  })

  test('the ab-test user-language fixture carries Turkish only in its Turkish prompt', () => {
    const r = scan(join(REPO, 'tests', 'fixtures', 'ab-test', 'user-language'), REPO)
    // cases.json, three files per fixture app and the German plan of the stop case
    expect(r.files).toBeGreaterThanOrEqual(11)
    expect(r.hits).toEqual([])
  })

  test('the generated harness/ output, the JS bundles decoded, carries Turkish only in category D', () => {
    const r = scan(join(REPO, 'harness'), REPO)
    expect(r.files).toBeGreaterThanOrEqual(200)
    expect(r.hits).toEqual([])
    for (const bundle of ['harness/opencode/plugins/buracle/index.js', 'harness/opencode/plugins/buracle/tui.js', 'harness/omp/extensions/buracle.js']) {
      const modules = readFileSync(join(REPO, bundle), 'utf8').split('\n').filter(l => /^\/\/ src\//.test(l))
      expect({ bundle, split: modules.length >= 50 }).toEqual({ bundle, split: true })
    }
  })

  test('the memories Buracle itself writes are English: the session memory, a handoff and a preference filed from an English statement of an older spool', () => withBrain(async ({ repo }) => {
    const sid = '0199a213-81c0-7800-8aa1-bbab2a035a99'
    await sessionStart('claude', sid, repo)
    appendSpool('claude', sid, [
      { ts: Date.now(), ev: 'prompt' },
      // A statement from a spool written before PRD follow-up 2026-11-06 (H26 reads none now); finalize still files it.
      { ts: Date.now() + 1, ev: 'prompt-signal' as const, signal: { kind: 'statement' as const, key: 'said:commit-run-tests', category: 'quality' as const, text: 'Run the tests before you commit', quote: 'Always run the tests before you commit.' } },
      { ts: Date.now() + 2, ev: 'stop', excerpt: 'Done.' },
    ])
    await finalize('claude', sid, { pending: false })
    const slug = (await projectInit(repo)).slug
    const items = [...await listAll(projectRef(slug)), ...await listAll(personRef())]
    expect(items.map(i => i.kind).sort()).toEqual(['preference', 'session'])
    expect(items.flatMap(i => findings(`brain/${slug}/${i.id}`, [i.title, i.summary, i.body, ...i.tags].join('\n')))).toEqual([])
  }))

  test('the guard sees what it guards', () => {
    expect(findings('canonical/skills/plan-build/SKILL.md', '# Spec\n8. **Kullanıcıya her görevden sonra kısa bir özet yaz.**\n')).toEqual(['canonical/skills/plan-build/SKILL.md:2: 8. **Kullanıcıya her görevden sonra kısa bir özet yaz.**'])
    expect(findings('canonical/rules/paths/typescript.md', '- Hafizaya kaydet ve devam et.')).toHaveLength(1)
    expect(findings('src/cli/commands/notify.ts', "const usage = 'Kullaniciya bildirim gonderir'")).toHaveLength(1)
    expect(findings('src/workflow/plan.ts', '// Kullanıcı yazınca')).toHaveLength(1)
    expect(findings('src/workflow/plan.ts', "// the CLI twin of the user's \"devam\"\nconst x = 1")).toEqual([])
    expect(findings('src/workflow/plan.ts', "const url = 'https://example.com' // devam")).toEqual([])
    const bundle = '// src/core/policy/intents.ts\nvar A = "dur|devam";\n// src/adapters/omp/runtime/extension.ts\nvar B = "K\\u0131sa \\xF6zet";\n'
    expect(findings('harness/omp/extensions/buracle.js', bundle)).toEqual(['harness/omp/extensions/buracle.js :: src/adapters/omp/runtime/extension.ts:4: var B = "Kısa özet";'])
    expect(findings('src/core/policy/intents.ts', "const X = re('devam|dur')")).toEqual([])
    expect(findings('harness/claude/hooks/core/policy/intents.ts', "// ı to i\nconst X = re('devam')")).toEqual([])
    expect(findings('src/engine/update/deps.ts', "const YES = /^(y|yes|evet)$/\nconst LINE = 'işlem tamam'")).toEqual(["src/engine/update/deps.ts:2: const LINE = 'işlem tamam'"])
    expect(findings('harness/claude/skills/memory/evals/cases.json', '{"prompt": "Geçen sefer ne yapmıştık?"}')).toEqual([])
  })
})
