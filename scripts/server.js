const fs = require("fs");
const http = require("http");
const path = require("path");
const childProcess = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(process.env.AIBOX_WEBAPP_DIST_DIR || path.join(rootDir, "dist"));
const dataDir = path.resolve(process.env.AIBOX_WEBAPP_DATA_DIR || path.join(rootDir, "data"));
const notesPath = path.join(dataDir, "notes.json");
const layoutPath = path.join(dataDir, "layout.json");
const simOutagesPath = path.join(dataDir, "sim-outages.json");
const monitorRoot = process.env.AIBOX_MONITOR_ROOT || path.join(process.env.HOME || "/home/boxtest2", "aibox-monitor");
const configPath = path.join(monitorRoot, "config.json");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 5173);
const adminToken = process.env.AIBOX_WEBAPP_ADMIN_TOKEN || "";
const connectivityUpstream = parseConnectivityUpstream(process.env.AIBOX_CONNECTIVITY_UPSTREAM);
const connectivityTimeoutMs = Number(process.env.AIBOX_CONNECTIVITY_TIMEOUT_MS || 8000);
// Collector machine identity -> dashboard AIBOX identity. Only mapped machines are queryable.
const connectivityMachineIds = {
  "aibox-td08": { id: "td08", ip: "100.64.0.27" },
  "aibox-oceanus": { id: "oceanus", ip: "100.64.0.80" },
  "aibox-th05": { id: "th05", ip: "100.64.0.81" },
  "aibox-th06": { id: "th06", ip: "100.64.0.82" },
  "aibox-th08": { id: "th08", ip: "100.64.0.122" },
  "aibox-starcity": { id: "starcity", ip: "100.64.0.44" },
  "aibox-th07": { id: "th07", ip: "100.64.0.104" },
  "aibox-th04": { id: "th04", ip: "100.64.0.1" },
  "aibox-neptune": { id: "neptune", ip: "100.64.0.85" },
  "vtas-aibox1": { id: "poseidon", ip: "100.64.0.45" },
  "aibox-th09": { id: "th09", ip: "100.64.0.123" },
  "aibox-td09": { id: "td09", ip: "100.64.0.121" },
};
const syncLockPath = "/tmp/aibox-monitor-webapp-sync.lock";
const connectivityMappingPath = path.join(rootDir, "connectivity-machines.json");
if (fs.existsSync(connectivityMappingPath)) {
  Object.assign(connectivityMachineIds, JSON.parse(fs.readFileSync(connectivityMappingPath, "utf8")));
}
const connectivityWaitingPath = path.join(dataDir, "connectivity-waiting.json");
const maxBodyBytes = 100_000;
const securityHeaders = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function ensureNotesFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(notesPath)) writeTextAtomic(notesPath, "{}\n");
}

function ensureLayoutFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(layoutPath)) writeTextAtomic(layoutPath, "{\"aiboxOrder\":[]}\n");
}

function readNotes() {
  ensureNotesFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(notesPath, "utf8"));
    const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    const normalized = normalizeNotes(source);
    if (JSON.stringify(source) !== JSON.stringify(normalized)) writeNotes(normalized);
    return normalized;
  } catch (error) {
    throw new Error(`Notes data is invalid: ${error.message}`);
  }
}

function noteId() {
  return `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeNote(note) {
  return {
    id: String(note.id || noteId()),
    creator: String(note.creator || ""),
    content: String(note.content || ""),
    createdAt: String(note.createdAt || new Date().toISOString()),
  };
}

function normalizeNotes(notes) {
  const normalized = Object.create(null);
  Object.keys(notes).forEach((key) => {
    const value = notes[key];
    if (Array.isArray(value)) {
      normalized[key] = value.map(normalizeNote);
    } else if (value && typeof value === "object") {
      normalized[key] = [normalizeNote(value)];
    }
  });
  return normalized;
}

function writeNotes(notes) {
  ensureNotesFile();
  writeTextAtomic(notesPath, `${JSON.stringify(notes, null, 2)}\n`);
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function normalizeLayout(layout) {
  const cameraOrder = Object.create(null);
  const sourceCameraOrder = layout && layout.cameraOrder && typeof layout.cameraOrder === "object" && !Array.isArray(layout.cameraOrder)
    ? layout.cameraOrder
    : {};
  Object.keys(sourceCameraOrder).forEach((networkId) => {
    cameraOrder[String(networkId)] = normalizeStringList(sourceCameraOrder[networkId]);
  });
  return {
    aiboxOrder: normalizeStringList(layout && layout.aiboxOrder),
    cameraOrder,
    networkOrder: normalizeStringList(layout && layout.networkOrder),
  };
}

function readLayout() {
  ensureLayoutFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(layoutPath, "utf8"));
    const normalized = normalizeLayout(parsed && typeof parsed === "object" ? parsed : {});
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) writeLayout(normalized);
    return normalized;
  } catch (error) {
    throw new Error(`Layout data is invalid: ${error.message}`);
  }
}

function writeLayout(layout) {
  ensureLayoutFile();
  writeTextAtomic(layoutPath, `${JSON.stringify(normalizeLayout(layout), null, 2)}\n`);
}

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, text, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}

function readJsonBody(req, callback) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentType !== "application/json") {
    req.resume();
    callback(Object.assign(new Error("Content-Type must be application/json"), { statusCode: 415 }));
    return;
  }
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    req.resume();
    callback(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
    return;
  }
  const chunks = [];
  let size = 0;
  let finished = false;
  function finish(error, body) {
    if (finished) return;
    finished = true;
    callback(error, body);
  }
  req.on("data", (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > maxBodyBytes) {
      finish(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (finished) return;
    try {
      const body = Buffer.concat(chunks).toString("utf8");
      finish(null, body ? JSON.parse(body) : {});
    } catch (error) {
      finish(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
    }
  });
  req.on("aborted", () => finish(Object.assign(new Error("Request aborted"), { statusCode: 400 })));
  req.on("error", (error) => finish(error));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function requireAdmin(req, res) {
  if (!adminToken) return true;
  if (req.headers["x-admin-token"] === adminToken) return true;
  sendError(res, 401, "Admin token required");
  return false;
}

function readConfig() {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.aiboxes) || !Array.isArray(parsed.target_scopes)) {
    throw new Error("Unsupported config shape");
  }
  return parsed;
}

function backupName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const backupDir = path.join(monitorRoot, "config-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  return path.join(backupDir, `config.json.backup-${stamp}`);
}

function writeConfig(config) {
  const backupPath = backupName();
  const tempPath = `${configPath}.tmp`;
  fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tempPath, configPath);
  return backupPath;
}

function syncData() {
  try {
    childProcess.execFileSync("/usr/bin/flock", ["-w", "120", syncLockPath, process.execPath, path.join(rootDir, "scripts", "sync-data.js")], { cwd: rootDir, stdio: "ignore", timeout: 125000 });
    return "";
  } catch (error) {
    return error.message;
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function cleanId(value) {
  return String(value || "").trim();
}

function ensureUnique(items, key, value, currentId) {
  return !items.some((item) => item[key] === value && item.id !== currentId);
}

function validateAibox(config, input, currentId) {
  const aibox = {
    id: cleanId(input.id),
    name: cleanId(input.name),
    user: cleanId(input.user),
    ip: cleanId(input.ip),
    "check-devices": Boolean(input["check-devices"]),
    "check-resource": Boolean(input["check-resource"]),
    status_recipient_group: cleanId(input.status_recipient_group || config.default_status_recipient_group || "default_group"),
    resource_recipients: normalizeList(input.resource_recipients),
    networks: normalizeList(input.networks),
  };
  const targetInterface = cleanId(input["target-interface"]);
  if (targetInterface) aibox["target-interface"] = targetInterface;
  if (!aibox.id || !aibox.name || !aibox.user || !aibox.ip) throw new Error("Missing required AIBOX fields");
  if (!ensureUnique(config.aiboxes, "id", aibox.id, currentId)) throw new Error("AIBOX id already exists");
  if (!ensureUnique(config.aiboxes, "ip", aibox.ip, currentId)) throw new Error("AIBOX IP already exists");
  if (config.recipient_groups && !config.recipient_groups[aibox.status_recipient_group]) throw new Error("Unknown recipient group");
  return aibox;
}

function mutateConfig(mutator) {
  const config = readConfig();
  const result = mutator(config) || {};
  const backupPath = writeConfig(config);
  const syncError = syncData();
  return { config, backupPath, syncError, ...result };
}

function handleConfigMutation(req, res, callback) {
  if (!requireAdmin(req, res)) return;
  readJsonBody(req, (error, body) => {
    if (error) {
      sendError(res, error.statusCode || 400, error.message);
      return;
    }
    try {
      sendJson(res, 200, callback(body || {}));
    } catch (mutationError) {
      sendError(res, 400, mutationError.message);
    }
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    ...securityHeaders,
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(`${JSON.stringify(data)}\n`);
}

function serveFile(req, res, pathname) {
  let safePath;
  try {
    safePath = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  } catch (_) {
    sendError(res, 400, "Malformed request path");
    return;
  }
  const requested = path.resolve(distDir, safePath || "index.html");
  const relativePath = path.relative(distDir, requested);
  const contained = relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  const filePath = contained && fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : path.join(distDir, "index.html");
  if (!fs.existsSync(filePath)) {
    sendError(res, 503, "Web application is not built");
    return;
  }
  const ext = path.extname(filePath);
  const headers = { ...securityHeaders, "Content-Type": mimeTypes[ext] || "application/octet-stream" };
  if (filePath.endsWith("index.html") || filePath.endsWith("aibox-data.json")) {
    headers["Cache-Control"] = "no-store, max-age=0";
  } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("open", () => {
    res.writeHead(200, headers);
    stream.pipe(res);
  });
  stream.on("error", (error) => {
    console.error(`Static file error: ${error.message}`);
    if (!res.headersSent) sendError(res, 500, "Unable to read web application file");
    else res.destroy();
  });
}

function serveData(req, res) {
  if (!fs.existsSync(path.join(distDir, "aibox-data.json"))) {
    sendError(res, 503, "Status snapshot is not available");
    return;
  }
  serveFile(req, res, "/aibox-data.json");
}

const SNAPSHOT_REQUEST_RE = /^([a-z0-9-]+)\/(\d{1,3}(?:\.\d{1,3}){3})(?:\.(\d+))?\.jpg$/i;

function serveCameraSnapshot(req, res, pathname) {
  const match = pathname.replace(/^\/camera-snapshots\//, "").match(SNAPSHOT_REQUEST_RE);
  if (!match) {
    sendError(res, 404, "Snapshot not found");
    return;
  }
  const snapshotsDir = path.join(dataDir, "camera-snapshots");
  const cameraDir = path.resolve(snapshotsDir, match[1], match[2]);
  if (!cameraDir.startsWith(snapshotsDir + path.sep)) {
    sendError(res, 404, "Snapshot not found");
    return;
  }
  let files = [];
  try {
    files = fs.readdirSync(cameraDir).filter((name) => name.endsWith(".jpg"))
      .map((name) => ({ name, mtime: fs.statSync(path.join(cameraDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) {
    sendError(res, 404, "Snapshot not found");
    return;
  }
  const slot = match[3] ? Number(match[3]) : 0;
  const file = Number.isInteger(slot) && slot >= 0 ? files[slot] : undefined;
  if (!file) {
    sendError(res, 404, "Snapshot not found");
    return;
  }
  const filePath = path.join(cameraDir, file.name);
  res.writeHead(200, { ...securityHeaders, "Cache-Control": "no-store, max-age=0", "Content-Type": "image/jpeg" });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("open", () => stream.pipe(res));
  stream.on("error", () => {
    if (!res.headersSent) sendError(res, 500, "Unable to read snapshot");
    else res.destroy();
  });
}

function parseConnectivityUpstream(value) {
  try {
    const url = new URL(value || "");
    if (url.protocol === "http:") return url;
  } catch (_) {}
  return new URL("http://127.0.0.1:8787");
}

function connectivityMachineFor(id) {
  const value = String(id || "").trim();
  if (!value) return "";
  if (connectivityMachineIds[value]) return value;
  for (const [machine, entry] of Object.entries(connectivityMachineIds)) {
    if (entry.id === value || entry.ip === value) return machine;
  }
  return "";
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function connectivityFetch(upstreamPath, params, callback) {
  const target = new URL(upstreamPath, connectivityUpstream);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value !== undefined && value !== null) target.searchParams.set(key, String(value));
  });
  const request = http.get(target, { timeout: connectivityTimeoutMs }, (upstream) => {
    const chunks = [];
    upstream.on("data", (chunk) => chunks.push(chunk));
    upstream.on("end", () => callback(null, { status: upstream.statusCode || 502, body: Buffer.concat(chunks) }));
  });
  request.on("timeout", () => request.destroy(new Error("Connectivity request timed out")));
  request.on("error", (error) => callback(error));
}

function trackSimOutages(machines) {
  let outages = {};
  try {
    outages = JSON.parse(fs.readFileSync(simOutagesPath, "utf8")) || {};
  } catch (_) {}
  let changed = false;
  for (const machine of machines) {
    const sample = machine.links && machine.links.USB && machine.links.USB.sample;
    if (!machine.ip || !sample) continue;
    if (sample.state === "online" && outages[machine.ip]) {
      delete outages[machine.ip];
      changed = true;
    } else if (sample.state === "offline" && !outages[machine.ip] && Number.isFinite(Number(sample.ts))) {
      outages[machine.ip] = { since: Number(sample.ts), machine: machine.machine || "" };
      changed = true;
    }
    if (sample.state === "offline" && outages[machine.ip]) machine.usbOfflineSince = outages[machine.ip].since;
  }
  if (changed) {
    try { writeTextAtomic(simOutagesPath, `${JSON.stringify(outages, null, 2)}\n`); } catch (_) {}
  }
}

function fetchConnectivityMachines(callback) {
  connectivityFetch("/api/fleet", {}, (error, result) => {
    if (error || !result || result.status !== 200) {
      callback(new Error("Connectivity collection unavailable"));
      return;
    }
    let hosts;
    try {
      hosts = JSON.parse(result.body.toString("utf8"));
    } catch (_) {
      callback(new Error("Connectivity collection returned invalid data"));
      return;
    }
    const machines = (Array.isArray(hosts) ? hosts : []).map((host) => ({
      ...host,
      id: (connectivityMachineIds[host.machine] || {}).id || "",
      ip: (connectivityMachineIds[host.machine] || {}).ip || "",
      label: (connectivityMachineIds[host.machine] || {}).label || "",
      enrolled: Boolean(connectivityMachineIds[host.machine]),
    }));
    trackSimOutages(machines);
    callback(null, machines);
  });
}

function handleConnectivityFleet(res) {
  fetchConnectivityMachines((error, machines) => {
    if (error) {
      sendError(res, 502, error.message);
      return;
    }
    let waitingMachines = [];
    try {
      const waiting = JSON.parse(fs.readFileSync(connectivityWaitingPath, "utf8"));
      waitingMachines = Object.keys(waiting).map((machine) => {
        const entry = connectivityMachineIds[machine] || {};
        return { machine, id: entry.id || "", ip: entry.ip || waiting[machine].ip || "", label: entry.label || waiting[machine].label || "" };
      }).filter((machine) => machine.ip);
    } catch (_) {}
    sendJson(res, 200, { available: true, fetchedAt: Date.now() / 1000, machines, waitingMachines });
  });
}

function handleConnectivityHistory(res, query) {
  const machine = connectivityMachineFor(query.machine);
  if (!machine) {
    sendError(res, 400, "Unknown connectivity machine");
    return;
  }
  const link = ["LAN", "USB"].includes(query.link) ? query.link : "";
  const kind = String(query.kind || "")
    .split(",")
    .filter((value) => ["measurement", "incident", "gap", "diagnostic"].includes(value))
    .join(",");
  const params = {
    machine,
    link,
    kind,
    since: boundedNumber(query.since, 0, 0, 9e15),
    until: boundedNumber(query.until, 9e15, 0, 9e15),
    minimum_severity: boundedNumber(query.minimum_severity, 0, 0, 3),
    limit: boundedNumber(query.limit, 2000, 1, 10000),
    offset: boundedNumber(query.offset, 0, 0, 1000000),
  };
  connectivityFetch("/api/history", params, (error, result) => {
    if (error || !result || result.status !== 200) {
      sendError(res, 502, "Connectivity collection unavailable");
      return;
    }
    try {
      sendJson(res, 200, JSON.parse(result.body.toString("utf8")));
    } catch (_) {
      sendError(res, 502, "Connectivity collection returned invalid data");
    }
  });
}

function handleConnectivityExport(res, query) {
  const machine = connectivityMachineFor(query.machine);
  if (!machine) {
    sendError(res, 400, "Unknown connectivity machine");
    return;
  }
  const target = new URL("/api/export.csv", connectivityUpstream);
  target.searchParams.set("machine", machine);
  target.searchParams.set("since", String(boundedNumber(query.since, 0, 0, 9e15)));
  target.searchParams.set("until", String(boundedNumber(query.until, 9e15, 0, 9e15)));
  const request = http.get(target, { timeout: connectivityTimeoutMs }, (upstream) => {
    if (upstream.statusCode !== 200) {
      upstream.resume();
      sendError(res, 502, "Connectivity collection unavailable");
      return;
    }
    res.writeHead(200, {
      ...securityHeaders,
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="connectivity-${machine}.csv"`,
    });
    upstream.pipe(res);
  });
  request.on("timeout", () => request.destroy(new Error("Connectivity request timed out")));
  request.on("error", () => {
    if (!res.headersSent) sendError(res, 502, "Connectivity collection unavailable");
    else res.destroy();
  });
  res.on("close", () => request.destroy());
}

function handleRequest(req, res) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const parsed = { pathname: requestUrl.pathname, query: Object.fromEntries(requestUrl.searchParams) };

  if (req.method === "GET" && parsed.pathname === "/api/notes") {
    sendJson(res, 200, readNotes());
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/api/layout") {
    sendJson(res, 200, readLayout());
    return;
  }

  if (req.method === "PUT" && parsed.pathname === "/api/layout") {
    readJsonBody(req, (error, body) => {
      if (error) {
        sendError(res, error.statusCode || 400, error.message);
        return;
      }
      try {
        const layout = normalizeLayout(body || {});
        writeLayout(layout);
        sendJson(res, 200, layout);
      } catch (writeError) {
        console.error(`Layout write failed: ${writeError.message}`);
        sendError(res, 500, "Unable to save layout");
      }
    });
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/api/config") {
    if (!requireAdmin(req, res)) return;
    try {
      sendJson(res, 200, { config: readConfig(), authRequired: Boolean(adminToken) });
    } catch (error) {
      sendError(res, 500, error.message);
    }
    return;
  }

  if (req.method === "POST" && parsed.pathname === "/api/config/aibox") {
    handleConfigMutation(req, res, (body) => mutateConfig((config) => {
      const aibox = validateAibox(config, body);
      config.aiboxes.push(aibox);
    }));
    return;
  }

  if (req.method === "PUT" && parsed.pathname === "/api/config/aibox") {
    handleConfigMutation(req, res, (body) => mutateConfig((config) => {
      const currentId = cleanId(body.currentId || body.id);
      const index = config.aiboxes.findIndex((item) => item.id === currentId);
      if (index === -1) throw new Error("AIBOX not found");
      config.aiboxes[index] = validateAibox(config, body, currentId);
    }));
    return;
  }

  if (req.method === "DELETE" && parsed.pathname === "/api/config/aibox") {
    if (!requireAdmin(req, res)) return;
    try {
      const id = cleanId(parsed.query.id);
      if (!id) throw new Error("Missing AIBOX id");
      sendJson(res, 200, mutateConfig((config) => {
        const next = config.aiboxes.filter((item) => item.id !== id);
        if (next.length === config.aiboxes.length) throw new Error("AIBOX not found");
        config.aiboxes = next;
      }));
    } catch (error) {
      sendError(res, 400, error.message);
    }
    return;
  }

  if (req.method === "POST" && parsed.pathname === "/api/config/camera") {
    handleConfigMutation(req, res, (body) => mutateConfig((config) => {
      const scopeId = cleanId(body.scopeId);
      const ip = cleanId(body.ip);
      const name = cleanId(body.name);
      const scope = config.target_scopes.find((item) => item.id === scopeId);
      if (!scope) throw new Error("Network not found");
      if (!ip || !name) throw new Error("Missing camera fields");
      scope.targets = scope.targets || {};
      if (scope.targets[ip]) throw new Error("Camera IP already exists in this network");
      scope.targets[ip] = name;
    }));
    return;
  }

  if (req.method === "PUT" && parsed.pathname === "/api/config/camera") {
    handleConfigMutation(req, res, (body) => mutateConfig((config) => {
      const scopeId = cleanId(body.scopeId);
      const currentIp = cleanId(body.currentIp || body.ip);
      const ip = cleanId(body.ip);
      const name = cleanId(body.name);
      const scope = config.target_scopes.find((item) => item.id === scopeId);
      if (!scope || !scope.targets || !scope.targets[currentIp]) throw new Error("Camera not found");
      if (!ip || !name) throw new Error("Missing camera fields");
      if (ip !== currentIp && scope.targets[ip]) throw new Error("Camera IP already exists in this network");
      delete scope.targets[currentIp];
      scope.targets[ip] = name;
    }));
    return;
  }

  if (req.method === "DELETE" && parsed.pathname === "/api/config/camera") {
    if (!requireAdmin(req, res)) return;
    try {
      const scopeId = cleanId(parsed.query.scopeId);
      const ip = cleanId(parsed.query.ip);
      if (!scopeId || !ip) throw new Error("Missing camera fields");
      sendJson(res, 200, mutateConfig((config) => {
        const scope = config.target_scopes.find((item) => item.id === scopeId);
        if (!scope || !scope.targets || !scope.targets[ip]) throw new Error("Camera not found");
        delete scope.targets[ip];
      }));
    } catch (error) {
      sendError(res, 400, error.message);
    }
    return;
  }

  if (req.method === "POST" && parsed.pathname === "/api/notes") {
    readJsonBody(req, (error, body) => {
      if (error) {
        sendError(res, error.statusCode || 400, error.message);
        return;
      }
      const ip = String(body.key || body.ip || "").trim();
      const creator = String(body.creator || "").trim();
      const content = String(body.content || "").trim();
      if (!ip || !creator || !content) {
        sendJson(res, 400, { error: "Missing note fields" });
        return;
      }
      try {
        const notes = readNotes();
        const note = { id: noteId(), creator, content, createdAt: new Date().toISOString() };
        const noteList = Array.isArray(notes[ip]) ? notes[ip] : [];
        noteList.push(note);
        notes[ip] = noteList;
        writeNotes(notes);
        sendJson(res, 200, noteList);
      } catch (writeError) {
        console.error(`Note write failed: ${writeError.message}`);
        sendError(res, 500, "Unable to save note");
      }
    });
    return;
  }

  if (req.method === "DELETE" && parsed.pathname === "/api/notes") {
    const ip = String(parsed.query.key || parsed.query.ip || "").trim();
    const targetNoteId = String(parsed.query.noteId || "").trim();
    if (!ip) {
      sendJson(res, 400, { error: "Missing note ip" });
      return;
    }
    if (!targetNoteId) {
      sendJson(res, 400, { error: "Missing note id" });
      return;
    }
    try {
      const notes = readNotes();
      notes[ip] = (Array.isArray(notes[ip]) ? notes[ip] : []).filter((note) => note.id !== targetNoteId);
      if (!notes[ip].length) delete notes[ip];
      writeNotes(notes);
      sendJson(res, 200, { ok: true });
    } catch (writeError) {
      console.error(`Note delete failed: ${writeError.message}`);
      sendError(res, 500, "Unable to delete note");
    }
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/api/connectivity/fleet") {
    handleConnectivityFleet(res);
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/api/connectivity/history") {
    handleConnectivityHistory(res, parsed.query);
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/api/connectivity/export.csv") {
    handleConnectivityExport(res, parsed.query);
    return;
  }

  if (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/")) {
    sendError(res, 404, "API endpoint not found");
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && parsed.pathname === "/aibox-data.json") {
    serveData(req, res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && parsed.pathname.startsWith("/camera-snapshots/")) {
    serveCameraSnapshot(req, res, parsed.pathname);
    return;
  }

  if (parsed.pathname === "/") {
    res.writeHead(302, { Location: `/tv${requestUrl.search}`, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  serveFile(req, res, parsed.pathname || "/");
}

const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (error) {
    console.error(`Request failed: ${error.message}`);
    if (!res.headersSent) sendError(res, 500, "Internal server error");
    else res.destroy();
  }
});

server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(port, host, () => {
  console.log(`AIBOX webapp listening on http://${host}:${port}`);
});

const simTracker = setInterval(() => fetchConnectivityMachines(() => {}), 30000);
simTracker.unref();
