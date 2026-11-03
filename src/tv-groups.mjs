const SITES = [
  { id: "mxa", label: "MXA" },
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
