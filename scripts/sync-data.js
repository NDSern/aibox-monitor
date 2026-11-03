const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const monitorRoot = process.env.AIBOX_MONITOR_ROOT || path.join(process.env.HOME, "aibox-monitor");
const configPath = path.join(monitorRoot, "config.json");
const logPath = path.join(monitorRoot, "aibox_monitor.log");
const dataDir = path.join(__dirname, "..", "data");
const historyPath = path.join(dataDir, "status-history.json");
const notifyStatePath = path.join(dataDir, "aibox-notify-state.json");
const availabilityPath = path.join(dataDir, "availability-history.json");
const publicPath = path.join(__dirname, "..", "public", "aibox-data.json");
const distPath = path.join(__dirname, "..", "dist", "aibox-data.json");
const tailBytes = 1024 * 1024 * 2;
const logRetentionDays = Number(process.env.AIBOX_WEBAPP_LOG_RETENTION_DAYS || 7);
const ntfyUrl = process.env.AIBOX_WEBAPP_NTFY_URL || "https://ntfy.sh";
const ntfyTopic = process.env.AIBOX_WEBAPP_NTFY_TOPIC || "";
const ntfyToken = process.env.AIBOX_WEBAPP_NTFY_TOKEN || "";
const notifyDryRun = process.env.AIBOX_WEBAPP_NOTIFY_DRY_RUN === "1";
const availabilityWindowMs = 7 * 24 * 60 * 60 * 1000;
const availabilityRetentionMs = 8 * 24 * 60 * 60 * 1000;

function isValidTime(value) {
  if (!value || /^0001-01-01/.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function olderTime(a, b) {
  if (!isValidTime(a)) return b || null;
  if (!isValidTime(b)) return a || null;
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

function formatLocalTime(value) {
  if (!isValidTime(value)) return "unknown time";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

function writeTextAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, text);
  fs.renameSync(tempPath, filePath);
}

function postNtfy(title, message, status) {
  if (!ntfyTopic && !notifyDryRun) return false;
  const targetUrl = `${ntfyUrl.replace(/\/$/, "")}/${encodeURIComponent(ntfyTopic || "dry-run")}`;
  const tags = status === "online" ? "white_check_mark" : "warning";
  if (notifyDryRun) {
    console.log(`[notify dry-run] ${title} :: ${message}`);
    return true;
  }
  const args = [
    "-fsS",
    "-X", "POST",
    targetUrl,
    "-H", `Title: ${title}`,
    "-H", `Tags: ${tags}`,
    "-H", "Priority: high",
    "--data-binary", message,
  ];
  if (ntfyToken) args.splice(6, 0, "-H", `Authorization: Bearer ${ntfyToken}`);
  try {
    execFileSync("curl", args, { stdio: "ignore", timeout: 10000 });
    return true;
  } catch (error) {
    console.warn(`Failed ntfy notification: ${error.message}`);
    return false;
  }
}

function notifyAiboxTransitions(aiboxes) {
  const state = readJsonSafe(notifyStatePath, { initialized: false, aiboxes: {} });
  const previous = state.aiboxes || {};
  const next = {};
  const initialized = state.initialized === true;
  for (const box of aiboxes) {
    if (box.status !== "online" && box.status !== "offline") continue;
    const old = previous[box.ip];
    next[box.ip] = { name: box.name, status: box.status, statusSince: box.statusSince || null };
    if (!initialized || !old || old.status === box.status) continue;
    const statusText = box.status === "online" ? "online" : "offline";
    const title = `AIBOX ${statusText}: ${box.name}`;
    const message = `${box.name} (${box.ip}) went ${statusText} at ${formatLocalTime(box.statusSince)}.`;
    postNtfy(title, message, box.status);
  }
  writeJsonAtomic(notifyStatePath, { initialized: true, updatedAt: new Date().toISOString(), aiboxes: next });
}

function addAvailabilityEvent(store, group, ip, status, at) {
  if ((status !== "online" && status !== "offline") || !isValidTime(at)) return;
  if (!store[group]) store[group] = {};
  if (!store[group][ip]) store[group][ip] = { events: [] };
  const iso = parseExternalTime(at);
  store[group][ip].events.push({ status, at: iso });
}

function readJournalLines(store) {
  try {
    const sinceDate = new Date(Date.now() - availabilityRetentionMs);
    const since = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, "0")}-${String(sinceDate.getDate()).padStart(2, "0")} ${String(sinceDate.getHours()).padStart(2, "0")}:${String(sinceDate.getMinutes()).padStart(2, "0")}:${String(sinceDate.getSeconds()).padStart(2, "0")}`;
    return execFileSync("journalctl", ["-u", "aibox-monitor.service", "--since", since, "-o", "cat", "--no-pager"], { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const message = `Availability journal backfill unavailable: ${error.message}`;
    console.warn(message);
    if (store) store.backfillErrors.push(message);
    return "";
  }
}

function targetScopeIdsByName(scopes) {
  return Object.fromEntries((scopes || []).map((scope) => [scope.name, scope.id]));
}

function targetStatusKey(event, scopeIds) {
  const scopeId = scopeIds[event.scopeName];
  return scopeId ? `${scopeId}:${event.ip}` : null;
}

function backfillAvailability(store, networks) {
  store.backfillErrors = [];
  const scopeIds = targetScopeIdsByName(networks);
  const logText = readLog(logPath, null);
  const journalText = readJournalLines(store);
  const text = `${logText}\n${journalText}`;
      for (const line of text.split("\n")) {
        const aiboxEvent = parseAiboxStatusLine(line);
        if (aiboxEvent) addAvailabilityEvent(store, "aiboxes", aiboxEvent.ip, aiboxEvent.status, aiboxEvent.at);
        const targetEvent = parseTargetStatusLine(line);
        const key = targetEvent ? targetStatusKey(targetEvent, scopeIds) : null;
        if (key && targetEvent.status !== "unknown") addAvailabilityEvent(store, "targets", key, targetEvent.status, targetEvent.at);
  }
  store.backfilledAt = new Date().toISOString();
  store.backfillSources = [logText ? "log" : null, journalText ? "journal" : null].filter(Boolean);
  store.backfillComplete = store.backfillErrors.length === 0;
}

function pruneAvailabilityEvents(events, nowMs) {
  const cutoff = nowMs - availabilityRetentionMs;
  const sorted = normalizeAvailabilityEvents(events)
    .filter((event) => new Date(event.at).getTime() <= nowMs);
  let baseline = null;
  const fresh = [];
  for (const event of sorted) {
    if (new Date(event.at).getTime() < cutoff) baseline = event;
    else fresh.push(event);
  }
  return normalizeAvailabilityEvents(baseline ? [baseline].concat(fresh) : fresh);
}

function normalizeAvailabilityEvents(events) {
  const sorted = (events || [])
    .filter((event) => event && (event.status === "online" || event.status === "offline") && isValidTime(event.at))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const normalized = [];
  let lastKey = "";
  for (const event of sorted) {
    const at = parseExternalTime(event.at);
    const key = `${at}:${event.status}`;
    if (key === lastKey) continue;
    const previous = normalized[normalized.length - 1];
    if (previous && previous.status === event.status) continue;
    normalized.push({ status: event.status, at });
    lastKey = key;
  }
  return normalized;
}

function updateAvailabilityEntry(entry, status, statusSince, generatedAt, nowMs) {
  if (status !== "online" && status !== "offline") return entry || { events: [] };
  const next = entry || { events: [] };
  next.events = pruneAvailabilityEvents(next.events, nowMs);
  const eventAt = parseExternalTime(statusSince) || generatedAt;
  const lastEvent = next.events[next.events.length - 1];
  const conflicts = lastEvent && new Date(eventAt).getTime() < new Date(lastEvent.at).getTime();
  const observedAt = next.lastStatus === status && isValidTime(next.lastChangedAt) ? next.lastChangedAt : generatedAt;
  const appendAt = conflicts ? (new Date(observedAt).getTime() > new Date(lastEvent.at).getTime() ? observedAt : generatedAt) : eventAt;
  if (conflicts) next.timestampConflict = { statusSince: eventAt, observedAt: appendAt };
  if (!lastEvent || lastEvent.status !== status) next.events.push({ status, at: appendAt });
  next.lastStatus = status;
  next.lastChangedAt = next.events[next.events.length - 1].at;
  next.events = pruneAvailabilityEvents(next.events, nowMs);
  return next;
}

function calculateAvailability(entry, nowMs) {
  const events = pruneAvailabilityEvents(entry ? entry.events : [], nowMs)
    .filter((event) => new Date(event.at).getTime() <= nowMs)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (!events.length) return null;
  const windowStart = nowMs - availabilityWindowMs;
  let status = null;
  let cursor = null;
  let index = 0;
  for (; index < events.length; index += 1) {
    const at = new Date(events[index].at).getTime();
    if (at <= windowStart) status = events[index].status;
    else break;
  }
  if (status) cursor = windowStart;
  else {
    status = events[index] ? events[index].status : events[events.length - 1].status;
    cursor = events[index] ? new Date(events[index].at).getTime() : new Date(events[events.length - 1].at).getTime();
    if (events[index]) index += 1;
  }
  let onlineMs = 0;
  const observedStart = cursor;
  for (; index < events.length; index += 1) {
    const at = Math.min(nowMs, new Date(events[index].at).getTime());
    if (at > cursor && status === "online") onlineMs += at - cursor;
    status = events[index].status;
    cursor = at;
  }
  if (nowMs > cursor && status === "online") onlineMs += nowMs - cursor;
  const totalMs = nowMs - observedStart;
  if (totalMs <= 0) return null;
  return { percent: Math.max(0, Math.min(100, (onlineMs / totalMs) * 100)), observedMs: totalMs };
}

function applyAvailability(payload, generatedAt) {
  const nowMs = new Date(generatedAt).getTime();
  const forceBackfill = process.env.AIBOX_WEBAPP_FORCE_AVAILABILITY_BACKFILL === "1";
  const store = forceBackfill ? { aiboxes: {}, targets: {} } : readJsonSafe(availabilityPath, { aiboxes: {}, targets: {} });
  if (!store.backfilledAt || forceBackfill) backfillAvailability(store, payload.networks);
  store.aiboxes = store.aiboxes || {};
  store.targets = store.targets || {};
  const activeAiboxIps = new Set(payload.aiboxes.map((box) => box.ip));
  for (const box of payload.aiboxes) {
    store.aiboxes[box.ip] = updateAvailabilityEntry(store.aiboxes[box.ip], box.status, box.statusSince, generatedAt, nowMs);
    const availability = calculateAvailability(store.aiboxes[box.ip], nowMs);
    if (availability !== null) {
      box.availability = availability.percent;
      box.availabilityObservedMs = availability.observedMs;
    }
  }
  for (const ip of Object.keys(store.aiboxes)) {
    if (!activeAiboxIps.has(ip)) delete store.aiboxes[ip];
  }
  const activeCameraIps = new Set();
  const activeCameraKeys = new Set();
  for (const network of payload.networks) {
    for (const camera of network.cameras || []) {
      const key = `${network.id}:${camera.ip}`;
      activeCameraIps.add(camera.ip);
      activeCameraKeys.add(key);
      if (camera.status !== "online" && camera.status !== "offline") {
        continue;
      }
      const existing = store.targets[key] || store.targets[camera.ip];
      store.targets[key] = updateAvailabilityEntry(existing, camera.status, camera.statusSince, generatedAt, nowMs);
      const availability = calculateAvailability(store.targets[key], nowMs);
      if (availability !== null) {
        camera.availability = availability.percent;
        camera.availabilityObservedMs = availability.observedMs;
      }
    }
  }
  for (const key of Object.keys(store.targets || {})) {
    if (!key.includes(":") && activeCameraIps.has(key)) delete store.targets[key];
    if (key.includes(":") && !activeCameraKeys.has(key)) delete store.targets[key];
  }
  for (const group of ["aiboxes", "targets"]) {
    for (const key of Object.keys(store[group] || {})) {
      store[group][key].events = pruneAvailabilityEvents(store[group][key].events, nowMs);
    }
  }
  store.updatedAt = generatedAt;
  writeJsonAtomic(availabilityPath, store);
  return store;
}

function readLogTail(filePath, maxBytes) {
  if (!fs.existsSync(filePath)) return "";
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.statSync(filePath).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readLog(filePath, maxBytes) {
  if (maxBytes === null) return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  return readLogTail(filePath, maxBytes);
}

function parseLogTime(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3})/);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}.${match[3]}+07:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseExternalTime(value) {
  if (!isValidTime(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function updateStatus(statuses, ip, status, timestamp, resetSince) {
  const current = statuses[ip];
  if (!current || current.status !== status || resetSince) {
    statuses[ip] = { status, statusSince: timestamp || null, resetSeen: Boolean(resetSince) };
    return;
  }
  if (!current.statusSince && timestamp) current.statusSince = timestamp;
}

const CAMERA_LAG_MINIMUM = 5;

function updateTargetStatus(statuses, ip, event) {
  const current = statuses[ip];
  if (event.status === "unknown") {
    statuses[ip] = { ...(current || {}), status: "unknown", method: "unknown" };
    return;
  }
  const reset = event.reset || !current || (current.status !== event.status && event.status !== "unknown");
  updateStatus(statuses, ip, event.status, event.at, reset);
  if (statuses[ip]) {
    statuses[ip].method = event.method || "ping";
    if (event.valid != null && event.status === "online") {
      statuses[ip].valid = event.valid;
      statuses[ip].validTotal = event.validTotal;
      statuses[ip].quality = event.valid < CAMERA_LAG_MINIMUM ? "lagging" : "ok";
    } else {
      delete statuses[ip].valid;
      delete statuses[ip].validTotal;
      delete statuses[ip].quality;
    }
  }
}

function parseAiboxStatusLine(line) {
  const timestamp = parseLogTime(line);
  let match = line.match(/(Initial AIBOX state|AIBOX unchanged|AIBOX status changed): .*?\(([^)]+)\) is (online|offline)/);
  if (match) return { ip: match[2], status: match[3], at: timestamp, reset: match[1] === "AIBOX status changed" };
  match = line.match(/AIBOX offline: .*?\(([^)]+)\)/);
  if (match) return { ip: match[1], status: "offline", at: timestamp, reset: true };
  match = line.match(/AIBOX back online: .*?\(([^)]+)\)/);
  if (match) return { ip: match[1], status: "online", at: timestamp, reset: true };
  return null;
}

function parseTargetStatusLine(line) {
  const timestamp = parseLogTime(line);
  const validMatch = line.match(/\[valid=(\d+)\/(\d+)\]/);
  const valid = validMatch ? { valid: Number(validMatch[1]), validTotal: Number(validMatch[2]) } : {};
  let match = line.match(/(Initial target state|Target unchanged) from (.*?): .*?\(([^)]+)\) is (online|offline)(?: \[method=([^\]]+)\])?/);
  if (match) return { scopeName: match[2], ip: match[3], status: match[4], method: match[5] || "ping", ...valid, at: timestamp, reset: false };
  match = line.match(/Target state unknown from (.*?): .*?\(([^)]+)\)/);
  if (match) return { scopeName: match[1], ip: match[2], status: "unknown", method: "unknown", at: timestamp, reset: false };
  match = line.match(/Target offline from (.*?): .*?\(([^)]+)\)/);
  if (match) return { scopeName: match[1], ip: match[2], status: "offline", method: (line.match(/\[method=([^\]]+)\]/) || [])[1] || "ping", ...valid, at: timestamp, reset: true };
  match = line.match(/Target back online from (.*?): .*?\(([^)]+)\)/);
  if (match) return { scopeName: match[1], ip: match[2], status: "online", method: (line.match(/\[method=([^\]]+)\]/) || [])[1] || "ping", ...valid, at: timestamp, reset: true };
  return null;
}

function parseScopeStatusLine(line, scopeIds) {
  const timestamp = parseLogTime(line);
  let match = line.match(/Target checks started from (.*?): \d+ target\(s\)$/);
  if (match && scopeIds[match[1]]) {
    return { id: scopeIds[match[1]], status: "checking", at: timestamp, reset: false };
  }
  match = line.match(/Target checks completed from (.*?): \d+ target\(s\)$/);
  if (match && scopeIds[match[1]]) {
    return { id: scopeIds[match[1]], status: "online", at: timestamp, reset: false, complete: true };
  }
  match = line.match(/Target checks unavailable from (.*?): no checker available$/);
  if (match && scopeIds[match[1]]) {
    return { id: scopeIds[match[1]], status: "unknown", at: timestamp, reset: false, complete: true };
  }
  const targetEvent = parseTargetStatusLine(line);
  if (targetEvent && targetEvent.status !== "unknown" && scopeIds[targetEvent.scopeName]) {
    return { id: scopeIds[targetEvent.scopeName], status: "online", at: timestamp, reset: false, complete: false };
  }
  match = line.match(/Skipping target checks because no checker is available: (.+)$/);
  if (match && scopeIds[match[1]]) {
    return { id: scopeIds[match[1]], status: "unknown", at: timestamp, reset: false };
  }
  return null;
}

function publicStatus(entry) {
  return entry ? { status: entry.status, statusSince: entry.statusSince || null, ...(entry.method ? { method: entry.method } : {}), ...(entry.quality ? { quality: entry.quality, valid: entry.valid, validTotal: entry.validTotal } : {}) } : entry;
}

function mergeStatusCache(current, cached) {
  const merged = {};
  for (const ip of Object.keys(cached || {})) {
    merged[ip] = publicStatus(cached[ip]);
  }
  for (const ip of Object.keys(current)) {
    const cacheEntry = cached[ip];
    const currentEntry = current[ip];
      merged[ip] = publicStatus(currentEntry);
    if (!cacheEntry || currentEntry.resetSeen || cacheEntry.status !== currentEntry.status || !cacheEntry.statusSince) continue;
    if (!currentEntry.statusSince || new Date(cacheEntry.statusSince).getTime() < new Date(currentEntry.statusSince).getTime()) {
      merged[ip] = { ...publicStatus(currentEntry), statusSince: cacheEntry.statusSince };
    }
  }
  return merged;
}

function latestStatusSnapshot(text, scopeIds, scopeHistory) {
  const aiboxes = {};
  const targets = {};
  const scopes = {};
  const unavailableScopes = new Set(Object.entries(scopeHistory || {})
    .filter(([, entry]) => entry.status === "unknown")
    .map(([id]) => id));
  const checkingScopes = new Set();
  for (const line of text.split("\n")) {
    const aiboxEvent = parseAiboxStatusLine(line);
    if (aiboxEvent) updateStatus(aiboxes, aiboxEvent.ip, aiboxEvent.status, aiboxEvent.at, aiboxEvent.reset);

    const scopeEvent = parseScopeStatusLine(line, scopeIds);
    if (scopeEvent && scopeEvent.status === "unknown") unavailableScopes.add(scopeEvent.id);
    if (scopeEvent && scopeEvent.status === "online") unavailableScopes.delete(scopeEvent.id);
    if (scopeEvent) {
      if (scopeEvent.status === "checking") {
        checkingScopes.add(scopeEvent.id);
      } else {
        if (scopeEvent.complete || scopeEvent.status === "unknown") checkingScopes.delete(scopeEvent.id);
        if (!(scopeEvent.status === "online" && checkingScopes.has(scopeEvent.id))) {
          const current = scopes[scopeEvent.id];
          updateStatus(scopes, scopeEvent.id, scopeEvent.status, scopeEvent.at, scopeEvent.reset || Boolean(current && current.status !== scopeEvent.status));
        }
      }
    }

    const targetEvent = parseTargetStatusLine(line);
    const key = targetEvent ? targetStatusKey(targetEvent, scopeIds) : null;
    const scopeId = targetEvent ? scopeIds[targetEvent.scopeName] : null;
    if (key) {
      updateTargetStatus(targets, key, targetEvent);
    }
  }
  for (const scopeId of unavailableScopes) {
    if (scopes[scopeId] && scopes[scopeId].status === "online") scopes[scopeId] = { ...scopes[scopeId], status: "unknown" };
  }
  return { aiboxes, targets, scopes };
}

function loadStatusHistory() {
  const history = readJsonSafe(historyPath, { aiboxes: {}, targets: {}, scopes: {} });
  return {
    aiboxes: history.aiboxes || {},
    targets: history.targets || {},
    scopes: history.scopes || {},
  };
}

function buildStatusHistory(config) {
  const history = loadStatusHistory();
  const needsFullScan = !fs.existsSync(historyPath) || process.env.AIBOX_WEBAPP_FORCE_STATUS_BACKFILL === "1";
  const scanBytes = needsFullScan ? null : tailBytes;
  const scopeIds = targetScopeIdsByName(config.target_scopes);
  const latest = latestStatusSnapshot(readLog(logPath, scanBytes), scopeIds, history.scopes);
  const aiboxes = mergeStatusCache(latest.aiboxes, history.aiboxes);
  const targets = mergeStatusCache(latest.targets, history.targets);
  for (const [key, event] of Object.entries(latest.targets)) {
    if (event.status === "unknown" && targets[key]) targets[key] = { ...targets[key], status: "unknown", method: "unknown" };
  }
  const scopes = mergeStatusCache(latest.scopes, history.scopes);
  const activeAiboxIps = new Set((config.aiboxes || []).map((box) => box.ip));
  for (const ip of Object.keys(aiboxes)) {
    if (!activeAiboxIps.has(ip)) delete aiboxes[ip];
  }
  const activeTargetKeys = new Set((config.target_scopes || []).flatMap((scope) => Object.keys(scope.targets || {}).map((ip) => `${scope.id}:${ip}`)));
  for (const key of Object.keys(targets)) {
    const scopeId = key.split(":", 1)[0];
    if (!activeTargetKeys.has(key) || (scopes[scopeId] && scopes[scopeId].status === "unknown" && targets[key].status !== "unknown")) delete targets[key];
  }
  for (const key of Object.keys(scopes)) {
    if (!Object.values(scopeIds).includes(key)) delete scopes[key];
  }
  return { aiboxes, targets, scopes };
}

function loadTailscaleStatuses() {
  if (process.env.AIBOX_WEBAPP_DISABLE_TAILSCALE_STATUS === "1") return {};
  try {
    const output = execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 5000 });
    const data = JSON.parse(output);
    const statuses = {};
    const peers = data.Peer || {};
    for (const peer of Object.values(peers)) {
      const ips = peer.TailscaleIPs || [];
      const ipv4 = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      if (!ipv4) continue;
      const online = peer.Online === true;
      statuses[ipv4] = {
        status: online ? "online" : "offline",
        statusSince: online ? null : parseExternalTime(peer.LastSeen),
        source: "tailscale",
      };
    }
    return statuses;
  } catch (error) {
    console.warn(`Tailscale status unavailable: ${error.message}`);
    return {};
  }
}

function mergeTailscaleDurations(statuses, tailscaleStatuses) {
  const merged = { ...statuses };
  for (const ip of Object.keys(tailscaleStatuses)) {
    const ts = tailscaleStatuses[ip];
    const current = merged[ip];
    if (!current || current.status !== ts.status) continue;
    merged[ip] = { status: current.status, statusSince: olderTime(current.statusSince, ts.statusSince) };
  }
  return merged;
}

function pruneOldLogs() {
  if (!Number.isFinite(logRetentionDays) || logRetentionDays < 0 || !fs.existsSync(monitorRoot)) return;
  const cutoff = Date.now() - logRetentionDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(monitorRoot)) {
    if (!/^aibox_monitor\.log\./.test(entry)) continue;
    const filePath = path.join(monitorRoot, entry);
    const stats = fs.statSync(filePath);
    if (stats.mtime.getTime() < cutoff) {
      fs.unlinkSync(filePath);
      console.log(`Deleted old log ${filePath}`);
    }
  }
}

function aiboxStatus(box, statuses) {
  return statuses[box.ip] ? statuses[box.ip].status : "unknown";
}

function aiboxStatusSince(box, statuses) {
  return statuses[box.ip] ? statuses[box.ip].statusSince : null;
}

function networkMonitorAiboxes(scopeId, aiboxes, statuses) {
  return aiboxes
    .filter((box) => box["check-devices"] !== false)
    .filter((box) => (box.networks || []).includes(scopeId))
    .map((box) => ({
      name: box.name,
      ip: box.ip,
      status: aiboxStatus(box, statuses),
      statusSince: aiboxStatusSince(box, statuses),
    }));
}

function networkUnavailableSince(monitors, fallback) {
  const times = monitors
    .map((monitor) => monitor.statusSince)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => !Number.isNaN(value));
  if (!times.length) return fallback;
  return new Date(Math.max(...times)).toISOString();
}

const TV_EVENT_LIMIT = 40;
const TV_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TV_STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;

function buildTvEventData(store, payload, config, nowMs) {
  const aiboxNames = new Map((config.aiboxes || []).map((box) => [box.ip, box.name]));
  const activeAiboxes = new Set((payload.aiboxes || []).map((box) => box.ip));
  const scopeById = new Map((config.target_scopes || []).map((scope) => [scope.id, scope]));
  const cameraMethods = new Map();
  for (const network of payload.networks || []) {
    for (const camera of network.cameras || []) {
      cameraMethods.set(`${network.id}:${camera.ip}`, camera.method);
    }
  }
  const events = [];
  const timelines = [];
  for (const [ip, entry] of Object.entries((store && store.aiboxes) || {})) {
    if (!activeAiboxes.has(ip)) continue;
    const normalized = normalizeAvailabilityEvents(entry && entry.events);
    timelines.push({ kind: "aibox", events: normalized });
    normalized.forEach((event, index) => {
      if (new Date(event.at).getTime() > nowMs) return;
      events.push({ at: event.at, kind: "aibox", change: event.status === "offline" ? "offline" : "online",
        name: aiboxNames.get(ip) || ip, ip, deviceKey: ip, transition: index > 0 });
    });
  }
  for (const [key, entry] of Object.entries((store && store.targets) || {})) {
    const separator = key.indexOf(":");
    if (separator < 0) continue;
    const scopeId = key.slice(0, separator);
    const ip = key.slice(separator + 1);
    const scope = scopeById.get(scopeId);
    if (!scope || !cameraMethods.has(key)) continue;
    const method = cameraMethods.get(key);
    const normalized = normalizeAvailabilityEvents(entry && entry.events);
    timelines.push({ kind: "camera", events: normalized });
    normalized.forEach((event, index) => {
      if (new Date(event.at).getTime() > nowMs) return;
      events.push({ at: event.at, kind: "camera", change: event.status === "offline" ? "offline" : "online",
        scope: scope.name, name: (scope.targets || {})[ip] || ip, ip, ...(method ? { method } : {}),
        deviceKey: key, transition: index > 0 });
    });
  }
  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  const windowStart = nowMs - TV_CHANGE_WINDOW_MS;
  const hourMs = 60 * 60 * 1000;
  const changed = { aibox: new Set(), camera: new Set() };
  const statusStart = nowMs - TV_STATUS_WINDOW_MS;
  const buckets = Array.from({ length: Math.round(TV_STATUS_WINDOW_MS / hourMs) }, (_, index) => ({
    from: new Date(statusStart + index * hourMs).toISOString(),
    to: new Date(statusStart + (index + 1) * hourMs).toISOString(),
  }));
  for (const event of events) {
    const at = new Date(event.at).getTime();
    if (!event.transition || at < windowStart || at > nowMs) continue;
    changed[event.kind].add(event.deviceKey);
  }
  return {
    recentEvents: events.slice(0, TV_EVENT_LIMIT).map(({ deviceKey, transition, ...event }) => event),
    changeCounts: { windowHours: 24, from: new Date(windowStart).toISOString(), to: new Date(nowMs).toISOString(),
      aiboxes: changed.aibox.size, cameras: changed.camera.size },
    statusSeries: buckets.map(({ from, to }) => {
      const endMs = new Date(to).getTime();
      const point = { from, to, aiboxOnline: 0, aiboxOffline: 0, cameraOnline: 0, cameraOffline: 0 };
      for (const timeline of timelines) {
        let status = null;
        for (const event of timeline.events) {
          if (new Date(event.at).getTime() > endMs) break;
          status = event.status;
        }
        if (status) point[`${timeline.kind}${status === "online" ? "Online" : "Offline"}`] += 1;
      }
      return point;
    }),
  };
}

function normalize(config) {
  if (config.version !== 2) {
    throw new Error("Only v2 monitor config is supported by this webapp");
  }

  const groups = config.recipient_groups || {};
  const defaultGroup = config.default_status_recipient_group || "aibox_report";
  const defaultRecipients = config.default_recipients || [];
  const history = buildStatusHistory(config);
  const targetStatuses = history.targets;
  const scopeStatuses = history.scopes;
  const statuses = mergeTailscaleDurations(history.aiboxes, loadTailscaleStatuses());
  writeJsonAtomic(historyPath, { updatedAt: new Date().toISOString(), fullScanCompleted: true, aiboxes: statuses, targets: targetStatuses, scopes: scopeStatuses });
  const generatedAt = new Date().toISOString();
  const sourceUpdatedAt = fs.existsSync(logPath) ? fs.statSync(logPath).mtime.toISOString() : null;
  const enabledNetworkIds = new Set((config.aiboxes || [])
    .filter((box) => box["check-devices"] !== false)
    .flatMap((box) => box.networks || []));

  const payload = {
    generatedAt,
    sourceUpdatedAt,
    aiboxes: (config.aiboxes || []).map((box) => {
      const group = box.status_recipient_group || defaultGroup;
      return {
        name: box.name,
        ip: box.ip,
        checkDevices: box["check-devices"] !== false,
        checkResource: box["check-resource"] !== false,
        networks: box.networks || [],
        monitors: groups[group] || [],
        status: statuses[box.ip] ? statuses[box.ip].status : "unknown",
        statusSince: statuses[box.ip] ? statuses[box.ip].statusSince : null,
      };
    }),
    networks: (config.target_scopes || []).filter((scope) => enabledNetworkIds.has(scope.id)).map((scope) => {
      const monitorAiboxes = networkMonitorAiboxes(scope.id, config.aiboxes || [], statuses);
      const scopeStatus = scopeStatuses[scope.id];
      const monitorsUnavailable = monitorAiboxes.length > 0 && monitorAiboxes.every((box) => box.status !== "online");
      const scopeUnavailable = monitorsUnavailable || (scopeStatus && scopeStatus.status === "unknown");
      const unavailableSince = scopeStatus && scopeStatus.status === "unknown"
        ? scopeStatus.statusSince
        : scopeUnavailable ? networkUnavailableSince(monitorAiboxes, generatedAt) : null;
      return {
        id: scope.id,
        name: scope.name,
        monitorStatus: scopeUnavailable ? "unknown" : "online",
        monitorStatusSince: scopeUnavailable ? unavailableSince : scopeStatus ? scopeStatus.statusSince : null,
        monitorAiboxes,
        monitors: scope.recipients || defaultRecipients,
        cameras: Object.entries(scope.targets || {}).map(([ip, name]) => {
          const targetStatus = targetStatuses[`${scope.id}:${ip}`];
          return {
            ip,
            name,
            status: scopeUnavailable ? "unknown" : targetStatus ? targetStatus.status : "unknown",
            statusSince: scopeUnavailable ? unavailableSince : targetStatus ? targetStatus.statusSince : null,
            method: targetStatus ? targetStatus.method || "ping" : "ping",
            ...(targetStatus && targetStatus.quality ? { quality: targetStatus.quality, valid: targetStatus.valid, validTotal: targetStatus.validTotal } : {}),
          };
        }),
      };
    }),
  };
  const availabilityStore = applyAvailability(payload, generatedAt);
  Object.assign(payload, buildTvEventData(availabilityStore, payload, config, new Date(generatedAt).getTime()));
  return payload;
}

const normalized = normalize(readJson(configPath));
notifyAiboxTransitions(normalized.aiboxes);
const payload = JSON.stringify(normalized, null, 2);
writeTextAtomic(publicPath, payload);
if (fs.existsSync(path.dirname(distPath))) writeTextAtomic(distPath, payload);
pruneOldLogs();
console.log(`Wrote ${publicPath}`);
