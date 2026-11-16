const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
// Evaluate only pure helpers; do not execute synchronization or notifications.
const source = fs.readFileSync(require.resolve("./sync-data.js"), "utf8");
const names = ["parseLogTime", "updateStatus", "updateTargetStatus", "parseAiboxStatusLine", "parseTargetStatusLine", "parseScopeStatusLine", "publicStatus", "mergeStatusCache", "targetStatusKey", "latestStatusSnapshot", "isValidTime", "parseExternalTime", "pruneAvailabilityEvents", "normalizeAvailabilityEvents", "updateAvailabilityEntry", "calculateAvailability", "reasonSnapshotAt", "aiboxCauseAt", "buildTvEventData"];
const context = { availabilityRetentionMs: 8 * 86400000, availabilityWindowMs: 7 * 86400000, TV_EVENT_LIMIT: 40, TV_CHANGE_WINDOW_MS: 86400000, TV_STATUS_WINDOW_MS: 86400000 };
vm.createContext(context);
for (const name of names) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf("\nfunction ", start + 1);
  vm.runInContext(source.slice(start, end), context);
}
const now = Date.parse("2026-10-07T01:35:00Z");
let entry = { events: [{ status: "online", at: "2026-09-29T22:22:07.019Z" }], lastStatus: "offline", lastChangedAt: "2026-10-07T01:33:47.552Z" };
entry = context.updateAvailabilityEntry(entry, "offline", "2026-09-22T07:47:39.872Z", new Date(now).toISOString(), now);
assert.equal(entry.events[entry.events.length - 1].status, "offline");
assert.equal(entry.events[entry.events.length - 1].at, "2026-10-07T01:33:47.552Z");
const changed = entry.lastChangedAt;
entry = context.updateAvailabilityEntry(entry, "offline", "2026-09-22T07:47:39.872Z", new Date(now + 60000).toISOString(), now + 60000);
assert.equal(entry.lastChangedAt, changed);
assert(context.calculateAvailability(entry, now + 60000).percent < 100);
const shortHistory = context.calculateAvailability({ events: [{ status: "online", at: new Date(now - 3 * 3600000).toISOString() }] }, now);
assert.equal(shortHistory.observedMs, 3 * 3600000);
assert.equal(shortHistory.percent, 100);
const fullWindow = context.calculateAvailability({ events: [{ status: "offline", at: new Date(now - 9 * 86400000).toISOString() }] }, now);
assert.equal(fullWindow.observedMs, 7 * 86400000);
assert.equal(fullWindow.percent, 0);
const unknownLine = "2026-10-26 12:00:00,000 - monitor - WARNING - Target state unknown from KimHoa: Camera (192.0.2.20) [method=unknown]";
const unknown = context.parseTargetStatusLine(unknownLine);
assert.equal(unknown.status, "unknown");
assert.equal(unknown.method, "unknown");
assert.equal(context.parseScopeStatusLine(unknownLine, { KimHoa: "kimhoa" }), null);
const scopeUnknown = context.parseScopeStatusLine("2026-10-26 12:01:00,000 - monitor - WARNING - Target checks unavailable from KimHoa: no checker available", { KimHoa: "kimhoa" });
assert.equal(scopeUnknown.status, "unknown");
const statusLines = [
  "2026-10-26 11:00:00,000 - monitor - INFO - Initial target state from KimHoa: Camera (192.0.2.20) is offline [method=image]",
  unknownLine,
  "2026-10-26 12:00:01,000 - monitor - INFO - Target checks completed from KimHoa: 1 target(s)",
];
const statusSnapshot = context.latestStatusSnapshot(statusLines.join("\n"), { KimHoa: "kimhoa" }, {});
assert.equal(statusSnapshot.targets["kimhoa:192.0.2.20"].status, "unknown");
assert.equal(statusSnapshot.targets["kimhoa:192.0.2.20"].statusSince, "2026-10-26T04:00:00.000Z");
assert.equal(statusSnapshot.targets["kimhoa:192.0.2.20"].method, "unknown");
assert.equal(statusSnapshot.scopes.kimhoa.status, "online");
const cached = context.mergeStatusCache(statusSnapshot.targets, { "kimhoa:192.0.2.20": { status: "offline", statusSince: "2026-10-26T04:00:00.000Z", method: "image" } });
assert.equal(cached["kimhoa:192.0.2.20"].status, "unknown");
assert.equal(cached["kimhoa:192.0.2.20"].method, "unknown");
const emptyCycle = context.parseScopeStatusLine("2026-10-26 12:01:00,000 - monitor - WARNING - Target checks unavailable from KimHoa: no checker available", { KimHoa: "kimhoa" });
assert.equal(emptyCycle.status, "unknown");
const unavailableSnapshot = context.latestStatusSnapshot("2026-10-26 12:01:00,000 - monitor - WARNING - Target checks unavailable from KimHoa: no checker available", { KimHoa: "kimhoa" }, {});
assert.equal(unavailableSnapshot.scopes.kimhoa.status, "unknown");

const hour = 3600000;
const event = (hoursAgo, status) => ({ at: new Date(now - hoursAgo * hour).toISOString(), status });
const history = (events) => ({ events });
const tvConfig = {
  aiboxes: [{ ip: "box-a", name: "A" }, { ip: "box-b", name: "B" }, { ip: "new-box", name: "New" }, { ip: "unchanged", name: "Unchanged" }],
  target_scopes: ["one", "two"].map((id) => ({ id, name: id, targets: { "192.0.2.1": "Camera" } })),
};
const tvPayload = {
  aiboxes: tvConfig.aiboxes,
  networks: tvConfig.target_scopes.map(({ id }) => ({ id, cameras: [{ ip: "192.0.2.1", method: "image" }] })),
};
const tvStore = {
  aiboxes: {
    "box-a": history([event(30, "online"), event(24, "offline"), event(23.9, "online"), event(23.8, "offline"), event(23, "online"), event(0, "offline"), event(-1, "online")]),
    "box-b": history([event(30, "offline"), event(1, "online")]),
    "new-box": history([event(0.5, "offline")]),
    unchanged: history([event(30, "online"), event(2, "online")]),
    removed: history([event(30, "online"), event(0.1, "offline")]),
  },
  targets: {
    "one:192.0.2.1": history([event(30, "online"), event(1.5, "offline"), event(1.4, "online")]),
    "two:192.0.2.1": history([event(30, "online"), event(1.5, "offline")]),
    "one:192.0.2.2": history([event(30, "online"), event(0.1, "offline")]),
  },
};
const originalTvStore = JSON.stringify(tvStore);
let tv = context.buildTvEventData(tvStore, tvPayload, tvConfig, now);
assert.equal(tv.changeCounts.aiboxes, 2, "count each changed AIBOX once, exclude first sightings and inactive boxes");
assert.equal(tv.changeCounts.cameras, 2, "same camera IP in separate scopes represents two cameras");
assert.equal(tv.statusSeries.length, 24, "24 hourly points");
assert.equal(tv.statusSeries[0].from, new Date(now - 24 * hour).toISOString());
const statusAt = (index) => { const { from, to, ...counts } = tv.statusSeries[index]; return counts; };
assert.deepEqual(statusAt(0), { aiboxOnline: 2, aiboxOffline: 1, aiboxPower: 0, aiboxNetwork: 0, aiboxUnknown: 1, cameraOnline: 2, cameraOffline: 0 }, "status at hour end includes event exactly at end; flaps inside hour use last status");
assert.deepEqual(statusAt(22), { aiboxOnline: 3, aiboxOffline: 0, aiboxPower: 0, aiboxNetwork: 0, aiboxUnknown: 0, cameraOnline: 1, cameraOffline: 1 }, "devices without history yet are not counted");
assert.deepEqual(statusAt(23), { aiboxOnline: 2, aiboxOffline: 2, aiboxPower: 0, aiboxNetwork: 0, aiboxUnknown: 2, cameraOnline: 1, cameraOffline: 1 }, "latest point ignores future events and inactive devices");
assert(tv.recentEvents.every((item) => Date.parse(item.at) <= now && !('deviceKey' in item) && !('transition' in item)));
assert.equal(JSON.stringify(tvStore), originalTvStore, "aggregation must not mutate history");
const manyBoxes = Array.from({ length: 45 }, (_, index) => ({ ip: `box-${index}` }));
tv = context.buildTvEventData({ aiboxes: Object.fromEntries(manyBoxes.map(({ ip }) => [ip, history([event(30, "online"), event(2, "offline")])])) }, { aiboxes: manyBoxes }, { aiboxes: manyBoxes }, now);
assert.equal(tv.recentEvents.length, 40);
assert.equal(tv.changeCounts.aiboxes, 45, "counts must use full history, not the event-board limit");
tv = context.buildTvEventData({}, {}, {}, now);
assert.equal(tv.changeCounts.aiboxes, 0);
assert.equal(tv.changeCounts.cameras, 0);
assert(tv.statusSeries.every((point) => point.aiboxOnline + point.aiboxOffline + point.cameraOnline + point.cameraOffline === 0));
assert.equal(tv.recentEvents.length, 0);
console.log("availability regression checks passed");
