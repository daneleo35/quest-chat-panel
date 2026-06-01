# Quest Chat Panel

A sideloadable Meta Quest 3 flat-panel app for Kick, Twitch, and YouTube chat. The headset app is intentionally simple: it connects to a PC relay over WebSocket, and the PC relay handles the streaming-platform connections.

## Build The APK

```powershell
git clone <repo-url>
cd quest-chat-panel
.\gradlew.bat assembleDebug
```

The APK is written to:

```text
app\build\outputs\apk\debug\app-debug.apk
```

## Install To Quest

Enable developer/debug mode, connect the headset by USB, accept the USB debugging prompt inside the headset, then run:

```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

Launch **Quest Chat Panel** from Unknown Sources.

## Run The Chat Relay

The easiest PC flow is the desktop control app:

Double-click:

```text
Quest Chat Panel Control.vbs
```

Or run:

```powershell
cd quest-chat-panel
npm run app
```

It starts the relay automatically, shows live logs, detects ADB devices, and installs the APK when an authorized Quest appears. The visible app log masks local relay URLs; the log file keeps the original lines for troubleshooting.

Use the **Chat Sources** section in the control app to set Twitch, YouTube, and Kick channels. Saving source settings restarts the relay automatically.

The control app checks GitHub Releases for updates. The update cards show the current and latest versions for both the Windows control app and the Quest APK. Use **Update App** to download, extract, and launch the newest Windows app, or **Update APK** to download and install the newest Quest APK to an authorized headset.

## Build The Windows EXE

```powershell
cd quest-chat-panel
npm run package:control
```

The packaged app is written to:

```text
release\Quest Chat Panel Control-win32-x64\Quest Chat Panel Control.exe
```

The `release` folder is ignored by Git because it contains the bundled Electron runtime.

## Build The Windows Installer

```powershell
cd quest-chat-panel
.\gradlew.bat assembleDebug
npm run package:installer
```

The installer is written to:

```text
installer\Quest-Chat-Panel-Control-Setup-1.0.0.exe
```

The installer includes the Quest APK as a bundled resource for auto-install.

The plain relay is still available:

Install the relay dependencies once:

```powershell
npm install
```

Then run:

```powershell
npm run relay
```

The relay prints one or more URLs like:

```text
Quest URL: ws://192.168.1.23:8787
```

The Quest app auto-discovers the relay on your LAN and connects by itself. The URL field is still there as a fallback if Windows Firewall or your network blocks UDP discovery.

Auto-discovery uses UDP port `8788`; chat uses WebSocket/HTTP port `8787` by default.

## Configure Sources

Edit `relay.config.json`:

```json
{
  "port": 8787,
  "twitchChannels": ["example_twitch_channel"],
  "youtubeSources": ["https://www.youtube.com/@ExampleChannel"],
  "kickChannels": ["example_kick_channel"]
}
```

Supported source forms:

- Twitch: channel names such as `example_twitch_channel`.
- Kick: channel names such as `example_kick_channel`.
- YouTube: live video URLs, 11-character live video IDs, channel IDs, or handles such as `@ExampleChannel`.

## Notes

- Twitch reads public chat through anonymous IRC via `tmi.js`.
- YouTube uses `youtube-chat`, which reads public live chat without a Google API key.
- Kick uses Kick's public channel metadata plus the chat Pusher websocket. Kick's public interface can change, so this connector is isolated in `scripts/relay-server.js`.
