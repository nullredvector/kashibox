#!/bin/bash
# Sets up the background job that keeps the TV app installed (see refresh.sh). Run from the repo:
#   tools/tv_refresh/install.sh              install / update the job and run it once now
#   tools/tv_refresh/install.sh --uninstall  remove it
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DIR="$HOME/Library/Application Support/kashibox-tv-refresh"
PLIST="$HOME/Library/LaunchAgents/net.fexel.kashibox.tv-refresh.plist"
LABEL="net.fexel.kashibox.tv-refresh"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; rm -rf "$DIR"
  echo "removed"; exit 0
fi

TEAM="$(sed -n 's/^DEVELOPMENT_TEAM *= *//p' "$REPO/tvos/Local.xcconfig" 2>/dev/null | head -1)"
[ -n "$TEAM" ] || { echo "no DEVELOPMENT_TEAM in tvos/Local.xcconfig"; exit 1; }
DEVICE="$(xcrun devicectl list devices 2>/dev/null | grep "Apple TV" | grep -Eo '[0-9A-F]{8}-[0-9A-F]{16}' | head -1)"
[ -n "$DEVICE" ] || { echo "no paired Apple TV found (pair it in Xcode first)"; exit 1; }

mkdir -p "$DIR" "$HOME/Library/Logs" "$HOME/Library/LaunchAgents"
printf 'DEVELOPMENT_TEAM=%s\nDEVICE_ID=%s\n' "$TEAM" "$DEVICE" > "$DIR/config"
cp "$HERE/refresh.sh" "$DIR/refresh.sh"; chmod +x "$DIR/refresh.sh"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/refresh.sh</string></array>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/kashibox-tv-refresh.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/kashibox-tv-refresh.log</string>
</dict></plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: checks every 6 hours, reinstalls when the last install is over 4 days old"
echo "log: ~/Library/Logs/kashibox-tv-refresh.log"
