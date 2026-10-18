#Requires -Version 5.1
<#
Installs Buracle on Windows.

  irm https://github.com/burakarslan0110/buracle/releases/latest/download/install.ps1 | iex
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Dir <checkout>] [-Branch <branch>] [-NoInstall]

What it does: installs Git for Windows and Bun through winget when they are missing, clones the
release branch (or updates the checkout), runs `bun install`, `buracle install --yes` and `buracle doctor`. Claude Code runs its hooks with the Git Bash that Git for Windows brings.
Variables: BURACLE_CHECKOUT (default ~\buracle), BURACLE_REPO, BURACLE_BRANCH (default release), BURACLE_HOME (default ~\.buracle).
macOS and Linux: scripts/install.sh.
#>
param(
  [string]$Dir = $(if ($env:BURACLE_CHECKOUT) { $env:BURACLE_CHECKOUT } else { Join-Path $HOME 'buracle' }),
  [string]$RepoUrl = $(if ($env:BURACLE_REPO) { $env:BURACLE_REPO } else { 'https://github.com/burakarslan0110/buracle.git' }),
  [string]$Branch = $(if ($env:BURACLE_BRANCH) { $env:BURACLE_BRANCH } else { 'release' }),
  [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

function Say([string]$Message) { Write-Host "`n==> $Message" }
function Have([string]$Command) { return $null -ne (Get-Command $Command -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$HOME\.bun\bin"
}
function Run([string]$Label, [scriptblock]$Body) {
  & $Body
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE)" }
}

if (-not (Have 'git')) {
  if (-not (Have 'winget')) { throw "git and winget were not found. Install 'App Installer' from the Microsoft Store (it brings winget) or Git for Windows, then run this script again." }
  Say 'Installing Git for Windows'
  Run 'winget install Git.Git' { winget install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements }
  Refresh-Path
}

Refresh-Path
if (-not (Have 'bun')) {
  Say 'Installing Bun'
  Run 'the Bun installer' { powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" }
  Refresh-Path
}
if (-not (Have 'bun')) { throw 'Bun was not found after the install; open a new terminal and run this script again.' }
$bunVersion = [version]((bun --version).Trim())
if ($bunVersion -lt [version]'1.4.0') { throw "Bun $bunVersion is too old: Buracle needs Bun 1.4 or newer (bun upgrade)." }

# The release branch holds the newest release; `buracle update` follows the branch it was cloned from.
if (Test-Path (Join-Path $Dir '.git')) {
  Say "Updating the checkout in $Dir"
  Run 'git pull' { git -C $Dir pull --ff-only }
} else {
  # git writes to stderr when the remote cannot be reached; Windows PowerShell 5.1 would turn that into an error under Stop.
  $ErrorActionPreference = 'Continue'
  git ls-remote --exit-code --heads $RepoUrl $Branch *> $null
  $hasBranch = $LASTEXITCODE -eq 0
  $ErrorActionPreference = 'Stop'
  if ($hasBranch) {
    Say "Cloning the $Branch branch into $Dir"
    Run 'git clone' { git clone --branch $Branch $RepoUrl $Dir }
  } else {
    Say "No $Branch branch yet; cloning the default branch into $Dir"
    Run 'git clone' { git clone $RepoUrl $Dir }
  }
}
Set-Location $Dir

Say 'Installing the dependencies'
Run 'bun install' { bun install --frozen-lockfile }

if ($NoInstall) {
  Say 'Skipped buracle install (-NoInstall). Run it yourself: bun src/cli/main.ts install'
} else {
  Say 'buracle install'
  Run 'buracle install' { bun src/cli/main.ts install --yes }
  $buracleHome = if ($env:BURACLE_HOME) { $env:BURACLE_HOME } else { Join-Path $HOME '.buracle' }
  $buracle = Join-Path $buracleHome 'bin\buracle.cmd'
  if (-not (Test-Path $buracle)) { throw "buracle install did not create the shim at $buracle" }
  Say 'buracle doctor'
  & $buracle doctor
}

Say "Done. Checkout: $Dir. Buracle has not been run on a real Windows machine yet: read the buracle doctor output above."
