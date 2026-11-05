import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { SERVICE_ENV_CHECK } from '../../../src/adapters/opencode/install'
import { run } from '../../../src/engine/proc'
import { fakeExe } from '../../helpers/fake-exe'
import { withSandbox } from '../../helpers/sandbox'

describe('OpenCode service check', () => {
  test('bun asks `opencode service get env BURACLE_HOME` and compares (no sh needed)', () => withSandbox(async ({ root }) => {
    const fake = fakeExe(join(root, 'opencode'), "if (argv.slice(0, 4).join(' ') === 'service get env BURACLE_HOME') console.log('/h/.buracle')")
    expect((await run([process.execPath, '-e', SERVICE_ENV_CHECK, fake, '/h/.buracle'])).code).toBe(0)
    expect((await run([process.execPath, '-e', SERVICE_ENV_CHECK, fake, '/other'])).code).toBe(1)
  }))
})
