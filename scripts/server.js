const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");
const childProcess = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const dataDir = path.join(rootDir, "data");
const notesPath = path.join(dataDir, "notes.json");
const layoutPath = path.join(dataDir, "layout.json");
const monitorRoot = process.env.AIBOX_MONITOR_ROOT || path.join(process.env.HOME || "/home/boxtest2", "aibox-monitor");
const configPath = path.join(monitorRoot, "config.json");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 5173);
const adminToken = process.env.AIBOX_WEBAPP_ADMIN_TOKEN || "";
const syncLockPath = "/tmp/aibox-monitor-webapp-sync.lock";

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
  if (!fs.existsSync(notesPath)) fs.writeFileSync(notesPath, "{}\n");
}

function ensureLayoutFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(layoutPath)) fs.writeFileSync(layoutPath, "{\"aiboxOrder\":[]}\n");
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
    return {};
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
  const normalized = {};
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
  fs.writeFileSync(notesPath, `${JSON.stringify(notes, null, 2)}\n`);
}

function normalizeStringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function normalizeLayout(layout) {
  const cameraOrder = {};
  const sourceCameraOrder = layout && layout.cameraOrder && typeof layout.cameraOrder === "object" && !Array.isArray(layout.cameraOrder)
    ? layout.cameraOrder
    : {};
  Object.keys(sourceCameraOrder).forEach((networkId) => {
    cameraOrder[String(networkId)] = normalizeStringList(sourceCameraOrder[networkId]);
  });
  return {
    aiboxOrder: normalizeStringList(layout && layout.aiboxOrder),
    cameraOrder,
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
    return { aiboxOrder: [], cameraOrder: {} };
  }
}

function writeLayout(layout) {
  ensureLayoutFile();
  fs.writeFileSync(layoutPath, `${JSON.stringify(normalizeLayout(layout), null, 2)}\n`);
}

function readJsonBody(req, callback) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
      if (body.length > 100000) req.destroy();
  });
  req.on("end", () => {
    try {
      callback(null, body ? JSON.parse(body) : {});
    } catch (error) {
      callback(error);
    }
  });
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
      sendError(res, 400, "Invalid JSON");
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
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(`${JSON.stringify(data)}\n`);
}

function serveFile(res, pathname) {
  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const requested = path.join(distDir, safePath || "index.html");
  const filePath = requested.startsWith(distDir) && fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : path.join(distDir, "index.html");
  const ext = path.extname(filePath);
  const headers = { "Content-Type": mimeTypes[ext] || "application/octet-stream" };
  if (filePath.endsWith("index.html") || filePath.endsWith("aibox-data.json")) {
    headers["Cache-Control"] = "no-store, max-age=0";
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function serveData(res) {
  serveFile(res, "/aibox-data.json");
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || "/", true);

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
        sendJson(res, 400, { error: "Invalid JSON" });
        return;
      }
      const layout = normalizeLayout(body || {});
      writeLayout(layout);
      sendJson(res, 200, layout);
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
        sendJson(res, 400, { error: "Invalid JSON" });
        return;
      }
      const ip = String(body.key || body.ip || "").trim();
      const creator = String(body.creator || "").trim();
      const content = String(body.content || "").trim();
      if (!ip || !creator || !content) {
        sendJson(res, 400, { error: "Missing note fields" });
        return;
      }
      const notes = readNotes();
      const note = { id: noteId(), creator, content, createdAt: new Date().toISOString() };
      notes[ip] = notes[ip] || [];
      notes[ip].push(note);
      writeNotes(notes);
      sendJson(res, 200, notes[ip]);
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
    const notes = readNotes();
    notes[ip] = (notes[ip] || []).filter((note) => note.id !== targetNoteId);
    if (!notes[ip].length) delete notes[ip];
    writeNotes(notes);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/aibox-data.json") {
    serveData(res);
    return;
  }

  serveFile(res, parsed.pathname || "/");
});

server.listen(port, host, () => {
  console.log(`AIBOX webapp listening on http://${host}:${port}`);
});
