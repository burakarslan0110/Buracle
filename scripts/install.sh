#!/usr/bin/env bash
# Installs Buracle on macOS and Linux.
#
#   curl -fsSL https://github.com/burakarslan0110/buracle/releases/latest/download/install.sh | bash
#   bash scripts/install.sh [--dir <checkout>] [--no-install]
#
# What it does: installs Bun when it is missing, clones the release branch (or updates the
# checkout), runs `bun install`, `buracle install --yes` and `buracle doctor`.
# Variables: BURACLE_CHECKOUT (default ~/buracle), BURACLE_REPO, BURACLE_BRANCH (default release),
# BURACLE_HOME (default ~/.buracle).
# Windows: scripts/install.ps1.
set -euo pipefail

REPO_URL="${BURACLE_REPO:-https://github.com/burakarslan0110/buracle.git}"
BRANCH="${BURACLE_BRANCH:-release}"
DIR="${BURACLE_CHECKOUT:-$HOME/buracle}"
RUN_INSTALL=1

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

bun_is_new_enough() {
  # engines.bun in package.json: >= 1.4.0
  bun --version 2>/dev/null | awk -F. 'NR == 1 { exit !($1 > 1 || ($1 == 1 && $2 >= 4)) }'
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) [ $# -ge 2 ] || die "--dir needs a path"; DIR="$2"; shift 2 ;;
      --no-install) RUN_INSTALL=0; shift ;;
      -h|--help) sed -n '2,11p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done

  case "$(uname -s)" in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) die "this script is for macOS and Linux; on Windows run scripts/install.ps1 in PowerShell" ;;
  esac

  if ! have git; then
    if [ "$os" = macos ]; then
      die "git was not found: run 'xcode-select --install', finish the Command Line Tools installation, then run this script again"
    fi
    say "Installing git, curl and unzip"
    if have apt-get; then sudo apt-get update && sudo apt-get install -y git curl unzip
    elif have dnf; then sudo dnf install -y git curl unzip
    elif have pacman; then sudo pacman -Sy --noconfirm git curl unzip
    else die "git was not found: install git, curl and unzip with your package manager, then run this script again"
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
    printf '\nNote: Homebrew is not installed. buracle install adds the system tools it needs (rg, ast-grep, jq, gh, tmux, uv, Node.js) through Homebrew; without it, buracle doctor lists what you still have to install yourself.\n'
  fi

  # The release branch holds the newest release; `buracle update` follows the branch it was cloned from.
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
    bun src/cli/main.ts install --yes
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

main "$@"
