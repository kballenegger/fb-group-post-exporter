#!/bin/bash
# Launches a Chromium-based browser with remote debugging enabled,
# using a dedicated profile dir so it doesn't interfere with your main session.

PROFILE_DIR="${HOME}/.fb-export-chrome-profile"
PORT=9222

# Auto-detect a Chromium-based browser (Chrome, Brave, Edge, Chromium)
CANDIDATES=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
)

BROWSER=""
for c in "${CANDIDATES[@]}"; do
  if [ -x "$c" ]; then
    BROWSER="$c"
    break
  fi
done

if [ -z "$BROWSER" ]; then
  echo "No Chromium-based browser found. Install Chrome, Brave, Edge, or Chromium."
  exit 1
fi

mkdir -p "$PROFILE_DIR"

echo "Launching: $BROWSER"
echo "Remote debugging port: $PORT"
echo "Profile dir: $PROFILE_DIR"
echo ""
echo "After the browser opens:"
echo "  1. Log in to Facebook"
echo "  2. In another terminal, run: node run.mjs"
echo ""

exec "$BROWSER" \
  --remote-debugging-port=$PORT \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "https://www.facebook.com/"
