#!/usr/bin/env bash
# Installs Buracle on macOS and Linux.
#
#   curl -fsSL https://github.com/burakarslan0110/buracle/releases/latest/download/install.sh | bash
#   bash scripts/install.sh [--dir <checkout>] [--no-install]
#
# What it does: installs Bun when it is missing, clones the main branch (or updates the
# checkout), runs `bun install` and hands over to `buracle install --script`, which installs
# the tools (a missing Node.js, uv, ripgrep or jq is downloaded, sha256-checked, into ~/.buracle),
# sets up every harness, starts the memory web UI and prints the summary. Nothing runs sudo.
# Variables: BURACLE_CHECKOUT (default ~/buracle), BURACLE_REPO, BURACLE_BRANCH (default main),
# BURACLE_HOME (default ~/.buracle). The details go to ~/.buracle/logs/install-<date>.log.
# Windows: scripts/install.ps1.
set -euo pipefail

REPO_URL="${BURACLE_REPO:-https://github.com/burakarslan0110/buracle.git}"
BRANCH="${BURACLE_BRANCH:-main}"
DIR="${BURACLE_CHECKOUT:-$HOME/buracle}"
RUN_INSTALL=1
LOG=""

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# The summary lines, in the layout of src/cli/ui/sections.ts (tests/engine/install-script.test.ts keeps them in step):
# an icon, the section name padded to 16 columns, the detail; an item is indented by four, its name padded to 12.
# A terminal gets one live line while a section runs; NO_COLOR, TERM=dumb or a pipe get plain lines only. The icons
# come from escapes so that this file stays ASCII: block symbols in a UTF-8 locale, + ! x i otherwise.
# shellcheck disable=SC2034 # the order of every section; this script prints the first two, the test compares it
SECTION_ORDER=(Prerequisites Buracle Harnesses Tools Memory Result)
LIVE=0
I_OK='+' I_WARN='!' I_FAIL='x' I_INFO='i' I_RUN='...' D='-'
C_OK='' C_WARN='' C_FAIL='' C_INFO='' C_OFF=''

setup_output() {
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*)
      I_OK=$'\xe2\x9c\x94'; I_WARN=$'\xe2\x96\xb2'; I_FAIL=$'\xe2\x9c\x96'; I_INFO=$'\xe2\x84\xb9'; I_RUN=$'\xe2\x80\xa6'; D=$'\xc2\xb7' ;;
  esac
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
    LIVE=1
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_FAIL=$'\033[31m'; C_INFO=$'\033[36m'; C_OFF=$'\033[0m'
  fi
}

icon() {
  case "$1" in
    ok) printf '%s%s%s' "$C_OK" "$I_OK" "$C_OFF" ;;
    warn) printf '%s%s%s' "$C_WARN" "$I_WARN" "$C_OFF" ;;
    fail) printf '%s%s%s' "$C_FAIL" "$I_FAIL" "$C_OFF" ;;
    *) printf '%s%s%s' "$C_INFO" "$I_INFO" "$C_OFF" ;;
  esac
}

# $1 section, $2 what runs now: the live line (a terminal only).
section_start() {
  if [ "$LIVE" = 1 ]; then printf '\r\033[2K%s %-16s%s' "$I_RUN" "$1" "$2"; fi
}

# $1 ok|warn|fail|info, $2 section, $3 detail: clears the live line and prints the section.
section_done() {
  if [ "$LIVE" = 1 ]; then printf '\r\033[2K'; fi
  printf '%s %-16s%s\n' "$(icon "$1")" "$2" "$3"
}

# $1 ok|warn|fail|info, $2 name, $3 detail: one indented line under a section.
section_item() {
  printf '    %s %-12s %s\n' "$(icon "$1")" "$2" "$3"
}

# $1 path: ~/... when it lies in the home folder.
tilde() {
  # shellcheck disable=SC2088 # the ~ is printed for the reader, never expanded
  case "$1" in
    "$HOME") printf '~' ;;
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Whether libatomic.so.1 is on this system (the usual library folders, or the dynamic linker's cache).
# BURACLE_LIB_ROOT (tests) looks under another root and skips the cache.
have_libatomic() {
  local f root="${BURACLE_LIB_ROOT:-}"
  for f in "$root"/lib/*-linux-gnu/libatomic.so.1 "$root"/usr/lib/*-linux-gnu/libatomic.so.1 "$root"/lib64/libatomic.so.1 "$root"/usr/lib64/libatomic.so.1 "$root"/lib/libatomic.so.1 "$root"/usr/lib/libatomic.so.1; do
    [ -e "$f" ] && return 0
  done
  # grep reads the whole list (no -q): under pipefail an early exit would kill ldconfig with SIGPIPE and read as "missing".
  [ -z "$root" ] && { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep 'libatomic\.so\.1' >/dev/null
}

# Takes the credentials out of a URL (https://user:token@host/... becomes https://host/...): BURACLE_REPO may hold them.
redact() { sed -E 's#://[^/@[:space:]]+@#://#g'; }

# Runs a command with its output in the install log, without the credentials of a URL (pipefail keeps its exit code).
logged() {
  printf '\n$ %s\n' "$*" | redact >> "$LOG"
  "$@" 2>&1 | redact >> "$LOG"
}

bun_is_new_enough() {
  # engines.bun in package.json: >= 1.4.0
  bun --version 2>/dev/null | awk -F. 'NR == 1 { exit !($1 > 1 || ($1 == 1 && $2 >= 4)) }'
}

# Linux only. The commands below are printed, never run: installing system packages needs root, so that stays your
# decision. src/engine/toolchain/linux-packages.ts holds the same table for `buracle doctor`; a test compares them.
os_words() {
  local line v
  [ -r "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ID=*|ID_LIKE=*) v="${line#*=}"; v="${v//\"/}"; v="${v//\'/}"; printf '%s ' "$v" ;;
    esac
  done < "$1"
}

managers_of() {
  case "$1" in
    debian|ubuntu|linuxmint|pop|raspbian|kali|elementary|neon|zorin) echo apt-get ;;
    fedora|rhel|centos|rocky|almalinux|ol|amzn|nobara) echo "dnf yum" ;;
    arch|archarm|manjaro|endeavouros|cachyos|garuda|artix) echo pacman ;;
    alpine) echo apk ;;
    opensuse*|suse|sles|sled) echo zypper ;;
  esac
}

# The package manager of this distribution: the one os-release names when it is installed, else the first installed one.
pm_detect() {
  local w m
  for w in $(os_words "${BURACLE_OS_RELEASE:-/etc/os-release}"); do
    for m in $(managers_of "$w"); do
      if have "$m"; then echo "$m"; return 0; fi
    done
  done
  for m in apt-get dnf yum pacman apk zypper; do
    if have "$m"; then echo "$m"; return 0; fi
  done
  return 1
}

# The package(s) manager $1 installs for tool $2 (nothing for a tool it has no package for).
pkgs_for() {
  case "$2" in
    git|curl|unzip|jq) echo "$2" ;;
    libatomic) case "$1" in apt-get|zypper) echo libatomic1 ;; pacman) echo gcc-libs ;; *) echo libatomic ;; esac ;;
    rg) echo ripgrep ;;
    node) if [ "$1" = zypper ]; then echo "nodejs-default npm-default"; else echo "nodejs npm"; fi ;;
  esac
}

# The install command of manager $1 for the packages $2.
pm_line() {
  local sudo="sudo "
  if [ "$(id -u)" = 0 ]; then sudo=""; fi
  case "$1" in
    apt-get) printf '%s' "${sudo}apt-get update && ${sudo}apt-get install -y $2" ;;
    dnf) printf '%s' "${sudo}dnf install -y $2" ;;
    yum) printf '%s' "${sudo}yum install -y $2" ;;
    pacman) printf '%s' "${sudo}pacman -S --needed $2" ;;
    apk) printf '%s' "${sudo}apk add $2" ;;
    zypper) printf '%s' "${sudo}zypper install -y $2" ;;
  esac
}

# The commands that install the tools $@ on this distribution, one per line: the package manager's, then uv's own installer.
install_lines() {
  local m="" pkgs="" t p
  m=$(pm_detect) || m=""
  for t in "$@"; do
    [ "$t" = uv ] && continue
    p=""
    if [ -n "$m" ]; then p=$(pkgs_for "$m" "$t"); fi
    if [ -n "$p" ]; then pkgs="${pkgs:+$pkgs }$p"; fi
  done
  if [ -n "$pkgs" ]; then printf '%s\n' "$(pm_line "$m" "$pkgs")"; fi
  for t in "$@"; do
    if [ "$t" = uv ]; then printf '%s\n' 'curl -LsSf https://astral.sh/uv/install.sh | sh'; fi
  done
}

# Prints how to install the tools $@ (Linux), or says that no package manager was found.
print_install_help() {
  local lines
  lines=$(install_lines "$@")
  if [ -n "$lines" ]; then
    printf '%s\n' "$lines" | sed 's/^/  /'
  fi
  if ! pm_detect >/dev/null; then
    printf "  No package manager was found (apt-get, dnf, yum, pacman, apk, zypper): install %s with your distribution's own tools.\n" "$*"
  fi
}

# The logo of the buracle command (LOGO in src/cli/ui/style.ts), with # for a full block, _ for a lower half and ^ for an
# upper half, so that this file stays ASCII; tests/engine/install-script.test.ts compares the two.
LOGO_ROWS=(
  '##                                             ##'
  '##                                             ##'
  '######_   ##    ##  ##_###   _######   _#####  ##   _####_'
  '## __ ##  ##    ##  ##^     ##    ##  ##       ##  ##____##'
  '## ^^ ##  ##    ##  ##      ##    ##  ##       ##  ##^^^^^^'
  '######^    ^######  ##       ^######   ^#####  ##   ^#####'
)
TAGLINE='everything your coding agents need, in one place'

# A row of the logo in block characters (when banner found a UTF-8 locale) or as it is written above.
glyphs() {
  local s="$1"
  s=${s//'#'/$full}; s=${s//_/$lower}; s=${s//'^'/$upper}
  printf '%s' "$s"
}

# The logo in the three shades of the buracle command (violet, indigo, cyan) when the output is a terminal with colours
# (FORCE_COLOR asks for them, NO_COLOR and TERM=dumb refuse them), in block characters when the locale is UTF-8 and in
# ASCII otherwise. A terminal narrower than the logo gets one line.
banner() {
  local full='#' lower='_' upper='^' violet='' indigo='' cyan='' dim='' reset='' cols row
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) full=$'\xe2\x96\x88'; lower=$'\xe2\x96\x84'; upper=$'\xe2\x96\x80' ;;
  esac
  if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
    if [ -t 1 ] || { [ -n "${FORCE_COLOR:-}" ] && [ "${FORCE_COLOR:-}" != 0 ] && [ "${FORCE_COLOR:-}" != false ]; }; then
      violet=$'\033[95m'; indigo=$'\033[94m'; cyan=$'\033[96m'; dim=$'\033[2m'; reset=$'\033[0m'
    fi
  fi
  cols="${COLUMNS:-}"
  [ -n "$cols" ] || cols=$(tput cols 2>/dev/null) || cols=80
  case "$cols" in ''|*[!0-9]*) cols=80 ;; esac
  if [ "$cols" -lt 62 ]; then
    printf '\n  %sburacle%s  %s\n\n' "$violet" "$reset" "$TAGLINE"
    return 0
  fi
  printf '\n'
  for row in "${LOGO_ROWS[@]}"; do
    printf '  %s%s%s%s%s%s%s\n' "$violet" "$(glyphs "${row:0:20}")" "$indigo" "$(glyphs "${row:20:20}")" "$cyan" "$(glyphs "${row:40}")" "$reset"
  done
  printf '  %s%s%s\n\n' "$dim" "$TAGLINE" "$reset"
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) [ $# -ge 2 ] || die "--dir needs a path"; DIR="$2"; shift 2 ;;
      --no-install) RUN_INSTALL=0; shift ;;
      -h|--help) sed -n '2,13p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done

  local started
  started=$(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
  banner

  case "$(uname -s)" in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) die "this script is for macOS and Linux; on Windows run scripts/install.ps1 in PowerShell" ;;
  esac

  setup_output
  LOG="${BURACLE_HOME:-$HOME/.buracle}/logs/install-$(date +%Y-%m-%d).log"
  mkdir -p "$(dirname "$LOG")"
  # The log holds the toolchain output and the health report: readable by this user only, as ~/.buracle/logs/buracle.log.
  ( umask 077; : >> "$LOG" ) && chmod 600 "$LOG" 2>/dev/null || true
  printf '\n== install.sh %s (%s)\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$os" >> "$LOG"

  # Prerequisites: git, curl (and unzip on Linux while Bun is missing) are yours to install; Bun this script installs.
  section_start Prerequisites "checking git, curl and Bun"
  local missing="" t
  for t in git curl; do have "$t" || missing="${missing:+$missing, }$t"; done
  # Bun's installer unpacks a zip file.
  if [ "$os" = linux ] && ! have bun && ! have unzip; then missing="${missing:+$missing, }unzip"; fi
  # The Node.js the install downloads when node is missing needs libatomic.so.1, which a minimal Linux lacks.
  if [ "$os" = linux ] && ! have node && ! have_libatomic; then missing="${missing:+$missing, }libatomic"; fi
  if [ -n "$missing" ]; then
    section_done fail Prerequisites "missing $missing ${D} this script runs no sudo and no package manager"
    if [ "$os" = macos ]; then
      section_item fail install "xcode-select --install, then run this script again"
    else
      local line
      # shellcheck disable=SC2086 # one word per tool
      while IFS= read -r line; do
        [ -n "$line" ] && section_item fail install "${line#  }"
      done < <(print_install_help ${missing//,/})
    fi
    exit 1
  fi
  export PATH="$HOME/.bun/bin:$PATH"
  if ! have bun; then
    section_start Prerequisites "installing Bun"
    # pipefail: a failed download must fail the step, not run an empty installer that exits 0.
    if ! logged bash -c 'set -o pipefail; curl -fsSL https://bun.sh/install | bash'; then
      section_done fail Prerequisites "Bun could not be installed ${D} log $(tilde "$LOG")"
      exit 1
    fi
    hash -r
  fi
  if ! have bun; then
    section_done fail Prerequisites "Bun was installed but is not on PATH ${D} open a new terminal and run this script again"
    exit 1
  fi
  if ! bun_is_new_enough; then
    section_done fail Prerequisites "Bun $(bun --version) is too old: Buracle needs 1.4 or newer ${D} bun upgrade"
    exit 1
  fi
  section_done ok Prerequisites "git, curl, Bun $(bun --version)"

  # Buracle: main only receives commits that passed CI on every platform; `buracle update` follows the branch it was cloned from.
  if [ -d "$DIR/.git" ]; then
    section_start Buracle "updating $(tilde "$DIR")"
    logged git -C "$DIR" pull --ff-only || { section_done fail Buracle "git pull in $(tilde "$DIR") failed ${D} log $(tilde "$LOG")"; exit 1; }
  elif git ls-remote --exit-code --heads "$REPO_URL" "$BRANCH" >/dev/null 2>&1; then
    section_start Buracle "cloning $BRANCH into $(tilde "$DIR")"
    logged git clone --branch "$BRANCH" "$REPO_URL" "$DIR" || { section_done fail Buracle "git clone failed ${D} log $(tilde "$LOG")"; exit 1; }
  else
    section_start Buracle "cloning the default branch into $(tilde "$DIR")"
    logged git clone "$REPO_URL" "$DIR" || { section_done fail Buracle "git clone failed ${D} log $(tilde "$LOG")"; exit 1; }
  fi
  cd "$DIR"
  section_start Buracle "installing the dependencies"
  logged bun install --frozen-lockfile || { section_done fail Buracle "bun install failed ${D} log $(tilde "$LOG")"; exit 1; }
  section_done ok Buracle "$(tilde "$DIR") ${D} $(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?') @ $(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"

  if [ "$RUN_INSTALL" != 1 ]; then
    section_done warn Result "skipped (--no-install) ${D} log $(tilde "$LOG")"
    exit 0
  fi
  # The rest is `buracle install --script`: Harnesses, Tools, Memory and Result. A terminal answers its questions, also
  # under `curl ... | bash` (stdin is the pipe there, so they are read from /dev/tty); without one it applies the defaults.
  local code=0
  local args=(src/cli/main.ts install --script --log "$LOG" --started "$started")
  if [ -t 1 ] && { : < /dev/tty; } 2>/dev/null; then
    bun "${args[@]}" < /dev/tty || code=$?
  else
    bun "${args[@]}" --yes < /dev/null || code=$?
  fi
  # 2: installed with warnings, which the summary shows.
  if [ "$code" != 0 ] && [ "$code" != 2 ]; then
    printf '%s buracle install exited %s %s log %s\n' "$(icon fail)" "$code" "$D" "$(tilde "$LOG")"
    exit 1
  fi
}

# BURACLE_INSTALL_SOURCED=1 loads the functions without running the installer (the tests use it).
if [ "${BURACLE_INSTALL_SOURCED:-}" != 1 ]; then main "$@"; fi
