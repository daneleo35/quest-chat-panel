const fs = require("fs");
const dgram = require("dgram");
const http = require("http");
const os = require("os");
const path = require("path");
const net = require("net");
const axios = require("axios");
const tmi = require("tmi.js");
const WebSocket = require("ws");
const { LiveChat } = require("youtube-chat");

const KICK_PUSHER_KEY = "32cbd69e4b950bf97679";
const KICK_RETRY_MS = 30000;
const YOUTUBE_RETRY_MS = 60000;
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "relay.config.json");
const DISCOVERY_PORT = 8788;
const DISCOVERY_REQUEST = "QUEST_CHAT_DISCOVER";

const config = normalizeConfig(readConfig());
const clients = new Set();
const connectors = [];
let questStatus = {
  questConnected: false,
  questDevice: "",
  questBattery: "",
  questBatteryStatus: "",
  timestamp: 0
};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function normalizeConfig(value) {
  return {
    port: Number(value.port || process.env.PORT || 8787),
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

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const socket of clients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(text);
    }
  }
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function status(source, state, detail) {
  const event = { type: "status", source, state, detail };
  console.log(`[${source}] ${state}${detail ? ` - ${detail}` : ""}`);
  broadcast(event);
}

function message(payload) {
  const parts = Array.isArray(payload.parts) ? payload.parts : undefined;
  broadcast({
    type: "message",
    id: `${payload.platform}:${payload.channel}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    text: payload.text || flattenMessageParts(parts),
    parts,
    ...payload
  });
}

function hud(payload) {
  broadcast({
    type: "hud",
    timestamp: new Date().toISOString(),
    ...payload
  });
}

function flattenMessageParts(parts) {
  return (parts || [])
    .map((part) => part.type === "emote" ? (part.alt || "") : (part.text || ""))
    .join("")
    .trim();
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

function buildTwitchParts(text, emotes) {
  const value = String(text || "");
  if (!emotes || typeof emotes !== "object") {
    return [{ type: "text", text: value }];
  }

  const ranges = [];
  for (const [emoteId, matches] of Object.entries(emotes)) {
    for (const range of matches || []) {
      if (!Array.isArray(range) || range.length < 2) continue;
      ranges.push({
        id: emoteId,
        start: Number(range[0]),
        end: Number(range[1])
      });
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

function buildYouTubeParts(messageItems) {
  const parts = [];
  for (const item of messageItems || []) {
    if (item?.text) {
      pushTextPart(parts, item.text);
      continue;
    }
    if (item?.url || item?.emojiText || item?.alt) {
      parts.push({
        type: "emote",
        alt: item.emojiText || item.alt || "",
        url: item.url || ""
      });
    }
  }
  return parts.length ? parts : [{ type: "text", text: "" }];
}

function buildKickParts(text) {
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

function slobsCall(resource, method, args = []) {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params: { resource, args }
  }) + "\n";

  return new Promise((resolve, reject) => {
    const socket = net.createConnection("\\\\.\\pipe\\slobs");
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out connecting to Streamlabs Desktop API"));
    }, 2500);

    socket.on("connect", () => {
      socket.write(request);
    });
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      const line = buffer.split("\n").find((item) => item.trim());
      if (!line) return;
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(line);
        if (response.error) {
          reject(new Error(response.error.message || JSON.stringify(response.error)));
          return;
        }
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => clearTimeout(timer));
  });
}

async function discoverObsState() {
  const [activeScene, scenes, audioSources] = await Promise.all([
    slobsCall("ScenesService", "activeScene"),
    slobsCall("ScenesService", "getScenes"),
    slobsCall("AudioService", "getSourcesForCurrentScene")
  ]);
  return {
    obsConnected: true,
    currentScene: activeScene?.name || "",
    scenes: (scenes || [])
      .map((scene) => ({ id: scene.id, name: scene.name }))
      .filter((scene) => scene.id && scene.name),
    audioInputs: (audioSources || [])
      .map((source) => ({
        id: source.id || source.sourceId || source.resourceId,
        resourceId: source.resourceId,
        name: source.name || source.sourceId || "Audio Source",
        muted: Boolean(source.muted),
        volumeDb: typeof source.fader?.deflection === "number" ? Math.round(source.fader.deflection * 100) : 0,
        volumeMul: typeof source.fader?.deflection === "number" ? source.fader.deflection : 0
      }))
      .filter((source) => source.resourceId)
  };
}

async function setObsScene(sceneName) {
  const scenes = await slobsCall("ScenesService", "getScenes");
  const scene = (scenes || []).find((item) => item.name === sceneName);
  if (!scene?.id) throw new Error(`Scene not found: ${sceneName}`);
  await slobsCall("ScenesService", "makeSceneActive", [scene.id]);
}

async function setObsInputMute(inputName, muted) {
  const snapshot = await discoverObsState();
  const source = snapshot.audioInputs.find((item) => item.name === inputName || item.id === inputName || item.resourceId === inputName);
  if (!source?.resourceId) throw new Error(`Audio source not found: ${inputName}`);
  await slobsCall(source.resourceId, "setMuted", [Boolean(muted)]);
}

async function setObsInputVolume(inputName, volume) {
  const snapshot = await discoverObsState();
  const source = snapshot.audioInputs.find((item) => item.name === inputName || item.id === inputName || item.resourceId === inputName);
  if (!source?.resourceId) throw new Error(`Audio source not found: ${inputName}`);
  const value = Math.max(0, Math.min(1, Number(volume) / 100));
  await slobsCall(source.resourceId, "setDeflection", [value]);
}

function createServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type"
      });
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/message") {
      readJsonBody(req).then((data) => {
          message({
            platform: data.platform || "relay",
            channel: data.channel || "manual",
            author: data.author || data.user || "Relay",
            text: String(data.text || data.message || "")
          });
          res.writeHead(204).end();
        }).catch(() => {
          res.writeHead(400).end("Expected JSON: {\"author\":\"Name\",\"text\":\"Message\"}");
        });
      return;
    }

    if (req.method === "POST" && req.url === "/hud") {
      readJsonBody(req).then((data) => {
          hud(data);
          res.writeHead(204).end();
        }).catch(() => {
          res.writeHead(400).end("Expected HUD JSON");
        });
      return;
    }

    if (req.method === "GET" && req.url === "/quest-status") {
      writeJson(res, 200, questStatus);
      return;
    }

    if (req.method === "POST" && req.url === "/quest-status") {
      readJsonBody(req).then((data) => {
          questStatus = {
            questConnected: data.connected !== false,
            questDevice: String(data.questDevice || data.device || ""),
            questBattery: String(data.questBattery || data.batteryLevel || ""),
            questBatteryStatus: String(data.questBatteryStatus || data.batteryStatus || ""),
            timestamp: Number(data.timestamp || Date.now())
          };
          hud(questStatus);
          res.writeHead(204).end();
        }).catch(() => {
          res.writeHead(400).end("Expected Quest status JSON");
        });
      return;
    }

    if (req.method === "GET" && req.url === "/control/obs/snapshot") {
      discoverObsState()
        .then((snapshot) => writeJson(res, 200, snapshot))
        .catch((error) => writeJson(res, 503, { error: cleanError(error) }));
      return;
    }

    if (req.method === "POST" && req.url === "/control/obs/scene") {
      readJsonBody(req)
        .then(async (data) => {
          await setObsScene(String(data.sceneName || ""));
          writeJson(res, 200, { ok: true });
        })
        .catch((error) => writeJson(res, 400, { error: cleanError(error) }));
      return;
    }

    if (req.method === "POST" && req.url === "/control/obs/mute") {
      readJsonBody(req)
        .then(async (data) => {
          await setObsInputMute(String(data.inputName || ""), data.muted);
          writeJson(res, 200, { ok: true });
        })
        .catch((error) => writeJson(res, 400, { error: cleanError(error) }));
      return;
    }

    if (req.method === "POST" && req.url === "/control/obs/volume") {
      readJsonBody(req)
        .then(async (data) => {
          await setObsInputVolume(String(data.inputName || ""), data.volume);
          writeJson(res, 200, { ok: true });
        })
        .catch((error) => writeJson(res, 400, { error: cleanError(error) }));
      return;
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Quest Chat Panel relay\n");
  });

  const wss = new WebSocket.Server({ server });
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    socket.on("message", (raw) => {
      handleSocketMessage(socket, raw).catch((error) => {
        socket.send(JSON.stringify({
          type: "control-result",
          ok: false,
          error: cleanError(error)
        }));
      });
    });
    socket.send(JSON.stringify({ type: "status", source: "Relay", state: "connected", detail: "PC relay attached" }));
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`Relay listening on port ${config.port}`);
    for (const address of localAddresses()) {
      console.log(`Quest URL: ws://${address}:${config.port}`);
    }
    console.log(`Discovery listening on UDP ${DISCOVERY_PORT}`);
  });
}

async function handleSocketMessage(socket, raw) {
  const data = parseJson(raw.toString());
  if (!data || data.type !== "control") return;

  const requestId = data.requestId || "";
  try {
    if (data.action === "obs:scene") {
      await setObsScene(String(data.sceneName || ""));
      socket.send(JSON.stringify({ type: "control-result", requestId, ok: true }));
      return;
    }
    if (data.action === "obs:mute") {
      await setObsInputMute(String(data.inputName || ""), data.muted);
      socket.send(JSON.stringify({ type: "control-result", requestId, ok: true }));
      return;
    }
    if (data.action === "obs:volume") {
      await setObsInputVolume(String(data.inputName || ""), data.volume);
      socket.send(JSON.stringify({ type: "control-result", requestId, ok: true }));
      return;
    }
    if (data.action === "obs:snapshot") {
      const snapshot = await discoverObsState();
      socket.send(JSON.stringify({ type: "control-result", requestId, ok: true, snapshot }));
      return;
    }

    socket.send(JSON.stringify({ type: "control-result", requestId, ok: false, error: `Unknown control action: ${data.action}` }));
  } catch (error) {
    socket.send(JSON.stringify({ type: "control-result", requestId, ok: false, error: cleanError(error) }));
  }
}

function createDiscoveryServer() {
  const socket = dgram.createSocket("udp4");

  socket.on("message", (message, remote) => {
    if (message.toString("utf8").trim() !== DISCOVERY_REQUEST) return;

    const url = `ws://${bestAddressFor(remote.address)}:${config.port}`;
    const response = Buffer.from(JSON.stringify({
      type: "quest-chat-relay",
      name: os.hostname(),
      url
    }));
    socket.send(response, remote.port, remote.address);
  });

  socket.on("error", (error) => {
    console.error(`Discovery error: ${cleanError(error)}`);
  });

  socket.bind(DISCOVERY_PORT, "0.0.0.0", () => {
    socket.setBroadcast(true);
  });
}

function bestAddressFor(remoteAddress) {
  const addresses = localAddresses();
  const remoteParts = String(remoteAddress).split(".");
  const sameSubnet = addresses.find((address) => {
    const parts = address.split(".");
    return parts[0] === remoteParts[0] && parts[1] === remoteParts[1] && parts[2] === remoteParts[2];
  });
  return sameSubnet || addresses[0] || "127.0.0.1";
}

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

function createTwitchConnector(channels) {
  let client;

  return {
    label: "Twitch",
    async start() {
      status("Twitch", "connecting", channels.join(", "));
      client = new tmi.Client({
        connection: { reconnect: true, secure: true },
        channels
      });

      client.on("message", (channel, userstate, text, self) => {
        if (self) return;
        const parts = buildTwitchParts(text, userstate.emotes);
        message({
          platform: "twitch",
          channel: channel.replace(/^#/, ""),
          author: userstate["display-name"] || userstate.username || "viewer",
          text,
          parts,
          color: userstate.color || "#a970ff",
          badges: Object.keys(userstate.badges || {})
        });
      });
      client.on("connected", () => status("Twitch", "connected", channels.join(", ")));
      client.on("disconnected", (reason) => status("Twitch", "disconnected", reason));
      await client.connect();
    },
    async stop() {
      if (client?.readyState() === "OPEN") await client.disconnect();
    }
  };
}

function createYouTubeConnector(source) {
  let liveChat;
  let retryTimer;
  const label = `YouTube ${shortSource(source)}`;

  return {
    label,
    async start() {
      await connect();
    },
    async stop() {
      clearTimeout(retryTimer);
      liveChat?.stop();
    }
  };

  async function connect() {
    clearTimeout(retryTimer);
    status(label, "connecting", source);
    try {
      const target = await resolveYouTubeTarget(source);
      liveChat = new LiveChat(target);
      liveChat.on("start", (liveId) => status(label, "connected", liveId));
      liveChat.on("end", (reason) => {
        status(label, "disconnected", reason || "ended");
        schedule();
      });
      liveChat.on("error", (error) => {
        status(label, "error", cleanError(error));
        schedule();
      });
      liveChat.on("chat", (item) => {
        const text = flattenYouTubeMessage(item.message);
        if (!text) return;
        const parts = buildYouTubeParts(item.message);
        message({
          platform: "youtube",
          channel: target.channelId || target.liveId || source,
          author: item.author?.name || "viewer",
          text,
          parts,
          badges: getYouTubeBadges(item)
        });
      });

      const ok = await liveChat.start();
      if (!ok) {
        status(label, "error", "Failed to start live chat");
        schedule();
      }
    } catch (error) {
      status(label, "error", cleanError(error));
      schedule();
    }
  }

  function schedule() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, YOUTUBE_RETRY_MS);
  }
}

async function resolveYouTubeTarget(source) {
  const value = String(source || "").trim();
  const videoId = extractYouTubeVideoId(value);
  if (videoId) return { liveId: videoId };
  if (/^UC[\w-]{20,}$/i.test(value)) return { channelId: value };
  return { channelId: await resolveYouTubeChannelId(value) };
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
  return undefined;
}

async function resolveYouTubeChannelId(source) {
  const url = source.startsWith("http")
    ? source
    : `https://www.youtube.com/${source.startsWith("@") ? source : `@${source}`}`;
  const response = await axios.get(url, {
    timeout: 12000,
    headers: {
      "accept": "text/html",
      "user-agent": "QuestChatPanel/0.1"
    }
  });
  const html = String(response.data || "");
  const match =
    html.match(/"channelId":"(UC[\w-]+)"/) ||
    html.match(/"externalId":"(UC[\w-]+)"/) ||
    html.match(/"browseId":"(UC[\w-]+)"/) ||
    html.match(/<meta itemprop="channelId" content="(UC[\w-]+)">/);
  if (!match) throw new Error(`Could not resolve YouTube channel id from ${source}`);
  return match[1];
}

function flattenYouTubeMessage(parts) {
  return (parts || [])
    .map((part) => part.text || part.emojiText || part.alt || "")
    .join("")
    .trim();
}

function getYouTubeBadges(item) {
  const badges = [];
  if (item.isOwner) badges.push("owner");
  if (item.isModerator) badges.push("mod");
  if (item.isVerified) badges.push("verified");
  if (item.isMembership) badges.push("member");
  if (item.superchat?.amount) badges.push(item.superchat.amount);
  return badges;
}

function createKickConnector(slug) {
  let socket;
  let reconnectTimer;
  let shouldRun = true;

  return {
    label: `Kick ${slug}`,
    async start() {
      shouldRun = true;
      let roomId;
      try {
        roomId = await fetchKickChatroomId(slug);
      } catch (error) {
        status("Kick", "error", `${cleanError(error)}. Retrying in ${Math.round(KICK_RETRY_MS / 1000)}s.`);
        reconnectTimer = setTimeout(() => this.start(), KICK_RETRY_MS);
        return;
      }

      status("Kick", "connecting", `${slug} (${roomId})`);
      socket = new WebSocket(`wss://ws-us2.pusher.com/app/${KICK_PUSHER_KEY}?protocol=7&client=js&version=8.4.0&flash=false`);

      socket.on("open", () => {
        socket.send(JSON.stringify({
          event: "pusher:subscribe",
          data: { auth: "", channel: `chatrooms.${roomId}.v2` }
        }));
      });
      socket.on("message", (raw) => {
        const event = parseJson(raw.toString());
        if (!event) return;
        if (event.event === "pusher:connection_established") {
          status("Kick", "connected", slug);
          return;
        }

        const data = parseJson(event.data);
        const body = parseKickMessage(data);
        if (!body) return;
        const parts = buildKickParts(body.text);
        message({
          platform: "kick",
          channel: slug,
          author: body.author,
          text: body.text,
          parts,
          color: "#53fc18",
          badges: body.badges
        });
      });
      socket.on("close", () => {
        status("Kick", "disconnected", slug);
        if (shouldRun) reconnectTimer = setTimeout(() => this.start(), 5000);
      });
      socket.on("error", (error) => status("Kick", "error", cleanError(error)));
    },
    async stop() {
      shouldRun = false;
      clearTimeout(reconnectTimer);
      socket?.close();
    }
  };
}

async function fetchKickChatroomId(slug) {
  const response = await axios.get(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    timeout: 12000,
    headers: {
      "accept": "application/json",
      "accept-language": "en-GB,en;q=0.9",
      "referer": `https://kick.com/${encodeURIComponent(slug)}`,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
    }
  });
  const roomId = response.data?.chatroom?.id || response.data?.chatroom_id;
  if (!roomId) throw new Error(`Kick channel ${slug} did not expose a chatroom id`);
  return roomId;
}

function parseKickMessage(data) {
  if (!data) return undefined;
  const sender = data.sender || data.user || data.author || {};
  const text = data.content || data.message || data.text;
  if (!text) return undefined;
  return {
    author: sender.username || sender.slug || sender.name || "viewer",
    text: String(text).replace(/\[emote:(\d+):([^\]]+)\]/g, "$2"),
    badges: (sender.identity?.badges || sender.badges || []).map((badge) => badge.text || badge.name || badge.type).filter(Boolean)
  };
}

function parseJson(value) {
  if (!value) return undefined;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function shortSource(value) {
  return String(value)
    .replace(/^https?:\/\/(www\.)?/i, "")
    .replace(/^youtube\.com\//i, "")
    .slice(0, 32);
}

function cleanError(error) {
  return error?.message || String(error || "Unknown error");
}

async function start() {
  createServer();
  createDiscoveryServer();

  if (config.twitchChannels.length) connectors.push(createTwitchConnector(config.twitchChannels));
  for (const source of config.youtubeSources) connectors.push(createYouTubeConnector(source));
  for (const channel of config.kickChannels) connectors.push(createKickConnector(channel));

  for (const connector of connectors) {
    connector.start().catch((error) => status(connector.label, "error", cleanError(error)));
  }
}

process.on("SIGINT", async () => {
  for (const connector of connectors) {
    await connector.stop().catch(() => {});
  }
  process.exit(0);
});

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
