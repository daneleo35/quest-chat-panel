const logEl = document.querySelector("#log");
const relayStatus = document.querySelector("#relayStatus");
const deviceStatus = document.querySelector("#deviceStatus");
const autoInstall = document.querySelector("#autoInstall");
const appUpdateStatus = document.querySelector("#appUpdateStatus");
const apkStatus = document.querySelector("#apkStatus");
const appVersionLine = document.querySelector("#appVersionLine");
const apkVersionLine = document.querySelector("#apkVersionLine");
const releaseLine = document.querySelector("#releaseLine");
const apkPath = document.querySelector("#apkPath");
const logPath = document.querySelector("#logPath");
const twitchChannels = document.querySelector("#twitchChannels");
const youtubeSources = document.querySelector("#youtubeSources");
const kickChannels = document.querySelector("#kickChannels");

document.querySelector("#startRelay").addEventListener("click", () => window.questControl.startRelay());
document.querySelector("#stopRelay").addEventListener("click", () => window.questControl.stopRelay());
document.querySelector("#install").addEventListener("click", () => window.questControl.install());
document.querySelector("#refresh").addEventListener("click", () => window.questControl.refresh());
document.querySelector("#buildApk").addEventListener("click", () => window.questControl.buildApk());
document.querySelector("#checkUpdates").addEventListener("click", () => window.questControl.checkUpdates());
document.querySelector("#updateApp").addEventListener("click", () => window.questControl.updateApp());
document.querySelector("#updateApk").addEventListener("click", () => window.questControl.updateApk());
document.querySelector("#saveSources").addEventListener("click", async () => {
  await window.questControl.saveConfig({
    twitchChannels: linesFrom(twitchChannels.value),
    youtubeSources: linesFrom(youtubeSources.value),
    kickChannels: linesFrom(kickChannels.value)
  });
});
document.querySelector("#openLogs").addEventListener("click", () => window.questControl.openLogs());
document.querySelector("#openFolder").addEventListener("click", () => window.questControl.openFolder());
autoInstall.addEventListener("change", () => window.questControl.setAutoInstall(autoInstall.checked));

window.questControl.onLog((line) => {
  logEl.textContent += `${line}\n`;
  const lines = logEl.textContent.split("\n");
  if (lines.length > 700) {
    logEl.textContent = lines.slice(lines.length - 700).join("\n");
  }
  logEl.scrollTop = logEl.scrollHeight;
});

window.questControl.onState((state) => {
  relayStatus.textContent = state.relayRunning ? "Running" : "Stopped";
  autoInstall.checked = Boolean(state.autoInstall);
  apkPath.textContent = state.apkPath || "";
  logPath.textContent = state.logPath || "";
  renderUpdates(state);

  const devices = state.devices || [];
  if (!devices.length) {
    deviceStatus.textContent = "No Quest detected";
  } else {
    deviceStatus.textContent = devices.map((device) => `${device.id} (${device.state})`).join(", ");
  }

  if (state.relayConfig) {
    renderConfig(state.relayConfig);
  }
});

function renderUpdates(state) {
  const update = state.updateInfo || {};
  const currentApp = update.currentAppVersion || "-";
  const latestApp = update.latestAppVersion || "-";
  const currentApk = update.currentApkVersion || "-";
  const latestApk = update.latestApkVersion || "-";

  appVersionLine.textContent = `Current: ${currentApp} / Latest: ${latestApp}`;
  apkVersionLine.textContent = `Current: ${currentApk} / Latest: ${latestApk}`;
  releaseLine.textContent = update.detail || "Not checked yet";

  if (update.checking) {
    appUpdateStatus.textContent = "Checking";
  } else {
    appUpdateStatus.textContent = update.appUpdateAvailable ? "Update available" : "App current";
  }

  if (!state.apk?.exists) {
    apkStatus.textContent = "APK missing";
  } else if (update.apkUpdateAvailable) {
    apkStatus.textContent = "Release update";
  } else if (state.apkNeedsInstall) {
    apkStatus.textContent = "New local APK";
  } else {
    apkStatus.textContent = "APK current";
  }
}

function linesFrom(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderConfig(config) {
  if (document.activeElement === twitchChannels || document.activeElement === youtubeSources || document.activeElement === kickChannels) {
    return;
  }
  twitchChannels.value = (config.twitchChannels || []).join("\n");
  youtubeSources.value = (config.youtubeSources || []).join("\n");
  kickChannels.value = (config.kickChannels || []).join("\n");
}

window.questControl.getConfig().then(renderConfig);
window.questControl.getState();
