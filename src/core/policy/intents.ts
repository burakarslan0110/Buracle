import { fold, stripQuoted, word } from './text'

export type Intent = 'pause' | 'resume' | 'stop' | 'history' | null

export const GUARD_MARKERS = ['Buracle stop guard:', 'Buracle plan check:', 'Buracle routing check:'] as const

export function isGuardContinuation(text: string): boolean {
  if (typeof text !== 'string') return false
  const t = text.trimStart().replace(/^(?:<[^<>]{1,200}>\s*)+/, '').replace(/^[A-Za-z ]{1,40} feedback:\s*/i, '')
  return GUARD_MARKERS.some(m => t.startsWith(m))
}

const HARNESS_TEXT = /^(?:<(?:task-notification|system-reminder|local-command|bash-|command-)|Base directory for this skill:)/i

export function isUserText(text: string): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  return trimmed !== '' && !isGuardContinuation(trimmed) && !HARNESS_TEXT.test(trimmed)
}

type Control = 'pause' | 'resume' | 'stop'
interface Hit { intent: Control, at: number, end: number }

const re = (body: string): RegExp => new RegExp(word(body), 'g')

const NEGATIONS: Array<[RegExp, Control | null]> = [
  [re("devam etme(?:yin|yelim|yiniz|sin)?|don'?t (?:continue|proceed|resume)|do not (?:continue|proceed|resume)"), 'pause'],
  [re("durma(?:yin|yiniz|dan|sin)?|don'?t (?:stop|pause|wait)|do not (?:stop|pause|wait)|never stop"), 'resume'],
  [re("iptal etme(?:yin|yelim)?|vazgecme(?:yin)?|don'?t (?:cancel|abort)|do not (?:cancel|abort)"), null],
]

const PAUSE_ANYWHERE = re('du+r+(?:un|sana)?|duraklat(?:in|iniz|sana)?|durur musun|durabilir misin|durdurur musun|durdurabilir misin|bekler misin|bekleyebilir misin|hold on|hold up')
const PAUSE_OBJECT_SENSITIVE = re('durdur(?:un|sana)?|bekle(?:yin|sene)?')
const DEVAM_REQUEST = [
  'devam (?:et|edin|ediniz|etsene|etsenize|edelim|edersin|edersiniz|edersen|ederseniz|edebilirsin|edebilirsiniz|edebiliriz|etmelisin|etmelisiniz|etmiyorsun|etmiyorsunuz|etsen|etseniz|etmen|etmeniz|etmeni|etmenizi)',
  'devam (?:eder|edebilir|edecek) mi(?:sin|siniz|yiz)',
  String.raw`(?<!hala |halen )devam(?=$|[.,!?;:\n]| (?:lutfen|please|dedim|diyorum|bakalim|o zaman|oyleyse|hadi|haydi|ama|fakat|ancak|yalniz)(?![a-z0-9_'-]))`,
  'devamke',
].join('|')
const RESUME_ANYWHERE = re(`${DEVAM_REQUEST}|surdur(?:un|elim|sene)?|kaldigin yerden|kaldigimiz yerden|keep going|carry on|go on|go ahead`)
const STOP_ANYWHERE = re('vazgec(?:tim|elim|in|iyorum)?|(?:cancel|abort|abandon) (?:the |this )?(?:plan|task|work|run)')

const THING_EN = 'button|btn|key|keyboard|hotkey|shortcut|icon|menu|screen|modal|dialog|popup|overlay|banner|toast|toolbar|tab|label|link|card|option|state|status|mode|flag|event|signal|handler|listener|callback|condition|time|timer|timeout|delay|interval|duration|word|token|statement|keyword|sign|animation|spinner|indicator|widget|gesture|click|sound|message|prompt|notification|list|queue|loss|order|motion'
const THING_TR = 'buton|dugme|tus|ekran|isaret|simge|ikon|menu|pencere|sayfa|sinyal|komut|modu|yazi|animasyon|bildirim|secene[kg]|ozelli[kg]|fonksiyon|islev|olay|kosul|nokta|zamanlayici'
const THING = new RegExp(`^ (?:(?:${THING_EN})(?:e?s)?(?:'[a-z]*)?|(?:${THING_TR})[a-z]*)(?![a-z0-9_'-])`)

function namesThing(t: string, end: number): boolean {
  return THING.test(t.slice(end))
}

const COMMAND: Array<[RegExp, Control]> = [
  [/^(?:stop|pause|halt|freeze|wait)(?![a-z0-9_'-])/, 'pause'],
  [/^(?:bi|bir) (?:dakika|saniye|sn|dk)(?![a-z0-9_'-])/, 'pause'],
  [/^(?:one|just a|a) (?:sec|second|moment|minute)(?![a-z0-9_'-])/, 'pause'],
  [/^(?:continue|resume|proceed|go on|carry on|keep going|move on)(?![a-z0-9_'-])/, 'resume'],
  [/^devam (?:ediyoruz|ederiz|edecegiz)(?![a-z0-9_'-])/, 'resume'],
  [/^(?:cancel|abort|abandon|forget it|never ?mind|drop it|scrap (?:it|that))(?![a-z0-9_'-])/, 'stop'],
  [/^iptal (?:et|edin|edelim|ettim|ediyorum|etsene)(?![a-z0-9_'-])/, 'stop'],
  [/^iptal(?=$|[.,!?;:])/, 'stop'],
  [/^birak(?:alim|in|sana)?(?=$|[.,!?;:])/, 'stop'],
  [/^birak (?:bunu|sunu|onu|isi|o isi|gitsin|artik|simdilik)(?![a-z0-9_'-])/, 'stop'],
  [/^(?:bunu|sunu|isi|o isi|bu isi) birak(?:alim|in)?(?![a-z0-9_'-])/, 'stop'],
  [/^bos ?ver(?:in|elim|sene)?(?=$|[.,!?;:])/, 'stop'],
  [/^bos ?ver(?:in|elim|sene)? (?:bunu|sunu|onu|gitsin|artik|simdilik|ya|be)(?![a-z0-9_'-])/, 'stop'],
  [/^unut(?:alim)?(?=$|[.,!?;:])/, 'stop'],
  [/^unut (?:gitsin|bunu|sunu|onu|artik)(?![a-z0-9_'-])/, 'stop'],
  [/^(?:bunu|sunu|onu) unut(?:alim)?(?![a-z0-9_'-])/, 'stop'],
]
const FILLERS = /^(?:(?:ok(?:ay)?|tamam(?:dir)?|peki|evet|hayir|yok|no|yes|lutfen|please|pls|hey|claude|codex|buracle|simdi|now|just|sadece|artik|haydi|hadi|neyse|o zaman|oyleyse|anyway|actually)(?![a-z0-9_'-])[ ,.!:;-]*)+/
const STEERING_AFTER_STOP = /^(?:stop|pause|halt) (?:(?!(?:every|any|no|some)thing\b)\w+ing\b|(?:(?:the|this|that|those|these|all|my|your) )?(?:dev ?server|server|process(?:es)?|container|watcher|watch|tests?|build|job|daemon|service|script|loop|timer|spinner|animation|worker|app|application|emulator|simulator|music|video|stream|recording)s?(?![a-z0-9_'-]))/
const STEERING_AFTER_WAIT = /^wait (?:for(?! (?:me|us|(?:my|our) (?:answer|approval|confirmation|reply|response|go-?ahead|ok|okay|input|feedback|review|decision|instructions?|signal))\b)|until|till|on|while|a bit longer for)\b/
const STEERING_AFTER_CANCEL = /^(?:cancel|abort) (?:the |this |that |my |a )?(?:button|order|subscription|request|token|signal|event|timer|job|build|deploy(?:ment)?|pr|pull request|workflow|upload|download|query|controller)\b/
const STEERING_AFTER_RESUME = /^(?:continue|resume) (?:(?:the|this|that|my|your|a) )?(?:upload|download|sync|transfer|playback|video|audio|music|song|stream|recording|animation|timer|countdown|slideshow|carousel)s?(?![a-z0-9_'-])/

const FIRST_PERSON_OBJECT = /^(?:beni|bizi)$|(?:imi|umu|imizi|umuzu)$/
const WORK_OBJECTS = new Set(['seyi', 'herseyi', 'hepsini', 'tumunu', 'plani', 'isi', 'isleri', 'gorevi', 'gorevleri', 'calismayi', 'calismani', 'akisi', 'isini'])

const HISTORY = re([
  'gecen (?:sefer|hafta|gun|ay|oturum)', 'daha once', 'onceden', 'onceki (?:oturum|konusma|calisma|plan)[a-z]*', 'neden boyle', 'niye boyle',
  'neden bu sekilde', 'hatirl[a-z]*', 'ne karar', 'neye karar', 'karar ver(?:dik|mistik|mistin|mistiniz)', 'konusmustuk', 'demistik',
  'yapmistik', 'en son ne', 'son oturum',
  'last time', 'previously', 'earlier session', 'previous session', 'why did we', "remember(?! to)", 'recall', 'what did we decide',
  'did we decide', 'we decided', 'we discussed', 'as discussed',
].join('|'))

function previousWord(t: string, at: number): string {
  const m = /([a-z0-9_']+)[ ,]*$/.exec(t.slice(0, at))
  return m ? (m[1] as string).replace(/'.*$/, '') : ''
}

function commandHits(t: string, short: boolean): Hit[] {
  const hits: Hit[] = []
  const starts = [0]
  for (const m of t.matchAll(/[.!?;\n]+ ?/g)) starts.push((m.index ?? 0) + m[0].length)
  if (short) for (const m of t.matchAll(/(?<=[ ,])(?=[a-z])/g)) starts.push(m.index ?? 0)
  for (const s of starts) {
    let pos = s
    const rest = t.slice(pos)
    const filler = FILLERS.exec(rest)
    if (filler) pos += filler[0].length
    const clause = t.slice(pos)
    if (clause === '') continue
    if ([STEERING_AFTER_STOP, STEERING_AFTER_WAIT, STEERING_AFTER_CANCEL, STEERING_AFTER_RESUME].some(rx => rx.test(clause))) continue
    for (const [rx, intent] of COMMAND) {
      const m = rx.exec(clause)
      if (m) {
        if (!namesThing(clause, m[0].length)) hits.push({ intent, at: pos, end: pos + m[0].length })
        break
      }
    }
  }
  return hits
}

function userWords(text: string): string | undefined {
  if (!isUserText(text)) return undefined
  const trimmed = text.trim()
  const slash = /^[/$][\w:.-]+(?:\s+([\s\S]*))?$/.exec(trimmed)
  const body = slash ? (slash[1] ?? '') : trimmed
  const t = fold(stripQuoted(body))
  return t === '' ? undefined : t
}

export function detectIntent(text: string): Intent {
  const t = userWords(text)
  if (t === undefined) return null
  const control = controlOf(t)
  if (control !== null) return control
  HISTORY.lastIndex = 0
  RECALL.lastIndex = 0
  return HISTORY.test(t) || RECALL.test(t) ? 'history' : null
}

function controlOf(t: string): Control | null {
  const hits: Hit[] = []
  const hidden: Array<[number, number]> = []
  for (const [rx, intent] of NEGATIONS) {
    for (const m of t.matchAll(rx)) {
      const at = m.index ?? 0
      hidden.push([at, at + m[0].length])
      if (intent) hits.push({ intent, at, end: at + m[0].length })
    }
  }
  const isHidden = (at: number): boolean => hidden.some(([a, b]) => at >= a && at < b)
  const add = (rx: RegExp, intent: Control): void => {
    for (const m of t.matchAll(rx)) {
      const at = m.index ?? 0
      const end = at + m[0].length
      if (!isHidden(at) && !namesThing(t, end)) hits.push({ intent, at, end })
    }
  }
  add(PAUSE_ANYWHERE, 'pause')
  add(RESUME_ANYWHERE, 'resume')
  add(STOP_ANYWHERE, 'stop')
  for (const m of t.matchAll(PAUSE_OBJECT_SENSITIVE)) {
    const at = m.index ?? 0
    if (isHidden(at) || namesThing(t, at + m[0].length)) continue
    const prev = previousWord(t, at)
    const isObject = /[iu]$/.test(prev) && !FIRST_PERSON_OBJECT.test(prev) && !WORK_OBJECTS.has(prev)
    if (!isObject) hits.push({ intent: 'pause', at, end: at + m[0].length })
  }
  const words = t.split(/[^a-z0-9_']+/).filter(w => w !== '')
  for (const h of commandHits(t, words.length <= 3)) if (!isHidden(h.at)) hits.push(h)

  if (hits.some(h => h.intent === 'stop')) return 'stop'
  if (hits.length === 0) return null
  hits.sort((a, b) => a.at - b.at)
  return (hits[0] as Hit).intent
}

export const CONTROL_GUIDANCE = {
  pausePlan: 'Buracle: the user asked you to stop. Finish only the current atomic step, say where you stopped, and wait. The active plan is now paused; the user saying "continue" (in any language) or `buracle plan resume` continues it. Also stop the background commands and subagents this session started (with the harness\'s stop control; if it has none, name the exact command or key and wait). A list of other sessions does not prove that nothing runs.',
  pause: 'Buracle: the user asked you to stop. Finish only the current atomic step, say where you stopped, and wait for them. Also stop the background commands and subagents this session started (with the harness\'s stop control; if it has none, name the exact command or key and wait). A list of other sessions does not prove that nothing runs.',
  resume: 'Buracle: the user said to continue. The plan is resumed; check `buracle plan status --json` and carry on where the plan stands. "Continue" answers no open question: if you were waiting for a decision, ask it again.',
  stop: 'Buracle: the user wants to drop the current task. Stop now and confirm with them before discarding or reverting anything. Also stop the background commands and subagents this session started (with the harness\'s stop control; if it has none, name the exact command or key and wait). A list of other sessions does not prove that nothing runs.',
  autoPause: 'Buracle: the user wrote while the plan was running, so the plan is paused (plan.autoPause). Answer them first; when the work should go on, run `buracle plan resume` (the user saying "continue" resumes it too).',
  resultApproved: 'Buracle: the user approved the verified result, so Buracle recorded the approval (`buracle plan approve-result`) and resumed the plan. Do the worktree merge if the run has one, then finish with `buracle plan verify`.',
} as const

export interface HeldInteraction { state: 'running' | 'paused'; kind?: 'discussion' | 'decision' | 'manual'; reason?: string }

function decisionAbout(i: HeldInteraction | undefined, prefix: string): boolean {
  return i?.state === 'paused' && i.kind === 'decision' && typeof i.reason === 'string' && i.reason.trim().toLowerCase().startsWith(prefix)
}

export const RESULT_REVIEW_REASON = 'result review'

export function isResultReview(i: HeldInteraction | undefined): boolean {
  return decisionAbout(i, RESULT_REVIEW_REASON)
}

export const RUNAWAY_REASON = 'runaway: continue, pivot or abandon?'

export function isRunawayDecision(i: HeldInteraction | undefined): boolean {
  return decisionAbout(i, 'runaway:')
}

export const HANDBACK_REASON = 'build hand-back:'

export const VERIFICATION_OFF_REASON = `${HANDBACK_REASON} done, verification off`

export function isHandback(i: HeldInteraction | undefined): boolean {
  return decisionAbout(i, HANDBACK_REASON)
}

export const MODEL_SWITCH_REASON = 'model switch:'

export function isModelSwitch(i: HeldInteraction | undefined): boolean {
  return decisionAbout(i, MODEL_SWITCH_REASON)
}

export function resumableDecision(i: HeldInteraction | undefined): boolean {
  return isRunawayDecision(i) || isHandback(i) || isModelSwitch(i)
}

const RUNAWAY_RESUME = 'Buracle: the user chose to continue after the stop guard\'s runaway limit, so the plan is resumed and the stop-guard counters start again. Check `buracle plan status --json` and carry on with the current approach; if the same block comes back, pause and ask again.'

const HANDBACK_RESUME = 'Buracle: the user said to continue after the build hand-back, so the plan is resumed and the stop-guard counters start again. Run `buracle flow start goal-build --title "<goal title>"`, re-read the run file and do one more round; the user\'s request is what allows a round past the fourth.'

const CRITERIA_ONLY_RESUME = `Buracle: the user said to continue after the criteria-only hand-back (done, verification off), so the plan is resumed. Every criterion passed and verification stays off for this run, so no round is left to do. Do what the message asks (a fix or a change: make it, re-judge the criteria it touches and add the rows to \`## Evidence\`), then hand back again with \`buracle plan pause --kind decision --reason "${VERIFICATION_OFF_REASON}"\`; if it asks for nothing more, hand back right away. A new goal is a new run.`

const MODEL_SWITCH_RESUME = 'Buracle: the user said to continue after the model switch, so the plan is resumed on the model now in use. Check `buracle plan status --json`, re-read the plan file and start the implementation with its first unticked task.'

function quoted(reason: string | undefined): string {
  const r = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : ''
  return r === '' ? '' : ` ("${r.length > 160 ? `${r.slice(0, 157)}...` : r}")`
}

const REVIEW_RULE = 'Only an explicit approval of this result counts: then run `buracle plan approve-result`. Feedback means `buracle plan resume`, fix, re-run the checks the fix touches and ask again; "I will test it first" means keep the pause and end the turn.'

function heldResume(i: HeldInteraction): string | undefined {
  if (i.state !== 'paused') return undefined
  if (i.kind === 'manual') return `Buracle: the user said to continue, but the plan stays paused on a manual step${quoted(i.reason)}. Check that the step is done (ask if you cannot tell), verify its result, then run \`buracle plan resume\` and continue.`
  if (i.kind !== 'decision') return undefined
  if (isRunawayDecision(i)) return RUNAWAY_RESUME
  if (decisionAbout(i, VERIFICATION_OFF_REASON)) return CRITERIA_ONLY_RESUME
  if (isHandback(i)) return HANDBACK_RESUME
  if (isModelSwitch(i)) return MODEL_SWITCH_RESUME
  if (isResultReview(i)) return `Buracle: the user said to continue, but the plan stays paused on the result review; "continue" is no approval of the result. ${REVIEW_RULE}`
  return `Buracle: the user said to continue, but the plan stays paused on an open decision${quoted(i.reason)}; "continue" alone does not answer it. If their message makes a choice, act on that choice and run \`buracle plan resume\`; otherwise ask the question again and end the turn.`
}

export function controlGuidance(intent: Intent, opts: { hasPlan: boolean, interaction?: HeldInteraction }): string | undefined {
  if (intent === 'pause') return opts.hasPlan ? CONTROL_GUIDANCE.pausePlan : CONTROL_GUIDANCE.pause
  if (intent === 'resume') {
    if (!opts.hasPlan) return undefined
    return (opts.interaction !== undefined ? heldResume(opts.interaction) : undefined) ?? CONTROL_GUIDANCE.resume
  }
  if (intent === 'stop') return CONTROL_GUIDANCE.stop
  return undefined
}

const RESULT_APPROVAL = /^(?:(?:yes|evet|ok|okay|tamam)[ ,.!:;-]+)?(?:i approve(?: (?:it|this|the result|the change|the changes))?|approved?(?: (?:it|this|the result|the change|the changes))?|lgtm|looks good(?: to me)?|ship it|onayl(?:iyorum|adim|andi|a|i)|onay(?:liyorum)?|kabul(?: ediyorum)?)(?:[ ,.!:;-]+(?:thanks|thank you|tesekkurler|tesekkur ederim|sagol))?[ .!]*$/

export function isResultApproval(text: string): boolean {
  const t = userWords(text)
  return t !== undefined && t.length <= 60 && RESULT_APPROVAL.test(t)
}

const MANUAL_DONE = /^(?:(?:ok|okay|tamam|evet|yes)[ ,.!:;-]+)?(?:done|finished|completed|it'?s done|i did it|i have done it|bitti|hallettim|hallettik|yaptim|yaptik|tamamladim|tamamlandi|tamam(?:dir)?|oldu)(?![a-z0-9_'-])/

export function isManualDone(text: string): boolean {
  const t = userWords(text)
  return t !== undefined && MANUAL_DONE.test(t)
}

export function pausedReply(i: HeldInteraction | undefined, text: string): string | undefined {
  if (i === undefined || i.state !== 'paused') return undefined
  if (i.kind === 'manual') {
    return isManualDone(text)
      ? `Buracle: the user reports the manual step${quoted(i.reason)} done. Check its result, then run \`buracle plan resume\` and continue.`
      : `Buracle: the plan is paused on a manual step${quoted(i.reason)}. Answer the user; the run goes on after they say the step is done and you have checked it (\`buracle plan resume\`).`
  }
  if (i.kind !== 'decision') return undefined
  if (isResultReview(i)) return `Buracle: the plan is paused on the result review. ${REVIEW_RULE} A bare "continue", silence or green checks are no approval.`
  if (isModelSwitch(i)) return 'Buracle: the plan is paused so the user can switch models before the implementation. Answer the user; when their message means go on, run `buracle plan resume` and start the implementation.'
  return `Buracle: the plan is paused on an open decision${quoted(i.reason)}. If this message answers it, act on the answer and run \`buracle plan resume\`; otherwise answer the user and keep waiting.`
}

const WAITING = re([
  'waiting (?:for|on|until)', 'wait(?:ing)? for (?:it|them|the [a-z0-9 -]{1,40}) to (?:finish|complete|return|report)',
  "i'?ll (?:check|continue|resume|report|pick (?:it|this) up) (?:back )?(?:when|once|after)", 'once (?:it|they|the [a-z0-9 -]{1,40}) (?:finish|complete|return|report)[a-z]*',
  '(?:is|are) (?:still )?running in the background', 'running in the background',
  'bekliyorum', 'bekleniyor', '(?:bitmesini|tamamlanmasini|sonuclanmasini|donmesini) bekl[a-z]*', 'bitince', 'tamamlaninca', 'arka planda (?:calisiyor|suruyor|devam ediyor)',
].join('|'))

export function reportsWaiting(text: string | undefined): boolean {
  if (typeof text !== 'string' || text.trim() === '') return false
  WAITING.lastIndex = 0
  return WAITING.test(fold(text))
}

const QUESTION_TAIL = String.raw`(?:[^.!?\n]{0,160}\?|(?:[^.!?\n]{0,120} )?(?:hangi|neden|niye|nasil|nerede|ne zaman)(?![a-z0-9_'-]))`

const RECALL = re([
  'gecen (?:sefer|hafta|gun|ay|oturum)', 'onceki (?:oturum|konusma|calisma|plan)[a-z]*', 'son oturum[a-z]*', 'en son ne',
  'neden boyle', 'niye boyle', 'neden bu sekilde', 'ne karar', 'neye karar', 'karar ver(?:dik|mistik|mistin|mistiniz)',
  'hatirliyor mu(?:sun|sunuz)?', 'hatirlamiyor mu(?:sun|sunuz)?',
  '(?:sebeb|neden|gerekce)(?:i|si) (?:neydi|ne idi|neymis)',
  "neden (?:[a-z0-9.'-]+ ){0,5}(?:sectik|secmistik|kullaniyoruz|kullandik|kullanmistik|calistiriyoruz|yapiyoruz|yaptik|tercih ettik|karar verdik)",
  'nerede kal(?:mistik|dik|mistim|mistin|diniz|mistiniz)', 'kaldigimiz yer[a-z]*',
  '[a-z]+(?<!opti|pesi)m[iu]st[iu]k', '[a-z]+m[iu]s m[iu]yd[iu]k', String.raw`[a-z]+[iu]yord[iu]k(?=[^.!\n]{0,80}\?)`,
  String.raw`(?:daha once|onceden) (?:[^.!?\n]{0,80} )?[a-z]+[dt][iu](?:k|n|niz) m[iu](?:y[iu]z|s[iu]n|s[iu]n[iu]z)?`,
  `hatirla(?:sana|yin|yiniz)?[,:]? ${QUESTION_TAIL}`,
  'last time', 'last session', 'earlier session', 'previous session', '(?:how|what|when|where|why) did we',
  "(?:which|what) (?:[a-z0-9.'-]+ ){1,3}did we", 'did we decide', '(?:did|have) we ever',
  String.raw`(?:have|had|did) we (?:[^.!?\n]{1,80} )?before(?= ?[?.!]|$)`,
  'we (?:had )?decided', 'we discussed', 'as discussed',
  '(?:what|which) (?:was|were) (?:our|the) (?:[a-z-]+ )?(?:decision|choice|plan|approach|idea|reasoning|rationale|conclusion|agreement|reason)s?',
  'where were we', 'where we left off', 'pick up where', 'do you remember', 'remember (?:when|how we|why we|what we)',
  'remember the [^.!?\\n]{1,60}\\?', String.raw`remember(?:[,:]| that| this) [^.!?\n]{0,160}\?`,
].join('|'))

const WRITE = re([
  String.raw`(?<!m[ae]yi (?:d[ae] )?)unutma(?:yin|yiniz|yalim)?`, 'bunu hatirla', 'hatirla bunu', `hatirla(?=[,:])(?![,:] ?${QUESTION_TAIL})`,
  '(?:bunu )?aklinda tut', 'aklinizda tutun',
  'not al(?:in)?', 'not et(?:in)?', 'not dus', '(?:hafiza|kasa)(?:ya|na) (?:kaydet|yaz|ekle|al|not et)', 'bundan boyle',
  String.raw`remember (?:this|that)(?![^.!?\n]{0,160}\?)`, String.raw`don'?t forget(?! to(?![a-z0-9_'-]))`,
  String.raw`do not forget(?! to(?![a-z0-9_'-]))`, 'note (?:this|that) down', 'take a note', 'make a note', 'keep in mind',
  'save (?:this|that|it) (?:to|in) (?:memory|the vault)', 'write (?:this|that|it) down', 'for future reference', 'from now on',
].join('|'))

export interface PromptSignals {
  control: 'pause' | 'resume' | 'stop' | null
  recall: boolean
  write: boolean
}

export function detectSignals(text: string): PromptSignals {
  const t = userWords(text)
  if (t === undefined) return { control: null, recall: false, write: false }
  RECALL.lastIndex = 0
  WRITE.lastIndex = 0
  return { control: controlOf(t), recall: RECALL.test(t), write: WRITE.test(t) }
}
