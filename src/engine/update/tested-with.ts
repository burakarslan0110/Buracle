import type { Harness } from '../../core/events'

export const TESTED_WITH: Readonly<Record<Harness, Readonly<{ tested: string, min: string }>>> = {
  claude: { tested: '2.1.302', min: '2.1.290' },
  codex: { tested: '0.162.1', min: '0.154.0' },
  opencode: { tested: '2.0.30', min: '2.0.20' },
  omp: { tested: '18.10.1', min: '18.8.0' },
}
