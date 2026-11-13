#!/usr/bin/env bash
# launch-chrome-cdp.sh — start Chrome/Chromium with a debugging port on a
# DEDICATED profile dir. Linux/macOS counterpart of launch-edge-cdp.ps1.
#
# Chromium 136+ refuses --remote-debugging-port together with the DEFAULT user
# data dir (that is why the browser you already have open cannot be attached
# to). So this uses its own dir next to this script. Log in to Taobao once in
# that window and the cookies live there from then on.
#
#   ./launch-chrome-cdp.sh
#   ./launch-chrome-cdp.sh --headless        no visible window (plumbing tests)
#   ./launch-chrome-cdp.sh --fresh           wipe the dedicated profile first
#   ./launch-chrome-cdp.sh --port 9223
#   ./launch-chrome-cdp.sh --url 'https://s.taobao.com/search?q=%E5%8F%A3%E7%BD%A9'
#   ./launch-chrome-cdp.sh --browser /path/to/chrome
#
# The browser is detached from this shell on purpose: a CDP browser must
# outlive the command that started it. (Chromium exits when its parent dies in
# some sandboxes, which shows up as "started fine, then ECONNREFUSED".)

set -euo pipefail

PORT=9222
HEADLESS=0
FRESH=0
URL='https://www.taobao.com'
BROWSER=''

while [ $# -gt 0 ]; do
  case "$1" in
    --port)     PORT="${2:?--port needs a value}"; shift 2 ;;
    --url)      URL="${2:?--url needs a value}"; shift 2 ;;
    --browser)  BROWSER="${2:?--browser needs a value}"; shift 2 ;;
    --headless) HEADLESS=1; shift ;;
    --fresh)    FRESH=1; shift ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$HERE/edge-profile"

# --- locate a Chromium-family browser -------------------------------------
if [ -z "$BROWSER" ]; then
  for candidate in \
    google-chrome google-chrome-stable chromium chromium-browser \
    brave-browser microsoft-edge microsoft-edge-stable vivaldi
  do
    if command -v "$candidate" >/dev/null 2>&1; then
      BROWSER="$(command -v "$candidate")"
      break
    fi
  done
fi
if [ -z "$BROWSER" ]; then
  for candidate in \
    /opt/google/chrome/chrome \
    /usr/lib/chromium/chromium \
    /snap/bin/chromium \
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
    '/Applications/Chromium.app/Contents/MacOS/Chromium' \
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  do
    if [ -x "$candidate" ]; then
      BROWSER="$candidate"
      break
    fi
  done
fi
if [ -z "$BROWSER" ]; then
  cat >&2 <<'EOF'
No Chromium-family browser found.

Install one (Chrome, Chromium, Brave, Edge or Vivaldi), or point at it directly:
  ./launch-chrome-cdp.sh --browser /path/to/chrome

Firefox is not supported: this tooling speaks the Chrome DevTools Protocol.
EOF
  exit 1
fi

# --- profile dir ----------------------------------------------------------
if [ "$FRESH" -eq 1 ] && [ -e "$PROFILE_DIR" ]; then
  # Refuse to delete anything that is not exactly this script's profile dir.
  resolved="$(cd "$PROFILE_DIR" && pwd)"
  expected="$HERE/edge-profile"
  if [ "$resolved" != "$expected" ]; then
    echo "refusing to delete unexpected path: $resolved" >&2
    exit 1
  fi
  echo "wiping $resolved"
  rm -rf -- "$resolved"
fi
mkdir -p "$PROFILE_DIR"

# --- build the command ----------------------------------------------------
args=(
  "--remote-debugging-port=$PORT"
  --remote-debugging-address=127.0.0.1
  "--user-data-dir=$PROFILE_DIR"
  --no-first-run
  --no-default-browser-check
  --disable-sync
  --disable-features=Translate
)
[ "$HEADLESS" -eq 1 ] && args+=(--headless=new)
args+=("$URL")

echo "launching: $BROWSER"
echo "profile:   $PROFILE_DIR"

# Detach: new session, no controlling terminal, output to a log file.
LOG="$PROFILE_DIR/launch.log"
setsid "$BROWSER" "${args[@]}" >"$LOG" 2>&1 </dev/null &
PID=$!
disown "$PID" 2>/dev/null || true
echo "pid:       $PID"

# --- wait for the endpoint ------------------------------------------------
deadline=$(( $(date +%s) + 25 ))
version=''
while [ "$(date +%s)" -lt "$deadline" ]; do
  if version="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" 2>/dev/null)"; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "browser exited during startup; last log lines:" >&2
    tail -n 20 "$LOG" >&2 || true
    exit 1
  fi
  sleep 0.4
done

if [ -z "$version" ]; then
  echo "CDP did not come up on port $PORT within 25s" >&2
  echo "last log lines:" >&2
  tail -n 20 "$LOG" >&2 || true
  exit 1
fi

browser_name="$(printf '%s' "$version" | sed -n 's/.*"Browser": *"\([^"]*\)".*/\1/p')"
echo
echo "CDP ready on http://127.0.0.1:$PORT"
echo "  browser : ${browser_name:-unknown}"
echo "  profile : $PROFILE_DIR"
echo
echo "drive it with:  CDP_PORT=$PORT node cdp.mjs list"
echo "the debugging port is a local trust boundary - close this window when done."
