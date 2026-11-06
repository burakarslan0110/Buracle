import { fold, stripQuoted, word } from './text'

export type Intent = 'pause' | 'resume' | 'stop' | 'history' | null

export const GUARD_MARKERS = ['Buracle stop guard:', 'Buracle plan check:', 'Buracle routing check:'] as const

export function isGuardContinuation(text: string): boolean {
  if (typeof text !== 'string') return false
  const t = text.trimStart().replace(/^(?:<[^<>]{1,200}>\s*)+/, '').replace(/^[A-Za-z ]{1,40} feedback:\s*/i, '')
  return GUARD_MARKERS.some(m => t.startsWith(m))
}

// Text a harness injects as a user turn: Claude Code's notifications and skill loads, and another session's or a lane's
// message (SendMessage, agent teams), which it frames as "Another Claude session sent a message:" / "A peer session sent a
// message while you were working:" around a <cross-session-message>, <agent-message> or <teammate-message> block.
const HARNESS_TEXT = /^(?:<(?:task-notification|system-reminder|local-command|bash-|command-|cross-session-message|agent-message|teammate-message)|Base directory for this skill:|(?:Another Claude|A peer) session sent a message(?: while you were working)?:)/i

export function isUserText(text: string): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  return trimmed !== '' && !isGuardContinuation(trimmed) && !HARNESS_TEXT.test(trimmed)
}

type Control = 'pause' | 'resume' | 'stop'

const re = (body: string): RegExp => new RegExp(word(body), 'g')

// H10 reads a control word only when it is the whole message (PRD follow-up 2026-11-06): the user's
// message, folded, minus punctuation and the polite or filler words around it, must be one of these
// phrases. A control word inside a longer sentence, or a control word in another language, is the
// agent's call under its rules (core rule *Autonomy*), so a bug report or a request that only mentions
// "stop" or "devam" never pauses or resumes a plan by itself.
const LEADING = /^(?:(?:ok(?:ay)?|tamam(?:dir)?|peki|evet|yes|yeah|yep|lutfen|please|pls|hey|claude|codex|buracle|simdi|now|just|sadece|artik|haydi|hadi|neyse|o zaman|oyleyse|anyway|alright)(?![a-z0-9_'-])[ ,.!:;-]*)+/
const TRAILING = /(?:[ ,]+(?:lutfen|please|pls|now|simdi|artik|hemen))+$/
const EDGE_PUNCTUATION = /^[\s.,!?;:…-]+|[\s.,!?;:…-]+$/g

const PAUSE_WHOLE = new RegExp(`^(?:${[
  'du+r+(?:un|sana)?', 'durdur(?:un|sana)?', 'duraklat(?:in|iniz|sana)?', 'bekle(?:yin|sene)?', 'biraz bekle', '(?:bi|bir) (?:dakika|saniye|sn|dk)(?: bekle)?',
  'dur (?:bi|bir) (?:dakika|saniye)', 'simdilik (?:dur|bekle)', 'durur musun', 'durabilir misin', 'durdurur musun', 'bekler misin', 'bekleyebilir misin',
  'devam etme(?:yin|yiniz|yelim)?', 'stop(?: it| here| for now)?', 'pause', 'halt', 'freeze', 'wait(?: a (?:sec|second|moment|minute|bit))?', 'hold on', 'hold up',
  'one sec(?:ond)?', '(?:just )?a (?:sec|second|moment|minute)', "don'?t (?:continue|proceed)", 'do not (?:continue|proceed)',
].join('|')})$`)
const RESUME_WHOLE = new RegExp(`^(?:${[
  'devam(?: et| edin| ediniz| edelim| ediyoruz| edebilirsin| edebilirsiniz)?', 'devamke', 'surdur(?:un|elim|sene)?',
  'kaldigin yerden(?: devam(?: et| edin)?)?', 'kaldigimiz yerden(?: devam(?: edelim)?)?', 'durma(?:yin|yiniz)?',
  'continue', 'resume', 'proceed', 'go on', 'go ahead', 'carry on', 'keep going', "don'?t stop", 'do not stop',
].join('|')})$`)
const STOP_WHOLE = new RegExp(`^(?:${[
  'iptal(?: et| edin| edelim| ediyorum)?', 'vazgec(?:tim|elim|in|iyorum)?', 'birak(?:alim|in|sana)?', 'bos ?ver(?:in|elim|sene)?', 'unut(?: gitsin)?',
  'cancel', 'abort', 'abandon', '(?:cancel|abort|abandon) (?:the |this )?(?:plan|task|work|run)', 'forget it', 'never ?mind', 'drop it',
].join('|')})$`)

function controlOf(t: string): Control | null {
  // No control phrase is long: a message over 200 characters is never one, and the edge trims stay cheap.
  if (t.length > 200) return null
  const whole = t.replace(EDGE_PUNCTUATION, '').replace(LEADING, '').replace(TRAILING, '').replace(EDGE_PUNCTUATION, '').replace(/\s+/g, ' ')
  if (whole === '' || whole.length > 60) return null
  if (STOP_WHOLE.test(whole)) return 'stop'
  if (PAUSE_WHOLE.test(whole)) return 'pause'
  if (RESUME_WHOLE.test(whole)) return 'resume'
  return null
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
  return controlOf(t)
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
  // A pause plan.autoPause recorded is no stop request: it gets no note, as before.
  if (i.kind === 'discussion' && i.reason?.includes('(plan.autoPause)') !== true) return 'Buracle: the plan is paused because the user asked to stop. If this message means go on, in any language, run `buracle plan resume` and continue; otherwise answer the user and keep waiting.'
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

export interface PromptSignals {
  control: 'pause' | 'resume' | 'stop' | null
  recall: boolean
  write: boolean
}

export function detectSignals(text: string): PromptSignals {
  const t = userWords(text)
  if (t === undefined) return { control: null, recall: false, write: false }
  // History questions and "remember this" are the agent's call under its rules (memory rule), so the
  // recall and write signals stay false; the fields remain for the PromptSignals contract.
  return { control: controlOf(t), recall: false, write: false }
}
