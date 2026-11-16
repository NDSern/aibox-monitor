import assert from "node:assert/strict";
import { buildTvGroups, buildTvOfflineNetworks } from "../src/tv-groups.mjs";

const data = {
  aiboxes: [
    { name: "Cảng Mỹ Xuân A 2", ip: "100.64.0.116", networks: ["myxuan-lan"], status: "online", availability: 0 },
    { name: "MXA 3", ip: "100.64.0.36", status: "offline", statusSince: "2026-10-27T00:00:00Z", availability: 100 },
    { name: "hp3", networks: ["giaminh-lan"], status: "online", availability: 90 },
    { name: "Tàu TH-04", status: "online", availability: null },
    { name: "TH08", status: "offline", statusSince: "invalid" },
    { name: "Kim Hoa 1", networks: ["kimhoa"], status: "unknown" },
  ],
  networks: [
    { id: "myxuan-lan", name: "Cảng Mỹ Xuân A", cameras: [
      { ip: "192.168.1.1", status: "online", quality: "lagging", availability: 80 },
      { ip: "192.168.1.2", status: "offline", statusSince: "2026-10-26T00:00:00Z", availability: 20 },
      { ip: "192.168.1.3", status: "unknown", availability: null },
    ] },
    { id: "giaminh-lan", name: "Gia Minh", cameras: [
      { ip: "192.168.1.1", status: "online", availability: 100 },
    ] },
    { id: "oceanus-lan", cameras: [{ ip: "192.168.1.1", status: "unknown" }] },
    { id: "kimhoa", cameras: [] },
  ],
};
const before = JSON.stringify(data);
const rows = buildTvGroups(data);
assert.deepEqual(rows.map((row) => row.id), ["mxa", "giaminh", "ships", "other"]);
assert.deepEqual(rows.map((row) => row.machines.total), [2, 1, 2, 1]);
assert.deepEqual(rows.map((row) => row.cameras.total), [3, 1, 1, 0]);
assert.equal(rows[0].machines.availability, 50);
assert.equal(rows[0].cameras.availability, 50);
assert.equal(rows[0].cameras.measured, 2);
assert.equal(rows[0].cameras.online, 1);
assert.equal(rows[0].cameras.offline, 1);
assert.equal(rows[0].cameras.unknown, 1);
assert.equal(rows[0].cameras.lagging, 1);
assert.equal(rows[0].longestOutage.kind, "camera");
assert.equal(rows[0].longestOutage.ip, "192.168.1.2");
assert.equal(rows[0].longestOutage.scope, "Cảng Mỹ Xuân A");
assert.equal(rows[2].machines.availability, null);
assert.equal(rows[2].longestOutage, null);
assert.equal(rows[2].undatedOffline, 1);
assert.equal(rows[3].machines.offline, 0);
assert.equal(JSON.stringify(data), before);
assert.equal(buildTvGroups({}).reduce((sum, row) => sum + row.machines.total + row.cameras.total, 0), 0);

for (const name of ["Mỹ Xuân", "myxuana", "aibox-mxa2"]) {
  assert.equal(buildTvGroups({ aiboxes: [{ name }] })[0].machines.total, 1, name);
}
for (const name of ["Tàu TH-04", "TD09", "TH08", "ship 1", "Ships", "Star City", "Oceanus", "Neptune", "Poseidon"]) {
  assert.equal(buildTvGroups({ aiboxes: [{ name }] })[2].machines.total, 1, name);
}
for (const id of ["starcity-lan", "oceanus-lan", "neptune-lan", "poseidon-lan", "th05-lan", "td08-lan", "td09-lan", "th09-lan"]) {
  assert.equal(buildTvGroups({ networks: [{ id, cameras: [{ ip: "192.168.1.1" }] }] })[2].cameras.total, 1, id);
}
const assigned = buildTvGroups({
  aiboxes: [
    { name: "mxa alias", networks: ["site-b"] },
    { name: "multi-site", networks: ["site-b", "oceanus-lan", "myxuan-lan"] },
  ],
  networks: [{ id: "site-b", name: "Cảng Gia Minh", cameras: [{ name: "MXA camera" }] }],
});
assert.deepEqual(assigned.map((row) => row.machines.total), [1, 1, 0, 0]);
assert.equal(assigned[1].cameras.total, 1, "Network site overrides camera label");

const outage = buildTvGroups({
  aiboxes: [
    { name: "MXA recovered", status: "online", statusSince: "2026-01-01T00:00:00Z" },
    { name: "MXA unknown", status: "unknown", statusSince: "2026-01-01T00:00:00Z" },
    { name: "MXA undated", status: "offline", statusSince: null },
    { name: "MXA empty", status: "offline", statusSince: "" },
    { name: "MXA outage", status: "offline", statusSince: "2026-10-28T00:00:00Z" },
  ],
  networks: [{ id: "myxuan-lan", cameras: [
    { status: "offline", quality: "lagging", availability: "50" },
    { status: "unknown", quality: "lagging", availability: NaN },
    { status: "online", availability: Infinity },
  ] }],
})[0];
assert.equal(outage.longestOutage.name, "MXA outage");
assert.equal(outage.undatedOffline, 3);
assert.equal(outage.cameras.lagging, 0);
assert.equal(outage.cameras.availability, null);
assert.equal(outage.cameras.measured, 0);
for (const group of [...rows, ...assigned, outage]) {
  for (const summary of [group.machines, group.cameras]) {
    assert.equal(summary.online + summary.offline + summary.unknown, summary.total);
  }
}
const offlineNetworks = buildTvOfflineNetworks({ networks: [
  { id: "a", name: "Tàu Oceanus LAN", cameras: [{ status: "offline", statusSince: "2026-10-28T00:00:00Z" }, { status: "offline", statusSince: "2026-10-27T00:00:00Z" }, { status: "online" }] },
  { id: "giaminh-lan", name: "Gia Minh", cameras: [{ status: "unknown" }, { status: "online" }] },
  { id: "myxuan-lan", name: "MXA", cameras: [{ status: "offline", statusSince: "2026-10-26T00:00:00Z" }] },
  { id: "kimhoa", name: "Kim Hoa", cameras: [{ status: "offline", statusSince: "bad" }] },
] });
assert.deepEqual(offlineNetworks.map((n) => [n.id, n.site, n.offline, n.total]), [["myxuan-lan", "MXA", 1, 1], ["a", "Tàu", 2, 3], ["kimhoa", "VNPost", 1, 1]], "offline networks only, oldest outage first, unknown ignored");
assert.equal(offlineNetworks[1].statusSince, "2026-10-27T00:00:00.000Z", "network outage starts at oldest offline camera");
assert.equal(offlineNetworks[2].statusSince, "", "undated outage kept last");
console.log("TV grouping and metric regression checks passed");
