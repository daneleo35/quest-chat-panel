const fs = require("fs");
const dgram = require("dgram");
const http = require("http");
const os = require("os");
const path = require("path");
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

function status(source, state, detail) {
  const event = { type: "status", source, state, detail };
  console.log(`[${source}] ${state}${detail ? ` - ${detail}` : ""}`);
  broadcast(event);
}

function message(payload) {
  broadcast({
    type: "message",
    id: `${payload.platform}:${payload.channel}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    ...payload
  });
}

function createServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/message") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          message({
            platform: data.platform || "relay",
            channel: data.channel || "manual",
            author: data.author || data.user || "Relay",
            text: String(data.text || data.message || "")
          });
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end("Expected JSON: {\"author\":\"Name\",\"text\":\"Message\"}");
        }
      });
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
        message({
          platform: "twitch",
          channel: channel.replace(/^#/, ""),
          author: userstate["display-name"] || userstate.username || "viewer",
          text,
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
        message({
          platform: "youtube",
          channel: target.channelId || target.liveId || source,
          author: item.author?.name || "viewer",
          text,
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
        message({
          platform: "kick",
          channel: slug,
          author: body.author,
          text: body.text,
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
