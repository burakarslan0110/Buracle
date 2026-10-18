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

describe('pause', () => {
  expectAll([
    ['dur!', 'pause'], ['DUR', 'pause'], ['Dur.', 'pause'], ['durr', 'pause'], ['duuur', 'pause'], ['dur bir dakika', 'pause'], ['lütfen dur', 'pause'],
    ['tamam dur', 'pause'], ['durun', 'pause'], ['dursana', 'pause'], ['Burada dur ve bana sor', 'pause'], ['şimdilik dur, akşam bakarız', 'pause'],
    ['durdur', 'pause'], ['her şeyi durdur', 'pause'], ['planı durdur', 'pause'], ['duraklat', 'pause'], ['duraklatın lütfen', 'pause'],
    ['bekle', 'pause'], ['bekleyin', 'pause'], ['biraz bekle', 'pause'], ['bir dakika bekle', 'pause'], ['beni bekle', 'pause'], ['cevabımı bekle', 'pause'],
    ['onayımı bekle, sonra devam', 'pause'], ['bi dakika', 'pause'], ['bir saniye, bir şey soracağım', 'pause'], ['durur musun', 'pause'],
    ['durabilir misin?', 'pause'], ['bekler misin', 'pause'],
    ['Stop', 'pause'], ['STOP!!!', 'pause'], ['stop it', 'pause'], ['please stop', 'pause'], ['ok stop', 'pause'], ['stop now', 'pause'], ['pause', 'pause'],
    ['Pause the plan for now', 'pause'], ['wait', 'pause'], ['wait, that is wrong', 'pause'], ['Wait! Which file is this?', 'pause'], ['hold on', 'pause'],
    ['hold on, I need to check something', 'pause'], ['Hold up.', 'pause'], ['halt', 'pause'], ['one sec', 'pause'], ['just a moment', 'pause'],
    ['That looks wrong. Stop.', 'pause'], ['stop everything', 'pause'], ['That is not what I asked for at all\nstop', 'pause'],
    ['Tamam, anladım.\nŞimdilik bekle', 'pause'], ['I checked the output and it looks fine now\n\ncontinue', 'resume'], ['devam etme', 'pause'], ['devam etmeyin', 'pause'], ["don't continue", 'pause'],
    ['do not proceed', 'pause'], ['/plan-build pause', 'pause'], ['/buracle:plan-build dur', 'pause'], ['$plan-build pause', 'pause'],
    ['Stop! The button is broken.', 'pause'], ['wait, the stop button is fine', 'pause'], ['Dur, bu butonu değil diğerini düzelt', 'pause'],
    ['o zaman dur', 'pause'],
    ['wait for me', 'pause'], ['wait for my approval before you push', 'pause'], ['Wait for our answer.', 'pause'],
  ])
})

describe('resume', () => {
  expectAll([
    ['devam', 'resume'], ['Devam et', 'resume'], ['devam edelim', 'resume'], ['devam ediyoruz', 'resume'], ['devam edebilirsin', 'resume'],
    ['tamam devam', 'resume'], ['evet devam et', 'resume'], ['hadi devam', 'resume'], ['devamke', 'resume'], ['sürdür', 'resume'], ['surdur', 'resume'],
    ['kaldığın yerden devam et', 'resume'], ['kaldigin yerden', 'resume'], ['kaldığımız yerden', 'resume'], ['durma', 'resume'], ['durmadan devam et', 'resume'],
    ['neden devam etmiyorsun?', 'resume'], ['devam edebilir miyiz', 'resume'],
    ['devam edin', 'resume'], ['devam eder misin', 'resume'], ['devam lütfen', 'resume'], ['devam dedim', 'resume'], ['Tamam, devam ediyoruz', 'resume'],
    ['Testler geçti, devam', 'resume'], ['devam ama önce testleri çalıştır', 'resume'], ['çalışmaya devam et', 'resume'], ['peki o zaman devam ediyoruz', 'resume'],
    ['continue', 'resume'], ['Continue.', 'resume'], ['resume', 'resume'], ['proceed', 'resume'], ['go on', 'resume'], ['go ahead', 'resume'],
    ['keep going', 'resume'], ['carry on', 'resume'], ["don't stop", 'resume'], ['do not stop', 'resume'], ['Looks good. Continue.', 'resume'],
    ['ok, continue with task 3', 'resume'], ['/plan-build resume', 'resume'], ['/goal-build devam', 'resume'], ['DEVAM', 'resume'],
  ])
})

describe('stop (cancel)', () => {
  expectAll([
    ['iptal', 'stop'], ['iptal et', 'stop'], ['İptal edelim.', 'stop'], ['vazgeç', 'stop'], ['vazgeçtim', 'stop'], ['bundan vazgeçelim', 'stop'],
    ['vazgec', 'stop'], ['bırak', 'stop'], ['bırak bunu', 'stop'], ['bunu bırak', 'stop'], ['bırakalım', 'stop'], ['cancel', 'stop'], ['abort', 'stop'],
    ['abandon the plan', 'stop'], ['cancel the plan', 'stop'], ['never mind', 'stop'], ['forget it', 'stop'], ['iptal et ve dur', 'stop'],
    ['drop it', 'stop'],
    ['boşver', 'stop'], ['Boş ver.', 'stop'], ['boşverin', 'stop'], ['boş verelim', 'stop'], ['Boşver bunu', 'stop'], ['unut gitsin', 'stop'],
    ['bunu unut', 'stop'], ['Unut gitsin, başka bir şey yapalım.', 'stop'], ['Neyse, boşver.', 'stop'], ['Tamam, bunu unut.', 'stop'],
  ])
})

describe('history', () => {
  expectAll([
    ['geçen sefer ne yapmıştık?', 'history'], ['daha önce bunu konuşmuştuk', 'history'], ['önceki oturumda ne oldu', 'history'],
    ['neden böyle yaptık?', 'history'], ['hatırla, bu projede pnpm kullanıyoruz', 'history'], ['hatırlıyor musun', 'history'], ['ne karar vermiştik?', 'history'],
    ['last time we used redis', 'history'], ['Why did we pick FTS5?', 'history'], ['What did we decide about auth?', 'history'], ['remember the rate limit issue?', 'history'],
    ['previously this failed', 'history'],
  ])
})

describe('no intent (false-positive corpus)', () => {
  expectAll([
    ['durum nedir?', null], ['Durumu özetle', null], ['durum raporu yaz', null], ['otobüs durağı', null], ['durak ekranını düzelt', null],
    ['devamlı hata veriyor', null], ['bu devamlı oluyor', null], ['devamı var mı', null], ['devamında ne var', null], ['dosyanın devamını oku', null],
    ['beklenen sonuç 35', null], ['beklenmedik bir hata var', null], ['beklentim bu değildi', null], ['bekleniyor', null], ['dürüst ol', null],
    ['neden durdu?', null], ['durduk yere hata verdi', null], ['süreç duruyor', null], ['build’in bitmesini bekle sonra testleri çalıştır', null],
    ['sunucuyu durdur ve testleri çalıştır', null], ['testleri bekle', null], ['sonucu bekle', null], ['iptal butonunu düzelt', null],
    ['siparişi iptal eden endpoint yaz', null], ['dosyayı olduğu gibi bırak', null], ['bu satırı boş bırak', null], ['vazgeçilmez bir özellik', null],
    ['add a stop button', null], ['stop using grep, use rg', null], ['stop the dev server and run the tests', null], ['the parser should stop at EOF', null],
    ['wait for the build to finish', null], ['make the loop continue on errors', null], ['fix the cancel button', null], ['cancel the order when payment fails', null],
    ['abort controller does not work', null], ['add a pause button to the player', null], ['the stopwatch is broken', null], ['nonstop', null],
    ['stop_words listesini güncelle', null], ['remember to run the tests', null], ['dur-kalk trafiğini simüle et', null],
    ['Kullanıcı "dur" yazınca ne oluyor?', null], ['`devam` komutunu belgele', null], ['> dur\nbunu alıntıladım', null], ['', null], ['   ', null],
    ['```\nstop\n```', null], ['bu kodu düzelt', null], ['testleri çalıştır', null], ['refactor the parser', null],
    ['boş veri döndürüyor', null], ['testleri boş verme', null], ['şifremi unuttum ekranı', null], ['kullanıcı şifreyi unutursa ne olacak', null],
  ])
})

describe('bug reports and status questions are not commands', () => {
  expectAll([
    ['Hata hâlâ devam ediyor, loglara bakar mısın?', null], ['Bu sorun devam ederse rollback yaparız.', null],
    ['Devam eden testlerde timeout var.', null], ['Login sorunu devam ediyor mu?', null], ['Testler hâlâ devam ediyor mu?', null],
    ['Devam eden görevler neler?', null], ['Migration devam edecek mi?', null], ['/buracle:plan-build devam eden siparişler için filtre ekle', null],
    ['Testlerin devam etmesi lazım', null], ['Sorun hâlâ devam.', null], ['hata almaya devam ediyoruz, neden?', null],
    ['Video kaldığı yerden devam etmiyor', null],
    ['Are the tests still running?', null], ['What are the ongoing tasks?', null], ['Will the migration continue?', null],
    ['The tests need to continue', null],
    ['Continue button is disabled after login.', null], ['Continue button is disabled after login. Is that caused by the auth change?', null],
    ['Stop button does not respond on iOS, please fix it.', null], ['/bugfix stop button does not work on the player page', null],
    ['Pause menu crashes when I press escape.', null], ['/plan-build wait time on the upload page is too long', null],
    ['Cancel button should close the dialog.', null], ['Resume button stays grey', null], ['Stop words are not filtered', null],
    ['Dur butonu çalışmıyor, düzeltir misin?', null], ['Oynatıcıya bir dur butonu ekle', null], ['Bekle ekranı hiç kapanmıyor.', null],
    ['Devam butonunun rengini değiştir', null], ['Devam butonu login sonrası pasif kalıyor.', null], ['Devam et butonu çalışmıyor', null],
    ['Durdur tuşuna basınca uygulama donuyor', null], ['Stop butonu çalışmıyor', null], ["Continue button'una basınca hata veriyor", null],
    ['Add a stop button to the player', null], ['Change the color of the continue button', null], ['fix stop button', null],
    ['stop server and run the tests', null], ['pause video when the tab is hidden', null],
    ['resume upload after the network comes back', null], ['Resume the video when the user returns', null], ['continue playback on the next device', null],
  ])
})

describe('the control phrases every harness relies on', () => {
  expectAll([
    ['dur', 'pause'], ['bekle', 'pause'], ['durdur', 'pause'], ['dur bir dakika', 'pause'], ['bir saniye', 'pause'],
    ['stop', 'pause'], ['wait', 'pause'], ['hold on', 'pause'],
    ['devam', 'resume'], ['devam et', 'resume'], ['devam edin', 'resume'], ['devam edelim', 'resume'], ['kaldığın yerden devam', 'resume'],
    ['hadi devam', 'resume'], ['sürdür', 'resume'], ['continue', 'resume'], ['go ahead', 'resume'],
    ['vazgeç', 'stop'], ['iptal', 'stop'], ['never mind', 'stop'], ['forget it', 'stop'], ['drop it', 'stop'],
  ])
})

describe('precedence and guard prompts', () => {
  test('stop wins over pause and resume', () => {
    expect(detectIntent('dur, iptal et')).toBe('stop')
    expect(detectIntent('devam etme, vazgeçtim')).toBe('stop')
  })

  test('the earliest control word wins between pause and resume', () => {
    expect(detectIntent('bekle, sonra devam edersin')).toBe('pause')
    expect(detectIntent('devam et ama sonra dur')).toBe('resume')
  })

  test('control words win over history', () => {
    expect(detectIntent('dur, geçen sefer ne yapmıştık?')).toBe('pause')
  })

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
})

describe('detectSignals (H22 memory signals)', () => {
  const sig = (text: string): PromptSignals => detectSignals(text)
  test('the memory eval prompts', () => {
    expect(sig('Nerede kalmıştık? Kaldığımız yerden devam edelim.')).toEqual({ control: 'resume', recall: true, write: false })
    expect(sig('Testleri neden bun test ile çalıştırıyoruz, bunun sebebi neydi?')).toEqual({ control: null, recall: true, write: false })
    expect(sig('Bunu unutma: bu projede commit mesajları İngilizce yazılıyor.')).toEqual({ control: null, recall: false, write: true })
    expect(sig('remember this: we deploy on Fridays only after the smoke test.')).toEqual({ control: null, recall: false, write: true })
    expect(sig('Geçen sefer bu projede önbellek katmanı için hangi kararı vermiştik?').recall).toBe(true)
    expect(sig('What did we decide last time about the plan file format?').recall).toBe(true)
  })

  test('recall: questions about earlier work and its reasons', () => {
    for (const t of ['Why did we pick FTS5?', 'where were we?', 'Do you remember the rate limit issue?', 'remember the token bug?', 'önceki oturumda ne oldu', 'neden böyle yaptık?', 'Bunu neden seçmiştik?', 'what was the reason for the cache?']) {
      expect({ t, recall: sig(t).recall }).toEqual({ t, recall: true })
    }
  })

  test('recall: "how did we", "have we ... before", "our decision" and the Turkish past forms of "we"', () => {
    for (const t of [
      'daha önce bu hatayı nasıl çözmüştük?', 'Bu konuda daha önce bir karar almış mıydık?', 'geçen sefer neden FTS5 seçmiştik?',
      'Bu hatayı daha önce gördün mü?', 'daha önce bunu denedik mi?', 'Bu projede hangi test runner kullanıyorduk?', 'Ne yapıyorduk?',
      'What was our decision on the lockfile policy?', 'Have we seen this error before?', 'How did we fix the codegraph timeout last week?',
      'Did we ever add retries to the client?', 'Which ORM did we choose?', 'When did we switch to pnpm?', 'What was our plan for the migration?',
    ]) {
      expect({ t, recall: sig(t).recall }).toEqual({ t, recall: true })
    }
  })

  test('"remember, ...?" with a question (English and Turkish) is a recall, not a write', () => {
    expect(sig("hatırla, bu projede hangi test runner'ı kullanıyorduk?")).toEqual({ control: null, recall: true, write: false })
    expect(sig('Hatırla, neden pnpm kullanıyoruz')).toEqual({ control: null, recall: true, write: false })
    expect(sig('Remember, which test runner were we using?')).toEqual({ control: null, recall: true, write: false })
    expect(sig('Remember that bug from the login page?')).toEqual({ control: null, recall: true, write: false })
  })

  test('write: requests to keep something', () => {
    for (const t of ['not al: staging veritabanı her pazar sıfırlanıyor', 'hatırla, bu projede pnpm kullanıyoruz', 'Keep in mind that the API is rate limited.', "don't forget: tests run in CI only", 'From now on use pnpm in this repo.', 'take a note: the vault lives in ~/Documents/Buracle', "Don't forget that the staging DB resets every Sunday.", 'Unutma, staging her pazar sıfırlanıyor.', 'remember that for every project']) {
      expect({ t, write: sig(t).write }).toEqual({ t, write: true })
    }
  })

  test('no write: "don\'t forget to <verb>" and its Turkish twin are instructions', () => {
    for (const t of ['testleri çalıştırmayı unutma', "don't forget to run the linter before you commit", 'Do not forget to bump the version.', 'PR açmayı da unutmayın', 'commit atmayı unutma lütfen']) {
      expect({ t, write: sig(t).write }).toEqual({ t, write: false })
    }
  })

  test('no recall: "last week" in feature talk, "optimistic" in Turkish, a decision table', () => {
    for (const t of ["Show last week's sales on the dashboard", 'optimistik güncelleme ekle', 'Our decision table needs a new column', 'Optimistik kilitleme nasıl çalışır?']) {
      expect({ t, recall: sig(t).recall }).toEqual({ t, recall: false })
    }
  })

  test('a control word does not hide the memory signals', () => {
    expect(sig('dur, geçen sefer ne yapmıştık?')).toEqual({ control: 'pause', recall: true, write: false })
    expect(sig('stop. what did we decide about auth?')).toEqual({ control: 'pause', recall: true, write: false })
  })

  test('no signals: code tasks, feature talk, "before" as a plain word', () => {
    for (const t of ['17 ile 23\'ü çarp.', 'Write a bash one-liner that counts the lines of every .md file in this folder.', 'remember the last selected tab in localStorage', 'daha önce bu fonksiyonu çağır', 'remember to run the tests', 'Note that the function returns null.', 'refactor the parser']) {
      expect({ t, s: sig(t) }).toEqual({ t, s: { control: null, recall: false, write: false } })
    }
    expect(sig('Buracle stop guard: where were we?')).toEqual({ control: null, recall: false, write: false })
    expect(sig('<task-notification>remember this</task-notification>')).toEqual({ control: null, recall: false, write: false })
    expect(sig('"remember this" is a phrase users type')).toEqual({ control: null, recall: false, write: false })
  })

  test('control signals agree with detectIntent', () => {
    for (const t of ['dur', 'devam', 'iptal', 'stop', 'continue', 'vazgeç', 'wait, that is wrong', 'stop using grep, use rg', 'geçen sefer ne yapmıştık?']) {
      const i = detectIntent(t)
      expect({ t, control: sig(t).control }).toEqual({ t, control: i === 'history' ? null : i })
    }
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

  test('no guidance for a discussion pause or a running plan', () => {
    expect(pausedReply({ state: 'paused', kind: 'discussion' }, 'what next?')).toBeUndefined()
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
