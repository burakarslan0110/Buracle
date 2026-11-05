// Whether a process whose command line matches `pattern` (an extended regular expression) is running: pgrep -f.
export function processRunning(pattern: string): boolean {
  return Bun.spawnSync(['pgrep', '-f', pattern], { env: { ...process.env } }).exitCode === 0
}
