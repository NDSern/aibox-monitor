// Shared offline-camera reason classification.
// Kept in CommonJS so scripts/sync-data.js can require it; the browser copy
// lives in src/tv-groups.mjs and scripts/test-tv-groups.mjs asserts parity.

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

function reasonForCamera(camera, checkerDown) {
  if (!camera || camera.status === "online") return null;
  if (camera.status === "image_unavailable") return "power";
  if (camera.method === "image_capture") return null;
  // The checker answered but its camera LAN route was down, so the camera was
  // never observed: that is a network fault, not a power fault.
  if (camera.method === "lan-down") return "network";
  if (checkerDown) return "network";
  if (camera.method === "image") return "power";
  if (camera.status === "offline") return "network";
  return "unknown";
}

function buildOfflineReasonCounts(networks) {
  const counts = { power: 0, network: 0, unknown: 0 };
  (Array.isArray(networks) ? networks : []).forEach((network) => {
    const checkerDown = checkerUnavailable(network);
    (Array.isArray(network.cameras) ? network.cameras : []).forEach((camera) => {
      const reason = reasonForCamera(camera, checkerDown);
      if (reason) counts[reason] += 1;
    });
  });
  return counts;
}

module.exports = { OFFLINE_REASONS, checkerUnavailable, reasonForCamera, buildOfflineReasonCounts };
