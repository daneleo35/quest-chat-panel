const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONTROL_STATE_PATH = path.join(ROOT, ".control-state.json");
const RELAY_CONFIG_PATH = path.join(ROOT, "relay.config.json");
const LOG_DIR = path.join(ROOT, "logs");
const LOG_PATH = path.join(LOG_DIR, `quest-chat-panel-${timestampForFile()}.log`);
const UPDATE_DIR = path.join(ROOT, "updates");
const POLL_MS = 3500;
const UPDATE_REPO = "daneleo35/quest-chat-panel";
const APP_ASSET_NAME = "Quest-Chat-Panel-Control-win32-x64.zip";
const APK_ASSET_NAME = "Quest-Chat-Panel.apk";
const ANDROID_PACKAGE_ID = "com.codex.questchatpanel";
const APK_PATH = resolveApkPath();
const DEVICE_STALE_MS = 10000;

let mainWindow;
let relayProcess;
let adbPollTimer;
let autoInstall = true;
let installedThisSession = false;
let controlState = readControlState();
let lastSeenApkFingerprint = "";
let questApkVersion = "";
let questApkVersionChecked = false;
let lastDevices = [];
let lastDeviceSeenAt = 0;
let updateInfo = {
  checking: false,
  currentAppVersion: app.getVersion(),
  currentApkVersion: currentApkVersion(),
  latestAppVersion: "",
  latestApkVersion: "",
  releaseUrl: "",
  appUpdateAvailable: false,
  apkUpdateAvailable: false,
  detail: "Not checked yet"
};

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveApkPath() {
  const candidates = [
    path.join(ROOT, "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
    path.join(process.resourcesPath || "", APK_ASSET_NAME),
    path.join(path.dirname(process.execPath || ""), APK_ASSET_NAME)
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || candidates[0];
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 520,
    title: "Quest Chat Panel Control",
    backgroundColor: "#0b0f14",
    webPreferences: {
      preload: path.join(__dirname, "control-preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "control-renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

function createAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        { label: "Open Folder", click: () => shell.openPath(ROOT) },
        { label: "Open Logs", click: () => shell.showItemInFolder(LOG_PATH) },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    }
  ]));
}

function emit(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

function log(line, scope = "app") {
  const text = `[${new Date().toLocaleTimeString()}] [${scope}] ${String(line).trimEnd()}`;
  const visibleText = maskPrivateRelayUrls(text);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, `${text}${os.EOL}`);
  emit("log", visibleText);
}

function maskPrivateRelayUrls(value) {
  return String(value).replace(/ws:\/\/(?:10|127|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2}:\d+/g, "ws://hidden-local-relay");
}

function setState(patch) {
  const apk = apkInfo();
  emit("state", {
    relayRunning: Boolean(relayProcess && !relayProcess.killed),
    autoInstall,
    installedThisSession,
    apk,
    apkNeedsInstall: Boolean(apk.fingerprint && apk.fingerprint !== controlState.lastInstalledApkFingerprint),
    updateInfo,
    devices: visibleDevices(),
    logPath: LOG_PATH,
    apkPath: APK_PATH,
    ...patch
  });
}

function visibleDevices() {
  if (lastDevices.length || Date.now() - lastDeviceSeenAt < DEVICE_STALE_MS) {
    return lastDevices;
  }
  return [];
}

function readControlState() {
  try {
    return JSON.parse(fs.readFileSync(CONTROL_STATE_PATH, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function saveControlState() {
  fs.writeFileSync(CONTROL_STATE_PATH, JSON.stringify(controlState, null, 2));
}

function apkInfo() {
  try {
    const stat = fs.statSync(APK_PATH);
    return {
      exists: true,
      size: stat.size,
      modifiedMs: stat.mtimeMs,
      modifiedText: stat.mtime.toLocaleString(),
      fingerprint: `${stat.size}:${Math.round(stat.mtimeMs)}`
    };
  } catch {
    return {
      exists: false,
      size: 0,
      modifiedMs: 0,
      modifiedText: "Missing",
      fingerprint: ""
    };
  }
}

function localApkVersion() {
  try {
    const buildGradle = fs.readFileSync(path.join(ROOT, "app", "build.gradle"), "utf8");
    const gradleVersion = buildGradle.match(/versionName\s+"([^"]+)"/)?.[1];
    if (gradleVersion) return gradleVersion;
  } catch {
    // The installed Windows app bundles the APK but not the Android Gradle file.
  }

  return app.getVersion() || "unknown";
}

function currentApkVersion() {
  if (questApkVersionChecked) return questApkVersion || "not installed";
  return questApkVersion || controlState.lastInstalledApkVersion || localApkVersion();
}

function apkUpdateAvailable(latestVersion) {
  const current = currentApkVersion();
  if (!latestVersion) return updateInfo.apkUpdateAvailable;
  if (!/^\d/.test(normalizeVersion(current))) return true;
  return compareVersions(current, latestVersion) < 0;
}

function refreshCurrentApkVersion() {
  updateInfo = {
    ...updateInfo,
    currentApkVersion: currentApkVersion(),
    apkUpdateAvailable: apkUpdateAvailable(updateInfo.latestApkVersion)
  };
}

function checkApkForUpdates() {
  const apk = apkInfo();
  if (apk.fingerprint && apk.fingerprint !== lastSeenApkFingerprint) {
    if (lastSeenApkFingerprint) {
      log(`APK update detected (${apk.modifiedText}, ${apk.size} bytes).`, "apk");
    } else {
      log(`APK found (${apk.modifiedText}, ${apk.size} bytes).`, "apk");
    }
    lastSeenApkFingerprint = apk.fingerprint;
  }
  setState({ apk });
  return apk;
}

function startRelay() {
  if (relayProcess && !relayProcess.killed) {
    log("Relay already running.");
    setState();
    return;
  }

  log("Starting relay...");
  relayProcess = spawn(process.execPath, [path.join(ROOT, "scripts", "relay-server.js")], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  relayProcess.stdout.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/).filter(Boolean)) log(line, "relay");
  });
  relayProcess.stderr.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/).filter(Boolean)) log(line, "relay");
  });
  relayProcess.on("exit", (code) => {
    log(`Relay exited with code ${code}.`, "relay");
    relayProcess = undefined;
    setState();
  });

  setState();
}

function stopRelay() {
  if (!relayProcess || relayProcess.killed) {
    log("Relay is not running.");
    setState();
    return;
  }

  log("Stopping relay...");
  relayProcess.kill();
  relayProcess = undefined;
  setState();
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      windowsHide: true,
      shell: false,
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function readRelayConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(RELAY_CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""));
    return normalizeRelayConfig(value);
  } catch {
    return normalizeRelayConfig({});
  }
}

function normalizeRelayConfig(value) {
  return {
    port: Number(value.port || 8787),
    twitchChannels: normalizeList(value.twitchChannels),
    youtubeSources: normalizeList(value.youtubeSources),
    kickChannels: normalizeList(value.kickChannels)
  };
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }

  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function saveRelayConfig(value) {
  const next = normalizeRelayConfig(value);
  fs.writeFileSync(RELAY_CONFIG_PATH, `${JSON.stringify(next, null, 2)}${os.EOL}`);
  log("Saved relay source settings.");
  if (relayProcess && !relayProcess.killed) {
    stopRelay();
    startRelay();
  }
  setState({ relayConfig: next });
  return next;
}

async function buildApk() {
  log("Building APK...", "apk");
  const result = await run("gradle", ["assembleDebug"], { shell: true });
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter(Boolean)) {
    log(line, "apk");
  }
  if (result.code === 0) {
    log("APK build complete.", "apk");
    checkApkForUpdates();
    await pollAdb();
    return true;
  }
  log(`APK build failed with code ${result.code}.`, "apk");
  return false;
}

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split(".").map((part) => Number(part) || 0);
  const b = normalizeVersion(right).split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "accept": "application/vnd.github+json",
        "user-agent": "QuestChatPanelControl"
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        resolve(requestJson(response.headers.location));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub returned ${response.statusCode}: ${body.slice(0, 160)}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const file = fs.createWriteStream(targetPath);
    https.get(url, { headers: { "user-agent": "QuestChatPanelControl" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.rmSync(targetPath, { force: true });
        downloadFile(response.headers.location, targetPath).then(resolve, reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        file.close();
        fs.rmSync(targetPath, { force: true });
        reject(new Error(`Download returned ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (error) => {
      file.close();
      fs.rmSync(targetPath, { force: true });
      reject(error);
    });
  });
}

function releaseAsset(release, name) {
  return (release.assets || []).find((asset) => asset.name === name);
}

async function checkForReleaseUpdates() {
  updateInfo = { ...updateInfo, checking: true, detail: "Checking GitHub Releases..." };
  setState();

  try {
    const release = await requestJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    const latest = normalizeVersion(release.tag_name || release.name);
    updateInfo = {
      checking: false,
      currentAppVersion: app.getVersion(),
      currentApkVersion: currentApkVersion(),
      latestAppVersion: latest,
      latestApkVersion: latest,
      releaseUrl: release.html_url || "",
      appUpdateAvailable: compareVersions(app.getVersion(), latest) < 0,
      apkUpdateAvailable: apkUpdateAvailable(latest),
      detail: `Latest release ${release.tag_name || latest}`,
      appAssetUrl: releaseAsset(release, APP_ASSET_NAME)?.browser_download_url || "",
      apkAssetUrl: releaseAsset(release, APK_ASSET_NAME)?.browser_download_url || ""
    };
    log(`Update check complete: app ${updateInfo.currentAppVersion} -> ${updateInfo.latestAppVersion}, APK ${updateInfo.currentApkVersion} -> ${updateInfo.latestApkVersion}.`, "update");
  } catch (error) {
    updateInfo = { ...updateInfo, checking: false, detail: `Update check failed: ${cleanError(error)}` };
    log(updateInfo.detail, "update");
  }

  setState();
  return updateInfo;
}

async function updateApkFromRelease() {
  if (!updateInfo.apkAssetUrl) await checkForReleaseUpdates();
  if (!updateInfo.apkAssetUrl) {
    log("No release APK asset found.", "update");
    return false;
  }

  const version = updateInfo.latestApkVersion || "latest";
  const targetPath = path.join(UPDATE_DIR, version, APK_ASSET_NAME);
  log(`Downloading APK ${version}...`, "update");
  await downloadFile(updateInfo.apkAssetUrl, targetPath);
  log(`Downloaded APK update to ${targetPath}.`, "update");
  return installApk("release update", targetPath);
}

async function updateAppFromRelease() {
  if (!updateInfo.appAssetUrl) await checkForReleaseUpdates();
  if (!updateInfo.appAssetUrl) {
    log("No release Windows app asset found.", "update");
    return false;
  }

  const version = updateInfo.latestAppVersion || "latest";
  const zipPath = path.join(UPDATE_DIR, version, APP_ASSET_NAME);
  const extractPath = path.join(UPDATE_DIR, version, "Quest Chat Panel Control-win32-x64");
  log(`Downloading Windows app ${version}...`, "update");
  await downloadFile(updateInfo.appAssetUrl, zipPath);
  fs.rmSync(extractPath, { recursive: true, force: true });

  log("Extracting Windows app update...", "update");
  const result = await run("powershell", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(extractPath)} -Force`
  ]);
  if (result.code !== 0) {
    log(`Extract failed: ${result.stderr || result.stdout}`, "update");
    return false;
  }

  const exePath = path.join(extractPath, "Quest Chat Panel Control.exe");
  if (!fs.existsSync(exePath)) {
    log(`Updated app exe was not found: ${exePath}`, "update");
    return false;
  }

  log(`Launching updated app ${version}.`, "update");
  spawn(exePath, [], {
    cwd: extractPath,
    detached: true,
    stdio: "ignore",
    windowsHide: false
  }).unref();
  app.quit();
  return true;
}

async function adbPath() {
  const fromPath = await run("where", ["adb"], { shell: true });
  const first = fromPath.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (first) return first;

  const sdkAdb = path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools", "adb.exe");
  return fs.existsSync(sdkAdb) ? sdkAdb : "adb";
}

async function listDevices() {
  const adb = await adbPath();
  const result = await run(adb, ["devices"]);
  const devices = result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, state] = line.split(/\s+/);
      return { id, state };
    });

  if (result.code !== 0) {
    log(`ADB device check failed: ${result.stderr || result.stdout}`, "adb");
  }

  if (devices.length) {
    lastDevices = devices;
    lastDeviceSeenAt = Date.now();
  } else if (Date.now() - lastDeviceSeenAt >= DEVICE_STALE_MS) {
    lastDevices = [];
  }

  const visible = visibleDevices();
  setState({ devices: visible });
  return { adb, devices: visible };
}

async function readQuestApkVersion(adb, deviceId) {
  const result = await run(adb, ["-s", deviceId, "shell", "dumpsys", "package", ANDROID_PACKAGE_ID]);
  if (result.code !== 0) {
    log(`Could not read Quest APK version: ${result.stderr || result.stdout}`, "adb");
    return "";
  }

  const wasChecked = questApkVersionChecked;
  const previousVersion = questApkVersion;
  questApkVersionChecked = true;
  const version = result.stdout.match(/versionName=([^\s]+)/)?.[1] || "";
  questApkVersion = version;
  if (version) {
    controlState.lastInstalledApkVersion = version;
    saveControlState();
  }

  if (version && (version !== previousVersion || !wasChecked)) {
    log(`Quest has ${ANDROID_PACKAGE_ID} ${version} installed.`, "adb");
  }
  if (!version && (previousVersion || !wasChecked)) {
    log(`Quest does not have ${ANDROID_PACKAGE_ID} installed.`, "adb");
  }

  refreshCurrentApkVersion();
  return version;
}

async function installApk(reason = "manual", apkPath = APK_PATH) {
  const { adb, devices } = await listDevices();
  const ready = devices.find((device) => device.state === "device");
  if (!ready) {
    log("No authorized Quest detected. Connect USB and accept the debugging prompt in-headset.", "adb");
    return false;
  }

  if (!fs.existsSync(apkPath)) {
    log(`APK missing: ${apkPath}`, "adb");
    return false;
  }

  log(`Installing APK to ${ready.id} (${reason})...`, "adb");
  const result = await run(adb, ["install", "-r", apkPath]);
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter(Boolean)) {
    log(line, "adb");
  }

  if (result.code === 0) {
    installedThisSession = true;
    const stat = fs.statSync(apkPath);
    controlState.lastInstalledApkFingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    controlState.lastInstalledApkVersion = reason === "release update" ? updateInfo.latestApkVersion : localApkVersion();
    questApkVersion = controlState.lastInstalledApkVersion;
    questApkVersionChecked = true;
    refreshCurrentApkVersion();
    controlState.lastInstalledAt = new Date().toISOString();
    saveControlState();
    log("Install complete.", "adb");
    setState();
    return true;
  }

  log(`Install failed with code ${result.code}.`, "adb");
  return false;
}

async function pollAdb() {
  const apk = checkApkForUpdates();
  const { adb, devices } = await listDevices();
  const readyDevice = devices.find((device) => device.state === "device");
  const ready = Boolean(readyDevice);
  const unauthorized = devices.some((device) => device.state === "unauthorized");

  if (unauthorized) {
    log("Quest is connected but unauthorized. Put on the headset and allow USB debugging.", "adb");
  }

  if (readyDevice) {
    await readQuestApkVersion(adb, readyDevice.id);
    setState();
  }

  const apkNeedsInstall = Boolean(apk.fingerprint && apk.fingerprint !== controlState.lastInstalledApkFingerprint);
  if (autoInstall && ready && apkNeedsInstall) {
    await installApk(installedThisSession ? "apk update" : "auto");
  }
}

ipcMain.handle("relay:start", () => startRelay());
ipcMain.handle("relay:stop", () => stopRelay());
ipcMain.handle("adb:install", () => installApk("manual"));
ipcMain.handle("adb:refresh", () => pollAdb());
ipcMain.handle("apk:build", () => buildApk());
ipcMain.handle("update:check", () => checkForReleaseUpdates());
ipcMain.handle("update:app", () => updateAppFromRelease());
ipcMain.handle("update:apk", () => updateApkFromRelease());
ipcMain.handle("config:get", () => readRelayConfig());
ipcMain.handle("config:save", (_event, value) => saveRelayConfig(value));
ipcMain.handle("auto-install:set", (_event, value) => {
  autoInstall = Boolean(value);
  log(`Auto-install ${autoInstall ? "enabled" : "disabled"}.`);
  setState();
});
ipcMain.handle("logs:open", () => shell.showItemInFolder(LOG_PATH));
ipcMain.handle("folder:open", () => shell.openPath(ROOT));
ipcMain.handle("state:get", () => {
  setState({ relayConfig: readRelayConfig() });
});

app.whenReady().then(() => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  createAppMenu();
  createWindow();
  log("Control app started.");
  log(`Log file: ${LOG_PATH}`);
  setState({ relayConfig: readRelayConfig() });
  checkApkForUpdates();
  checkForReleaseUpdates();
  startRelay();
  pollAdb();
  adbPollTimer = setInterval(() => pollAdb().catch((error) => log(error.message, "adb")), POLL_MS);
});

app.on("before-quit", () => {
  clearInterval(adbPollTimer);
  if (relayProcess && !relayProcess.killed) relayProcess.kill();
});

app.on("window-all-closed", () => {
  app.quit();
});
