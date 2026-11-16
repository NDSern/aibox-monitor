// Cameras discovered locally on boxes that were offline during the archive
// rollout. Monitor config is still the primary camera source; this only adds
// cameras the timelapse view would otherwise never know about.
//
// Matching is by (scope, IP) so a camera already present keeps its configured
// name, order and network placement. Discovered cameras have no health data,
// so their status stays unknown until the monitor reports them.

const UNKNOWN = "unknown";

function cameraKey(ip) {
  return String(ip || "").trim();
}

/**
 * Merge discovered archive cameras into the configured network list.
 *
 * @param {Array} networks networks from aibox-data.json
 * @param {Object|null} inventory payload from /camera-archive-inventory.json
 * @returns {Array} new array; input objects are never mutated
 */
export function mergeArchiveInventory(networks, inventory) {
  const list = Array.isArray(networks) ? networks : [];
  const scopes = inventory && typeof inventory === "object" ? inventory.scopes : null;
  if (!scopes || typeof scopes !== "object") return list;

  const merged = list.map((network) => ({ ...network, cameras: [...(network.cameras || [])] }));
  const byId = new Map(merged.map((network, index) => [network.id, index]));

  Object.entries(scopes).forEach(([scopeId, scope]) => {
    const entries = Array.isArray(scope?.cameras) ? scope.cameras : [];
    if (!entries.length) return;

    const index = byId.get(scopeId);
    if (index === undefined) {
      // Unknown scope: keep the cameras reachable instead of dropping them.
      merged.push({
        id: scopeId,
        name: scope?.device ? `${scope.device} (lưu trữ)` : scopeId,
        discovered: true,
        cameras: entries.map((entry) => ({
          ip: cameraKey(entry.ip),
          name: String(entry.name || entry.ip || "").trim() || cameraKey(entry.ip),
          status: UNKNOWN,
          discovered: true,
        })),
      });
      return;
    }

    const network = merged[index];
    const existing = new Set(network.cameras.map((camera) => cameraKey(camera.ip)));
    const additions = [];
    entries.forEach((entry) => {
      const ip = cameraKey(entry.ip);
      if (!ip || existing.has(ip)) return;
      existing.add(ip);
      additions.push({
        ip,
        name: String(entry.name || "").trim() || ip,
        status: UNKNOWN,
        discovered: true,
      });
    });
    if (additions.length) network.cameras = network.cameras.concat(additions);
  });

  return merged;
}
