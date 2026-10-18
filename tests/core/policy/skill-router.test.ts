import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { CatalogSkill } from '../../../src/core/catalog'
import { catalogSkills } from '../../../src/core/catalog'
import type { Harness, ToolCall } from '../../../src/core/events'
import { HARNESSES } from '../../../src/core/events'
import { isGuardContinuation } from '../../../src/core/policy/intents'
import type { RoutingPolicy } from '../../../src/core/policy/routing'
import { parseRouteRef } from '../../../src/core/policy/routing'
import type { PromptRoute } from '../../../src/core/policy/skill-router'
import {
  ROUTE_HEADER, ROUTE_TEXT_MAX_BYTES, compileTriggers, parseSkillTriggers, routePrompt, routeText, utf8Bytes, validateSkillTriggers,
} from '../../../src/core/policy/skill-router'
import { emptyLedger, ledgerCall, ledgerPrompt, turnAudit } from '../../../src/core/policy/usage'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'

const CANON = paths.canonicalDir()
const BUNDLE = loadCanonicalSync(CANON)
const SKILLS = catalogSkills(BUNDLE.skills)
const POLICY = BUNDLE.routing
const T = compileTriggers(SKILLS, POLICY)
const ALL_SERVERS = Object.keys(BUNDLE.mcp.servers)
const EXPLICIT = SKILLS.filter(s => s.invocation === 'explicit').map(s => s.id)
const TURKISH = /[ğüşıöçĞÜŞİÖÇ]/

const route = (text: string, o: Partial<{ harness: Harness, loaded: string[], available: string[], deps: string[] }> = {}): PromptRoute =>
  routePrompt(text, T, { harness: o.harness ?? 'claude', loaded: o.loaded ?? [], available: o.available ?? ALL_SERVERS, ...(o.deps !== undefined ? { deps: o.deps } : {}) })
const offered = (r: PromptRoute): string[] => [...r.load, ...r.candidates]

function categoryOf(server: string): string | undefined {
  return POLICY.categories.find(c => { const r = parseRouteRef(c.prefer[0] ?? ''); return r?.kind === 'mcp' && r.server === server })?.id
}

interface EvalCase { id: string, prompt: string, tags: string[], expect: Record<string, unknown> }
function evalCases(): Array<{ skill: string, c: EvalCase }> {
  const out: Array<{ skill: string, c: EvalCase }> = []
  for (const id of readdirSync(join(CANON, 'skills')).sort()) {
    const f = join(CANON, 'skills', id, 'evals', 'cases.json')
    if (!existsSync(f)) continue
    for (const c of (JSON.parse(readFileSync(f, 'utf8')) as { cases: EvalCase[] }).cases) out.push({ skill: id, c })
  }
  return out
}
const EVALS = evalCases()

describe('canonical/skill-triggers.yaml', () => {
  const raw = parseYaml(readFileSync(join(CANON, 'skill-triggers.yaml'), 'utf8')) as unknown

  test('validates against the canonical tree and loads without warnings', () => {
    const known = { skills: BUNDLE.skills.map(s => ({ id: s.id, invocation: s.frontmatter['invocation'] as string, userInvocable: s.frontmatter['user-invocable'] !== false })), categories: POLICY.categories.map(c => c.id) }
    expect(validateSkillTriggers(raw, known)).toEqual([])
    expect(BUNDLE.warnings).toEqual([])
    expect(parseSkillTriggers(raw).errors).toEqual([])
  })

  test('every workflow skill has explicit requests in English and Turkish; explicit-only skills have no topics', () => {
    const skills = (raw as { skills: Record<string, { ask?: Record<string, string[]>, topic?: unknown }> }).skills
    for (const s of SKILLS.filter(x => x.userInvocable)) {
      expect({ id: s.id, en: (skills[s.id]?.ask?.['en'] ?? []).length > 0, tr: (skills[s.id]?.ask?.['tr'] ?? []).length > 0 }).toEqual({ id: s.id, en: true, tr: true })
    }
    for (const id of EXPLICIT) expect(skills[id]?.topic).toBeUndefined()
    expect(EXPLICIT.sort()).toEqual(['bugfix', 'dead-code', 'goal-build', 'inspect', 'plan-build', 'requirements'])
  })

  test('the loader attaches the triggers to skills and routing categories (routing.yaml holds no vocabulary)', () => {
    expect(BUNDLE.triggers?.skills['plan-build']?.ask?.length).toBeGreaterThan(0)
    expect(SKILLS.find(s => s.id === 'research')?.triggers?.topic?.length).toBeGreaterThan(0)
    expect(POLICY.categories.find(c => c.id === 'library-docs')?.triggers?.deps?.length).toBeGreaterThan(0)
    const yaml = parseYaml(readFileSync(join(CANON, 'routing.yaml'), 'utf8')) as RoutingPolicy
    for (const c of yaml.categories) expect(c.triggers).toBeUndefined()
    expect(readFileSync(join(CANON, 'routing.yaml'), 'utf8')).not.toMatch(TURKISH)
  })

  test('validation reports unknown ids, bad phrases, topics on explicit skills and missing languages', () => {
    const errs = validateSkillTriggers({
      version: 1, extra: true,
      skills: { ghost: { ask: ['x'] }, 'plan-build': { ask: { en: ['Use Plan-build'], tr: ['plan-build ile'] }, topic: ['plan'] }, bugfix: { ask: { en: ['re:(unclosed', 'a*b'] } } },
      categories: { nowhere: { topic: ['x'] }, 'library-docs': { deps: 'api' } },
    }, { skills: [{ id: 'plan-build', invocation: 'explicit' }, { id: 'bugfix', invocation: 'explicit' }], categories: ['library-docs'] }).join('\n')
    for (const needle of ['(root).extra: unknown key', 'skills.ghost: no canonical skill', 'lower case', 'skills.plan-build.topic: plan-build is explicit-only', 'invalid regular expression', '* may only end a word', 'skills.bugfix.ask.tr: every workflow skill', 'categories.nowhere: no routing category', 'categories.library-docs.deps: expected a list']) {
      expect(errs).toContain(needle)
    }
    expect(parseSkillTriggers(null).errors).toEqual(['(root): expected a mapping with version, skills and categories'])
  })
})

describe('the skill evals as routing fixtures', () => {
  test('there are fixtures with positives and near-miss negatives', () => {
    expect(EVALS.length).toBeGreaterThanOrEqual(30)
    expect(EVALS.filter(e => e.c.tags.includes('negative')).length).toBeGreaterThanOrEqual(8)
  })

  for (const { skill, c } of EVALS) {
    test(`${skill}/${c.id}: ${c.prompt.slice(0, 60)}`, () => {
      for (const h of HARNESSES) {
        const r = route(c.prompt, { harness: h })
        for (const [probe, want] of Object.entries(c.expect)) {
          const [kind, rest] = [probe.slice(0, probe.indexOf(':')), probe.slice(probe.indexOf(':') + 1)]
          const yes = want === true || (typeof want === 'string' && want.startsWith('>='))
          if (kind === 'skill') expect({ h, probe, offered: offered(r).includes(rest) }).toEqual({ h, probe, offered: yes })
          else if (kind === 'mcp') {
            const cat = categoryOf(rest)
            const hit = (cat !== undefined && r.categories.includes(cat)) || (rest === 'buracle-memory' && (r.memory.recall || r.memory.write))
            expect({ h, probe, routed: hit }).toEqual({ h, probe, routed: yes })
          } else if (kind === 'cmd' && rest.startsWith('buracle ')) {
            if (yes && !offered(r).some(id => id !== 'buracle')) expect({ h, probe, offered: offered(r).includes('buracle') }).toEqual({ h, probe, offered: true })
            if (!yes) expect({ h, probe, offered: offered(r).includes('buracle') }).toEqual({ h, probe, offered: false })
          }
        }
      }
    })
  }
})

describe('T1: explicit requests load the workflow (and nothing else does)', () => {
  const LOADS: Array<[string, string]> = [
    ["Let's do this plan-driven: add OAuth login to the dashboard.", 'plan-build'],
    ['Write a plan and implement it: export invoices as CSV.', 'plan-build'],
    ['Use the plan-build workflow for the billing change.', 'plan-build'],
    ['Plan yaz ve uygula: kullanıcı silme özelliği ekle.', 'plan-build'],
    ['Bunu plan-build ile yap: rapor ekranına filtre ekle.', 'plan-build'],
    ['Use the goal-build workflow: the goal is a CLI that converts CSV to JSON.', 'goal-build'],
    ['Hedef şu, yolunu sen bul: testler 2 saniyenin altına insin.', 'goal-build'],
    ['Bitene kadar döngüyle çalış, tüm lint uyarıları gitsin.', 'goal-build'],
    ['Root-cause fix please: the parser crashes on empty input.', 'bugfix'],
    ['Bugfix ile çöz: login sayfası 500 veriyor.', 'bugfix'],
    ['Write a PRD for a team billing page.', 'requirements'],
    ['Bu fikri netleştirelim, sonra PRD yaz.', 'requirements'],
    ["PRD'yi yaz: davet akışı.", 'requirements'],
    ["Bunun PRD'sini çıkar.", 'requirements'],
    ['Draft a product requirements document for the export feature.', 'requirements'],
    ['We need a PRD for the billing page before any code.', 'requirements'],
    ['Do it plan-driven: add rate limiting to the upload API.', 'plan-build'],
    ['Plan-driven, please: add an audit log.', 'plan-build'],
    ['Solve it with the bugfix workflow: the parser crashes on empty input.', 'bugfix'],
    ['Go with the goal-build workflow: the goal is a CLI that converts CSV to JSON.', 'goal-build'],
    ['The goal: tests under two seconds. You find the way.', 'goal-build'],
    ['Loop until it passes: every lint warning has to go.', 'goal-build'],
    ['Investigate how the stop guard decides to block.', 'inspect'],
    ['Investigate this: why does the stop guard block twice?', 'inspect'],
    ['Plan kaydının nasıl çalıştığını incele.', 'inspect'],
    ['Run a dead code audit on src/.', 'dead-code'],
    ['Find unused exports in src/core and report them.', 'dead-code'],
    ['Can you find dead code in the CLI?', 'dead-code'],
    ['Kullanılmayan kodları bul ve raporla.', 'dead-code'],
    ['Research this: which ORM fits a small Bun service?', 'research'],
    ['Bunu araştır: Bun SQLite eşzamanlı yazmada güvenli mi?', 'research'],
    ['Bu repo için AGENTS.md hazırla.', 'project-rules'],
    ["AGENTS.md'yi güncelle, test komutu değişti.", 'project-rules'],
    ['Turn this into a skill: the release checklist we just ran.', 'new-skill'],
    ['Benchmark the skill change before we keep it.', 'ab-test'],
  ]
  for (const [text, id] of LOADS) {
    test(`${id} <- ${text}`, () => {
      const r = route(text)
      expect(r.load).toEqual([id])
      if (EXPLICIT.includes(id)) expect(r.candidates).toEqual([])
    })
  }

  const QUIET: string[] = [
    'Önce planla, sonra konuşuruz.', 'Plan first, then we talk.', 'Update the API spec in docs/openapi.yaml.', 'Build the project and run the tests.',
    'Run the goal-build workflow on GitHub Actions again.', 'Bunu düzelt.', 'Fix the failing test in parser.test.ts.', 'Fix the workflow file so CI passes.',
    'The PRD says the limit is 10; update the code.', 'Investigate why the test fails and fix it.', 'Remove the unused import in a.ts.',
    'Bu kodu düzelt ve testleri çalıştır.', 'refactor the parser', 'Önce goal-build ile başla, sonra testleri çalıştır.', 'plan-build ile ilgili bir sorum var',
    'Use the spec from the docs folder.', 'npm run bugfix ile lint hatalarını gider',
    'write the requirements.txt for this python project', 'write the requirements in the README',
    'Update the requirements document with the new flow.', 'The product requirements document says the limit is 10; update the code.',
    'Is there a PRD for the billing page?', 'Do we need a PRD for this?', "PRD'yi güncelle, yeni gereksinim ekle.", "Bunu PRD'den çıkar.",
    'Gereksinim dokümanını güncelle, yeni alanı ekle.', 'something is wrong with the goal-build workflow', 'the build loop is slow, make it faster',
    'can you find the path yourself to the config file?', 'Can you find the way the config is loaded?', 'The worker should loop until it passes the health check.',
    'the API is spec-driven (OpenAPI), add an endpoint for users', 'we need to investigate the performance regression',
    'investigate the options later, first finish the migration', 'We need to investigate this further before we merge.',
    'The root cause fix from yesterday broke the login page.', 'Add a lint rule to find unused exports.', 'The linter can find unused files for us.',
  ]
  for (const text of QUIET) {
    test(`no workflow: ${text}`, () => {
      const r = route(text)
      expect(r.load.filter(id => EXPLICIT.includes(id))).toEqual([])
      expect(r.candidates.filter(id => EXPLICIT.includes(id))).toEqual([])
    })
  }

  test('explicit-only skills never become candidates through topics', () => {
    const r = route('How does the router work? Where is the config loaded?')
    expect(offered(r)).toEqual([])
    expect(r.categories).toContain('code-search')
  })
})

describe('typed skill syntax per harness', () => {
  test('own syntax is invoked (no text); the syntax of another harness is a request', () => {
    expect(route('/buracle:plan-build add login', { harness: 'claude' })).toMatchObject({ invoked: ['plan-build'], load: [] })
    expect(route('/plan-build add login', { harness: 'claude' })).toMatchObject({ invoked: ['plan-build'], load: [] })
    expect(route('<command-message>spec is running…</command-message>\n<command-name>/buracle:plan-build</command-name>', { harness: 'claude' }).invoked).toEqual(['plan-build'])
    expect(route('$plan-build add login', { harness: 'codex' })).toMatchObject({ invoked: ['plan-build'], load: [] })
    expect(route('please use $research for this', { harness: 'codex' })).toMatchObject({ invoked: ['research'] })
    expect(route('@research compare zod and valibot', { harness: 'opencode' })).toMatchObject({ invoked: ['research'], load: [] })
    expect(route('/skill:research bun sqlite', { harness: 'omp' })).toMatchObject({ invoked: ['research'], load: [] })
    expect(route('/plan-build x', { harness: 'omp' }).invoked).toEqual(['plan-build'])
    expect(route('$plan-build add login', { harness: 'claude' })).toMatchObject({ invoked: [], load: ['plan-build'] })
    expect(route('/plan-build add login', { harness: 'codex' })).toMatchObject({ invoked: [], load: ['plan-build'] })
    expect(route('/buracle:bugfix the crash', { harness: 'omp' })).toMatchObject({ invoked: [], load: ['bugfix'] })
    expect(routeText(route('/plan-build add login', { harness: 'claude' }), 'claude', POLICY)).toBeUndefined()
  })

  test('a bare /<id> names only user-invocable skills (/memory is Claude Code\'s own command)', () => {
    const t = compileTriggers([
      { id: 'memory', description: 'Memory protocol', userInvocable: false, invocation: 'implicit' },
      { id: 'plan-build', description: 'Spec workflow', userInvocable: true, invocation: 'explicit' },
    ], { strictness: 'enforce', categories: [] })
    const r = (text: string, harness: Harness) => routePrompt(text, t, { harness, loaded: [], available: [] })
    expect(r('/memory', 'claude')).toMatchObject({ invoked: [], load: [] })
    expect(r('/buracle:memory', 'claude').invoked).toEqual(['memory'])
    expect(r('<command-name>/memory</command-name>', 'claude').invoked).toEqual([])
    expect(r('$memory what did we decide?', 'codex').invoked).toEqual(['memory'])
    expect(r('/plan-build x', 'claude').invoked).toEqual(['plan-build'])
  })

  test('unknown commands, shell variables and file mentions are not skills', () => {
    for (const [text, h] of [['/compact', 'claude'], ['echo $PATH', 'codex'], ['look at @src/index.ts', 'claude'], ['$HOME is wrong', 'opencode']] as const) {
      expect(offered(route(text, { harness: h })).concat(route(text, { harness: h }).invoked)).toEqual([])
    }
  })
})

describe('caps, dedupe and availability', () => {
  test('at most one load, two candidates and two categories', () => {
    const r = route('Use the research skill and the ab-test skill. Compare zod vs valibot, check the latest release notes, who calls parse, find examples on github, take a screenshot.')
    expect(r.load.length).toBeLessThanOrEqual(1)
    expect(r.candidates.length).toBeLessThanOrEqual(2)
    expect(r.categories.length).toBeLessThanOrEqual(2)
  })

  test('skills already loaded this session are not offered again', () => {
    expect(route('Research this: is zod still maintained?', { loaded: ['research'] }).load).toEqual([])
    expect(offered(route('Is the request npm package still maintained?', { loaded: ['research'] }))).not.toContain('research')
  })

  test('a new request for a workflow loaded earlier in the session loads it again (each request starts a run)', () => {
    for (const h of HARNESSES) expect(route('plan-build ile yap: add an audit log', { harness: h, loaded: ['plan-build'] }).load).toEqual(['plan-build'])
    expect(route('$goal-build the goal is a green lint run', { harness: 'claude', loaded: ['goal-build'] }).load).toEqual(['goal-build'])
    expect(routeText(route('Use the bugfix workflow: the parser crashes.', { loaded: ['bugfix', 'research'] }), 'claude', POLICY, { triggers: T })).toContain('The user asked for the bugfix workflow')
  })

  test('H23 holds the second request to a new load of the workflow, through the usage ledger', () => {
    const read: ToolCall = { harness: 'claude', sessionId: 's', cwd: '/p', tool: 'Read', kind: 'read', input: { file_path: '/plugin/skills/plan-build/SKILL.md' }, paths: ['/plugin/skills/plan-build/SKILL.md'] }
    let l = ledgerCall(ledgerPrompt(emptyLedger(), route('plan-build ile yap: rate limiting'), 1), read)
    expect(turnAudit(l).action).toBe('allow')
    l = ledgerPrompt(l, route('plan-build ile yap: add an audit log', { loaded: Object.keys(l.skills) }), 2)
    expect(turnAudit(l)).toMatchObject({ action: 'block', reason: expect.stringContaining('the user asked for plan-build and it was not loaded') })
    expect(turnAudit(ledgerCall(l, read)).action).toBe('allow')
  })

  test('categories need their preferred server; memory falls back to the CLI', () => {
    const text = 'Express 5: verify in the docs whether async errors reach the error middleware.'
    expect(route(text).categories).toContain('library-docs')
    expect(route(text, { available: ALL_SERVERS.filter(s => s !== 'context7') }).categories).not.toContain('library-docs')
    expect(route('What did we decide last time about the plan file format?', { available: [] }).memory).toEqual({ recall: true, write: false, cli: true })
  })

  test('type and compile errors call for the lsp server, and only where it is installed (Codex and OpenCode)', () => {
    for (const text of ['Fix the type errors in src/app.ts', 'Why does this give a compile error?', "What's the type of user in handler.go?", 'src/app.ts dosyasındaki tip hatalarını düzelt']) {
      expect({ text, routed: route(text).categories.includes('language-server') }).toEqual({ text, routed: true })
      expect({ text, routed: route(text, { available: ALL_SERVERS.filter(s => s !== 'lsp') }).categories.includes('language-server') }).toEqual({ text, routed: false })
    }
    expect(route('Rename the type in the docs').categories).not.toContain('language-server')
    expect(routeText(route('Fix the type errors in src/app.ts'), 'codex', POLICY)).toContain("- Language server: check an edited Python, TypeScript, Go, Rust, C# or Java file with the lsp server's diagnostics")
  })

  test('a running workflow drives the turn: no candidates beside it', () => {
    expect(route('/buracle:plan-build compare zod vs valibot for the forms').candidates).toEqual([])
  })
})

describe('large output calls for context-mode (context-saving, narrow triggers)', () => {
  const CALLS = [
    'Analyze the output of npm test and tell me which suites fail.', 'Summarize the server logs from last night.', 'Go through the build output and list the warnings.',
    'Scan the nginx logs for 500 errors.', 'The test output is huge; which tests failed?', 'Look at the build log and find why the linker fails.',
    'Here is the crash log of the app.', 'Triage this stack trace.', 'Check this large CSV file for duplicate rows.', 'Read the JSON dump and count the users per country.',
    'Summarize the git log since the last tag.', 'Bu test çıktısını özetle, hangi testler kırıldı?', 'Logları incele ve hataları say.',
    'Çıktıyı analiz et, hangi adım yavaş?', 'Build çıktısında hangi uyarılar var?', 'Bu log dosyasında kaç hata var?', 'Büyük CSV dosyasındaki tekrarları bul.',
  ]
  const QUIET = [
    'Add a CSV export button to the reports page.', 'Clean the build output folder before packaging.', 'Fix the failing test in parser.test.ts.',
    'Run the unit tests and tell me which ones fail.', 'Write code that parses the output of the API.', 'Add logging to the auth middleware.',
    'The login page logs users out after an hour.', 'Set the output directory to dist.', 'Rename the log level option.', 'Çıktı klasörünü temizle.',
  ]
  for (const text of CALLS) {
    test(`calls for it: ${text}`, () => {
      for (const h of HARNESSES) expect({ h, cats: route(text, { harness: h }).categories }).toEqual({ h, cats: expect.arrayContaining(['context-saving']) })
    })
  }
  for (const text of QUIET) test(`no call: ${text}`, () => expect(route(text).categories).not.toContain('context-saving'))

  test('only while context-mode is available; the route text names it "Large output"', () => {
    const text = 'Summarize the server logs from last night.'
    expect(route(text, { available: ALL_SERVERS.filter(s => s !== 'context-mode') }).categories).not.toContain('context-saving')
    const out = routeText(route(text), 'claude', POLICY, { triggers: T }) ?? ''
    expect(out).toContain('- Large output: process large output in the context-mode sandbox (ctx_batch_execute, ctx_execute, ctx_execute_file) and print only what you need.')
    expect(categoryOf('context-mode')).toBe('context-saving')
  })
})

describe('project dependencies call for their docs', () => {
  const deps = ['zod', 'express', 'next', '@tanstack/react-query', 'yaml']
  test('a dependency named next to an API word', () => {
    const r = route("How do I configure zod's error map for nested objects?", { deps })
    expect(r.categories).toContain('library-docs')
    expect(r.libs).toEqual(['zod'])
    expect(route('Next.js app router config for redirects', { deps }).libs).toEqual(['next'])
    expect(route('Use react-query hooks with suspense in the list page', { deps }).libs).toEqual(['@tanstack/react-query'])
  })
  test('no API word, an ordinary word or no dependency: nothing', () => {
    expect(route('zod is great', { deps }).categories).toEqual([])
    expect(route('What is the next step to configure this?', { deps }).libs).toBeUndefined()
    expect(route('How do I configure the error map?', { deps: [] }).categories).not.toContain('library-docs')
  })

  test('library questions in English and Turkish, by the names people use for a dependency (R6-05)', () => {
    const LIB: Array<[string[], string, string]> = [
      [['react', 'react-dom', 'next'], 'How does React useEffect cleanup work?', 'react'],
      [['@tanstack/react-query'], 'What options does tanstack query useQuery take for staleTime?', '@tanstack/react-query'],
      [['@tanstack/react-query'], 'Does react query refetch on window focus by default?', '@tanstack/react-query'],
      [['tailwindcss'], 'tailwind v4 config dosyasında dark mode nasıl açılır', 'tailwindcss'],
      [['@prisma/client'], 'Prisma ile soft delete nasıl yapılır?', '@prisma/client'],
      [['fastapi', 'pydantic', 'sqlalchemy'], "pydantic v2'de field validator nasıl yazılır?", 'pydantic'],
      [['fastapi', 'pydantic', 'sqlalchemy'], 'sqlalchemy 2.0 select syntax for joins', 'sqlalchemy'],
      [['react'], "React'te useEffect cleanup nasıl çalışır?", 'react'],
      [['github.com/gin-gonic/gin'], 'gin middleware for request ids', 'github.com/gin-gonic/gin'],
      [['github.com/go-chi/chi/v5', 'github.com/redis/go-redis/v9'], 'How do I set a timeout on the redis client?', 'github.com/redis/go-redis/v9'],
      [['laravel/framework'], 'How does Laravel queue retry work?', 'laravel/framework'],
    ]
    for (const [d, text, lib] of LIB) {
      const r = route(text, { deps: d })
      expect({ text, first: r.categories[0], libs: r.libs }).toEqual({ text, first: 'library-docs', libs: [lib] })
    }
    expect(route('How do I create a refund with the Stripe SDK?', { deps: [] }).categories).toContain('library-docs')
  })

  test('a library named as the subject of a how-does-it-work question gets the docs line first; local code keeps semble', () => {
    expect(route('How does React useEffect cleanup work?', { deps: ['react'] }).categories).toEqual(['library-docs', 'code-search'])
    expect(route('How does our auth middleware work?', { deps: ['react'] }).categories).toEqual(['code-search'])
  })

  test('one dependency per mention: the longer spelling, then the one named in full', () => {
    expect(route('Does react query refetch on window focus by default?', { deps: ['react', '@tanstack/react-query'] }).libs).toEqual(['@tanstack/react-query'])
    expect(route('How do I set up prisma migrations for a new table?', { deps: ['prisma', '@prisma/client', 'zod'] }).libs).toEqual(['prisma'])
    expect(route('How do I use react with zod?', { deps: ['react', '@tanstack/react-query', 'zod'] }).libs).toEqual(['react', 'zod'])
  })

  test('ordinary words never stand for a dependency (Go path segments, scopes, short names)', () => {
    const d = ['golang.org/x/sync', 'github.com/pkg/errors', 'golang.org/x/net', '@types/node', 'symfony/console']
    for (const text of ['How do I handle the errors in the sync code?', 'What does the net config option do?', 'How do I configure the types here?', 'How does the console output work?']) {
      expect({ text, libs: route(text, { deps: d }).libs }).toEqual({ text, libs: undefined })
    }
  })
})

describe('trigger words in everyday coding prompts (R6-08)', () => {
  type Want = { skill?: string, category?: string }
  const check = (text: string, w: Want, yes: boolean): void => {
    const r = route(text, { deps: ['react', 'zod'] })
    if (w.skill !== undefined) expect({ text, offered: offered(r).includes(w.skill) }).toEqual({ text, offered: yes })
    if (w.category !== undefined) expect({ text, routed: r.categories.includes(w.category) }).toEqual({ text, routed: yes })
  }
  const NOISE: Array<[string, Want]> = [
    ['the assertion fails: actual vs expected differ by one', { skill: 'research' }],
    ['follow best practices when writing the tests', { skill: 'research' }],
    ['check that the handler really calls the API', { skill: 'ab-test' }],
    ['show the before/after diff of the refactor', { skill: 'ab-test' }],
    ['Do a before and after comparison of the bundle size.', { skill: 'ab-test' }],
    ['webhook tetikleniyor mu kontrol et', { skill: 'ab-test' }],
    ['add a usage limit to the free plan API', { skill: 'buracle' }],
    ['add a weekly limit to free accounts', { skill: 'buracle' }],
    ['kullanım limiti ekle', { skill: 'buracle' }],
    ['5 saatlik bir önbellek süresi ekle', { skill: 'buracle' }],
    ['the plan status endpoint returns 500', { skill: 'buracle' }],
    ['add a review scope option to the CLI', { skill: 'buracle' }],
    ['add a section in the docs about the new flag', { category: 'library-docs' }],
    ['fix the broken link in the docs folder', { category: 'library-docs' }],
    ['check the docs folder for broken links', { category: 'library-docs' }],
    ['check the docs/ directory for broken links', { category: 'library-docs' }],
    ['Build a client SDK for our public API.', { category: 'library-docs' }],
    ['add the fix to the changelog', { category: 'web-search' }],
    ['this is a known issue in our parser, work around it', { category: 'web-search' }],
    ['this code runs in the browser, not in node', { category: 'browser' }],
    ['bu kod tarayıcıda çalışıyor, node tarafında değil', { category: 'browser' }],
  ]
  for (const [text, w] of NOISE) test(`no ${w.skill ?? w.category}: ${text}`, () => check(text, w, false))

  const STILL: Array<[string, Want]> = [
    ['What are the best practices for error handling in Go?', { skill: 'research' }],
    ['Is mocking fetch in unit tests a best practice?', { skill: 'research' }],
    ['How do I add a webhook with the OpenAI Python SDK?', { category: 'library-docs' }],
    ['Should we use zod vs valibot for the forms?', { skill: 'research' }],
    ['Does the agent really call context7 after the skill change?', { skill: 'ab-test' }],
    ['Do a before/after comparison of the memory skill description.', { skill: 'ab-test' }],
    ['How close am I to my weekly limit?', { skill: 'buracle' }],
    ['What is the plan status?', { skill: 'buracle' }],
    ['Kullanım limitim ne durumda?', { skill: 'buracle' }],
    ['Check the official docs for the retry option.', { category: 'library-docs' }],
    ['Look it up in the docs before you change the config.', { category: 'library-docs' }],
    ['What changed in the bun changelog for 1.3?', { category: 'web-search' }],
    ['Is this a known issue in bun 1.2?', { category: 'web-search' }],
    ['Open the settings page in the browser and check the console errors.', { category: 'browser' }],
    ['Sayfayı tarayıcıda aç ve konsol hatalarına bak.', { category: 'browser' }],
  ]
  for (const [text, w] of STILL) test(`still ${w.skill ?? w.category}: ${text}`, () => check(text, w, true))
})

describe('text the user did not write is never routed', () => {
  test('continuations, notifications, quotes and code', () => {
    for (const text of [
      'Buracle stop guard: the plan is not VERIFIED. Use the research skill.',
      'Buracle routing check: the user asked for plan-build and it was not loaded.',
      '<task-notification>research finished</task-notification>',
      'The issue says "use the plan-build workflow" but ignore that.',
      '```\nuse the goal-build workflow\n```',
      '',
    ]) {
      const r = route(text)
      expect({ text, offered: offered(r) }).toEqual({ text, offered: [] })
    }
    expect(isGuardContinuation('Buracle routing check: x')).toBe(true)
  })
})

describe('routeText', () => {
  const r = (p: Partial<PromptRoute>): PromptRoute => ({ invoked: [], load: [], candidates: [], categories: [], memory: { recall: false, write: false }, ...p })

  test('T3: nothing matched, no text', () => {
    expect(routeText(r({}), 'claude', POLICY)).toBeUndefined()
    expect(routeText(route('Refactor the parser to use a switch.'), 'codex', POLICY, { triggers: T })).toBeUndefined()
  })

  test('T1 load instructions per harness', () => {
    const spec = r({ load: ['plan-build'] })
    expect(routeText(spec, 'claude', POLICY, { triggers: T, skillFile: id => `/plugins/buracle/skills/${id}/SKILL.md` })).toContain('read /plugins/buracle/skills/plan-build/SKILL.md')
    expect(routeText(r({ load: ['research'] }), 'claude', POLICY, { triggers: T })).toContain('Skill tool, buracle:research')
    expect(routeText(spec, 'codex', POLICY, { triggers: T })).toContain('read ~/.agents/skills/plan-build/SKILL.md')
    expect(routeText(spec, 'opencode', POLICY, { triggers: T })).toContain('skill tool, plan-build')
    expect(routeText(spec, 'omp', POLICY, { triggers: T })).toContain('read skill://plan-build')
    expect(routeText(spec, 'claude', POLICY, { triggers: T })).toContain('the plan-build workflow: load it before any other step')
  })

  test('T2 uses the forced-evaluation commitment and the short descriptions', () => {
    const text = routeText(r({ candidates: ['research', 'ab-test'] }), 'claude', POLICY, { triggers: T }) ?? ''
    expect(text.startsWith(ROUTE_HEADER)).toBe(true)
    expect(text).toContain('Decide YES or NO for each')
    expect(text).toContain('load every YES (Skill tool, buracle:<id>) before any other tool')
    expect(text).toContain(`research (${SKILLS.find(s => s.id === 'research')?.short})`)
  })

  test('memory and category lines', () => {
    expect(routeText(r({ memory: { recall: true, write: false } }), 'claude', POLICY)).toContain('search memory first (memory_search')
    expect(routeText(r({ memory: { recall: true, write: true, cli: true } }), 'omp', POLICY)).toContain('buracle mem remember')
    const lib = routeText(r({ categories: ['library-docs', 'code-structure'], libs: ['zod'] }), 'codex', POLICY) ?? ''
    expect(lib).toContain('- Library docs (zod): resolve the library with context7')
    expect(lib).toContain('- Code structure: ask codegraph')
  })

  test('stays within 600 bytes, English and deterministic for every fixture on every harness', () => {
    for (const h of HARNESSES) {
      for (const { c } of EVALS) {
        const a = routeText(route(c.prompt, { harness: h }), h, POLICY, { triggers: T })
        if (a === undefined) continue
        expect(utf8Bytes(a)).toBeLessThanOrEqual(ROUTE_TEXT_MAX_BYTES)
        expect(a).not.toMatch(TURKISH)
        expect(routeText(route(c.prompt, { harness: h }), h, POLICY, { triggers: T })).toBe(a)
      }
    }
  })

  test('a skill the harness attached to the prompt: the T1 line says so, within the same budget', () => {
    const full = r({ load: ['research'], candidates: ['ab-test', 'project-rules'], categories: ['library-docs', 'web-search'], libs: ['zod'], memory: { recall: true, write: true } })
    const text = routeText(full, 'opencode', POLICY, { triggers: T, attached: ['research'] }) ?? ''
    expect(text).toContain('- The user asked for the research skill: its skill is attached to this message; follow it, and treat the rest of the prompt as its input.')
    expect(text).not.toContain('load it before any other step')
    expect(utf8Bytes(text)).toBeLessThanOrEqual(ROUTE_TEXT_MAX_BYTES)
    expect(routeText(r({ load: ['plan-build'] }), 'opencode', POLICY, { triggers: T, attached: ['plan-build'] })).toContain('the plan-build workflow: its skill is attached')
  })

  test('the budget drops lower-priority lines, never the load instruction', () => {
    const full = r({ load: ['plan-build'], candidates: ['research', 'ab-test'], categories: ['library-docs', 'code-structure'], libs: ['zod', 'express', 'next'], memory: { recall: true, write: true } })
    const text = routeText(full, 'claude', POLICY, { triggers: T, skillFile: id => `/Users/someone/.claude/plugins/marketplaces/buracle/harness/claude/skills/${id}/SKILL.md` }) ?? ''
    expect(text).toContain('the plan-build workflow')
    expect(utf8Bytes(text)).toBeLessThanOrEqual(ROUTE_TEXT_MAX_BYTES)
    expect(text).toContain('Earlier work')
  })
})

describe('compileTriggers', () => {
  test('tolerates odd input and never throws', () => {
    const bad: CatalogSkill[] = [{ id: 'x', description: '', userInvocable: true, triggers: { ask: ['re:(', ''], topic: ['ok'] } }, { id: 'Bad Id', description: '', userInvocable: true }]
    const t = compileTriggers(bad, { strictness: 'enforce', categories: [] })
    expect(t.skills.map(s => s.id)).toEqual(['x'])
    expect(routePrompt('ok then', t, { harness: 'claude', loaded: [], available: [] }).candidates).toEqual(['x'])
    expect(routePrompt(undefined as unknown as string, t, { harness: 'claude', loaded: [], available: [] }).load).toEqual([])
  })

  test('routes fast enough to run on every prompt', () => {
    const prompts = [...EVALS.map(e => e.c.prompt), 'x '.repeat(20_000), 'Lorem ipsum dolor sit amet. '.repeat(400)]
    const start = performance.now()
    let n = 0
    for (let i = 0; i < 20; i++) for (const p of prompts) { route(p, { deps: ['zod', 'express', 'react', 'next', 'vitest'] }); n++ }
    const perPrompt = (performance.now() - start) / n
    expect(perPrompt).toBeLessThan(5)
  })
})
