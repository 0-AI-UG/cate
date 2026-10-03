# Cate for iOS

The mobile shell (architecture 15, `shells/mobile`). It hosts the same
portable client the desktop renderer runs, in a `WKWebView`, and provides the
native primitives behind the client's ports through a bridge
(`window.webkit.messageHandlers.cate`).

- `Cate/ClientView.swift`: the web view.
- `Cate/AppSchemeHandler.swift`: serves `Cate/Web/` at `cate-app://app/`.
- `Cate/ShellBridge.swift`: native methods the page calls (`app.info` so far).
- `Cate/Web/`: the client bundle. For now a placeholder page that checks what
  the client relies on (secure context, `crypto.randomUUID`, WebSocket,
  WebRTC, the bridge).

## Build

```bash
brew install xcodegen
cd ios
xcodegen generate          # writes Cate.xcodeproj (not checked in)
open Cate.xcodeproj
```

From the command line (if `xcode-select` points at the Command Line Tools,
prefix with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`):

```bash
xcodebuild -project Cate.xcodeproj -scheme Cate -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
```
