#!/usr/bin/env bash
# Install reel-mesh: runtime + `reel-mesh` CLI, then register the skill with the AI coding tools found on this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/x-mesh/reel-mesh/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/x-mesh/reel-mesh/main/scripts/install.sh | bash -s -- --yes
#   bash scripts/install.sh [install|uninstall|status] [--yes] [--targets claude,codex,...|all] [--source <dir>] [--skip-browser] [--force]

set -euo pipefail

REPO="x-mesh/reel-mesh"
REF="${REEL_MESH_REF:-main}"
INSTALL_HOME="${REEL_MESH_HOME:-$HOME/.local/share/reel-mesh}"
BIN_DIR="${REEL_MESH_BIN_DIR:-$HOME/.local/bin}"
MARKER=".reel-mesh-install"

ACTION="install"
ASSUME_YES=0
FORCE=0
SKIP_BROWSER=0
TARGETS=""
SOURCE=""
DOWNLOAD_DIR=""

info() { printf '\033[0;34m[reel-mesh]\033[0m %s\n' "$1"; }
ok() { printf '\033[0;32m[reel-mesh]\033[0m %s\n' "$1"; }
warn() { printf '\033[0;33m[reel-mesh]\033[0m %s\n' "$1"; }
fail() {
  printf '\033[0;31m[reel-mesh]\033[0m %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [install|uninstall|status] [options]

  install     Install the runtime and CLI, then register the skill (default)
  uninstall   Remove the skill registrations, the CLI, and the runtime
  status      Show what is installed

Options:
  --yes            Do not ask before registering the skill with AI coding tools
  --targets LIST   Comma-separated: claude,codex,cursor,kiro,antigravity,opencode, or all (default: detected)
  --source DIR     Install from a local checkout instead of GitHub
  --skip-browser   Do not run `npx playwright install chromium`
  --force          Overwrite files that reel-mesh did not create

Environment: REEL_MESH_HOME (runtime, default ~/.local/share/reel-mesh),
             REEL_MESH_BIN_DIR (CLI, default ~/.local/bin), REEL_MESH_REF (git ref, default main)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    install | uninstall | status) ACTION="$1" ;;
    --yes | -y) ASSUME_YES=1 ;;
    --force) FORCE=1 ;;
    --skip-browser) SKIP_BROWSER=1 ;;
    --targets)
      [ $# -ge 2 ] || fail "--targets needs a value"
      TARGETS="$2"
      shift
      ;;
    --source)
      [ $# -ge 2 ] || fail "--source needs a directory"
      SOURCE="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

CLI="$BIN_DIR/reel-mesh"
SETUP_ARGS=()
[ -n "$TARGETS" ] && SETUP_ARGS+=(--targets "$TARGETS")
[ "$FORCE" = 1 ] && SETUP_ARGS+=(--force)

require() { command -v "$1" >/dev/null 2>&1 || fail "$1 not found. $2"; }

# Refuse to replace a directory this script did not create.
assert_managed_home() {
  if [ -e "$INSTALL_HOME" ] && [ ! -f "$INSTALL_HOME/$MARKER" ]; then
    fail "$INSTALL_HOME exists but was not installed by reel-mesh; set REEL_MESH_HOME to another path or remove it"
  fi
}

# A local checkout is used when this script runs from one; `curl | bash` has no script directory, so GitHub is used.
resolve_source() {
  if [ -n "$SOURCE" ]; then
    [ -f "$SOURCE/bin/reel-mesh.ts" ] || fail "--source $SOURCE is not a reel-mesh checkout"
    (cd "$SOURCE" && pwd)
    return
  fi
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [ -n "$script_dir" ] && [ -f "$script_dir/../bin/reel-mesh.ts" ] && [ -f "$script_dir/../.claude-plugin/plugin.json" ]; then
    (cd "$script_dir/.." && pwd)
    return
  fi
  require curl "Install curl, or run with --source <checkout>."
  require tar "Install tar."
  info "Downloading $REPO@$REF..." >&2
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xzf - -C "$DOWNLOAD_DIR" --strip-components=1 ||
    fail "download failed: https://codeload.github.com/$REPO/tar.gz/$REF"
  printf '%s\n' "$DOWNLOAD_DIR"
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  # `curl | bash` reads the script from stdin, so the answer has to come from the terminal.
  if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    local answer
    printf '%s [y/N] ' "$1" >/dev/tty
    read -r answer </dev/tty || answer=""
    case "$answer" in y | Y | yes | YES) return 0 ;; esac
  fi
  return 1
}

install_runtime() {
  require node "Install Node.js (verified with v26.12.1)."
  require npm "Install npm."
  command -v ffmpeg >/dev/null 2>&1 || warn "ffmpeg not found. Recording needs it on PATH (brew install ffmpeg)."
  assert_managed_home

  local source staging
  # resolve_source runs in a subshell, so the download folder is created here where the EXIT trap can remove it.
  DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/reel-mesh-src.XXXXXX")"
  trap 'rm -rf -- "$DOWNLOAD_DIR"' EXIT
  source="$(resolve_source)"
  staging="$(mktemp -d "${TMPDIR:-/tmp}/reel-mesh-home.XXXXXX")"
  info "Copying runtime from $source"
  tar -C "$source" \
    --exclude='./.git' --exclude='./node_modules' --exclude='./.reel' --exclude='./.xm' \
    --exclude='./docs/REQUIREMENTS.md' --exclude='./docs/PLAN.md' \
    -cf - . | tar -C "$staging" -xf -
  touch "$staging/$MARKER"

  info "Installing dependencies (npm ci --omit=dev)..."
  (cd "$staging" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || fail "npm ci failed in $staging"

  mkdir -p "$(dirname "$INSTALL_HOME")"
  rm -rf -- "$INSTALL_HOME"
  mv "$staging" "$INSTALL_HOME"

  if [ "$SKIP_BROWSER" = 1 ]; then
    warn "Skipped Chromium download (--skip-browser)."
  else
    info "Installing Chromium for Playwright..."
    (cd "$INSTALL_HOME" && npx playwright install chromium) || fail "npx playwright install chromium failed"
  fi

  mkdir -p "$BIN_DIR"
  cat >"$CLI" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_HOME/bin/reel-mesh.ts" "\$@"
EOF
  chmod +x "$CLI"
  "$CLI" validate "$INSTALL_HOME/examples/scenarios/fixture-app.yaml" >/dev/null ||
    fail "the installed CLI failed to run: $CLI validate $INSTALL_HOME/examples/scenarios/fixture-app.yaml"
  ok "CLI installed: $CLI"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on PATH. Add it so agents can run reel-mesh: export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
}

register_skill() {
  if ! "$CLI" setup install ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}; then
    warn "Skill not registered. Install an AI coding tool, or pick one: reel-mesh setup install --targets <list> --yes"
    return
  fi
  if confirm "Register the reel-mesh skill with these tools?"; then
    "$CLI" setup install --yes ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"} || fail "skill registration failed (see FAIL lines above)"
  else
    warn "Skill not registered. Run later: reel-mesh setup install --yes"
  fi
}

case "$ACTION" in
  install)
    install_runtime
    register_skill
    ;;
  uninstall)
    if [ -n "$TARGETS" ]; then
      [ -x "$CLI" ] || fail "reel-mesh is not installed ($CLI)"
      "$CLI" setup uninstall --yes ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}
      exit $?
    fi
    if [ -x "$CLI" ]; then
      "$CLI" setup uninstall --yes ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"} || fail "skill removal failed; the CLI and runtime were kept"
      rm -f -- "$CLI"
    fi
    assert_managed_home
    rm -rf -- "$INSTALL_HOME"
    ok "Removed reel-mesh"
    ;;
  status)
    if [ -x "$CLI" ]; then
      info "CLI: $CLI -> $INSTALL_HOME"
      "$CLI" setup status
    else
      info "CLI: not installed ($CLI)"
    fi
    ;;
esac
