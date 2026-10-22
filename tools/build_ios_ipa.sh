#!/bin/bash
# Builds an unsigned Release .ipa of the iPhone app (ios/) for AltStore. AltStore signs it with your Apple ID when you
# install it and renews that signing in the background, so nothing personal is baked in.
#   tools/build_ios_ipa.sh [output.ipa]      (default: ~/Downloads/Kashibox.ipa)
set -euo pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # CocoaPods needs a UTF-8 locale
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/Downloads/Kashibox.ipa}"
CACHE="$HOME/Library/Caches/kashibox-ipa-build"

cd "$REPO/ios"
[ -d node_modules ] || npm ci --silent
cd ios/App
[ -d Pods ] || pod install

xcodebuild -workspace App.xcworkspace -scheme App -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$CACHE" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build | tail -3

APP="$CACHE/Build/Products/Release-iphoneos/App.app"
[ -d "$APP" ] || { echo "no app was built"; exit 1; }
mkdir -p "$CACHE/stage"
rm -rf "$CACHE/stage/Payload"
mkdir "$CACHE/stage/Payload"
cp -R "$APP" "$CACHE/stage/Payload/"
rm -f "$OUT"
(cd "$CACHE/stage" && zip -qry "$OUT" Payload)
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
