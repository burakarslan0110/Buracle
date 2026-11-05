import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { EXIT, type CommandIO, type Writer } from '../router'
import { bashOptions } from '../../adapters/codex/guards'
import { CONSENT_ASK_ID, takeConsentAsk, type ConsentTake } from '../../adapters/shared/consent-asks'
import { checkBash } from '../../core/policy/bash-guard'
import { createContext } from './hook'

export const name = 'consent'
export const summary = 'Run a command the user approved in the harness\'s own consent prompt (Codex, H20)'
export const usage = `Usage: buracle consent run <id> <command>

On Codex, Buracle's H20 gate turns a command it holds for the user's say-so into
\`buracle consent run <id> '<command>'\`, and Buracle's execpolicy rule makes Codex ask the user
before it runs. Once the user approved it there, this runs <command> once with the user's shell
(bash, zsh or sh; else /bin/sh) and exits with its exit code. It refuses (exit 1, nothing runs)
when Buracle did not hold exactly this command, when the question never reached the user, when
the user turned it down, when it runs outside the Codex session that asked, when the bash guard
(H01) refuses the command, or after 15 minutes; then ask the user in the conversation.`

const SHELLS = new Set(['bash', 'zsh', 'sh'])

export function promptShell(env: Record<string, string | undefined>): string {
  const sh = env['SHELL']
  return sh !== undefined && sh.startsWith('/') && SHELLS.has(basename(sh)) && existsSync(sh) ? sh : '/bin/sh'
}

type Refused = Exclude<ConsentTake, { ok: true }>['why'] | 'elsewhere'

function refusal(why: Refused): string {
  const what = why === 'not-asked' ? 'the consent question never reached the user'
    : why === 'elsewhere' ? 'it does not run in the Codex session that asked the user'
    : why === 'expired' ? 'the approval is older than 15 minutes'
    : why === 'changed' ? 'the command differs from the one Buracle held'
    : 'Buracle holds no such command'
  return `buracle consent: nothing ran, because ${what}. Ask the user in the conversation, naming the exact command and what it changes, then run the command itself once they say yes.\n`
}

async function pump(stream: ReadableStream<Uint8Array> | number | undefined | null, w: Writer): Promise<void> {
  if (stream === undefined || stream === null || typeof stream === 'number') return
  const dec = new TextDecoder()
  for await (const chunk of stream) w.write(dec.decode(chunk, { stream: true }))
}

export async function runCommand(shell: string, command: string, io: CommandIO): Promise<number> {
  const inherit = io.stdout.fd === 1 && io.stderr.fd === 2
  const child = Bun.spawn([shell, '-lc', command], {
    cwd: process.cwd(), env: { ...process.env }, stdin: inherit ? 'inherit' : 'ignore', stdout: inherit ? 'inherit' : 'pipe', stderr: inherit ? 'inherit' : 'pipe',
  })
  await Promise.all([pump(child.stdout as ReadableStream<Uint8Array> | undefined, io.stdout), pump(child.stderr as ReadableStream<Uint8Array> | undefined, io.stderr)])
  const code = await child.exited
  return child.signalCode ? 128 + (child.signalCode === 'SIGINT' ? 2 : child.signalCode === 'SIGHUP' ? 1 : child.signalCode === 'SIGKILL' ? 9 : 15) : code
}

function guardDenial(command: string): string | undefined {
  try {
    return checkBash(command, bashOptions(createContext(), process.cwd())).deny
  } catch (e) {
    return `the bash guard could not check it (${e instanceof Error ? e.message : String(e)})`
  }
}

export async function runConsent(argv: string[], io: CommandIO, now: number = Date.now(), env: Record<string, string | undefined> = process.env): Promise<number> {
  const [sub, id, command, ...extra] = argv
  if (sub !== 'run' || id === undefined || command === undefined || extra.length > 0 || !CONSENT_ASK_ID.test(id)) {
    io.stderr.write(`${usage}\n`)
    return EXIT.error
  }
  const taken = takeConsentAsk(id, command, now)
  if (!taken.ok || env['CODEX_THREAD_ID'] !== taken.record.sid) {
    io.stderr.write(refusal(taken.ok ? 'elsewhere' : taken.why))
    return EXIT.error
  }
  const denied = guardDenial(command)
  if (denied !== undefined) {
    io.stderr.write(`buracle consent: nothing ran, because Buracle H01 refuses it: ${denied}\n`)
    return EXIT.error
  }
  return runCommand(promptShell(env), command, io)
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  return runConsent(argv, io)
}
