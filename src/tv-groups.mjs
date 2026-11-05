const SITES = [
  { id: "mxa", label: "Mỹ Xuân A" },
  { id: "giaminh", label: "Gia Minh" },
  { id: "ships", label: "Tàu" },
  { id: "other", label: "VNPost" },
];

function classifyText(value) {
  const text = String(value || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const compact = text.replace(/ /g, "");
  if (/myxuan|mxa/.test(compact)) return "mxa";
  if (/giaminh/.test(compact)) return "giaminh";
  if (/starcity|oceanus|neptune|poseidon/.test(compact)
    || /\b(?:tau|ships?)\b/.test(text)
    || /\bt[dh]\s*\d+\b/.test(text)) return "ships";
  return "other";
}

function summarize(items) {
  const measured = items.filter((item) => Number.isFinite(item.availability));
  const online = items.filter((item) => item.status === "online").length;
  const offline = items.filter((item) => item.status === "offline").length;
  return {
    total: items.length,
    online,
    offline,
    unknown: items.length - online - offline,
    lagging: items.filter((item) => item.kind === "camera" && item.status === "online" && item.quality === "lagging").length,
    availability: measured.length ? measured.reduce((sum, item) => sum + item.availability, 0) / measured.length : null,
    measured: measured.length,
  };
}

function aiboxSite(box, networkLookup) {
  const assignments = Array.isArray(box.networks) ? box.networks : [];
  const sites = assignments.map((id) => classifyText(`${id} ${networkLookup.get(id)?.name || ""}`));
  return SITES.find((item) => item.id !== "other" && sites.includes(item.id))?.id || classifyText(box.name);
}

export function buildTvSiteLabels(data) {
  const networks = Array.isArray(data.networks) ? data.networks : [];
  const aiboxes = Array.isArray(data.aiboxes) ? data.aiboxes : [];
  const networkLookup = new Map(networks.map((network) => [network.id, network]));
  const labels = new Map(SITES.map((site) => [site.id, site.label]));
  return new Map(aiboxes.map((box) => [box.ip, labels.get(aiboxSite(box, networkLookup))]));
}

export function buildTvOfflineNetworks(data) {
  const networks = Array.isArray(data.networks) ? data.networks : [];
  const labels = new Map(SITES.map((site) => [site.id, site.label]));
  return networks.map((network) => {
    const cameras = Array.isArray(network.cameras) ? network.cameras : [];
    const offline = cameras.filter((camera) => camera.status === "offline");
    const since = offline.map((camera) => Date.parse(camera.statusSince)).filter(Number.isFinite);
    return {
      id: network.id,
      name: network.name || network.id,
      site: labels.get(classifyText(`${network.id || ""} ${network.name || ""}`)),
      offline: offline.length,
      total: cameras.length,
      statusSince: since.length ? new Date(Math.min(...since)).toISOString() : "",
    };
  }).filter((network) => network.offline)
    .sort((a, b) => (Date.parse(a.statusSince) || Infinity) - (Date.parse(b.statusSince) || Infinity));
}

const OFFLINE_REASONS = [
  { id: "power", label: "Mất nguồn" },
  { id: "network", label: "Mất mạng" },
  { id: "unknown", label: "Chưa rõ" },
];

function checkerUnavailable(network) {
  const monitors = Array.isArray(network.monitorAiboxes) ? network.monitorAiboxes : [];
  if (monitors.length) return monitors.every((box) => box && box.status !== "online");
  return network.monitorStatus === "offline";
}

// Group offline cameras by plausible cause. Each camera is counted at most
// once; stale capture evidence is not an offline cause, so it is omitted.
export function offlineReasonId(camera, checkerDown) {
  if (!camera || camera.status === "online") return null;
  // The checker reached the camera but got no frame: power, not network.
  if (camera.status === "image_unavailable") return "power";
  // Stale/unknown capture evidence is not a cause.
  if (camera.method === "image_capture") return null;
  // The checker answered but its camera LAN route was down, so the camera was
  // never observed: that is a network fault, not a power fault.
  if (camera.method === "lan-down") return "network";
  // A blind checker cannot distinguish causes, so the network is the suspect.
  if (checkerDown) return "network";
  if (camera.method === "image") return "power";
  if (camera.status === "offline") return "network";
  return "unknown";
}
export function buildTvOfflineReasons(data) {
  const networks = Array.isArray(data.networks) ? data.networks : [];
  const reasons = new Map(OFFLINE_REASONS.map((reason) => [reason.id, {
    ...reason, count: 0, sites: new Map(),
  }]));

  networks.forEach((network) => {
    const siteId = classifyText(`${network.id || ""} ${network.name || ""}`);
    const siteLabel = SITES.find((site) => site.id === siteId)?.label || "VNPost";
    const checkerDown = checkerUnavailable(network);
    const cameras = Array.isArray(network.cameras) ? network.cameras : [];
    cameras.forEach((camera) => {
      if (!camera || camera.status === "online") return;
      if (camera.method === "image_capture" && camera.status !== "image_unavailable") return;
      const reasonId = offlineReasonId(camera, checkerDown);
      const reason = reasons.get(reasonId);
      reason.count += 1;
      reason.sites.set(siteLabel, (reason.sites.get(siteLabel) || 0) + 1);
    });
  });

  return [...reasons.values()]
    .filter((reason) => reason.count > 0)
    .map((reason) => ({
      id: reason.id,
      label: reason.label,
      count: reason.count,
      sites: [...SITES.map((site) => site.label), "VNPost"]
        .filter((label, index, labels) => labels.indexOf(label) === index && reason.sites.has(label))
        .map((label) => ({ label, count: reason.sites.get(label) })),
    }));
}

// AIBOX offline causes, from boot evidence collected after the box came back.
// A box that is down right now has no evidence yet, so it stays "unknown"
// until it reconnects and the probe can read its boot session.
export function buildAiboxOfflineReasons(data) {
  const networks = Array.isArray(data.networks) ? data.networks : [];
  const aiboxes = Array.isArray(data.aiboxes) ? data.aiboxes : [];
  const networkLookup = new Map(networks.map((network) => [network.id, network]));
  const bySite = new Map();
  aiboxes.forEach((box) => {
    if (!box || box.status === "online") return;
    const site = aiboxSite(box, networkLookup);
    const label = SITES.find((item) => item.id === site)?.label || "VNPost";
    // Only a cause that still describes the present outage may be shown. A
    // cause from an older, already-closed outage is history, not current state.
    // `currentCause` is explicitly null when the verdict is stale, so a null
    // must NOT fall back to lastOutageCause: `??` would resurrect the old cause
    // and label an unknown outage with it. Fall back only when the field was
    // never written at all.
    const boot = box.boot || {};
    const cause = boot.currentCause === undefined
      ? boot.lastOutageCause
      : boot.currentCause;
    const key = cause === "power" || cause === "network" ? cause : "unknown";
    const entry = bySite.get(label) || { power: 0, network: 0, unknown: 0 };
    entry[key] += 1;
    bySite.set(label, entry);
  });
  return bySite;
}

export function buildTvGroups(data) {
  const networks = Array.isArray(data.networks) ? data.networks : [];
  const aiboxes = Array.isArray(data.aiboxes) ? data.aiboxes : [];
  const networkLookup = new Map(networks.map((network) => [network.id, network]));
  const groups = new Map(SITES.map((site) => [site.id, { ...site, machines: [], cameras: [] }]));

  aiboxes.forEach((box) => {
    const assignments = Array.isArray(box.networks) ? box.networks : [];
    const site = aiboxSite(box, networkLookup);
    const scope = assignments.map((id) => networkLookup.get(id)?.name || id).join(" · ");
    groups.get(site).machines.push({ ...box, kind: "aibox", scope });
  });

  networks.forEach((network) => {
    const site = classifyText(`${network.id || ""} ${network.name || ""}`);
    const cameras = Array.isArray(network.cameras) ? network.cameras : [];
    cameras.forEach((camera) => groups.get(site).cameras.push({
      ...camera, kind: "camera", scope: network.name || network.id,
    }));
  });

  return [...groups.values()].map((group) => {
    let longestOutage = null;
    let oldest = Infinity;
    let undatedOffline = 0;
    [...group.machines, ...group.cameras].forEach((item) => {
      if (item.status !== "offline") return;
      const since = item.statusSince ? Date.parse(item.statusSince) : NaN;
      if (!Number.isFinite(since)) {
        undatedOffline += 1;
      } else if (since < oldest) {
        oldest = since;
        longestOutage = {
          kind: item.kind, name: item.name, ip: item.ip, scope: item.scope, statusSince: item.statusSince,
        };
      }
    });
    return {
      id: group.id,
      label: group.label,
      machines: summarize(group.machines),
      cameras: summarize(group.cameras),
      longestOutage,
      undatedOffline,
    };
  });
}
