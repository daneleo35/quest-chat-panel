# Quest Chat Panel

A sideloadable Meta Quest 3 flat-panel app for Kick, Twitch, and YouTube chat, with an optional Windows companion for relay management, Streamlabs control, updates, and installs.

## What Is New In v2

- Quest app modes:
  - `Companion App + OBS`
  - `Stream Chat Only`
- Manual Twitch, YouTube, and Kick source settings in both the headset and the Windows companion.
- Real emote rendering for Twitch, YouTube, and Kick instead of plain-text fallbacks.
- Streamlabs scene switching and audio mute/volume control from both the companion app and the headset overlay.
- Automatic relay discovery on the local network.
- Headset battery and device status reported over Wi-Fi to the companion app, with ADB still available as a fallback.
- Windows companion close-to-tray behavior and relay takeover if older relay instances are already running.

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

## Companion vs Headset-Only

`Companion App + OBS`

- Uses the Windows relay.
- Enables Streamlabs scene and audio control.
- Reports Quest battery/device status over the local network.

`Stream Chat Only`

- Connects to Twitch, YouTube, and Kick directly from the headset.
- Hides relay and Streamlabs controls.
- Useful when you do not want to run the Windows companion.

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
installer\Quest-Chat-Panel-Control-Setup-<version>.exe
```

The installer includes the Quest APK as a bundled resource for auto-install.

## The plain relay via command prompt/powershell

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
- The Windows companion uses the local Streamlabs named pipe, so no remote token setup is needed for the manual control flow.
