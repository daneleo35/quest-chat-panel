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
const obsStatus = document.querySelector("#obsStatus");
const obsScene = document.querySelector("#obsScene");
const questHudStatus = document.querySelector("#questHudStatus");
const obsEnabled = document.querySelector("#obsEnabled");
const obsSceneList = document.querySelector("#obsSceneList");
const obsAudioList = document.querySelector("#obsAudioList");

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
}

document.querySelector("#startRelay").addEventListener("click", () => window.questControl.startRelay());
document.querySelector("#stopRelay").addEventListener("click", () => window.questControl.stopRelay());
document.querySelector("#install").addEventListener("click", () => window.questControl.install());
document.querySelector("#refresh").addEventListener("click", () => window.questControl.refresh());
document.querySelector("#buildApk").addEventListener("click", () => window.questControl.buildApk());
document.querySelector("#checkUpdates").addEventListener("click", () => window.questControl.checkUpdates());
document.querySelector("#updateApp").addEventListener("click", () => window.questControl.updateApp());
document.querySelector("#updateApk").addEventListener("click", () => window.questControl.updateApk());
document.querySelector("#refreshObs").addEventListener("click", () => window.questControl.refreshObs());
obsEnabled.addEventListener("change", saveObsConfig);
document.querySelector("#saveSources").addEventListener("click", async () => {
  const current = await window.questControl.getConfig();
  await window.questControl.saveConfig({
    ...current,
    twitchChannels: linesFrom(twitchChannels.value),
    youtubeSources: linesFrom(youtubeSources.value),
    kickChannels: linesFrom(kickChannels.value)
  });
});
document.querySelector("#saveObs").addEventListener("click", async () => {
  await saveObsConfig();
});
async function saveObsConfig() {
  const current = await window.questControl.getConfig();
  await window.questControl.saveConfig({
    ...current,
    obs: {
      enabled: obsEnabled.checked
    }
  });
}
document.querySelector("#openLogs").addEventListener("click", () => window.questControl.openLogs());
document.querySelector("#openFolder").addEventListener("click", () => window.questControl.openFolder());
autoInstall.addEventListener("change", () => window.questControl.setAutoInstall(autoInstall.checked));

function appendLog(line) {
  logEl.textContent += `${line}\n`;
  const lines = logEl.textContent.split("\n");
  if (lines.length > 700) {
    logEl.textContent = lines.slice(lines.length - 700).join("\n");
  }
  requestAnimationFrame(() => {
    logEl.scrollTop = logEl.scrollHeight;
  });
}

window.questControl.onLog((line) => {
  appendLog(line);
});

window.questControl.onState((state) => {
  relayStatus.textContent = state.relayRunning ? "Running" : "Stopped";
  autoInstall.checked = Boolean(state.autoInstall);
  apkPath.textContent = state.apkPath || "";
  logPath.textContent = state.logPath || "";
  renderUpdates(state);
  renderObsStatus(state);

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

function renderObsStatus(state) {
  const obs = state.obs || {};
  obsStatus.textContent = obs.obsConnected
    ? (obs.streaming ? "Live" : "Connected")
    : (obs.obsEnabled ? "Offline" : "Disabled");
  obsScene.textContent = obs.currentScene || "-";
  questHudStatus.textContent = obs.questConnected
    ? `${obs.questDevice || "Quest"} ${obs.questBattery || ""} ${obs.questBatteryStatus || ""}`.trim()
    : "No Quest";
  renderObsScenes(obs);
  renderObsAudio(obs);
}

function renderObsScenes(obs) {
  const scenes = obs.scenes || [];
  obsSceneList.replaceChildren();
  if (!obs.obsConnected) {
    obsSceneList.append(emptyItem("Connect Streamlabs to load scenes."));
    return;
  }
  if (!scenes.length) {
    obsSceneList.append(emptyItem("No scenes found."));
    return;
  }
  for (const sceneItem of scenes) {
    const scene = typeof sceneItem === "string" ? sceneItem : sceneItem.name;
    const row = document.createElement("div");
    row.className = `scene-item ${scene === obs.currentScene ? "active" : ""}`;
    const name = document.createElement("div");
    name.className = "scene-name";
    name.textContent = scene;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = scene === obs.currentScene ? "Live" : "Switch";
    button.disabled = scene === obs.currentScene;
    button.addEventListener("click", () => window.questControl.setObsScene(scene));
    row.append(name, button);
    obsSceneList.append(row);
  }
}

function renderObsAudio(obs) {
  const inputs = obs.audioInputs || [];
  obsAudioList.replaceChildren();
  if (!obs.obsConnected) {
    obsAudioList.append(emptyItem("Connect Streamlabs to load audio inputs."));
    return;
  }
  if (!inputs.length) {
    obsAudioList.append(emptyItem("No controllable audio inputs found."));
    return;
  }
  for (const input of inputs) {
    const row = document.createElement("div");
    row.className = "audio-item";
    const name = document.createElement("div");
    name.className = "audio-name";
    name.textContent = input.name;

    const controls = document.createElement("div");
    controls.className = "audio-controls";
    const mute = document.createElement("button");
    mute.type = "button";
    mute.textContent = input.muted ? "Unmute" : "Mute";
    mute.addEventListener("click", () => window.questControl.setObsInputMute(input.name, !input.muted));

    const volume = document.createElement("input");
    volume.type = "range";
    volume.min = "0";
    volume.max = "100";
    volume.step = "1";
    volume.value = String(Math.round(input.volumeDb || 0));
    volume.addEventListener("change", () => window.questControl.setObsInputVolume(input.name, Number(volume.value)));

    const readout = document.createElement("code");
    readout.textContent = `${Math.round(input.volumeDb || 0)}%`;
    volume.addEventListener("input", () => {
      readout.textContent = `${volume.value}%`;
    });

    controls.append(mute, volume, readout);
    row.append(name, controls);
    obsAudioList.append(row);
  }
}

function emptyItem(text) {
  const item = document.createElement("div");
  item.className = "empty-list";
  item.textContent = text;
  return item;
}

function activateTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.classList.toggle("active", panel.id === `tab-${name}`);
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
  renderObsConfig(config.obs || {});
}

function renderObsConfig(obs) {
  if (document.activeElement === obsEnabled) {
    return;
  }
  obsEnabled.checked = Boolean(obs.enabled);
}

window.questControl.getConfig().then((config) => {
  renderConfig(config);
  renderObsConfig(config.obs || {});
});
window.questControl.getState();
