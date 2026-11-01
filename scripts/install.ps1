#Requires -Version 5.1
<#
Installs Buracle on Windows.

  irm https://github.com/burakarslan0110/buracle/releases/latest/download/install.ps1 | iex
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Dir <checkout>] [-Branch <branch>] [-NoInstall]

What it does: installs Git for Windows and Bun when they are missing (for this user only, through winget or
else scoop, so without administrator rights; the Visual C++ runtime only from an administrator terminal),
clones the main branch (or updates the checkout), runs `bun install`, puts ~\.local\bin, where the
`buracle` command lives, on your PATH and hands over to `buracle install --script`, which installs the tools
(Node.js, uv, ripgrep and jq through winget or scoop, else downloaded and sha256-checked into ~\.buracle),
sets up every harness, starts the memory web UI and prints the summary. The details go to
~\.buracle\logs\install-<date>.log. Claude Code runs its hooks with the Git Bash that Git for Windows brings.
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
$BuracleHome = if ($env:BURACLE_HOME) { $env:BURACLE_HOME } else { Join-Path $HOME '.buracle' }
$Started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$Log = Join-Path $BuracleHome ('logs\install-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')

function Have([string]$Command) { return $null -ne (Get-Command $Command -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
  $env:Path = "$machine;$user;$HOME\.bun\bin;$winget;$HOME\scoop\shims;$LocalBin"
}

# The summary lines, in the layout of src/cli/ui/sections.ts (tests/engine/install-script.test.ts keeps them in step):
# an icon, the section name padded to 16 columns, the detail; an item is indented by four, its name padded to 12.
# The icons are code points, so that this file stays ASCII (Windows PowerShell 5.1 reads a file without a BOM in the
# ANSI code page): block symbols where the console shows them, + ! x i otherwise.
$SectionOrder = @('Prerequisites', 'Buracle', 'Harnesses', 'Tools', 'Memory', 'Result')
$Unicode = $false
try { $Unicode = ($PSVersionTable.PSVersion.Major -ge 6) -or [bool]$env:WT_SESSION -or ([Console]::OutputEncoding.CodePage -eq 65001) } catch { }
$Redirected = $true
try { $Redirected = [Console]::IsOutputRedirected } catch { }
$Live = (-not $Redirected) -and (-not $env:NO_COLOR) -and ($env:TERM -ne 'dumb')
$Icons = if ($Unicode) {
  @{ ok = [string][char]0x2714; warn = [string][char]0x25B2; fail = [string][char]0x2716; info = [string][char]0x2139; run = [string][char]0x2026 }
} else {
  @{ ok = '+'; warn = '!'; fail = 'x'; info = 'i'; run = '...' }
}
$D = if ($Unicode) { [string][char]0x00B7 } else { '-' }
$Colors = @{ ok = 'Green'; warn = 'Yellow'; fail = 'Red'; info = 'Cyan' }
$LiveShown = $false

function Write-Icon([string]$Status) {
  if ($Live) { Write-Host -NoNewline $Icons[$Status] -ForegroundColor $Colors[$Status] } else { Write-Host -NoNewline $Icons[$Status] }
}

function Clear-Live {
  if ($script:LiveShown) {
    $width = 80
    try { $w = $Host.UI.RawUI.WindowSize.Width; if ($w -gt 1) { $width = $w } } catch { }
    Write-Host -NoNewline ("`r" + (' ' * ($width - 1)) + "`r")
    $script:LiveShown = $false
  }
}

# $Name section, $Text what runs now: the live line (a console only).
function Start-Section([string]$Name, [string]$Text) {
  if (-not $Live) { return }
  Clear-Live
  Write-Host -NoNewline ($Icons['run'] + ' ' + $Name.PadRight(16) + $Text)
  $script:LiveShown = $true
}

# $Status ok|warn|fail|info, $Name section, $Detail: clears the live line and prints the section.
function Write-Section([string]$Status, [string]$Name, [string]$Detail) {
  Clear-Live
  Write-Icon $Status
  Write-Host (' ' + $Name.PadRight(16) + $Detail)
}

# $Status ok|warn|fail|info, $Name, $Detail: one indented line under a section.
function Write-Item([string]$Status, [string]$Name, [string]$Detail) {
  Write-Host -NoNewline '    '
  Write-Icon $Status
  Write-Host (' ' + $Name.PadRight(12) + ' ' + $Detail)
}

function Tilde([string]$Path) {
  if ($Path.StartsWith($HOME, [StringComparison]::OrdinalIgnoreCase)) { return '~' + $Path.Substring($HOME.Length) }
  return $Path
}

# Without the credentials of a URL (https://user:token@host/... becomes https://host/...): BURACLE_REPO may hold them.
function Write-Log([string]$Text) {
  try { ($Text -replace '://[^/@\s]+@', '://') | Out-File -FilePath $Log -Append -Encoding utf8 } catch { }
}

# README.md runs this script as `irm ... | iex`, in the user's own session, where `exit` would close the window and the
# line above with it. A failure throws instead: the script ends, the session stays, and `pwsh -File` still exits 1.
function Stop-Install { throw 'Buracle was not installed; the line above says why.' }

# Runs a native command with every line it prints in the install log; returns its exit code. Git writes progress to
# stderr, which Windows PowerShell 5.1 would turn into an error under Stop.
function Invoke-Logged([string]$Exe, [string[]]$Arguments) {
  Write-Log ("`n$ $Exe " + ($Arguments -join ' '))
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments 2>&1 | ForEach-Object { Write-Log "$_" }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

# Everything installs for this user only (winget --scope user, or scoop), so no step needs administrator rights.
function Install-Package([string]$Label, [string]$WingetId, [string]$ScoopName) {
  $code = 1
  if (Have 'winget') {
    $code = Invoke-Logged 'winget' @('install', '--id', $WingetId, '--exact', '--scope', 'user', '--silent', '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements')
  } elseif ($ScoopName -ne '' -and (Have 'scoop')) {
    $code = Invoke-Logged 'scoop' @('install', $ScoopName)
  } else {
    Write-Section 'fail' 'Prerequisites' "$Label is missing and neither winget nor scoop was found"
    Write-Item 'fail' 'install' "App Installer from the Microsoft Store (it brings winget), then run this script again"
    Stop-Install
  }
  Refresh-Path
  return $code
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

# Puts $Folder on the user PATH once; says whether it was added.
function Add-ToUserPath([string]$Folder) {
  $added = $false
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @(if ($user) { $user -split ';' | Where-Object { $_ -ne '' } })
  if ($parts -notcontains $Folder) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $Folder) -join ';'), 'User')
    $added = $true
  }
  if (($env:Path -split ';') -notcontains $Folder) { $env:Path = "$env:Path;$Folder" }
  return $added
}

# The logo of the buracle command (LOGO in src/cli/ui/style.ts), with # for a full block, _ for a lower half and ^ for an
# upper half, so that this file stays ASCII (Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page);
# tests/engine/install-script.test.ts compares the two.
$LogoRows = @(
  '##                                             ##'
  '##                                             ##'
  '######_   ##    ##  ##_###   _######   _#####  ##   _####_'
  '## __ ##  ##    ##  ##^     ##    ##  ##       ##  ##____##'
  '## ^^ ##  ##    ##  ##      ##    ##  ##       ##  ##^^^^^^'
  '######^    ^######  ##       ^######   ^#####  ##   ^#####'
)
$Tagline = 'everything your coding agents need, in one place'

function Write-Part([string]$Text, [string]$Color) {
  if ($Color) { Write-Host -NoNewline $Text -ForegroundColor $Color } else { Write-Host -NoNewline $Text }
}

# The logo in three shades along each row (violet to cyan, as the buracle command paints it), in block characters when the
# console can show them and in ASCII otherwise. A window narrower than the logo gets one line. Blue and DarkMagenta are not
# used: on the dark blue background of Windows PowerShell's own console they cannot be read.
function Show-Banner {
  $unicode = $false
  try { $unicode = (-not [Console]::IsOutputRedirected) -and (($PSVersionTable.PSVersion.Major -ge 6) -or [bool]$env:WT_SESSION -or ([Console]::OutputEncoding.CodePage -eq 65001)) } catch { }
  $shades = if ($env:NO_COLOR) { @('', '', '') } else { @('Magenta', 'DarkCyan', 'Cyan') }
  $width = 80
  try { $w = $Host.UI.RawUI.WindowSize.Width; if ($w -gt 0) { $width = $w } } catch { }
  Write-Host ''
  if ($width -lt 62) {
    Write-Part '  buracle' $shades[0]
    Write-Host "  $Tagline"
    Write-Host ''
    return
  }
  foreach ($row in $LogoRows) {
    Write-Part '  ' ''
    for ($i = 0; $i -lt 3 -and $i * 20 -lt $row.Length; $i++) {
      $text = if ($i -eq 2) { $row.Substring(40) } else { $row.Substring($i * 20, [Math]::Min(20, $row.Length - $i * 20)) }
      if ($unicode) { $text = $text.Replace('#', [string][char]0x2588).Replace('_', [string][char]0x2584).Replace('^', [string][char]0x2580) }
      Write-Part $text $shades[$i]
    }
    Write-Host ''
  }
  Write-Part "  $Tagline" $(if ($env:NO_COLOR) { '' } else { 'DarkGray' })
  Write-Host ''
  Write-Host ''
}

Show-Banner
Refresh-Path
New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
Write-Log ("`n== install.ps1 " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# Prerequisites: Git for Windows and Bun, for this user only; the Visual C++ runtime only from an administrator terminal.
Start-Section 'Prerequisites' 'checking Git and Bun'
if (-not (Have 'git')) {
  Start-Section 'Prerequisites' 'installing Git for Windows'
  [void](Install-Package 'Git for Windows' 'Git.Git' 'git')
  if (-not (Have 'git')) { Write-Section 'fail' 'Prerequisites' "Git was installed but is not on PATH $D open a new terminal and run this script again"; Stop-Install }
}
if (-not (Have 'bun')) {
  Start-Section 'Prerequisites' 'installing Bun'
  # Bun's own installer, run in this session as `irm bun.sh/install.ps1 | iex` runs it by hand: it sees this session's
  # proxy and TLS settings. It reports a failure without an exit code, so the check is whether bun is there afterwards.
  try { Invoke-RestMethod -Uri 'https://bun.sh/install.ps1' | Invoke-Expression *>&1 | ForEach-Object { Write-Log "$_" } } catch { Write-Log "$_" }
  Refresh-Path
  if (-not (Have 'bun')) { [void](Install-Package 'Bun' 'Oven-sh.Bun' 'bun') }
}
if (-not (Have 'bun')) { Write-Section 'fail' 'Prerequisites' "Bun was not found after the install $D open a new terminal and run this script again"; Stop-Install }
$bunVersion = [version]((bun --version).Trim())
if ($bunVersion -lt [version]'1.4.0') { Write-Section 'fail' 'Prerequisites' "Bun $bunVersion is too old: Buracle needs 1.4 or newer $D bun upgrade"; Stop-Install }
$vcMissing = $env:PROCESSOR_ARCHITECTURE -eq 'AMD64' -and -not (Has-VcRuntime)
if ($vcMissing -and (Is-Elevated) -and (Have 'winget')) {
  Start-Section 'Prerequisites' 'installing the Visual C++ runtime'
  if ((Invoke-Logged 'winget' @('install', '--id', 'Microsoft.VCRedist.2015+.x64', '--exact', '--silent', '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements')) -eq 0) { $vcMissing = $false }
}
if ($vcMissing) {
  # codegraph's native module and ast-grep need it; the rest of Buracle works without it.
  Write-Section 'warn' 'Prerequisites' "Git, Bun $bunVersion $D the Visual C++ runtime is missing"
  Write-Item 'warn' 'vcredist' 'codegraph and ast-grep need it: winget install --id Microsoft.VCRedist.2015+.x64 -e (administrator terminal)'
} else {
  Write-Section 'ok' 'Prerequisites' "Git, Bun $bunVersion"
}

# Buracle: main only receives commits that passed CI on every platform; `buracle update` follows the branch it was cloned from.
if (Test-Path (Join-Path $Dir '.git')) {
  Start-Section 'Buracle' ("updating " + (Tilde $Dir))
  if ((Invoke-Logged 'git' @('-C', $Dir, 'pull', '--ff-only')) -ne 0) { Write-Section 'fail' 'Buracle' ("git pull failed $D log " + (Tilde $Log)); Stop-Install }
} else {
  $ErrorActionPreference = 'Continue'
  git ls-remote --exit-code --heads $RepoUrl $Branch *> $null
  $hasBranch = $LASTEXITCODE -eq 0
  $ErrorActionPreference = 'Stop'
  $cloneArgs = if ($hasBranch) { @('clone', '--branch', $Branch, $RepoUrl, $Dir) } else { @('clone', $RepoUrl, $Dir) }
  Start-Section 'Buracle' ("cloning into " + (Tilde $Dir))
  if ((Invoke-Logged 'git' $cloneArgs) -ne 0) { Write-Section 'fail' 'Buracle' ("git clone failed $D log " + (Tilde $Log)); Stop-Install }
}
Set-Location $Dir
Start-Section 'Buracle' 'installing the dependencies'
if ((Invoke-Logged 'bun' @('install', '--frozen-lockfile')) -ne 0) { Write-Section 'fail' 'Buracle' ("bun install failed $D log " + (Tilde $Log)); Stop-Install }
$head = (git -C $Dir rev-parse --short HEAD 2>$null)
$ref = (git -C $Dir rev-parse --abbrev-ref HEAD 2>$null)
Write-Section 'ok' 'Buracle' ((Tilde $Dir) + " $D $ref @ $head")

if ($NoInstall) {
  Write-Section 'warn' 'Result' ("skipped (-NoInstall) $D log " + (Tilde $Log))
} else {
  # ~\.local\bin, where the buracle command lives, on the user PATH; the Result line says so.
  $scriptArgs = @('src/cli/main.ts', 'install', '--script', '--log', $Log, '--started', "$Started")
  if (Add-ToUserPath $LocalBin) { $scriptArgs += @('--path-note', 'added to your user PATH') }
  # A console answers the install's questions; without one (a CI job, redirected output) it applies the defaults.
  $interactive = $false
  try { $interactive = -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected } catch { }
  if (-not $interactive) { $scriptArgs += '--yes' }
  & bun @scriptArgs
  $installCode = $LASTEXITCODE
  # 2: installed with warnings, which the summary shows.
  if ($installCode -ne 0 -and $installCode -ne 2) {
    Write-Icon 'fail'
    Write-Host (" buracle install exited $installCode $D log " + (Tilde $Log))
    Stop-Install
  }
}
$global:LASTEXITCODE = 0
