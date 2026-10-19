// Whether a process whose command line matches `pattern` (an extended regular expression) is running.
// POSIX: pgrep -f. Windows has no pgrep: PowerShell matches the command lines of Win32_Process, with the
// pattern in the environment so no quoting stands between it and the regex.
export function processRunning(pattern: string): boolean {
  if (process.platform !== 'win32') return Bun.spawnSync(['pgrep', '-f', pattern], { env: { ...process.env } }).exitCode === 0
  const script = '@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $env:BURACLE_TEST_PATTERN }).Count'
  const r = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, BURACLE_TEST_PATTERN: pattern }, stdout: 'pipe', stderr: 'ignore' })
  return r.exitCode === 0 && Number(r.stdout.toString().trim()) > 0
}
