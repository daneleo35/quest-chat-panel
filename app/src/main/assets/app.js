const MODE_COMPANION = "companion";
const MODE_STREAMCHAT = "streamchat";
const STORAGE_KEY = "questChatPanel.settings";

const messagesEl = document.querySelector("#messages");
const sourcesEl = document.querySelector("#sources");
const statusEl = document.querySelector("#status");
const form = document.querySelector("#settingsForm");
const socketInput = document.querySelector("#socketUrl");
const connectButton = document.querySelector("#connectButton");
const clearButton = document.querySelector("#clearButton");
const compactToggle = document.querySelector("#compactToggle");
const obsToggle = document.querySelector("#obsToggle");
const settingsToggle = document.querySelector("#settingsToggle");
const settingsPanel = document.querySelector("#settingsPanel");
const closeSettings = document.querySelector("#closeSettings");
const modeSelect = document.querySelector("#modeSelect");
const relayUrlField = document.querySelector("#relayUrlField");
const sourcesFieldset = document.querySelector("#sourcesFieldset");
const twitchChannelsInput = document.querySelector("#twitchChannels");
const youtubeSourcesInput = document.querySelector("#youtubeSources");
const kickChannelsInput = document.querySelector("#kickChannels");
const saveSettingsButton = document.querySelector("#saveSettings");
const refreshObsButton = document.querySelector("#refreshObsButton");
const closeObsControls = document.querySelector("#closeObsControls");
const hud = document.querySelector("#hud");
const hudObs = document.querySelector("#hudObs");
const hudScene = document.querySelector("#hudScene");
const hudUptime = document.querySelector("#hudUptime");
const hudQuest = document.querySelector("#hudQuest");
const obsControls = document.querySelector("#obsControls");
const sceneControls = document.querySelector("#sceneControls");
const audioControls = document.querySelector("#audioControls");

const colors = ["#5fd0a5", "#f7c873", "#8fb8ff", "#ff9ca8", "#bba3ff", "#7bdff2"];
const sourceState = new Map();
const directCleanups = [];
const displayedMessages = new Set();

let settings = loadSettings();
let hudState = { scenes: [], audioInputs: [] };
let socket;
let reconnectTimer = 0;
let manualDisconnect = false;
let obsPanelOpen = false;
let controlCounter = 0;
let questHeartbeatTimer = 0;
const pendingControls = new Map();

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return normalizeSettings(stored);
  } catch {
    return normalizeSettings({});
  }
}

function normalizeSettings(value) {
  return {
    mode: value.mode === MODE_STREAMCHAT ? MODE_STREAMCHAT : MODE_COMPANION,
    relayUrl: String(value.relayUrl || localStorage.getItem("relayUrl") || ""),
    twitchChannels: normalizeList(value.twitchChannels),
    youtubeSources: normalizeList(value.youtubeSources),
    kickChannels: normalizeList(value.kickChannels),
    compact: String(localStorage.getItem("compact")) === "true"
  };
}

function persistSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    mode: settings.mode,
    relayUrl: settings.relayUrl,
    twitchChannels: settings.twitchChannels,
    youtubeSources: settings.youtubeSources,
    kickChannels: settings.kickChannels
  }));
  localStorage.setItem("relayUrl", settings.relayUrl);
  localStorage.setItem("compact", String(document.body.classList.contains("compact")));
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

function setStatus(text) {
  statusEl.textContent = text;
}

function setModeClass() {
  document.body.classList.toggle("mode-companion", settings.mode === MODE_COMPANION);
  document.body.classList.toggle("mode-streamchat", settings.mode === MODE_STREAMCHAT);
}

function syncModeVisibility() {
  const companion = settings.mode === MODE_COMPANION;
  relayUrlField.hidden = !companion;
  sourcesFieldset.hidden = companion;
  hud.hidden = !companion;
  obsControls.hidden = !companion || !obsPanelOpen;
  form.hidden = !companion;
  obsToggle.hidden = !companion;
}

function syncSettingsForm() {
  modeSelect.value = settings.mode;
  socketInput.value = settings.relayUrl;
  twitchChannelsInput.value = settings.twitchChannels.join("\n");
  youtubeSourcesInput.value = settings.youtubeSources.join("\n");
  kickChannelsInput.value = settings.kickChannels.join("\n");
  syncModeVisibility();
}

function toggleSettings(open) {
  settingsPanel.hidden = !open;
}

function toggleObsControls(open) {
  obsPanelOpen = Boolean(open) && settings.mode === MODE_COMPANION;
  syncModeVisibility();
}

function colorFor(name) {
  let total = 0;
  for (const char of name) total += char.charCodeAt(0);
  return colors[total % colors.length];
}

function updateSource(source, state, detail) {
  sourceState.set(source, { source, state, detail });
  renderSources();
}

function renderSources() {
  sourcesEl.replaceChildren();
  if (!sourceState.size) {
    const item = document.createElement("div");
    item.className = "source";
    item.textContent = settings.mode === MODE_STREAMCHAT ? "No direct sources yet" : "No sources yet";
    sourcesEl.append(item);
    return;
  }

  for (const source of sourceState.values()) {
    const item = document.createElement("div");
    item.className = `source ${source.state || ""}`;
    item.textContent = `${source.source}: ${source.detail || source.state || ""}`;
    sourcesEl.append(item);
  }
}

function pushTextPart(parts, text) {
  if (!text) return;
  const previous = parts[parts.length - 1];
  if (previous && previous.type === "text") {
    previous.text += text;
    return;
  }
  parts.push({ type: "text", text });
}

function flattenParts(parts) {
  return (parts || [])
    .map((part) => part.type === "emote" ? (part.alt || "") : (part.text || ""))
    .join("");
}

function splitKickParts(text) {
  const value = String(text || "");
  const parts = [];
  const pattern = /\[emote:(\d+):([^\]]+)\]/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) {
      pushTextPart(parts, value.slice(cursor, match.index));
    }
    parts.push({
      type: "emote",
      alt: match[2],
      url: `https://files.kick.com/emotes/${match[1]}/fullsize`
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) {
    pushTextPart(parts, value.slice(cursor));
  }
  return parts.length ? parts : [{ type: "text", text: value }];
}

function renderMessageBody(container, parts, fallbackText) {
  container.replaceChildren();
  const messageParts = Array.isArray(parts) && parts.length ? parts : [{ type: "text", text: fallbackText || "" }];
  for (const part of messageParts) {
    if (part.type === "emote" && part.url) {
      const image = document.createElement("img");
      image.className = "emote";
      image.src = part.url;
      image.alt = part.alt || "";
      image.loading = "lazy";
      image.addEventListener("load", () => scrollMessagesToBottom());
      container.append(image);
      continue;
    }
    if (part.text) {
      const span = document.createElement("span");
      span.textContent = part.text;
      container.append(span);
    }
  }
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48;
}

function scrollMessagesToBottom(force = true) {
  if (!force && !isNearBottom()) return;
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function addMessage({ id, platform = "relay", author = "Relay", user, text = "", parts, timestamp, time }) {
  const displayName = author || user || "Relay";
  const plainText = String(text || flattenParts(parts)).trim();
  if (!plainText && !(parts || []).length) return;
  if (id && displayedMessages.has(id)) return;
  if (id) displayedMessages.add(id);

  const item = document.createElement("article");
  item.className = "message";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.style.background = colorFor(displayName);
  avatar.textContent = displayName.slice(0, 1).toUpperCase();

  const body = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "meta";

  const badge = document.createElement("div");
  badge.className = `platform ${platform}`;
  badge.textContent = platform;

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = displayName;

  const stamp = document.createElement("time");
  stamp.className = "time";
  stamp.textContent = new Date(timestamp || time || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const message = document.createElement("div");
  message.className = "text";
  renderMessageBody(message, parts, plainText);

  meta.append(badge, name, stamp);
  body.append(meta, message);
  item.append(avatar, body);
  messagesEl.append(item);

  while (messagesEl.children.length > 140) messagesEl.firstElementChild.remove();
  while (displayedMessages.size > 220) {
    const first = displayedMessages.values().next();
    if (first.done) break;
    displayedMessages.delete(first.value);
  }
  scrollMessagesToBottom();
}

function renderHud(event) {
  hudState = {
    ...hudState,
    ...event,
    scenes: Array.isArray(event.scenes) ? event.scenes : (hudState.scenes || []),
    audioInputs: Array.isArray(event.audioInputs) ? event.audioInputs : (hudState.audioInputs || [])
  };
  hudObs.textContent = event.obsConnected ? (event.streaming ? "Live" : "Ready") : "Offline";
  hudScene.textContent = event.currentScene || "-";
  hudUptime.textContent = event.streamUptime || "00:00:00";
  hudQuest.textContent = event.questConnected
    ? `${event.questBattery || "?"} ${event.questBatteryStatus || ""}`.trim()
    : "Offline";
  renderObsControls();
}

function renderObsControls() {
  const connected = Boolean(hudState.obsConnected);
  obsControls.classList.toggle("offline", !connected);
  sceneControls.replaceChildren();
  audioControls.replaceChildren();

  if (!connected) {
    sceneControls.append(emptyState("Streamlabs offline"));
    audioControls.append(emptyState("Connect Streamlabs on the PC"));
    return;
  }

  for (const sceneItem of hudState.scenes || []) {
    const scene = typeof sceneItem === "string" ? { name: sceneItem } : sceneItem;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `scene-chip ${scene.name === hudState.currentScene ? "active" : ""}`;
    button.textContent = scene.name || "Scene";
    button.disabled = !scene.name || scene.name === hudState.currentScene;
    button.addEventListener("click", async () => {
      try {
        await sendObsControl("obs:scene", { sceneName: scene.name }, "/control/obs/scene");
        hudState.currentScene = scene.name;
        setStatus(`Switched to ${scene.name}`);
        renderObsControls();
        refreshObsSnapshot();
      } catch (error) {
        setStatus(error.message || "Scene switch failed");
      }
    });
    sceneControls.append(button);
  }

  if (!sceneControls.children.length) {
    sceneControls.append(emptyState("No scenes found"));
  }

  for (const input of hudState.audioInputs || []) {
    const card = document.createElement("section");
    card.className = "audio-card";

    const top = document.createElement("div");
    top.className = "audio-top";
    const name = document.createElement("div");
    name.className = "audio-name";
    name.textContent = input.name || "Audio Source";
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = `mute-button ${input.muted ? "muted" : ""}`;
    mute.textContent = input.muted ? "Unmute" : "Mute";
    mute.addEventListener("click", async () => {
      try {
        await sendObsControl("obs:mute", { inputName: input.name, muted: !input.muted }, "/control/obs/mute");
        input.muted = !input.muted;
        setStatus(`${input.muted ? "Muted" : "Unmuted"} ${input.name}`);
        renderObsControls();
        refreshObsSnapshot();
      } catch (error) {
        setStatus(error.message || "Mute toggle failed");
      }
    });
    top.append(name, mute);

    const sliderRow = document.createElement("div");
    sliderRow.className = "slider-row";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(input.volumeDb || 0));
    const readout = document.createElement("strong");
    readout.className = "audio-readout";
    readout.textContent = `${slider.value}%`;

    slider.addEventListener("input", () => {
      input.volumeDb = Number(slider.value);
      readout.textContent = `${slider.value}%`;
    });
    slider.addEventListener("change", async () => {
      try {
        await sendObsControl("obs:volume", { inputName: input.name, volume: Number(slider.value) }, "/control/obs/volume");
        setStatus(`Set ${input.name} to ${slider.value}%`);
        refreshObsSnapshot();
      } catch (error) {
        setStatus(error.message || "Volume change failed");
      }
    });
    sliderRow.append(slider, readout);

    card.append(top, sliderRow);
    audioControls.append(card);
  }

  if (!audioControls.children.length) {
    audioControls.append(emptyState("No audio inputs found"));
  }
}

function emptyState(text) {
  const item = document.createElement("div");
  item.className = "empty-state";
  item.textContent = text;
  return item;
}

function disconnectRelay() {
  window.clearTimeout(reconnectTimer);
  stopQuestHeartbeat();
  if (socket) {
    manualDisconnect = true;
    socket.close();
  }
  socket = null;
}

function scheduleReconnect() {
  window.clearTimeout(reconnectTimer);
  if (settings.mode !== MODE_COMPANION || !settings.relayUrl) return;
  reconnectTimer = window.setTimeout(() => connectRelay(settings.relayUrl, { isRetry: true }), 2500);
}

function readQuestDeviceStatus() {
  try {
    if (!window.QuestBridge || typeof window.QuestBridge.getDeviceStatus !== "function") {
      return null;
    }
    const raw = window.QuestBridge.getDeviceStatus();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      connected: parsed.connected !== false,
      questDevice: String(parsed.questDevice || parsed.device || "Quest"),
      questBattery: String(parsed.questBattery || ""),
      questBatteryStatus: String(parsed.questBatteryStatus || ""),
      timestamp: Number(parsed.timestamp || Date.now())
    };
  } catch {
    return null;
  }
}

function relayHttpUrl() {
  const raw = settings.relayUrl.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

async function postControl(path, payload) {
  const base = relayHttpUrl();
  if (!base) {
    throw new Error("Relay address unavailable");
  }
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed (${response.status})`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function getControl(path) {
  const base = relayHttpUrl();
  if (!base) {
    throw new Error("Relay address unavailable");
  }
  const response = await fetch(`${base}${path}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed (${response.status})`);
  }
  return response.json();
}

async function postQuestHeartbeat() {
  if (settings.mode !== MODE_COMPANION) return;
  const base = relayHttpUrl();
  if (!base) return;
  const status = readQuestDeviceStatus();
  if (!status) return;
  try {
    await fetch(`${base}/quest-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(status)
    });
  } catch {
  }
}

function stopQuestHeartbeat() {
  if (questHeartbeatTimer) {
    window.clearInterval(questHeartbeatTimer);
    questHeartbeatTimer = 0;
  }
}

function startQuestHeartbeat() {
  stopQuestHeartbeat();
  if (settings.mode !== MODE_COMPANION || !settings.relayUrl) return;
  postQuestHeartbeat();
  questHeartbeatTimer = window.setInterval(postQuestHeartbeat, 8000);
}

function sendRelayControl(action, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Relay websocket is not connected"));
  }

  const requestId = `ctrl-${Date.now()}-${controlCounter++}`;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingControls.delete(requestId);
      reject(new Error("Control request timed out"));
    }, 1500);

    pendingControls.set(requestId, { resolve, reject, timeout });
    socket.send(JSON.stringify({
      type: "control",
      action,
      requestId,
      ...payload
    }));
  });
}

async function sendObsControl(action, payload, fallbackPath, method = "POST") {
  try {
    return await sendRelayControl(action, payload);
  } catch (error) {
    if (!settings.relayUrl) throw error;
    if (method === "GET") {
      return getControl(fallbackPath);
    }
    return postControl(fallbackPath, payload);
  }
}

async function refreshObsSnapshot() {
  if (settings.mode !== MODE_COMPANION) return;
  try {
    const result = await sendObsControl("obs:snapshot", {}, "/control/obs/snapshot", "GET");
    const snapshot = result.snapshot || result || {};
    renderHud({
      ...hudState,
      ...snapshot,
      streamUptime: hudState.streamUptime,
      questConnected: hudState.questConnected,
      questBattery: hudState.questBattery,
      questBatteryStatus: hudState.questBatteryStatus,
      streaming: hudState.streaming
    });
  } catch {
  }
}

function handleRelayEvent(event) {
  if (event.type === "hud") {
    renderHud(event);
    return;
  }

  if (event.type === "control-result") {
    const pending = pendingControls.get(event.requestId || "");
    if (!pending) return;
    pendingControls.delete(event.requestId || "");
    window.clearTimeout(pending.timeout);
    if (event.ok) {
      pending.resolve(event);
    } else {
      pending.reject(new Error(event.error || "Control request failed"));
    }
    return;
  }

  if (event.type === "status") {
    if (event.source === "Relay") {
      setStatus(event.state === "connected" ? "Connected to relay" : (event.detail || event.state));
      return;
    }
    updateSource(event.source, event.state, event.detail || event.state);
    setStatus(`${event.source}: ${event.detail || event.state}`);
    return;
  }

  if (event.type === "reset") {
    messagesEl.replaceChildren();
    displayedMessages.clear();
    return;
  }

  if (event.type === "message") {
    addMessage(event);
  }
}

function connectRelay(url, options = {}) {
  if (!url) return;
  disconnectRelay();
  settings.relayUrl = url;
  persistSettings();
  syncSettingsForm();
  setStatus(options.isRetry ? "Reconnecting..." : "Connecting...");
  connectButton.disabled = true;
  manualDisconnect = false;

  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    setStatus("Connected to relay");
    connectButton.disabled = false;
    messagesEl.focus();
    startQuestHeartbeat();
    refreshObsSnapshot();
  });
  socket.addEventListener("message", (message) => {
    try {
      handleRelayEvent(JSON.parse(message.data));
    } catch {
    }
  });
  socket.addEventListener("close", () => {
    stopQuestHeartbeat();
    for (const [requestId, pending] of pendingControls.entries()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("Relay disconnected"));
      pendingControls.delete(requestId);
    }
    if (manualDisconnect) {
      manualDisconnect = false;
      setStatus("Disconnected");
      connectButton.disabled = false;
      return;
    }
    setStatus("Disconnected, retrying");
    connectButton.disabled = false;
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    setStatus("Relay connection error");
    connectButton.disabled = false;
  });
}

function stopDirectConnectors() {
  while (directCleanups.length) {
    const cleanup = directCleanups.pop();
    try {
      cleanup();
    } catch {
    }
  }
}

function stopAllChat() {
  disconnectRelay();
  stopDirectConnectors();
}

function parseTags(input) {
  const tags = {};
  for (const pair of String(input || "").split(";")) {
    if (!pair) continue;
    const [rawKey, rawValue = ""] = pair.split("=");
    tags[rawKey] = rawValue
      .replace(/\\s/g, " ")
      .replace(/\\:/g, ";")
      .replace(/\\\\/g, "\\")
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n");
  }
  if (tags.emotes) {
    const emotes = {};
    for (const group of tags.emotes.split("/")) {
      const [id, positions] = group.split(":");
      if (!id || !positions) continue;
      emotes[id] = positions.split(",").map((range) => range.split("-").map((value) => Number(value)));
    }
    tags.emotes = emotes;
  } else {
    tags.emotes = null;
  }
  return tags;
}

function buildTwitchParts(text, emotes) {
  const value = String(text || "");
  if (!emotes || typeof emotes !== "object") {
    return [{ type: "text", text: value }];
  }
  const ranges = [];
  for (const [id, matches] of Object.entries(emotes)) {
    for (const match of matches || []) {
      if (!Array.isArray(match) || match.length < 2) continue;
      ranges.push({ id, start: Number(match[0]), end: Number(match[1]) });
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  if (!ranges.length) {
    return [{ type: "text", text: value }];
  }

  const parts = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      pushTextPart(parts, value.slice(cursor, range.start));
    }
    const alt = value.slice(range.start, range.end + 1);
    parts.push({
      type: "emote",
      alt,
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${range.id}/default/dark/2.0`
    });
    cursor = range.end + 1;
  }
  if (cursor < value.length) {
    pushTextPart(parts, value.slice(cursor));
  }
  return parts.length ? parts : [{ type: "text", text: value }];
}

function startTwitchConnector(channels) {
  let stopped = false;
  let ws;
  let retryTimer = 0;
  const nick = `justinfan${Math.floor(Math.random() * 99999)}`;

  function schedule() {
    window.clearTimeout(retryTimer);
    if (stopped || settings.mode !== MODE_STREAMCHAT) return;
    retryTimer = window.setTimeout(connect, 5000);
  }

  function connect() {
    if (stopped || !channels.length) return;
    updateSource("Twitch", "connecting", channels.join(", "));
    ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    ws.addEventListener("open", () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      ws.send("PASS SCHMOOPIIE\r\n");
      ws.send(`NICK ${nick}\r\n`);
      ws.send(`JOIN ${channels.map((channel) => `#${channel.toLowerCase()}`).join(",")}\r\n`);
    });
    ws.addEventListener("message", (event) => {
      for (const line of String(event.data || "").split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) {
          ws.send(`${line.replace("PING", "PONG")}\r\n`);
          continue;
        }

        const match = line.match(/^(?:@([^ ]+) )?(?::([^ ]+) )?(\S+)(?: (.+))?$/);
        if (!match) continue;
        const tags = parseTags(match[1]);
        const command = match[3];
        const rest = match[4] || "";

        if (command === "001") {
          updateSource("Twitch", "connected", channels.join(", "));
          continue;
        }

        if (command !== "PRIVMSG") continue;

        const divider = rest.indexOf(" :");
        if (divider === -1) continue;
        const channel = rest.slice(0, divider).trim().replace(/^#/, "");
        const text = rest.slice(divider + 2);
        const parts = buildTwitchParts(text, tags.emotes);
        addMessage({
          id: `${platformKey("twitch", channel, tags.id || `${Date.now()}`)}`,
          platform: "twitch",
          channel,
          author: tags["display-name"] || tags.login || nick,
          text,
          parts,
          timestamp: tags["tmi-sent-ts"] ? Number(tags["tmi-sent-ts"]) : Date.now()
        });
      }
    });
    ws.addEventListener("close", () => {
      updateSource("Twitch", "disconnected", channels.join(", "));
      schedule();
    });
    ws.addEventListener("error", () => {
      updateSource("Twitch", "error", channels.join(", "));
    });
  }

  connect();
  return () => {
    stopped = true;
    window.clearTimeout(retryTimer);
    ws?.close();
  };
}

function platformKey(platform, channel, id) {
  return `${platform}:${channel}:${id}`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "text/html,application/json",
      "x-requested-with": "QuestChatPanel"
    }
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
}

function parseThumbnailToImageItem(data, alt) {
  const items = Array.isArray(data) ? data : [];
  const thumbnail = items[items.length - 1];
  return thumbnail ? { url: thumbnail.url, alt } : { url: "", alt: "" };
}

function parseYouTubeMessages(runs) {
  return (runs || []).map((run) => {
    if ("text" in run) {
      return { type: "text", text: run.text };
    }
    const thumbnail = run?.emoji?.image?.thumbnails?.[0];
    const shortcut = run?.emoji?.shortcuts?.[0] || "";
    return {
      type: "emote",
      alt: shortcut || run?.emoji?.emojiId || "",
      url: thumbnail?.url || ""
    };
  });
}

function parseYouTubeAction(action) {
  const item = action?.addChatItemAction?.item;
  return item?.liveChatTextMessageRenderer ||
    item?.liveChatPaidMessageRenderer ||
    item?.liveChatPaidStickerRenderer ||
    item?.liveChatMembershipItemRenderer ||
    null;
}

function parseYouTubeChatData(data) {
  const continuationRoot = data?.continuationContents?.liveChatContinuation;
  const actions = continuationRoot?.actions || [];
  const continuations = continuationRoot?.continuations || [];
  const next = continuations[0]?.invalidationContinuationData?.continuation ||
    continuations[0]?.timedContinuationData?.continuation ||
    "";

  const messages = actions.map((action) => {
    const renderer = parseYouTubeAction(action);
    if (!renderer) return null;

    const runs = renderer.message?.runs || renderer.headerSubtext?.runs || [];
    const parts = parseYouTubeMessages(runs);
    const authorName = renderer.authorName?.simpleText || "";
    return {
      id: renderer.id,
      author: authorName || "viewer",
      timestamp: Number(renderer.timestampUsec || 0) / 1000 || Date.now(),
      parts,
      text: flattenParts(parts)
    };
  }).filter(Boolean);

  return { messages, continuation: next };
}

function parseYouTubeOptions(html) {
  const liveId = html.match(/<link rel="canonical" href="https:\/\/www.youtube.com\/watch\?v=(.+?)">/)?.[1];
  if (!liveId) throw new Error("Live stream not found");
  if (/['"]isReplay['"]:\s*(true)/.test(html)) throw new Error(`${liveId} is finished live`);
  const apiKey = html.match(/['"]INNERTUBE_API_KEY['"]:\s*['"](.+?)['"]/)?.[1];
  const clientVersion = html.match(/['"]clientVersion['"]:\s*['"]([\d.]+?)['"]/)?.[1];
  const continuation = html.match(/['"]continuation['"]:\s*['"](.+?)['"]/)?.[1];
  if (!apiKey || !clientVersion || !continuation) {
    throw new Error("Could not read YouTube live chat metadata");
  }
  return { liveId, apiKey, clientVersion, continuation };
}

async function resolveYouTubeChannelId(source) {
  const url = source.startsWith("http")
    ? source
    : `https://www.youtube.com/${source.startsWith("@") ? source : `@${source}`}`;
  const html = await fetchText(url);
  const match =
    html.match(/"channelId":"(UC[\w-]+)"/) ||
    html.match(/"externalId":"(UC[\w-]+)"/) ||
    html.match(/"browseId":"(UC[\w-]+)"/) ||
    html.match(/<meta itemprop="channelId" content="(UC[\w-]+)">/);
  if (!match) throw new Error(`Could not resolve YouTube channel id from ${source}`);
  return match[1];
}

function extractYouTubeVideoId(value) {
  if (/^[\w-]{11}$/.test(value) && !value.startsWith("@")) return value;
  try {
    const url = new URL(value);
    if (url.hostname.includes("youtu.be")) return url.pathname.split("/").filter(Boolean)[0];
    if (url.hostname.includes("youtube.com")) {
      const watchId = url.searchParams.get("v");
      if (watchId) return watchId;
      const parts = url.pathname.split("/").filter(Boolean);
      if ((parts[0] === "live" || parts[0] === "embed") && /^[\w-]{11}$/.test(parts[1] || "")) return parts[1];
    }
  } catch {
  }
  return "";
}

async function fetchYouTubeOptions(source) {
  const value = String(source || "").trim();
  if (!value) throw new Error("Missing YouTube source");
  const videoId = extractYouTubeVideoId(value);
  let url = "";
  if (videoId) {
    url = `https://www.youtube.com/watch?v=${videoId}`;
  } else if (/^UC[\w-]{20,}$/i.test(value)) {
    url = `https://www.youtube.com/channel/${value}/live`;
  } else {
    const channelId = value.startsWith("@") || !value.startsWith("http")
      ? await resolveYouTubeChannelId(value)
      : "";
    url = channelId ? `https://www.youtube.com/channel/${channelId}/live` : `${value.replace(/\/$/, "")}/live`;
  }
  return parseYouTubeOptions(await fetchText(url));
}

async function fetchYouTubeChat(options) {
  const response = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${encodeURIComponent(options.apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: { client: { clientVersion: options.clientVersion, clientName: "WEB" } },
      continuation: options.continuation
    })
  });
  if (!response.ok) {
    throw new Error(`YouTube chat returned ${response.status}`);
  }
  return parseYouTubeChatData(await response.json());
}

function startYouTubeConnector(source) {
  let stopped = false;
  let timer = 0;
  const seen = new Set();
  const label = `YouTube ${String(source).slice(0, 24)}`;
  const state = { options: null };

  function schedule(delay = 5000) {
    window.clearTimeout(timer);
    if (stopped || settings.mode !== MODE_STREAMCHAT) return;
    timer = window.setTimeout(connect, delay);
  }

  async function poll() {
    if (stopped || !state.options) return;
    try {
      const result = await fetchYouTubeChat(state.options);
      state.options.continuation = result.continuation;
      updateSource(label, "connected", state.options.liveId);
      for (const message of result.messages) {
        if (!message.id || seen.has(message.id)) continue;
        seen.add(message.id);
        addMessage({
          id: platformKey("youtube", state.options.liveId, message.id),
          platform: "youtube",
          author: message.author,
          text: message.text,
          parts: message.parts,
          timestamp: message.timestamp
        });
      }
      schedule(1500);
    } catch (error) {
      updateSource(label, "error", error.message || "YouTube poll failed");
      schedule(5000);
    }
  }

  async function connect() {
    if (stopped) return;
    updateSource(label, "connecting", source);
    try {
      state.options = await fetchYouTubeOptions(source);
      updateSource(label, "connected", state.options.liveId);
      poll();
    } catch (error) {
      updateSource(label, "error", error.message || "YouTube setup failed");
      schedule(8000);
    }
  }

  connect();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

function parseKickMessage(data) {
  if (!data) return undefined;
  const sender = data.sender || data.user || data.author || {};
  const text = data.content || data.message || data.text;
  if (!text) return undefined;
  return {
    id: data.id || data.uuid || `${Date.now()}`,
    author: sender.username || sender.slug || sender.name || "viewer",
    text: String(text)
  };
}

async function fetchKickChatroomId(slug) {
  const response = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    headers: {
      "accept": "application/json",
      "referer": `https://kick.com/${encodeURIComponent(slug)}`
    }
  });
  if (!response.ok) {
    throw new Error(`Kick channel ${slug} returned ${response.status}`);
  }
  const data = await response.json();
  const roomId = data?.chatroom?.id || data?.chatroom_id;
  if (!roomId) throw new Error(`Kick channel ${slug} did not expose a chatroom id`);
  return roomId;
}

function startKickConnector(slug) {
  let stopped = false;
  let ws;
  let retryTimer = 0;
  const label = `Kick ${slug}`;

  function schedule() {
    window.clearTimeout(retryTimer);
    if (stopped || settings.mode !== MODE_STREAMCHAT) return;
    retryTimer = window.setTimeout(connect, 5000);
  }

  async function connect() {
    if (stopped) return;
    updateSource(label, "connecting", slug);
    let roomId;
    try {
      roomId = await fetchKickChatroomId(slug);
    } catch (error) {
      updateSource(label, "error", error.message || slug);
      schedule();
      return;
    }

    ws = new WebSocket("wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false");
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        event: "pusher:subscribe",
        data: { auth: "", channel: `chatrooms.${roomId}.v2` }
      }));
    });
    ws.addEventListener("message", (event) => {
      const payload = safeJson(event.data);
      if (!payload) return;
      if (payload.event === "pusher:connection_established") {
        updateSource(label, "connected", slug);
        return;
      }
      const body = safeJson(payload.data);
      const message = parseKickMessage(body);
      if (!message) return;
      addMessage({
        id: platformKey("kick", slug, message.id),
        platform: "kick",
        author: message.author,
        text: message.text,
        parts: splitKickParts(message.text),
        timestamp: Date.now()
      });
    });
    ws.addEventListener("close", () => {
      updateSource(label, "disconnected", slug);
      schedule();
    });
    ws.addEventListener("error", () => {
      updateSource(label, "error", slug);
    });
  }

  connect();
  return () => {
    stopped = true;
    window.clearTimeout(retryTimer);
    ws?.close();
  };
}

function safeJson(value) {
  if (!value) return undefined;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function startDirectMode() {
  sourceState.clear();
  renderSources();
  setStatus("Connecting directly to chat sources");
  disconnectRelay();
  stopDirectConnectors();

  if (settings.twitchChannels.length) {
    directCleanups.push(startTwitchConnector(settings.twitchChannels));
  }
  for (const source of settings.youtubeSources) {
    directCleanups.push(startYouTubeConnector(source));
  }
  for (const channel of settings.kickChannels) {
    directCleanups.push(startKickConnector(channel));
  }

  if (!directCleanups.length) {
    setStatus("Add Twitch, YouTube, or Kick sources in settings");
  }
}

function startCompanionMode() {
  sourceState.clear();
  renderSources();
  stopDirectConnectors();
  if (settings.relayUrl) {
    startQuestHeartbeat();
    connectRelay(settings.relayUrl, { isRetry: true });
  } else {
    setStatus("Searching for relay on your LAN");
  }
}

function applyMode() {
  setModeClass();
  if (settings.mode !== MODE_COMPANION) {
    obsPanelOpen = false;
  }
  syncSettingsForm();
  if (settings.mode === MODE_COMPANION) {
    startCompanionMode();
  } else {
    startDirectMode();
  }
}

window.autoConnectRelay = (url) => {
  if (!url || settings.mode !== MODE_COMPANION) return;
  settings.relayUrl = url;
  persistSettings();
  syncSettingsForm();
  setStatus("Found relay");
  connectRelay(url);
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (settings.mode === MODE_COMPANION && settings.relayUrl) {
    persistSettings();
    connectRelay(settings.relayUrl);
  }
});

clearButton.addEventListener("click", () => {
  messagesEl.replaceChildren();
  displayedMessages.clear();
});
refreshObsButton.addEventListener("click", () => {
  refreshObsSnapshot();
});
compactToggle.addEventListener("click", () => {
  const compact = !document.body.classList.contains("compact");
  document.body.classList.toggle("compact", compact);
  localStorage.setItem("compact", String(compact));
});
obsToggle.addEventListener("click", () => toggleObsControls(!obsPanelOpen));
settingsToggle.addEventListener("click", () => toggleSettings(true));
closeSettings.addEventListener("click", () => toggleSettings(false));
closeObsControls.addEventListener("click", () => toggleObsControls(false));
messagesEl.addEventListener("pointerdown", () => messagesEl.focus());
messagesEl.addEventListener("wheel", () => messagesEl.focus(), { passive: true });
document.addEventListener("keydown", (event) => {
  if (!settingsPanel.hidden || !obsControls.hidden) return;

  const page = messagesEl.clientHeight * 0.9;
  if (event.key === "ArrowDown") {
    messagesEl.scrollBy({ top: event.shiftKey ? page : 120, behavior: "smooth" });
    event.preventDefault();
  } else if (event.key === "ArrowUp") {
    messagesEl.scrollBy({ top: event.shiftKey ? -page : -120, behavior: "smooth" });
    event.preventDefault();
  } else if (event.key === "PageDown" || event.key === " ") {
    messagesEl.scrollBy({ top: page, behavior: "smooth" });
    event.preventDefault();
  } else if (event.key === "PageUp") {
    messagesEl.scrollBy({ top: -page, behavior: "smooth" });
    event.preventDefault();
  } else if (event.key === "Home") {
    messagesEl.scrollTo({ top: 0, behavior: "smooth" });
    event.preventDefault();
  } else if (event.key === "End") {
    scrollMessagesToBottom();
    event.preventDefault();
  }
});
modeSelect.addEventListener("change", () => {
  settings.mode = modeSelect.value === MODE_STREAMCHAT ? MODE_STREAMCHAT : MODE_COMPANION;
  syncSettingsForm();
});
saveSettingsButton.addEventListener("click", () => {
  settings.mode = modeSelect.value === MODE_STREAMCHAT ? MODE_STREAMCHAT : MODE_COMPANION;
  settings.relayUrl = socketInput.value.trim();
  settings.twitchChannels = normalizeList(twitchChannelsInput.value);
  settings.youtubeSources = normalizeList(youtubeSourcesInput.value);
  settings.kickChannels = normalizeList(kickChannelsInput.value);
  persistSettings();
  toggleSettings(false);
  applyMode();
});

document.body.classList.toggle("compact", settings.compact);
renderSources();
renderObsControls();
setModeClass();
syncSettingsForm();
applyMode();
messagesEl.focus();
