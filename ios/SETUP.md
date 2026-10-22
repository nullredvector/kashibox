# kashibox for iPhone

A thin Capacitor shell that loads the kashibox page and adds native Google Cast. Install it on your phone from Xcode
(free Apple ID signing is enough; AltStore can re-sign it every 7 days).

## Build

```bash
cd ios
npm ci
cd ios/App
export LANG=en_US.UTF-8          # CocoaPods needs a UTF-8 locale
pod install
open App.xcworkspace
```

In Xcode: App target -> Signing & Capabilities -> pick your Team (this is not stored in git), choose your iPhone, Run.

## Notes

- Do not run `npx cap sync`: it overwrites `ios/App/App/capacitor.config.json`, where the Cast plugin is registered
  (`packageClassList`).
- The plugin source is `ios/App/KashiboxCastPlugin.swift` / `.m` (Xcode compiles these exact files); `CastBridgeVC.swift` is the view controller.
- The Cast App ID is in `KashiboxCastPlugin.swift`; Bonjour and Local Network entries for device discovery are in `Info.plist`.
- Page changes (`starplayer.js`) reach the app through the server; only native changes need a rebuild.

## Install with AltStore (renews itself)

A free Apple ID signs apps for 7 days; AltStore (with AltServer running on the Mac) renews that in the background, but
only for apps it installed from an `.ipa`. Build one and open it in AltStore (My Apps -> +):

```bash
tools/build_ios_ipa.sh        # writes ~/Downloads/Kashibox.ipa (unsigned: AltStore signs it)
```

Native changes (the Cast plugin, Info.plist, the icon) need a new `.ipa`; page changes reach the app through the server.

