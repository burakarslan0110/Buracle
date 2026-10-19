#Requires -Version 5.1
<#
Installs Buracle on Windows.

  irm https://github.com/burakarslan0110/buracle/releases/latest/download/install.ps1 | iex
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Dir <checkout>] [-Branch <branch>] [-NoInstall]

What it does: installs what Buracle needs when it is missing (Git for Windows, Bun, Node.js LTS, uv,
ripgrep and jq, for this user only through winget or else scoop, so without administrator rights; the
Visual C++ runtime only from an administrator terminal), clones the main branch (or
updates the checkout), runs `bun install`, `buracle install --yes` and `buracle doctor`, and puts
~\.local\bin, where the `buracle` command lives, on your PATH. Claude Code runs its hooks with the
Git Bash that Git for Windows brings.
Variables: BURACLE_CHECKOUT (default ~\buracle), BURACLE_REPO, BURACLE_BRANCH (default main), BURACLE_HOME (default ~\.buracle).
macOS and Linux: scripts/install.sh.
#>
param(
  [string]$Dir = $(if ($env:BURACLE_CHECKOUT) { $env:BURACLE_CHECKOUT } else { Join-Path $HOME 'buracle' }),
  [string]$RepoUrl = $(if ($env:BURACLE_REPO) { $env:BURACLE_REPO } else { 'https://github.com/burakarslan0110/buracle.git' }),
  [string]$Branch = $(if ($env:BURACLE_BRANCH) { $env:BURACLE_BRANCH } else { 'main' }),
  [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'
$LocalBin = Join-Path $HOME '.local\bin'

function Say([string]$Message) { Write-Host "`n==> $Message" }
function Have([string]$Command) { return $null -ne (Get-Command $Command -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
  $env:Path = "$machine;$user;$HOME\.bun\bin;$winget;$HOME\scoop\shims;$LocalBin"
}
function Run([string]$Label, [scriptblock]$Body) {
  & $Body
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE)" }
}

# Everything installs for this user only (winget --scope user, or scoop), so no step needs administrator rights.
function Install-Package([string]$Label, [string]$WingetId, [string]$ScoopName) {
  if (Have 'winget') {
    Say "Installing $Label"
    Run "winget install $WingetId" { winget install --id $WingetId --exact --scope user --silent --disable-interactivity --accept-package-agreements --accept-source-agreements }
  } elseif ($ScoopName -ne '' -and (Have 'scoop')) {
    Say "Installing $Label"
    Run "scoop install $ScoopName" { scoop install $ScoopName }
  } else {
    throw "$Label is missing and neither winget nor scoop was found. Install 'App Installer' from the Microsoft Store (it brings winget), then run this script again."
  }
  Refresh-Path
}

function Ensure-Command([string]$Command, [string]$Label, [string]$WingetId, [string]$ScoopName) {
  if (Have $Command) { return }
  Install-Package $Label $WingetId $ScoopName
  if (-not (Have $Command)) { throw "$Label was installed but '$Command' is not on PATH yet; open a new terminal and run this script again." }
}

function Is-Elevated {
  $principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Has-VcRuntime {
  $key = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
  $runtime = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  return $null -ne $runtime -and $runtime.Installed -eq 1
}

function Add-ToUserPath([string]$Folder) {
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @(if ($user) { $user -split ';' | Where-Object { $_ -ne '' } })
  if ($parts -notcontains $Folder) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $Folder) -join ';'), 'User')
    Say "Added $Folder to your PATH (new terminals see it)"
  }
  if (($env:Path -split ';') -notcontains $Folder) { $env:Path = "$env:Path;$Folder" }
}

Refresh-Path
Ensure-Command 'git' 'Git for Windows' 'Git.Git' 'git'
if (-not (Have 'bun')) {
  Say 'Installing Bun'
  # Bun's own installer, run in this session as `irm bun.sh/install.ps1 | iex` runs it by hand: it sees this
  # session's proxy and TLS settings, and its messages show here. It reports a failure without an exit code, so
  # the check is whether bun is there afterwards.
  Invoke-RestMethod -Uri 'https://bun.sh/install.ps1' | Invoke-Expression
  Refresh-Path
  if (-not (Have 'bun')) {
    Say 'The Bun installer did not leave a bun command; installing Bun through winget or scoop instead'
    Install-Package 'Bun' 'Oven-sh.Bun' 'bun'
  }
}
if (-not (Have 'bun')) { throw 'Bun was not found after the install; open a new terminal and run this script again.' }
$bunVersion = [version]((bun --version).Trim())
if ($bunVersion -lt [version]'1.4.0') { throw "Bun $bunVersion is too old: Buracle needs Bun 1.4 or newer (bun upgrade)." }
Ensure-Command 'node' 'Node.js LTS' 'OpenJS.NodeJS.LTS' 'nodejs-lts'
Ensure-Command 'uv' 'uv' 'astral-sh.uv' 'uv'
Ensure-Command 'rg' 'ripgrep' 'BurntSushi.ripgrep.MSVC' 'ripgrep'
Ensure-Command 'jq' 'jq' 'jqlang.jq' 'jq'
# The Visual C++ runtime is the one part that installs only for the whole machine; codegraph's native module and
# ast-grep need it. It is installed when this terminal already runs as administrator, and named otherwise: no UAC prompt.
if ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64' -and -not (Has-VcRuntime)) {
  if ((Is-Elevated) -and (Have 'winget')) {
    Say 'Installing the Visual C++ runtime'
    Run 'winget install Microsoft.VCRedist.2015+.x64' { winget install --id Microsoft.VCRedist.2015+.x64 --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements }
  } else {
    Write-Warning 'The Visual C++ runtime is missing, and only an administrator can install it. codegraph and ast-grep need it; the rest of Buracle works without it. To add it once, run in an administrator terminal: winget install --id Microsoft.VCRedist.2015+.x64 -e'
  }
}

# main only receives commits that passed CI on every platform; `buracle update` follows the branch it was cloned from.
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
  bun src/cli/main.ts install --yes
  $installCode = $LASTEXITCODE
  if ($installCode -eq 2) { Write-Warning 'buracle install finished with warnings (exit code 2); read them above.' }
  elseif ($installCode -ne 0) { throw "buracle install failed (exit code $installCode)" }
  $buracleHome = if ($env:BURACLE_HOME) { $env:BURACLE_HOME } else { Join-Path $HOME '.buracle' }
  $shim = Join-Path $buracleHome 'bin\buracle.cmd'
  if (-not (Test-Path $shim)) { throw "buracle install did not create the shim at $shim" }
  Add-ToUserPath $LocalBin
  if (-not (Have 'buracle')) { throw "the buracle command is not on PATH; $LocalBin should hold buracle.cmd" }
  Run 'buracle --version' { buracle --version }
  Say 'buracle doctor'
  & buracle doctor
  # The doctor's findings are for the reader; like install.sh, its exit code does not fail the install.
  $global:LASTEXITCODE = 0
}

Say "Done. Checkout: $Dir. Open a new terminal to use the buracle command."
