#!/bin/bash
# Rebuilds the kashibox TV app from master and installs it on the Apple TV. A free Apple ID signs apps for 7 days only,
# so this runs often but only acts when the last install is older than STALE_DAYS (or with --force).
# Needs: Xcode signed into the Apple ID, XcodeGen, the Apple TV paired and awake on the network.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

DIR="$HOME/Library/Application Support/kashibox-tv-refresh"
LOG="$HOME/Library/Logs/kashibox-tv-refresh.log"
REPO_URL="https://github.com/nullredvector/kashibox.git"
STALE_DAYS=4
. "$DIR/config"   # DEVELOPMENT_TEAM and DEVICE_ID, written by install.sh

log()  { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
fail() {
  log "FAILED: $*"
  osascript -e "display notification \"$*\" with title \"kashibox TV app refresh failed\"" >/dev/null 2>&1
  exit 1
}

if [ "${1:-}" != "--force" ] && [ -f "$DIR/last-success" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$DIR/last-success") ))
  [ "$age" -lt $(( STALE_DAYS * 86400 )) ] && exit 0
fi

mkdir "$DIR/lock" 2>/dev/null || exit 0     # another run is in progress
trap 'rmdir "$DIR/lock" 2>/dev/null' EXIT
log "refresh started"

# The Apple TV can be asleep: give it a few tries to show up
up=""
for i in 1 2 3 4 5 6; do
  if xcrun devicectl list devices 2>/dev/null | grep "$DEVICE_ID" | grep -Eq "available|connected"; then up=1; break; fi
  log "Apple TV not reachable (try $i of 6)"; sleep 60
done
[ -n "$up" ] || fail "the Apple TV was not reachable"

SRC="$DIR/src"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --quiet --depth 1 origin master >>"$LOG" 2>&1 && git -C "$SRC" reset --quiet --hard FETCH_HEAD >>"$LOG" 2>&1 || fail "could not update the source from GitHub"
else
  rm -rf "$SRC"
  git clone --quiet --depth 1 --branch master "$REPO_URL" "$SRC" >>"$LOG" 2>&1 || fail "could not download the source from GitHub"
fi

# Xcode keeps reusing its cached signing profile for this app until that has expired, so a reinstall would carry the old
# expiry date. Drop the cached copy (it is only a cache) so a fresh profile, valid for another 7 days, is requested.
PROFILES="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
for f in "$PROFILES"/*.mobileprovision; do
  [ -f "$f" ] || continue
  name="$(security cms -D -i "$f" 2>/dev/null | plutil -extract Name raw - 2>/dev/null)"
  [ "$name" = "tvOS Team Provisioning Profile: net.fexel.kashibox.tv" ] && rm -f "$f" && log "dropped the cached signing profile"
done

cd "$SRC/tvos" || fail "no tvos folder in the source"
printf 'DEVELOPMENT_TEAM = %s\n' "$DEVELOPMENT_TEAM" > Local.xcconfig
xcodegen generate >>"$LOG" 2>&1 || fail "xcodegen failed"
xcodebuild -project KashiboxTV.xcodeproj -scheme KashiboxTV -destination "id=$DEVICE_ID" \
  -derivedDataPath "$DIR/build" -allowProvisioningUpdates build >>"$LOG" 2>&1 \
  || fail "the build or signing failed (is Xcode still signed in to your Apple ID?)"

APP="$DIR/build/Build/Products/Debug-appletvos/KashiboxTV.app"

# Never install something that is about to expire again: the build's own profile must have most of its 7 days left
EXP="$(security cms -D -i "$APP/embedded.mobileprovision" 2>/dev/null | plutil -extract ExpirationDate raw - 2>/dev/null)"
EXP_EPOCH="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$EXP" +%s 2>/dev/null)"
[ -n "$EXP_EPOCH" ] && [ $(( EXP_EPOCH - $(date +%s) )) -gt $(( 5 * 86400 )) ] || fail "the new build's signing profile expires too soon ($EXP)"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP" >>"$LOG" 2>&1 || fail "installing on the Apple TV failed"

touch "$DIR/last-success"
log "refresh done: installed $(git -C "$SRC" rev-parse --short HEAD), signing valid until $EXP"
