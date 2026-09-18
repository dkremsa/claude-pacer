#!/bin/zsh
# Builds Pacer.app, copies it to /Applications and (re)installs the sampling launchd agent.
set -e
cd "$(dirname "$0")"
APP="Pacer.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -o "$APP/Contents/MacOS/Pacer" Pacer.swift
mkdir -p "$APP/Contents/Resources"
[ -f Pacer.icns ] || { swiftc -O -o /tmp/pacer-icon icon.swift && rm -rf Pacer.iconset && mkdir Pacer.iconset && /tmp/pacer-icon Pacer.iconset && iconutil -c icns Pacer.iconset -o Pacer.icns; }
cp Pacer.icns "$APP/Contents/Resources/Pacer.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.claude-pacer</string>
  <key>CFBundleName</key><string>Pacer</string>
  <key>CFBundleDisplayName</key><string>Pacer</string>
  <key>CFBundleExecutable</key><string>Pacer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleIconFile</key><string>Pacer</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
NODE="$(command -v node)"
# launchd gives a job only the system PATH. The Copilot reader shells out to `gh`, so its directory is derived
# from where gh actually is (Homebrew, nix, MacPorts…) rather than guessed.
GH="$(command -v gh 2>/dev/null || true)"   # `dirname ""` prints ".", so an absent gh must stay empty
GH_DIR="${GH:+$(dirname "$GH")}"
JOB_PATH="${GH_DIR:+$GH_DIR:}/usr/bin:/bin:/usr/sbin:/sbin"
PLIST_PATH="$HOME/Library/LaunchAgents/com.claude-pacer.tick.plist"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-pacer.tick</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$PWD/pacer.mjs</string><string>tick</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$JOB_PATH</string></dict>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PWD/tick.log</string>
  <key>StandardErrorPath</key><string>$PWD/tick.log</string>
</dict></plist>
PLIST
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
# "Claude Pacer.app" is the pre-rename name
rm -rf "/Applications/Claude Pacer.app" /Applications/Pacer.app && cp -R "$APP" "/Applications/Pacer.app"
echo "built $PWD/$APP → /Applications/Pacer.app · launchd com.claude-pacer.tick every 10 min (node: $NODE)"
echo "open it:  open \"/Applications/Pacer.app\"   · at login: System Settings → General → Login Items → add Pacer"
