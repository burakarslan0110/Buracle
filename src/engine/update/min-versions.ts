import type { Harness } from '../../core/events'

// The oldest release of each harness that Buracle supports. Below it an install skips the harness or a step
// (a Codex older than this cannot load the config.toml Buracle writes) and `buracle doctor` reports an error.
export const MIN_VERSIONS: Readonly<Record<Harness, string>> = {
  claude: '2.1.290',
  codex: '0.154.0',
  opencode: '2.0.20',
  omp: '18.8.0',
}
