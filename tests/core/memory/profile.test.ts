import { describe, expect, test } from 'bun:test'
import {
  profileAggregate, profileFacts, profileInferenceEvidence, profilePromptLanguage, profileSanitizeSignal, profileSessionEvidence, profileSignalsFromDigest,
  profileSignalsFromPrompt, profileUsageSignal, type ProfileClaim, type ProfileEvidence, type ProfileSignal,
} from '../../../src/core/memory/profile'
import { spoolDigest } from '../../../src/core/memory/spool'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)

const keys = (s: ProfileSignal[]) => s.map(x => x.key)

const topLines = (claims: readonly ProfileClaim[], max = 10) => profileFacts(claims).filter(f => !f.hypothesis && f.project === undefined)
  .sort((a, b) => a.rank - b.rank).slice(0, max).map(f => `- ${f.text}${f.confidence === 'medium' ? ' (medium)' : ''}`)

describe('profileSignalsFromPrompt', () => {
  test('explicit standing rules in English and Turkish become statements with a short quote', () => {
    const en = profileSignalsFromPrompt('From now on, always run the tests before you commit.')
    expect(en).toContainEqual({ kind: 'statement', key: 'quality.tests=always', category: 'quality', text: 'Write and run tests for every change', quote: 'From now on, always run the tests before you commit.' })
    const tr = profileSignalsFromPrompt('Bundan sonra her zaman Türkçe yanıt ver lütfen.')
    expect(tr.find(s => s.kind === 'statement')).toMatchObject({ key: 'communication.reply_language=tr', text: 'Reply in Turkish' })
    expect(keys(tr)).toContain('style.prompt_language=tr')
  })

  test('a rule that is not a known preference keeps its own wording under a word-order-free key', () => {
    const a = profileSignalsFromPrompt('Never push without asking me.').find(s => s.kind === 'statement')
    const b = profileSignalsFromPrompt('Please, without asking, never push.').find(s => s.kind === 'statement')
    expect(a).toMatchObject({ polarity: -1, category: 'avoid', text: 'Never push without asking me' })
    expect(a?.key).toMatch(/^said:/)
    expect(a?.key).toBe(b?.key)
    expect(profileSignalsFromPrompt('I prefer pnpm over npm for this repo.').find(s => s.kind === 'statement')?.text).toBe('Prefer pnpm over npm for this repo')
  })

  test('"without asking" is autonomy only when nothing forbids the action', () => {
    expect(keys(profileSignalsFromPrompt('From now on just fix lint errors without asking.'))).toContain('autonomy.ask=never')
    expect(keys(profileSignalsFromPrompt('asla sormadan push etme'))).not.toContain('autonomy.ask=never')
  })

  test('facts about the code, envelopes and empty text give no statement', () => {
    expect(profileSignalsFromPrompt('The tests always fail on CI.').filter(s => s.kind === 'statement')).toEqual([])
    expect(profileSignalsFromPrompt('Never mind, skip it.').filter(s => s.kind === 'statement')).toEqual([])
    expect(profileSignalsFromPrompt('<task-notification>always do x</task-notification>')).toEqual([])
    expect(profileSignalsFromPrompt('   ')).toEqual([])
  })

  test('questions, bug reports, thanks and status remarks are never rules, whatever trigger word they carry', () => {
    const notRules = [
      'Artık çalışıyor, teşekkürler.',
      'Artık bu hata çıkmıyor.',
      'Her zaman aynı hatayı veriyor.',
      'Bundan sonra ne yapacağız?',
      'Bundan sonra bunu mu yapalım',
      'Every time I run the build it crashes.',
      'Whenever I open the page, the console shows an error.',
      'Whenever you click save, it throws.',
      'Why does it always fail on CI?',
      'Can you always add the tests',
      'Thanks, from now on it works.',
      'From now on, the tests are green.',
      'You always forget the tests.',
      'Never had this problem before.',
      'Always the same error!',
      'Never works on the first try.',
      'Going forward the build is faster.',
      'Unutma, dün de aynı şey olmuştu.',
    ]
    for (const text of notRules) expect({ text, statements: profileSignalsFromPrompt(text).filter(s => s.kind === 'statement') }).toEqual({ text, statements: [] })
  })

  test('standing rules in their usual shapes still count', () => {
    const rules = [
      'Whenever you change the schema, run the migrations.',
      'Every time you finish a task, update the changelog.',
      'Bundan sonra testleri hep sen çalıştır.',
      'Bundan sonra bun kullanalım.',
      'Unutma, commit mesajları İngilizce olsun.',
      'From now on use bun instead of npm.',
      'Going forward we should squash merge.',
      'You should always run the linter.',
      "I don't want emojis in commits, please.",
      'Always fix lint errors before committing.',
      'Never ignore a failing test.',
      'Her zaman kısa cevap ver.',
      'Artık her değişiklikte testleri çalıştırmalısın.',
    ]
    for (const text of rules) expect({ text, rule: profileSignalsFromPrompt(text).some(s => s.kind === 'statement') }).toEqual({ text, rule: true })
  })

  test('workflow commands, corrections and confirmations', () => {
    expect(profileSignalsFromPrompt('/plan-build add a login page')[0]).toEqual({ kind: 'usage', key: 'usage.workflow=plan-build', category: 'workflow', text: 'plan-build' })
    expect(keys(profileSignalsFromPrompt('/buracle:bugfix the flaky test'))).toContain('usage.workflow=bugfix')
    expect(keys(profileSignalsFromPrompt('$research which queue to use'))).toContain('usage.workflow=research')
    expect(keys(profileSignalsFromPrompt('/clear'))).toEqual([])
    expect(keys(profileSignalsFromPrompt('Hayır, yanlış. Öyle değil.'))).toContain('feedback.correction')
    expect(keys(profileSignalsFromPrompt('No, that is wrong, use the other table.'))).toContain('feedback.correction')
    expect(keys(profileSignalsFromPrompt('evet tamam, devam'))).toContain('feedback.confirmation')
    expect(keys(profileSignalsFromPrompt('LGTM, ship it'))).toContain('feedback.confirmation')
  })

  test('with statements off, the user wording is never kept', () => {
    const off = profileSignalsFromPrompt('From now on, never deploy on Fridays.', { statements: false })
    const st = off.find(s => s.kind === 'statement')
    expect(st?.key).toMatch(/^said:/)
    expect(st?.quote).toBeUndefined()
    expect(st?.text).toBeUndefined()
    expect(profileSignalsFromPrompt('Always reply in Turkish', { statements: false }).find(s => s.kind === 'statement')).toEqual({ kind: 'statement', key: 'communication.reply_language=tr', category: 'communication', text: 'Reply in Turkish' })
  })

  test('secrets and private text never survive into a quote', () => {
    const s = profileSignalsFromPrompt('From now on always use this key: sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 <private>my secret plan</private>')
    const text = JSON.stringify(s)
    expect(text).not.toContain('sk-ant-abcdef')
    expect(text).not.toContain('my secret plan')
  })

  test('prompt language needs a few words; capital I is English', () => {
    expect(profilePromptLanguage('Bu projede testleri her zaman çalıştır')).toBe('tr')
    expect(profilePromptLanguage('I WANT YOU TO RUN THE TESTS')).toBe('en')
    expect(profilePromptLanguage('ok go')).toBeUndefined()
  })
})

describe('negated standing rules', () => {
  const statement = (text: string, statements = true) => profileSignalsFromPrompt(text, { statements }).find(s => s.kind === 'statement')

  test('a negated rule never becomes the claim it negates; the reply language maps to its explicit opposite', () => {
    for (const text of ['Never reply in Turkish.', 'Never, ever reply in Turkish.', "Please don't ever respond in Turkish.", 'Asla Türkçe yanıt verme.', 'Bundan sonra Türkçe cevap verme.', 'Bundan sonra Türkçe cevap istemiyorum.']) {
      expect(statement(text)).toMatchObject({ key: 'communication.reply_language=tr', polarity: -1, category: 'communication', text: 'Do not reply in Turkish' })
    }
    expect(statement("Please don't ever reply in English.")).toMatchObject({ key: 'communication.reply_language=en', polarity: -1, text: 'Do not reply in English' })
    expect(statement('Bundan sonra İngilizce yanıt verme.')).toMatchObject({ key: 'communication.reply_language=en', polarity: -1, text: 'Do not reply in English' })
  })

  test('a negated rule with a narrower scope keeps the user\'s own words with negative polarity', () => {
    const tests = statement('From now on, never write tests for throwaway scripts.')
    expect(tests).toMatchObject({ polarity: -1, category: 'avoid', text: 'Never write tests for throwaway scripts' })
    expect(tests?.key).toMatch(/^said:/)
    const ask = statement('Never ask me before running the tests.')
    expect(ask).toMatchObject({ polarity: -1, category: 'avoid', text: 'Never ask me before running the tests' })
    expect(ask?.key).toMatch(/^said:/)
    const tr = statement('Bundan sonra testleri çalıştırma.')
    expect(tr).toMatchObject({ polarity: -1, category: 'avoid' })
    expect(tr?.key).toMatch(/^said:/)
    const comments = statement('Always write code comments in English, never in Turkish.')
    expect(comments?.key).toMatch(/^said:/)
    expect(comments?.polarity).toBe(-1)
  })

  test('a contrast keeps the claim it affirms', () => {
    const tr = statement('Always reply in Turkish, never in English.')
    expect(tr).toMatchObject({ key: 'communication.reply_language=tr', text: 'Reply in Turkish' })
    expect(tr?.polarity).toBeUndefined()
    expect(statement('From now on reply in English, never in Turkish.')).toMatchObject({ key: 'communication.reply_language=en', text: 'Reply in English' })
    expect(statement('Her zaman Türkçe yanıt ver, İngilizce yazma.')).toMatchObject({ key: 'communication.reply_language=tr', text: 'Reply in Turkish' })
    expect(statement('Always run the tests so we do not break main.')).toMatchObject({ key: 'quality.tests=always' })
    expect(statement('Always run the tests, even if it is not required.')).toMatchObject({ key: 'quality.tests=always' })
    expect(statement('From now on just fix lint errors without asking.')).toMatchObject({ key: 'autonomy.ask=never' })
  })

  test('rules that forbid something keep their meaning; a double negative does not', () => {
    expect(statement('Never use emojis.')).toMatchObject({ key: 'communication.emoji=never', text: 'No emojis in replies or files' })
    expect(statement('Asla emoji kullanma.')).toMatchObject({ key: 'communication.emoji=never' })
    expect(statement("From now on don't ask me, just fix it.")).toMatchObject({ key: 'autonomy.ask=never' })
    const twice = statement('Never stop asking me before you push.')
    expect(twice).toMatchObject({ polarity: -1, text: 'Never stop asking me before you push' })
    expect(twice?.key).toMatch(/^said:/)
  })

  test('without statements, a negated rule keeps no wording and still never the claim it negates', () => {
    expect(statement('Never reply in Turkish.', false)).toEqual({ kind: 'statement', key: 'communication.reply_language=tr', polarity: -1, category: 'communication', text: 'Do not reply in Turkish' })
    const free = statement('From now on, never write tests for throwaway scripts.', false)
    expect(free?.key).toMatch(/^said:/)
    expect(free?.polarity).toBe(-1)
    expect(free?.text).toBeUndefined()
  })

  test('the profile injects what the newest statement says, never its opposite', () => {
    const at = (text: string, ts: number, source: string) => profileSessionEvidence(profileSignalsFromPrompt(text).map(signal => ({ ts, signal })), { source, harness: 'claude' })
    const injected = (evidence: ProfileEvidence[]) => topLines(profileAggregate(evidence, NOW))
    let top = injected([...at('Always reply in English.', NOW - DAY, 'claude-a'), ...at('Never reply in Turkish.', NOW, 'claude-b')])
    expect(top).toContain('- Reply in English')
    expect(top).toContain('- Do not reply in Turkish')
    expect(top).not.toContain('- Reply in Turkish')
    top = injected([...at('Always reply in Turkish.', NOW - DAY, 'claude-a'), ...at('Asla Türkçe yanıt verme.', NOW, 'claude-b')])
    expect(top).toContain('- Do not reply in Turkish')
    expect(top).not.toContain('- Reply in Turkish')
    top = injected([...at('Asla Türkçe yanıt verme.', NOW - DAY, 'claude-a'), ...at('Always reply in Turkish.', NOW, 'claude-b')])
    expect(top).toContain('- Reply in Turkish')
    expect(top).not.toContain('- Do not reply in Turkish')
    top = injected([...at('From now on, always run the tests before you commit.', NOW - DAY, 'claude-a'), ...at('From now on, never write tests for throwaway scripts.', NOW, 'claude-b'), ...at('Never ask me before running the tests.', NOW, 'claude-b')])
    expect(top).toContain('- Write and run tests for every change')
    expect(top).toContain('- Never write tests for throwaway scripts')
    expect(top).toContain('- Never ask me before running the tests')
    expect(top.join('\n')).not.toContain('Ask before acting')
  })

  test('a statement joins a preference note only when both say the same thing', () => {
    const note = ev({ kind: 'statement', key: 'note:m-2', weight: 3, text: 'Write tests for throwaway scripts', source: 'note:m-2' })
    const negative = ev({ kind: 'statement', key: 'said:script-tests-throwaw-write', polarity: -1, weight: 3, text: 'Never write tests for throwaway scripts', source: 'claude-s5' })
    const claims = profileAggregate([note, negative], NOW)
    expect(claims.map(c => [c.key, c.polarity])).toEqual([['note:m-2', 1], ['said:script-tests-throwaw-write', -1]])
  })
})

describe('signals from a session digest and usage', () => {
  test('languages, test runners, package managers, MCP servers and the harness, one each', () => {
    const d = spoolDigest([
      { ts: 1, ev: 'tool', tool: 'Edit', kind: 'edit', paths: ['/r/src/a.ts', '/r/src/b.ts', '/r/tool.py'] },
      { ts: 2, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'bun install && bun test', exit: 0 },
      { ts: 3, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'FOO=1 uv run pytest -q', exit: 1 },
      { ts: 4, ev: 'tool', tool: 'mcp__plugin_buracle_context7__query-docs', kind: 'mcp' },
      { ts: 5, ev: 'tool', tool: 'mcp__semble__search', kind: 'mcp' },
      { ts: 6, ev: 'tool', tool: 'web_search_search', kind: 'mcp' },
    ], '/r')
    const k = keys(profileSignalsFromDigest(d, { harness: 'claude' }))
    expect(k).toEqual(expect.arrayContaining(['env.language=typescript', 'env.language=python', 'env.test_runner=bun-test', 'env.package_manager=bun', 'usage.mcp=context7', 'usage.mcp=semble', 'usage.mcp=web-search', 'usage.harness=claude']))
    expect(new Set(k).size).toBe(k.length)
  })

  test('context-mode tools count as the context-mode server on every harness, never as context7', () => {
    const tools = ['mcp__plugin_buracle_context-mode__ctx_batch_execute', 'mcp__context_mode__ctx_execute', 'context-mode_ctx_search', 'mcp__context_mode_ctx_fetch_and_index']
    for (const tool of tools) {
      const k = keys(profileSignalsFromDigest(spoolDigest([{ ts: 1, ev: 'tool', tool, kind: 'mcp' }], '/r')))
      expect({ tool, k }).toEqual({ tool, k: ['usage.mcp=context-mode'] })
    }
    expect(keys(profileSignalsFromDigest(spoolDigest([{ ts: 1, ev: 'tool', tool: 'mcp__context7__query-docs', kind: 'mcp' }], '/r')))).toEqual(['usage.mcp=context7'])
  })

  test('usage signals and sanitizing', () => {
    expect(profileUsageSignal('skill', 'buracle:Research')).toEqual({ kind: 'usage', key: 'usage.skill=research', category: 'workflow', text: 'research' })
    expect(profileUsageSignal('mcp', '!!')).toBeUndefined()
    expect(profileSanitizeSignal({ kind: 'telepathy', key: 'x' })).toBeUndefined()
    expect(profileSanitizeSignal({ kind: 'usage', key: 'Bad Key' })).toBeUndefined()
    const s = profileSanitizeSignal({ kind: 'statement', key: 'said:a-b', polarity: -1, weight: 99, category: 'avoid', text: 'x'.repeat(500), quote: 'line one\nline two', extra: 1 })
    expect(s).toMatchObject({ kind: 'statement', key: 'said:a-b', polarity: -1, weight: 5, category: 'avoid', quote: 'line one line two' })
    expect(s?.text?.length).toBe(160)
    expect(profileSanitizeSignal({ kind: 'usage', key: 'usage.mcp=x', quote: 'only statements keep quotes' })?.quote).toBeUndefined()
  })
})

function ev(over: Partial<ProfileEvidence> & { key: string }): ProfileEvidence {
  return { kind: 'usage', polarity: 1, weight: 0.5, events: 1, ts: NOW - DAY, source: 'claude-s1', ...over }
}

describe('profileAggregate', () => {
  test('an explicit statement is high confidence at once; implicit claims need sessions and agreement', () => {
    const claims = profileAggregate([
      ev({ kind: 'statement', key: 'communication.reply_language=tr', weight: 3, text: 'Reply in Turkish', category: 'communication', project: 'a' }),
      ev({ key: 'usage.mcp=context7', text: 'context7', events: 3, source: 'claude-s1' }),
      ev({ key: 'usage.mcp=context7', text: 'context7', events: 3, source: 'codex-s2' }),
      ev({ key: 'usage.mcp=context7', text: 'context7', events: 3, source: 'codex-s3' }),
      ev({ key: 'usage.mcp=semble', text: 'semble', events: 1, source: 'claude-s1' }),
    ], NOW)
    const by = (k: string) => claims.find(c => c.key === k)
    expect(by('communication.reply_language=tr')).toMatchObject({ confidence: 'high', explicit: true, hypothesis: false, local: false })
    expect(by('usage.mcp=context7')).toMatchObject({ confidence: 'medium', sessions: 3, events: 9 })
    expect(by('usage.mcp=semble')).toMatchObject({ confidence: 'low', hypothesis: true })
  })

  test('a stated rule that is never said again fades: medium after one half-life, a hypothesis after two; a preference note does not fade', () => {
    const stated = (days: number) => profileAggregate([ev({ kind: 'statement', key: 'said:deploy-fridays', polarity: -1, weight: 3, text: 'Never deploy on Fridays', ts: NOW - days * DAY })], NOW)[0]!
    expect(stated(10)).toMatchObject({ confidence: 'high', explicit: true, hypothesis: false })
    expect(stated(120)).toMatchObject({ confidence: 'medium', explicit: true, hypothesis: false })
    expect(stated(200)).toMatchObject({ confidence: 'low', explicit: true, hypothesis: true })
    const again = profileAggregate([
      ev({ kind: 'statement', key: 'said:deploy-fridays', polarity: -1, weight: 3, text: 'Never deploy on Fridays', ts: NOW - 200 * DAY }),
      ev({ kind: 'statement', key: 'said:deploy-fridays', polarity: -1, weight: 3, text: 'Never deploy on Fridays', ts: NOW - 2 * DAY, source: 'codex-s2' }),
    ], NOW)[0]!
    expect(again.confidence).toBe('high')
    const note = profileAggregate([ev({ kind: 'statement', key: 'note:m-9', weight: 3, text: 'Use bun for every script', source: 'note:m-9', ts: NOW - 300 * DAY })], NOW)[0]!
    expect(note).toMatchObject({ confidence: 'high', hypothesis: false })
    const top = topLines([stated(200)])
    expect(top.join('\n')).not.toContain('Fridays')
  })

  test('the newest statement wins an exclusive group, and old evidence decays', () => {
    const claims = profileAggregate([
      ev({ kind: 'statement', key: 'communication.reply_language=tr', weight: 3, text: 'Reply in Turkish', ts: NOW - 30 * DAY }),
      ev({ kind: 'statement', key: 'communication.reply_language=en', weight: 3, text: 'Reply in English', ts: NOW - DAY, source: 'codex-s9' }),
    ], NOW)
    expect(claims.map(c => c.key)).toEqual(['communication.reply_language=en'])
    const fresh = profileAggregate([ev({ key: 'env.language=go', ts: NOW })], NOW)[0]!
    const old = profileAggregate([ev({ key: 'env.language=go', ts: NOW - 180 * DAY })], NOW)[0]!
    expect(old.support).toBeLessThan(fresh.support / 3)
  })

  test('a rule seen in one project is local to it; in two projects it is global; personal claims are always global', () => {
    const one = profileAggregate([ev({ kind: 'statement', key: 'said:deploy-fridays', polarity: -1, weight: 3, text: 'Never deploy on Fridays', project: 'shop' })], NOW)[0]!
    expect(one).toMatchObject({ local: true, projects: ['shop'], category: 'avoid' })
    const two = profileAggregate([
      ev({ kind: 'statement', key: 'said:deploy-fridays', polarity: -1, weight: 3, text: 'Never deploy on Fridays', project: 'shop' }),
      ev({ kind: 'statement', key: 'said:deploy-fridays', polarity: -1, weight: 3, text: 'Never deploy on Fridays', project: 'blog', source: 'codex-2' }),
    ], NOW)[0]!
    expect(two.local).toBe(false)
    expect(profileAggregate([ev({ kind: 'statement', key: 'autonomy.ask=never', weight: 3, text: 'Work autonomously', project: 'shop' })], NOW)[0]!.local).toBe(false)
  })

  test('a statement joins the preference note that says the same thing', () => {
    const claims = profileAggregate([
      ev({ kind: 'statement', key: 'note:m-1', weight: 3, text: 'Use bun for every script', link: '[[global/preferences/use-bun|note]]', source: 'note:m-1' }),
      ev({ kind: 'statement', key: 'said:bun-every-script', weight: 3, text: 'Use bun for every script', source: 'claude-s4' }),
    ], NOW)
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ key: 'note:m-1', events: 2, links: ['[[global/preferences/use-bun|note]]'] })
  })

  test('session evidence collapses repeated signals', () => {
    const e = profileSessionEvidence([
      { ts: 5, signal: { kind: 'style', key: 'style.prompt_language=tr' } },
      { ts: 9, signal: { kind: 'style', key: 'style.prompt_language=tr' } },
      { ts: 7, signal: { kind: 'usage', key: 'usage.workflow=plan-build', text: 'plan-build' } },
    ], { source: 'codex-s1', project: 'shop', harness: 'codex' })
    expect(e).toEqual([
      { kind: 'style', key: 'style.prompt_language=tr', polarity: 1, weight: 1, events: 2, ts: 9, source: 'codex-s1', project: 'shop', harness: 'codex' },
      { kind: 'usage', key: 'usage.workflow=plan-build', polarity: 1, weight: 0.5, text: 'plan-build', events: 1, ts: 7, source: 'codex-s1', project: 'shop', harness: 'codex' },
    ])
  })
})

describe('the profile facts', () => {
  const claims = profileAggregate([
    ev({ kind: 'statement', key: 'communication.reply_language=tr', weight: 3, text: 'Reply in Turkish', category: 'communication' }),
    ev({ kind: 'statement', key: 'said:deploy-fridays', polarity: -1, weight: 3, text: 'Never deploy on Fridays', project: 'shop' }),
    ...['claude-a', 'claude-b', 'codex-c', 'codex-d'].map(source => ev({ key: 'usage.workflow=plan-build', text: 'plan-build', events: 2, source, harness: source.split('-')[0] })),
    ...['claude-a', 'claude-b', 'codex-c', 'codex-d'].map(source => ev({ key: `usage.harness=${source.split('-')[0]}`, text: source.split('-')[0]!, source })),
    ...Array.from({ length: 8 }, (_, i) => ev({ kind: 'style', key: 'style.prompt_language=tr', weight: 1, source: `claude-p${i}` })),
    ev({ kind: 'correction', key: 'feedback.correction', weight: 2 }),
  ], NOW)

  test('one fact per claim and per summary line, each with a stable key', () => {
    const facts = profileFacts(claims)
    const byKey = Object.fromEntries(facts.map(f => [f.key, f]))
    expect(byKey['communication.reply_language=tr']).toMatchObject({ text: 'Reply in Turkish', explicit: true, confidence: 'high', rank: 0 })
    expect(byKey['group:prompt-language']?.text).toBe('Writes to the agents mostly in Turkish (100% of 8 prompts)')
    expect(byKey['group:workflows']?.text).toBe('Workflows used most: /plan-build (4 sessions)')
    expect(byKey['group:harnesses']?.text).toMatch(/^Works in Claude Code \(50%\), Codex \(50%\) of 4 sessions$/)
    expect(byKey['group:feedback']).toMatchObject({ hypothesis: true })
    expect(new Set(facts.map(f => f.key)).size).toBe(facts.length)
  })

  test('a claim seen in one project names it, so it never reaches the person layer', () => {
    const local = profileFacts(claims).find(f => f.key === 'said:deploy-fridays')
    expect(local?.project).toBe('shop')
    expect(topLines(claims).join('\n')).not.toContain('Fridays')
  })

  test('the injected lines: stated rules first, never hypotheses', () => {
    const top = topLines(claims)
    expect(top[0]).toBe('- Reply in Turkish')
    expect(top.join('\n')).not.toContain('Feedback so far')
    expect(topLines(claims, 2)).toHaveLength(2)
  })
})

describe('inferences from the distillation', () => {
  const known = [
    { key: 'infer:cause-fix-root', text: 'Asks for the root cause before a fix' },
    { key: 'communication.reply_language=tr', text: 'Reply in Turkish' },
  ]
  const ctx = (n: number) => ({ ts: NOW - n * DAY, source: `claude-s${n}`, project: 'demo', harness: 'claude', known })

  test('a new tendency gets an infer key; a known one is reused by key or by wording; against counts the other way; a line the profile already states is skipped', () => {
    const ev = profileInferenceEvidence([
      { text: 'Reviews the plan before any code is written', category: 'workflow', why: 'asked to see the plan first' },
      { text: 'Wants the cause first', same: 'infer:cause-fix-root' },
      { text: 'Reply in Turkish' },
      { text: 'Accepted a quick patch without a cause', against: 'infer:cause-fix-root' },
    ], ctx(0))
    expect(ev).toHaveLength(2)
    expect(ev[0]).toMatchObject({ kind: 'inference', polarity: 1, category: 'workflow', text: 'Reviews the plan before any code is written', quote: 'asked to see the plan first', project: 'demo', source: 'claude-s0' })
    expect(ev[0]?.key.startsWith('infer:')).toBe(true)
    expect(ev[1]).toMatchObject({ key: 'infer:cause-fix-root', polarity: 1 })
    const again = profileInferenceEvidence([{ text: 'Asks for the root cause before any fix' }], ctx(1))
    expect(again.map(e => e.key)).toEqual(['infer:cause-fix-root'])
    const against = profileInferenceEvidence([{ text: 'Took a patch without asking why', against: 'infer:cause-fix-root' }], ctx(2))
    expect(against).toMatchObject([{ key: 'infer:cause-fix-root', polarity: -1, text: 'Asks for the root cause before a fix' }])
  })

  test('one session leaves a hypothesis about the person; the same tendency in three sessions becomes a profile line; it never turns into a project convention', () => {
    const one = profileAggregate(profileInferenceEvidence([{ text: 'Reviews the plan before any code is written' }], ctx(0)), NOW)
    expect(one).toMatchObject([{ inferred: true, hypothesis: true, local: false }])
    const three = profileAggregate([0, 1, 2].flatMap(n => profileInferenceEvidence([{ text: 'Reviews the plan before any code is written' }], ctx(n))), NOW)
    expect(three).toMatchObject([{ inferred: true, hypothesis: false, confidence: 'medium', sessions: 3, local: false }])
    const facts = profileFacts(three)
    expect(facts).toMatchObject([{ inferred: true, text: 'Reviews the plan before any code is written' }])
    expect(facts[0]?.project).toBeUndefined()
  })
})
