import { describe, expect, test } from 'bun:test'
import * as core from '../../../src/core/index'
import {
  CONTROL_GUIDANCE, RESULT_REVIEW_REASON, VERIFICATION_OFF_REASON, controlGuidance, detectIntent, detectSignals, isGuardContinuation, isManualDone, isResultApproval, isResultReview, isUserText, pausedReply,
  reportsWaiting, type Intent, type PromptSignals,
} from '../../../src/core/policy/intents'
import { STOP_GUARD_ESCAPE, stopVerdict, emptyState } from '../../../src/core/plan/state'
import { defaultConfig } from '../../../src/core/config'

function expectAll(cases: Array<[string, Intent]>): void {
  for (const [text, want] of cases) {
    test(`${JSON.stringify(text).slice(0, 90)} → ${String(want)}`, () => {
      expect(detectIntent(text)).toBe(want)
    })
  }
}

describe('contract minimum (CONTRACTS §10.1)', () => {
  expectAll([['dur', 'pause'], ['bekle', 'pause'], ['stop', 'pause'], ['devam', 'resume']])
})

// H10 reads a control word only when it is the whole message (PRD follow-up 2026-11-06), after the
// punctuation and the polite or filler words around it. A control word inside a longer sentence, or in
// any other language, is the agent's call under its rules.
describe('pause: the whole message is a pause word', () => {
  expectAll([
    ['dur!', 'pause'], ['DUR', 'pause'], ['Dur.', 'pause'], ['durr', 'pause'], ['duuur', 'pause'], ['dur bir dakika', 'pause'], ['lütfen dur', 'pause'],
    ['tamam dur', 'pause'], ['durun', 'pause'], ['dursana', 'pause'], ['durdur', 'pause'], ['duraklat', 'pause'], ['duraklatın lütfen', 'pause'],
    ['bekle', 'pause'], ['bekleyin', 'pause'], ['biraz bekle', 'pause'], ['bir dakika bekle', 'pause'], ['bi dakika', 'pause'], ['bir saniye', 'pause'],
    ['şimdilik dur', 'pause'], ['durur musun', 'pause'], ['durabilir misin?', 'pause'], ['bekler misin', 'pause'], ['o zaman dur', 'pause'],
    ['Stop', 'pause'], ['STOP!!!', 'pause'], ['stop it', 'pause'], ['please stop', 'pause'], ['ok stop', 'pause'], ['stop now', 'pause'], ['pause', 'pause'],
    ['wait', 'pause'], ['hold on', 'pause'], ['Hold up.', 'pause'], ['halt', 'pause'], ['one sec', 'pause'], ['just a moment', 'pause'],
    ['devam etme', 'pause'], ['devam etmeyin', 'pause'], ["don't continue", 'pause'], ['do not proceed', 'pause'],
    ['/plan-build pause', 'pause'], ['/buracle:plan-build dur', 'pause'], ['$plan-build pause', 'pause'],
  ])
})

describe('resume: the whole message is a resume word', () => {
  expectAll([
    ['devam', 'resume'], ['Devam et', 'resume'], ['devam edelim', 'resume'], ['devam ediyoruz', 'resume'], ['devam edebilirsin', 'resume'],
    ['tamam devam', 'resume'], ['evet devam et', 'resume'], ['hadi devam', 'resume'], ['devamke', 'resume'], ['sürdür', 'resume'], ['surdur', 'resume'],
    ['kaldığın yerden devam et', 'resume'], ['kaldigin yerden', 'resume'], ['durma', 'resume'], ['devam edin', 'resume'], ['devam lütfen', 'resume'],
    ['Tamam, devam ediyoruz', 'resume'], ['continue', 'resume'], ['Continue.', 'resume'], ['resume', 'resume'], ['proceed', 'resume'], ['go on', 'resume'],
    ['go ahead', 'resume'], ['keep going', 'resume'], ['carry on', 'resume'], ["don't stop", 'resume'], ['do not stop', 'resume'],
    ['/plan-build resume', 'resume'], ['/goal-build devam', 'resume'], ['DEVAM', 'resume'],
  ])
})

describe('stop: the whole message is a cancel word', () => {
  expectAll([
    ['iptal', 'stop'], ['iptal et', 'stop'], ['İptal edelim.', 'stop'], ['vazgeç', 'stop'], ['vazgeçtim', 'stop'], ['vazgec', 'stop'], ['bırak', 'stop'],
    ['bırakalım', 'stop'], ['cancel', 'stop'], ['abort', 'stop'], ['abandon the plan', 'stop'], ['cancel the plan', 'stop'], ['never mind', 'stop'],
    ['forget it', 'stop'], ['drop it', 'stop'], ['boşver', 'stop'], ['Boş ver.', 'stop'], ['boşverin', 'stop'], ['unut gitsin', 'stop'], ['Neyse, boşver.', 'stop'],
  ])
})

describe('a control word inside a longer message is no command: the agent decides', () => {
  expectAll([
    ['Burada dur ve bana sor', null], ['şimdilik dur, akşam bakarız', null], ['her şeyi durdur', null], ['planı durdur', null], ['beni bekle', null],
    ['onayımı bekle, sonra devam', null], ['bir saniye, bir şey soracağım', null], ['Pause the plan for now', null], ['wait, that is wrong', null],
    ['Wait! Which file is this?', null], ['hold on, I need to check something', null], ['That looks wrong. Stop.', null], ['stop everything', null],
    ['Stop! The button is broken.', null], ['wait for my approval before you push', null], ['devam dedim', null], ['Testler geçti, devam', null],
    ['devam ama önce testleri çalıştır', null], ['çalışmaya devam et', null], ['neden devam etmiyorsun?', null], ['ok, continue with task 3', null],
    ['Looks good. Continue.', null], ['bundan vazgeçelim', null], ['bırak bunu', null], ['iptal et ve dur', null], ['Unut gitsin, başka bir şey yapalım.', null],
    ['dur, iptal et', null], ['bekle, sonra devam edersin', null],
    ['Halt! Warte bitte.', null], ['Stopp', null], ['待って', null],
  ])
})

describe('no intent (false-positive corpus)', () => {
  expectAll([
    ['durum nedir?', null], ['Durumu özetle', null], ['otobüs durağı', null], ['devamlı hata veriyor', null], ['devamı var mı', null], ['beklenen sonuç 35', null],
    ['neden durdu?', null], ['sunucuyu durdur ve testleri çalıştır', null], ['testleri bekle', null], ['iptal butonunu düzelt', null], ['dosyayı olduğu gibi bırak', null],
    ['add a stop button', null], ['stop using grep, use rg', null], ['stop the dev server and run the tests', null], ['wait for the build to finish', null],
    ['fix the cancel button', null], ['the stopwatch is broken', null], ['nonstop', null], ['Kullanıcı "dur" yazınca ne oluyor?', null], ['`devam` komutunu belgele', null],
    ['> dur\nbunu alıntıladım', null], ['', null], ['   ', null], ['```\nstop\n```', null], ['Hata hâlâ devam ediyor, loglara bakar mısın?', null],
    ['Continue button is disabled after login.', null], ['Dur butonu çalışmıyor, düzeltir misin?', null], ['Stop button does not respond on iOS, please fix it.', null],
    ['geçen sefer ne yapmıştık?', null], ['Why did we pick FTS5?', null], ['remember the rate limit issue?', null],
  ])
})

describe('precedence and guard prompts', () => {
  test("Buracle's own stop-guard text is never read as the user's intent", () => {
    const { decision } = stopVerdict(
      { ...emptyState(), plan: { path: 'docs/plans/x.md', slug: 'x', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1 } },
      { harness: 'codex', sessionId: 's', cwd: '/r', now: 5 }, defaultConfig().plan,
    )
    expect(decision.action).toBe('block')
    const reason = decision.action === 'block' ? decision.reason : ''
    expect(isGuardContinuation(reason)).toBe(true)
    expect(detectIntent(reason)).toBeNull()
    expect(detectIntent(STOP_GUARD_ESCAPE)).toBeNull()
  })

  test('guard text wrapped by a harness is still recognized', () => {
    expect(isGuardContinuation('<hook_prompt hook_run_id="abc">Buracle stop guard: the plan … dur</hook_prompt>')).toBe(true)
    expect(isGuardContinuation('Stop hook feedback: Buracle plan check: the plan …')).toBe(true)
    expect(isGuardContinuation('please stop. Buracle stop guard: is annoying')).toBe(false)
    expect(isGuardContinuation(42 as unknown as string)).toBe(false)
  })

  test('harness notifications are ignored', () => {
    expect(detectIntent('<task-notification>build stopped, continue?</task-notification>')).toBeNull()
  })

  test("another session's or a lane's message (Claude Code's cross-session wrapper) is not the user's text", () => {
    for (const t of [
      'Another Claude session sent a message:\n<agent-message from="lane-1">\nLane report (status: done). Please stop here and wait for the lead.\n</agent-message>',
      'Another Claude session sent a message while you were working:\n<teammate-message teammate_id="t1" color="blue" summary="done">\nstop\n</teammate-message>',
      'A peer session sent a message while you were working:\nstop',
      '<cross-session-message>stop</cross-session-message>',
      '<agent-message from="lane-1">stop</agent-message>',
      '<teammate-message teammate_id="t1">stop</teammate-message>',
    ]) {
      expect({ t, user: isUserText(t), intent: detectIntent(t) }).toEqual({ t, user: false, intent: null })
    }
  })

  test('non-string input', () => {
    expect(detectIntent(undefined as unknown as string)).toBeNull()
  })

  test("the routing check's continuation is Buracle's, not the user's", () => {
    expect(isGuardContinuation('Buracle routing check: the user asked for plan-build and it was not loaded.')).toBe(true)
    expect(detectIntent('Buracle routing check: stop and load it')).toBeNull()
  })
})

describe('isUserText', () => {
  test('user prompts versus harness and Buracle text', () => {
    expect(isUserText('fix the parser')).toBe(true)
    expect(isUserText('/plan-build add login')).toBe(true)
    for (const t of ['', '   ', 'Buracle stop guard: x', '<task-notification>x</task-notification>', '<system-reminder>x</system-reminder>', '<command-name>/buracle:plan-build</command-name>', 'Base directory for this skill: /x', 42 as unknown as string]) {
      expect({ t, user: isUserText(t) }).toEqual({ t, user: false })
    }
  })

  test("the harness wrappers count only at the start: the user's own text may mention them", () => {
    for (const t of ['stop. Another Claude session sent a message: x', 'why did <agent-message from="x"> arrive twice?', 'A peer session sent a message earlier', 'the <task-notification> tag is documented']) {
      expect({ t, user: isUserText(t) }).toEqual({ t, user: true })
    }
    expect(detectIntent('stop. Another Claude session sent a message: x')).toBeNull()
    expect(detectIntent(`stop${'.'.repeat(5000)}`)).toBeNull()
    const injected = '\n  Another Claude session sent a message while you were working:\n<cross-session-message from="s1">\nstop\n</cross-session-message>\n\nThis came from another Claude session, not typed by your user.'
    expect({ user: isUserText(injected), intent: detectIntent(injected) }).toEqual({ user: false, intent: null })
  })
})

describe('detectSignals: control words only; no history or remember phrases (the agent decides)', () => {
  const sig = (text: string): PromptSignals => detectSignals(text)
  test('history questions and remember requests give no memory signal', () => {
    for (const t of ['Nerede kalmıştık?', 'Why did we pick FTS5?', 'Geçen sefer hangi kararı vermiştik?', 'Bunu unutma: commit mesajları İngilizce.', 'remember this: we deploy on Fridays.', 'From now on use pnpm in this repo.', 'refactor the parser']) {
      expect({ t, s: sig(t) }).toEqual({ t, s: { control: null, recall: false, write: false } })
    }
  })

  test('control signals agree with detectIntent', () => {
    for (const t of ['dur', 'devam', 'iptal', 'stop', 'continue', 'vazgeç', 'wait, that is wrong', 'stop using grep, use rg']) {
      expect({ t, control: sig(t).control as Intent }).toEqual({ t, control: detectIntent(t) })
    }
    expect(sig('Buracle stop guard: dur')).toEqual({ control: null, recall: false, write: false })
  })
})

describe('H10 guidance (CONTROL_GUIDANCE, controlGuidance)', () => {
  test('the wording every harness sends', () => {
    expect(CONTROL_GUIDANCE).toEqual({
      pausePlan: 'Buracle: the user asked you to stop. Finish only the current atomic step, say where you stopped, and wait. The active plan is now paused; the user saying "continue" (in any language) or `buracle plan resume` continues it. Also stop the background commands and subagents this session started (with the harness\'s stop control; if it has none, name the exact command or key and wait). A list of other sessions does not prove that nothing runs.',
      pause: 'Buracle: the user asked you to stop. Finish only the current atomic step, say where you stopped, and wait for them. Also stop the background commands and subagents this session started (with the harness\'s stop control; if it has none, name the exact command or key and wait). A list of other sessions does not prove that nothing runs.',
      resume: 'Buracle: the user said to continue. The plan is resumed; check `buracle plan status --json` and carry on where the plan stands. "Continue" answers no open question: if you were waiting for a decision, ask it again.',
      stop: 'Buracle: the user wants to drop the current task. Stop now and confirm with them before discarding or reverting anything. Also stop the background commands and subagents this session started (with the harness\'s stop control; if it has none, name the exact command or key and wait). A list of other sessions does not prove that nothing runs.',
      autoPause: 'Buracle: the user wrote while the plan was running, so the plan is paused (plan.autoPause). Answer them first; when the work should go on, run `buracle plan resume` (the user saying "continue" resumes it too).',
      resultApproved: 'Buracle: the user approved the verified result, so Buracle recorded the approval (`buracle plan approve-result`) and resumed the plan. Do the worktree merge if the run has one, then finish with `buracle plan verify`.',
    })
  })

  test('a resume during a decision or manual pause says the pause holds and what answers it; a discussion pause resumes', () => {
    const decision = controlGuidance('resume', { hasPlan: true, interaction: { state: 'paused', kind: 'decision', reason: 'merge decision' } }) ?? ''
    expect(decision).toContain('stays paused on an open decision ("merge decision")')
    expect(decision).toContain('"continue" alone does not answer it')
    expect(decision).toContain('buracle plan resume')
    const review = controlGuidance('resume', { hasPlan: true, interaction: { state: 'paused', kind: 'decision', reason: RESULT_REVIEW_REASON } }) ?? ''
    expect(review).toContain('"continue" is no approval of the result')
    expect(review).toContain('buracle plan approve-result')
    const manual = controlGuidance('resume', { hasPlan: true, interaction: { state: 'paused', kind: 'manual', reason: 'rotate the API key' } }) ?? ''
    expect(manual).toContain('manual step ("rotate the API key")')
    expect(manual).toContain('verify its result')
    expect(controlGuidance('resume', { hasPlan: true, interaction: { state: 'paused', kind: 'discussion' } })).toBe(CONTROL_GUIDANCE.resume)
    expect(controlGuidance('resume', { hasPlan: true, interaction: { state: 'running' } })).toBe(CONTROL_GUIDANCE.resume)
    expect(controlGuidance('resume', { hasPlan: false, interaction: { state: 'paused', kind: 'decision' } })).toBeUndefined()
  })

  test('a continue after the criteria-only hand-back resumes without another round; other hand-backs get one more round', () => {
    const done = controlGuidance('resume', { hasPlan: true, interaction: { state: 'paused', kind: 'decision', reason: VERIFICATION_OFF_REASON } }) ?? ''
    expect(done).toContain('no round is left to do')
    expect(done).toContain(`buracle plan pause --kind decision --reason "${VERIFICATION_OFF_REASON}"`)
    expect(done).not.toContain('do one more round')
    const limit = controlGuidance('resume', { hasPlan: true, interaction: { state: 'paused', kind: 'decision', reason: 'build hand-back: round limit' } }) ?? ''
    expect(limit).toContain('do one more round')
  })
})

describe('H10 replies while the plan is paused (pausedReply, isResultApproval, isManualDone)', () => {
  test('a reply during a decision pause is pointed at the open question; the result review names the only approval', () => {
    expect(pausedReply({ state: 'paused', kind: 'decision', reason: 'Redis or in-memory?' }, 'option 2') ?? '').toContain('If this message answers it, act on the answer and run `buracle plan resume`')
    const review = pausedReply({ state: 'paused', kind: 'decision', reason: 'result review' }, 'what about the logs?') ?? ''
    expect(review).toContain('Only an explicit approval of this result counts')
    expect(review).toContain('A bare "continue", silence or green checks are no approval')
  })

  test('a manual pause: "done" (in either language) means check the step, anything else keeps waiting', () => {
    const held = { state: 'paused', kind: 'manual', reason: 'enable the feature flag' } as const
    for (const t of ['done', 'Done, flag is on', 'finished', 'bitti', 'Tamam, yaptım', 'hallettim']) expect({ t, done: pausedReply(held, t)?.includes('reports the manual step') }).toEqual({ t, done: true })
    expect(pausedReply(held, 'how do I enable it?') ?? '').toContain('the run goes on after they say the step is done')
    expect(isManualDone('not done yet')).toBe(false)
  })

  test('a discussion pause gets a meaning-based note (no word list); a running plan gets none', () => {
    expect(pausedReply({ state: 'paused', kind: 'discussion' }, 'ok devam edelim, önce testleri çalıştır')).toBe('Buracle: the plan is paused because the user asked to stop. If this message means go on, in any language, run `buracle plan resume` and continue; otherwise answer the user and keep waiting.')
    expect(pausedReply({ state: 'paused', kind: 'discussion', reason: 'the user sent a message while the plan was running (plan.autoPause)' }, 'what next?')).toBeUndefined()
    expect(pausedReply({ state: 'running' }, 'done')).toBeUndefined()
    expect(pausedReply(undefined, 'done')).toBeUndefined()
  })

  test('the result approval is a short explicit phrase; continue, yes and long or wrapped text are not', () => {
    for (const t of ['approve', 'Approved!', 'I approve', 'approve the result', 'LGTM', 'looks good to me', 'ship it', 'yes, approve', 'Onaylıyorum', 'onayla', 'kabul ediyorum', 'evet onaylıyorum']) {
      expect({ t, ok: isResultApproval(t) }).toEqual({ t, ok: true })
    }
    for (const t of ['continue', 'devam', 'yes', 'ok', 'tamam', 'approve it but first rename every handler in the module, then run it again', '<teammate-message teammate_id="r">lgtm</teammate-message>', 'Buracle stop guard: approve', 'do not approve']) {
      expect({ t, ok: isResultApproval(t) }).toEqual({ t, ok: false })
    }
  })

  test('isResultReview matches the result review pause only', () => {
    expect(isResultReview({ state: 'paused', kind: 'decision', reason: 'Result review: rate limit' })).toBe(true)
    expect(isResultReview({ state: 'paused', kind: 'decision', reason: 'merge decision' })).toBe(false)
    expect(isResultReview({ state: 'paused', kind: 'manual', reason: 'result review' })).toBe(false)
    expect(isResultReview({ state: 'running', reason: 'result review' })).toBe(false)
  })

  test('reportsWaiting recognizes a last message that waits for background work, in English or Turkish', () => {
    for (const t of ['Waiting for the test suite to finish.', 'The review lane is running in the background; I will continue once it reports.', 'Testlerin bitmesini bekliyorum.', 'Build arka planda çalışıyor.']) {
      expect({ t, waits: reportsWaiting(t) }).toEqual({ t, waits: true })
    }
    for (const t of ['All tests pass.', 'Task 3 is done; moving on.', '', undefined]) expect({ t, waits: reportsWaiting(t) }).toEqual({ t, waits: false })
  })

  test('pause, resume and stop get their text, a pause and a resume depend on a plan; nothing else gets any', () => {
    expect(controlGuidance('pause', { hasPlan: true })).toBe(CONTROL_GUIDANCE.pausePlan)
    expect(controlGuidance('pause', { hasPlan: false })).toBe(CONTROL_GUIDANCE.pause)
    expect(controlGuidance('resume', { hasPlan: true })).toBe(CONTROL_GUIDANCE.resume)
    expect(controlGuidance('resume', { hasPlan: false })).toBeUndefined()
    expect(controlGuidance('stop', { hasPlan: true })).toBe(CONTROL_GUIDANCE.stop)
    expect(controlGuidance('stop', { hasPlan: false })).toBe(CONTROL_GUIDANCE.stop)
    expect(controlGuidance('history', { hasPlan: true })).toBeUndefined()
    expect(controlGuidance(null, { hasPlan: true })).toBeUndefined()
  })

  test('English only: no Turkish letters and none of the Turkish control words Buracle recognizes', () => {
    for (const [key, text] of Object.entries(CONTROL_GUIDANCE)) {
      expect({ key, turkish: /[ğüşıöçĞÜŞİÖÇ]|\b(?:dur|bekle|devam|iptal|vazgeç)\b/i.test(text) }).toEqual({ key, turkish: false })
      expect(text.startsWith('Buracle: ')).toBe(true)
    }
  })

  test('exported through the pure core surface', () => {
    expect(core.CONTROL_GUIDANCE).toBe(CONTROL_GUIDANCE)
    expect(core.controlGuidance).toBe(controlGuidance)
  })
})
