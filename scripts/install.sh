#!/usr/bin/env bash
# Installs Buracle on macOS and Linux.
#
#   curl -fsSL https://github.com/burakarslan0110/buracle/releases/latest/download/install.sh | bash
#   bash scripts/install.sh [--dir <checkout>] [--no-install]
#
# What it does: installs Bun when it is missing, clones the main branch (or updates the
# checkout), runs `bun install`, `buracle install --yes` and `buracle doctor`. On Linux it never
# runs sudo or a package manager: it prints the command for what is missing (git, curl, unzip,
# Node.js, uv, ripgrep, jq) and leaves running it to you.
# Variables: BURACLE_CHECKOUT (default ~/buracle), BURACLE_REPO, BURACLE_BRANCH (default main),
# BURACLE_HOME (default ~/.buracle).
# Windows: scripts/install.ps1.
set -euo pipefail

REPO_URL="${BURACLE_REPO:-https://github.com/burakarslan0110/buracle.git}"
BRANCH="${BURACLE_BRANCH:-main}"
DIR="${BURACLE_CHECKOUT:-$HOME/buracle}"
RUN_INSTALL=1

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

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

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) [ $# -ge 2 ] || die "--dir needs a path"; DIR="$2"; shift 2 ;;
      --no-install) RUN_INSTALL=0; shift ;;
      -h|--help) sed -n '2,13p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done

  case "$(uname -s)" in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) die "this script is for macOS and Linux; on Windows run scripts/install.ps1 in PowerShell" ;;
  esac

  if [ "$os" = macos ]; then
    have git || die "git was not found: run 'xcode-select --install', finish the Command Line Tools installation, then run this script again"
  else
    local missing="" t
    for t in git curl; do have "$t" || missing="$missing $t"; done
    # Bun's installer unpacks a zip file.
    if ! have bun && ! have unzip; then missing="$missing unzip"; fi
    if [ -n "$missing" ]; then
      printf '\nMissing on this machine:%s\nThis script does not run sudo or a package manager. Install them with:\n' "$missing" >&2
      # shellcheck disable=SC2086 # one word per tool
      print_install_help $missing >&2
      die "install the tools above, then run this script again"
    fi
  fi
  have curl || die "curl was not found: install it, then run this script again"

  export PATH="$HOME/.bun/bin:$PATH"
  if ! have bun; then
    say "Installing Bun"
    curl -fsSL https://bun.sh/install | bash
    hash -r
  fi
  have bun || die "Bun was not found after the install; open a new shell and run this script again"
  bun_is_new_enough || die "Bun $(bun --version) is too old: Buracle needs Bun 1.4 or newer (bun upgrade)"

  if [ "$os" = linux ] && ! have brew; then
    local absent="" tool
    for tool in node uv rg jq; do have "$tool" || absent="$absent $tool"; done
    if [ -n "$absent" ]; then
      printf '\nMissing system tools:%s\nWithout Homebrew buracle install cannot add them, and this script does not run sudo or a package manager. Install them with:\n' "$absent"
      # shellcheck disable=SC2086 # one word per tool
      print_install_help $absent
      printf 'then run buracle install again; buracle doctor lists what is still missing.\n'
    fi
  fi

  # main only receives commits that passed CI on every platform; `buracle update` follows the branch it was cloned from.
  if [ -d "$DIR/.git" ]; then
    say "Updating the checkout in $DIR"
    git -C "$DIR" pull --ff-only
  elif git ls-remote --exit-code --heads "$REPO_URL" "$BRANCH" >/dev/null 2>&1; then
    say "Cloning the $BRANCH branch into $DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$DIR"
  else
    say "No $BRANCH branch yet; cloning the default branch into $DIR"
    git clone "$REPO_URL" "$DIR"
  fi
  cd "$DIR"

  say "Installing the dependencies"
  bun install --frozen-lockfile

  if [ "$RUN_INSTALL" = 1 ]; then
    say "buracle install"
    code=0
    bun src/cli/main.ts install --yes || code=$?
    if [ "$code" = 2 ]; then printf '\nburacle install finished with warnings (exit code 2); read them above.\n'
    elif [ "$code" != 0 ]; then die "buracle install failed (exit code $code)"
    fi
    buracle="${BURACLE_HOME:-$HOME/.buracle}/bin/buracle"
    [ -x "$buracle" ] || die "buracle install did not create the shim at $buracle"
    say "buracle doctor"
    "$buracle" doctor || true
  else
    say "Skipped buracle install (--no-install). Run it yourself: bun src/cli/main.ts install"
  fi

  # shellcheck disable=SC2016 # the export line is printed for the user to copy, unexpanded
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) printf '\nAdd ~/.local/bin to your PATH so that the buracle command is found, for example in ~/.zshrc or ~/.bashrc:\n  export PATH="$HOME/.local/bin:$PATH"\n' ;;
  esac
  say "Done. Checkout: $DIR"
}

# BURACLE_INSTALL_SOURCED=1 loads the functions without running the installer (the tests use it).
if [ "${BURACLE_INSTALL_SOURCED:-}" != 1 ]; then main "$@"; fi
