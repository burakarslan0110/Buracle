---
description: "Buracle path rule: Mobile apps (injected when editing or writing matching files)"
condition:
  - "**/capacitor.config.*"
  - "**/ionic.config.json"
  - "**/android/app/build.gradle*"
  - "**/android/app/src/main/AndroidManifest.xml"
  - "**/*.xcodeproj/project.pbxproj"
  - "**/*.xcworkspace/contents.xcworkspacedata"
  - "**/Podfile"
  - "**/pubspec.yaml"
  - "**/react-native.config.*"
  - "**/metro.config.*"
  - "**/expo.json"
  - "**/eas.json"
  - "**/app.config.{js,ts}"
---
# Mobile apps

## Know the project first
- Take the bundle or package ids, SDK and toolchain pins, build variants and target devices from the project (Gradle files, the Xcode project, `pubspec.yaml`, `app.config.*`, the repo's scripts and docs). Never guess them.
- Use the project's own build, install, signing and device commands before any generic one.

## Verify the installed app
- A change to native code, packaging, permissions, plugins or release settings is verified on the installed app, not on a desktop dev server. Build it, install it, and use the changed flow.
- Report the build you ran (variant, version, build number) and where: simulator or emulator, or a physical device with its OS version.
- Poll device boot, app start and async work with a timeout; never wait without a limit.

## Drivers per surface
- Android WebView: find that app's own `webview_devtools_remote_<pid>` socket (`adb shell cat /proc/net/unix`), never the first one on a device that runs several apps, then `adb forward tcp:<port> localabstract:<socket>`. Forward again after the app restarts.
- Buracle's chrome-devtools server starts its own isolated Chrome and cannot attach to that port, and omp's built-in browser cannot reach a device either. Inspect through `chrome://inspect` in a desktop Chrome, a CDP client started for that port (for example `chrome-devtools-mcp --browser-url=http://127.0.0.1:<port>`), or the project's own harness.
- Android native: the project's UI automation (Espresso, UI Automator, Maestro, Detox, Flutter `integration_test`).
- iOS: Safari Web Inspector for a WebView, the project's XCTest or XCUITest harness for native screens. A desktop browser driver does not reach either.
- Keep remote debugging and injected bridges out of release builds; use the project's debug-only switches.

## Device state
- `INSTALL_FAILED_VERSION_DOWNGRADE` means the new build's version code is lower than the installed one. Use the project's test-build path; never uninstall the app, clear its data or change release versioning to get past it.
- Clearing app data (`adb uninstall`, `adb shell pm clear`, `xcrun simctl erase`) needs the user's permission.
- Dismissing the keyboard can act as Back. Look at the screen you landed on before you assume a crash.

## Device UI checks
- Safe areas: content clears the notch, the status bar and the home indicator. On the web, set `viewport-fit=cover` and check `env(safe-area-inset-*)`; never assume an inset is there.
- With the keyboard open, the focused field and the primary action stay visible and usable; `dvh` alone does not guarantee that.
- OS text scaling at its largest setting causes no clipping, overlap or unreachable navigation.
- Check the light and dark system themes, with intentional surface and background colors.
- Touch targets are at least 44×44 pt on iOS and 48×48 dp on Android.
- The frontend and browser-automation rules cover components, accessibility and the browser procedure for WebView screens.

## Library docs
- Check Capacitor, React Native, Expo, Flutter and platform SDK APIs with context7 at the installed version.
