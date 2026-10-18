import { describe, expect, test } from 'bun:test'
import { backgroundWait, finiteRunner } from '../../../src/core/plan/background'

describe('finiteRunner: shell commands that end by themselves', () => {
  test('test, build, check and lint runners count', () => {
    for (const c of ['bun test', 'bun test tests/a.test.ts', 'npm test', 'npm run build', 'pnpm lint', 'yarn typecheck', 'bunx tsc --noEmit -p .', 'npx eslint .', 'cargo test', 'go vet ./...', 'pytest -q', 'vitest run', './gradlew test', 'make', 'timeout 600 bun test', 'FOO=1 bun run test:unit']) {
      expect({ c, finite: finiteRunner(c) }).toEqual({ c, finite: true })
    }
  })

  test('watchers, dev servers, compound and unknown commands do not', () => {
    for (const c of ['bun test --watch', 'npm run dev', 'bun run start', 'vitest', 'pnpm run test:watch', 'make dev', 'go run .', 'tail -f x.log', 'cd x && bun test', 'bun test | tee out.txt', 'sleep 60', 'bun test $(cat files)', '']) {
      expect({ c, finite: finiteRunner(c) }).toEqual({ c, finite: false })
    }
  })
})

describe('backgroundWait: the agent waits for work that will wake the session', () => {
  const shell = (command: string, status = 'running') => ({ id: 't', type: 'shell', status, command })

  test('a waiting message plus a live waking task', () => {
    expect(backgroundWait('Waiting for the test suite to finish.', [shell('bun test')])).toBe(true)
    for (const type of ['subagent', 'monitor', 'workflow', 'MCP task', 'cloud session']) {
      expect({ type, waits: backgroundWait('The reviewer is running in the background; I will continue once it reports.', [{ id: 'a', type, status: 'running' }]) }).toEqual({ type, waits: true })
    }
    expect(backgroundWait('Testlerin bitmesini bekliyorum.', [shell('bun test', 'pending')])).toBe(true)
  })

  test('no wait without the message, with a question, for a dev server, a finished task or a recurring cron alone', () => {
    expect(backgroundWait('Task 3 is done.', [shell('bun test')])).toBe(false)
    expect(backgroundWait('Waiting for the build. Should I keep waiting?', [shell('bun run build')])).toBe(false)
    expect(backgroundWait('Waiting for the dev server.', [shell('bun run dev')])).toBe(false)
    expect(backgroundWait('Waiting for the tests.', [shell('bun test', 'completed')])).toBe(false)
    expect(backgroundWait('Waiting for the next check.', [], [{ id: 'c', schedule: '*/5 * * * *', recurring: true, prompt: 'check' }])).toBe(false)
    expect(backgroundWait('Waiting for the scheduled wakeup.', [], [{ id: 'c', schedule: '0 9 17 10 *', recurring: false, prompt: 'go on' }])).toBe(true)
    expect(backgroundWait(undefined, [shell('bun test')])).toBe(false)
    expect(backgroundWait('Waiting.', 'nope', null)).toBe(false)
  })
})
