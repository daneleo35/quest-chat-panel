const messagesEl = document.querySelector("#messages");
const sourcesEl = document.querySelector("#sources");
const statusEl = document.querySelector("#status");
const form = document.querySelector("#settingsForm");
const socketInput = document.querySelector("#socketUrl");
const connectButton = document.querySelector("#connectButton");
const mockButton = document.querySelector("#mockButton");
const clearButton = document.querySelector("#clearButton");
const compactToggle = document.querySelector("#compactToggle");

const colors = ["#5fd0a5", "#f7c873", "#8fb8ff", "#ff9ca8", "#bba3ff", "#7bdff2"];
const sourceState = new Map();
let socket;
let mockTimer;
let autoConnectStarted = false;

socketInput.value = localStorage.getItem("relayUrl") || "";
document.body.classList.toggle("compact", localStorage.getItem("compact") === "true");

function setStatus(text) {
  statusEl.textContent = text;
}

function colorFor(name) {
  let total = 0;
  for (const char of name) total += char.charCodeAt(0);
  return colors[total % colors.length];
}

function renderSources() {
  sourcesEl.replaceChildren();
  if (!sourceState.size) {
    const item = document.createElement("div");
    item.className = "source";
    item.textContent = "No sources yet";
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

function addMessage({ platform = "relay", author = "Relay", user, text = "", timestamp, time }) {
  const displayName = author || user || "Relay";
  if (!String(text).trim()) return;

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
  message.textContent = text;

  meta.append(badge, name, stamp);
  body.append(meta, message);
  item.append(avatar, body);
  messagesEl.append(item);

  while (messagesEl.children.length > 140) messagesEl.firstElementChild.remove();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function handleRelayEvent(event) {
  if (event.type === "status") {
    sourceState.set(event.source, event);
    renderSources();
    setStatus(`${event.source}: ${event.detail || event.state}`);
    return;
  }

  if (event.type === "reset") {
    messagesEl.replaceChildren();
    return;
  }

  if (event.type === "message") {
    addMessage(event);
  }
}

function stopMock() {
  if (mockTimer) window.clearInterval(mockTimer);
  mockTimer = null;
}

function disconnect() {
  if (socket) socket.close();
  socket = null;
}

function startMock() {
  disconnect();
  stopMock();
  const samples = [
    { platform: "twitch", author: "Nova", text: "Twitch is readable." },
    { platform: "youtube", author: "Ash", text: "YouTube messages land here too." },
    { platform: "kick", author: "Mira", text: "Kick is wired through the PC relay." },
  ];
  let index = 0;
  setStatus("Mock feed running");
  addMessage({ platform: "relay", author: "System", text: "Mock chat started." });
  mockTimer = window.setInterval(() => {
    addMessage(samples[index % samples.length]);
    index += 1;
  }, 2100);
}

function connect(url) {
  stopMock();
  disconnect();
  localStorage.setItem("relayUrl", url);
  socketInput.value = url;
  setStatus("Connecting...");
  connectButton.disabled = true;

  socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    setStatus("Connected to relay");
    connectButton.disabled = false;
  });
  socket.addEventListener("message", (message) => {
    try {
      handleRelayEvent(JSON.parse(message.data));
    } catch {
      addMessage({ platform: "relay", author: "Relay", text: String(message.data) });
    }
  });
  socket.addEventListener("close", () => {
    setStatus("Disconnected");
    connectButton.disabled = false;
  });
  socket.addEventListener("error", () => {
    setStatus("Relay connection error");
    connectButton.disabled = false;
  });
}

window.autoConnectRelay = (url) => {
  if (!url || autoConnectStarted) return;
  autoConnectStarted = true;
  setStatus("Found relay");
  connect(url);
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = socketInput.value.trim();
  if (url) connect(url);
});

mockButton.addEventListener("click", startMock);
clearButton.addEventListener("click", () => messagesEl.replaceChildren());
compactToggle.addEventListener("click", () => {
  const compact = !document.body.classList.contains("compact");
  document.body.classList.toggle("compact", compact);
  localStorage.setItem("compact", String(compact));
});

renderSources();
setStatus(socketInput.value ? "Searching for relay, saved URL is fallback" : "Searching for relay on your LAN");
addMessage({ platform: "relay", author: "System", text: "Start npm run relay on the PC. The headset will auto-connect when it finds it." });
