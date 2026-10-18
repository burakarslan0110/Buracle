import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log, rotate } from '../../src/engine/log'
import { logFile } from '../../src/engine/paths'
import { withEnv, withSandbox } from '../helpers/sandbox'

describe('log', () => {
  test('appends JSON lines under BURACLE_HOME/logs', () => withSandbox(({ buracleHome }) => {
    log('info', 'hello', { a: 1 })
    log('error', 'boom', new Error('bad thing'))
    log('debug', 'hidden by default')
    const file = join(buracleHome, 'logs', 'buracle.log')
    expect(logFile()).toBe(file)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'hello', data: { a: 1 } })
    expect(typeof lines[0]?.['ts']).toBe('string')
    expect(lines[1]).toMatchObject({ level: 'error', msg: 'boom', data: { name: 'Error', message: 'bad thing' } })
  }))

  test('BURACLE_LOG_LEVEL controls the threshold', () => withSandbox(({ buracleHome }) => withEnv({ BURACLE_LOG_LEVEL: 'debug' }, () => {
    log('debug', 'now visible')
    expect(readFileSync(join(buracleHome, 'logs', 'buracle.log'), 'utf8')).toContain('now visible')
  })))

  test('never throws when the log cannot be written', () => withSandbox(({ root }) => {
    const blocker = join(root, 'not-a-dir')
    writeFileSync(blocker, 'x')
    return withEnv({ BURACLE_HOME: blocker }, () => {
      expect(() => log('error', 'nowhere to go')).not.toThrow()
      expect(existsSync(join(blocker, 'logs'))).toBe(false)
    })
  }))

  test('a full log moves to .1; a rotation that lost a race never overwrites .1 with a fresh log (O3)', () => withSandbox(({ buracleHome }) => {
    const file = join(buracleHome, 'logs', 'buracle.log')
    mkdirSync(join(buracleHome, 'logs'), { recursive: true })
    writeFileSync(file, 'old full log\n'.repeat(10))
    rotate(file, 50)
    expect(readFileSync(`${file}.1`, 'utf8')).toContain('old full log')
    expect(existsSync(file)).toBe(false)
    writeFileSync(file, 'full again\n'.repeat(10))
    const seenBySecond = statSync(file)
    renameSync(file, `${file}.1`)
    writeFileSync(file, 'fresh line\n')
    rotate(file, 50, seenBySecond)
    expect(readFileSync(`${file}.1`, 'utf8')).toContain('full again')
    expect(readFileSync(file, 'utf8')).toBe('fresh line\n')
  }))
})
