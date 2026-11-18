import assert from "assert";
import {
  MACHINE_KINDS,
  buildMachineSpans,
  formatDuration,
  machineReasonLabel,
  machineRows,
  machineStateLabel,
  spanPercent,
} from "../src/machine-uptime.js";

const HOUR = 3_600_000;
const BASE = Date.parse("2026-11-18T00:00:00Z");

function machine(overrides) {
  return {
    observedAt: new Date(BASE + 12 * HOUR).toISOString(),
    bootAt: new Date(BASE).toISOString(),
    reachable: true,
    openOutageSince: null,
    reboots: [{ at: new Date(BASE).toISOString(), uptimeSeconds: 20 }],
    outages: [],
    ...overrides,
  };
}

const windowStart = BASE;
const windowEnd = BASE + 12 * HOUR;

// 1. No evidence at all: nothing may be claimed as off.
{
  const result = buildMachineSpans({}, windowStart, windowEnd);
  assert.strictEqual(result.hasEvidence, false);
  assert.strictEqual(result.spans.length, 1);
  assert.strictEqual(result.spans[0].kind, MACHINE_KINDS.UNKNOWN);
  assert.strictEqual(result.spans[0].reason, "no-boot-evidence");
  assert.ok(result.spans[0].start === windowStart && result.spans[0].end === windowEnd);
}

// 2. Same boot id across a lost connection: the machine kept running.
{
  const result = buildMachineSpans(
    machine({
      outages: [
        {
          startedAt: new Date(BASE + 4 * HOUR).toISOString(),
          endedAt: new Date(BASE + 5 * HOUR).toISOString(),
          cause: "network",
          evidence: "boot-before-outage",
          bootAtAfter: new Date(BASE).toISOString(),
          provisionalStart: false,
        },
      ],
    }),
    windowStart,
    windowEnd,
  );
  assert.strictEqual(result.hasEvidence, true);
  const gaps = result.spans.filter((span) => span.kind === MACHINE_KINDS.GAP);
  assert.deepStrictEqual(gaps, [], "a network outage must never render as an off gap");
  const running = result.spans.filter((span) => span.kind === MACHINE_KINDS.RUNNING);
  assert.ok(running.length >= 1, "the window is a running stretch");
  assert.strictEqual(result.spans.some((span) => span.kind === MACHINE_KINDS.UNKNOWN), false,
    "a machine that stayed up must not leave unknown holes inside its evidence");
  // The stretch the outage covered is kept, but marked inferred, so the UI does
  // not claim a measured observation there.
  const inferred = running.filter((span) => span.inferred);
  assert.strictEqual(inferred.length, 1);
  assert.strictEqual(inferred[0].start, BASE + 4 * HOUR);
  assert.strictEqual(inferred[0].end, BASE + 5 * HOUR);
  assert.strictEqual(inferred[0].reason, "unchanged-boot-id");
  // Observed stretches are not falsely marked inferred.
  assert.ok(running.some((span) => !span.inferred));
  assert.strictEqual(running[0].start, windowStart);
  assert.strictEqual(running[running.length - 1].end, windowEnd);
}

// 3. Changed boot id: a gap exists, bounded by the new boot instant.
{
  const bootAfter = BASE + 8 * HOUR;
  const result = buildMachineSpans(
    machine({
      reboots: [
        { at: new Date(BASE).toISOString(), uptimeSeconds: 20 },
        { at: new Date(bootAfter).toISOString(), uptimeSeconds: 21 },
      ],
      outages: [
        {
          startedAt: new Date(BASE + 6 * HOUR).toISOString(),
          endedAt: new Date(bootAfter + 300_000).toISOString(),
          cause: "power",
          evidence: "boot-id-changed",
          bootAtAfter: new Date(bootAfter).toISOString(),
          provisionalStart: true,
        },
      ],
    }),
    windowStart,
    windowEnd,
  );
  const gaps = result.spans.filter((span) => span.kind === MACHINE_KINDS.GAP);
  assert.strictEqual(gaps.length, 1);
  assert.strictEqual(gaps[0].start, BASE + 6 * HOUR);
  assert.strictEqual(gaps[0].end, bootAfter, "the gap stops at the boot instant, not the verdict time");
  assert.strictEqual(gaps[0].inferred, true, "power loss is inferred, never observed");
  assert.strictEqual(gaps[0].provisional, true);

  const running = result.spans.filter((span) => span.kind === MACHINE_KINDS.RUNNING);
  assert.strictEqual(running.length, 2, "one session before the reboot, one after");
  assert.strictEqual(running[1].start, bootAfter);

  assert.strictEqual(result.boots.length, 2, "both boot instants are inside the window");
}

// 4. Open outage: no verdict. The tail is unknown, not an off gap.
{
  const result = buildMachineSpans(
    machine({
      observedAt: new Date(BASE + 3 * HOUR).toISOString(),
      bootAt: new Date(BASE).toISOString(),
      reboots: [{ at: new Date(BASE).toISOString(), uptimeSeconds: 20 }],
      outages: [
        {
          startedAt: new Date(BASE + 3 * HOUR).toISOString(),
          endedAt: null,
          cause: "unknown",
          evidence: "insufficient",
          bootAtAfter: null,
          provisionalStart: true,
        },
      ],
    }),
    windowStart,
    windowEnd,
  );
  const gaps = result.spans.filter((span) => span.kind === MACHINE_KINDS.GAP);
  assert.deepStrictEqual(gaps, [], "an unresolved outage must not assert power loss");
  const tail = result.spans[result.spans.length - 1];
  assert.strictEqual(tail.kind, MACHINE_KINDS.UNKNOWN);
  assert.strictEqual(tail.end, windowEnd);
  assert.ok(tail.start >= BASE + 3 * HOUR);
}

// 5. Clipping: spans are cut to the window and never leak outside it.
{
  const result = buildMachineSpans(
    machine({
      observedAt: new Date(BASE + 30 * HOUR).toISOString(),
      bootAt: new Date(BASE - 5 * HOUR).toISOString(),
      reboots: [{ at: new Date(BASE - 5 * HOUR).toISOString(), uptimeSeconds: 10 }],
    }),
    windowStart,
    windowStart + 2 * HOUR,
  );
  for (const span of result.spans) {
    assert.ok(span.start >= windowStart, "span starts inside the window");
    assert.ok(span.end <= windowStart + 2 * HOUR, "span ends inside the window");
  }
  assert.deepStrictEqual(result.boots, [], "boot before the window is not drawn inside it");
}

// 6. Stale evidence: the region after the last observation is unknown.
{
  const result = buildMachineSpans(
    machine({
      observedAt: new Date(BASE + 2 * HOUR).toISOString(),
      bootAt: new Date(BASE).toISOString(),
      reboots: [{ at: new Date(BASE).toISOString(), uptimeSeconds: 20 }],
    }),
    windowStart,
    windowEnd,
  );
  const tail = result.spans[result.spans.length - 1];
  assert.strictEqual(tail.kind, MACHINE_KINDS.UNKNOWN);
  assert.strictEqual(tail.reason, "after-last-observation");
  assert.strictEqual(tail.start, BASE + 2 * HOUR);
}

// 7. Rows: a scope served by two boxes gets two labelled rows, sorted; a box
//    that does not serve the scope is excluded.
{
  const boxes = [
    { ip: "100.64.0.49", name: "Gia Minh Cân 1", networks: ["giaminh-lan"], machine: machine({}) },
    { ip: "100.64.0.92", name: "Gia Minh Cân 2", networks: ["giaminh-lan"], machine: machine({}) },
    { ip: "100.64.0.85", name: "Neptune", networks: ["neptune-lan"], machine: machine({}) },
    { ip: "100.64.0.99", name: "No networks", machine: machine({}) },
  ];
  const rows = machineRows("giaminh-lan", boxes);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map((row) => row.ip).sort(), ["100.64.0.49", "100.64.0.92"]);
  assert.deepStrictEqual(machineRows("neptune-lan", boxes).map((row) => row.ip), ["100.64.0.85"]);
  assert.deepStrictEqual(machineRows("missing-lan", boxes), []);
  assert.deepStrictEqual(machineRows("", boxes), []);
}

// 8. Bar geometry shares the image timeline scale and keeps short spans visible.
{
  const span = { start: BASE + HOUR, end: BASE + 2 * HOUR };
  const bar = spanPercent(span, BASE, BASE + 10 * HOUR);
  assert.ok(Math.abs(bar.left - 10) < 1e-9);
  assert.ok(Math.abs(bar.width - 10) < 1e-9);

  const sliver = spanPercent({ start: BASE, end: BASE + 1000 }, BASE, BASE + 10 * HOUR);
  assert.ok(sliver.width >= 0.35, "a brief reboot must still be visible");

  assert.deepStrictEqual(spanPercent(span, 0, 0), { left: 0, width: 0.35 });
}

// 9. Labels are text, so state is never conveyed by colour alone.
{
  assert.strictEqual(machineStateLabel(MACHINE_KINDS.RUNNING), "Đang chạy");
  assert.strictEqual(machineStateLabel(MACHINE_KINDS.GAP), "Suy ra mất điện/khởi động lại");
  assert.strictEqual(machineStateLabel(MACHINE_KINDS.UNKNOWN), "Không rõ");
  for (const [reason, expected] of [
    ["boot-session", "Thiết bị được quan sát thấy đang chạy"],
    ["reboot-boot-id-changed", "Boot ID đổi — có khởi động lại; thời điểm mất điện được suy ra"],
    ["unchanged-boot-id", "Mất kết nối nhưng Boot ID không đổi — máy vẫn chạy (suy luận)"],
    ["no-observation", "Không có dữ liệu cho khoảng này"],
    ["no-boot-evidence", "Chưa có dữ liệu khởi động"],
  ]) {
    assert.strictEqual(machineReasonLabel(reason), expected);
  }
  assert.strictEqual(machineReasonLabel("something-new"), "Không đủ dữ liệu");
}

// 10. Durations round to the minute and stay readable across units.
{
  assert.strictEqual(formatDuration(0), "0 phút");
  assert.strictEqual(formatDuration(-5), "0 phút");
  assert.strictEqual(formatDuration(30_000), "dưới 1 phút");
  assert.strictEqual(formatDuration(5 * 60_000), "5 phút");
  assert.strictEqual(formatDuration(2 * HOUR + 5 * 60_000), "2 giờ 5 phút");
  assert.strictEqual(formatDuration(26 * HOUR), "1 ngày 2 giờ");
}

// 11. Invalid windows are rejected rather than drawing nonsense.
{
  assert.deepStrictEqual(buildMachineSpans(machine({}), 10, 10).spans, []);
  assert.deepStrictEqual(buildMachineSpans(machine({}), 20, 10).spans, []);
}

// 12. Adjacency: spans that touch must be contiguous and cover the window with
//     no holes, but an inferred segment stays its own span so the UI can mark
//     it. Merging observed into inferred would hide that it was not measured.
{
  const result = buildMachineSpans(
    machine({
      bootAt: new Date(BASE).toISOString(),
      reboots: [{ at: new Date(BASE).toISOString(), uptimeSeconds: 20 }],
      observedAt: new Date(BASE + 10 * HOUR).toISOString(),
      outages: [
        {
          startedAt: new Date(BASE + 2 * HOUR).toISOString(),
          endedAt: new Date(BASE + 3 * HOUR).toISOString(),
          cause: "network",
          bootAtAfter: new Date(BASE).toISOString(),
          provisionalStart: false,
        },
      ],
    }),
    windowStart,
    windowEnd,
  );
  const running = result.spans.filter((span) => span.kind === MACHINE_KINDS.RUNNING);
  assert.strictEqual(running.length, 3, "observed/inferred/observed stay distinct");
  assert.deepStrictEqual(running.map((span) => Boolean(span.inferred)), [false, true, false]);
  assert.strictEqual(running[0].start, windowStart);
  // Evidence stops at observedAt, so the running bar stops there too.
  assert.strictEqual(running[running.length - 1].end, BASE + 10 * HOUR);
  // No holes between consecutive running spans.
  for (let index = 1; index < running.length; index += 1) {
    assert.strictEqual(running[index].start, running[index - 1].end,
      "consecutive spans must touch exactly, with no hole and no overlap");
  }
  // The window beyond the last observation is unknown, not "off".
  const tail = result.spans[result.spans.length - 1];
  assert.strictEqual(tail.kind, MACHINE_KINDS.UNKNOWN);
  assert.strictEqual(tail.reason, "after-last-observation");
  assert.strictEqual(tail.start, BASE + 10 * HOUR);
  assert.strictEqual(tail.end, windowEnd);
}

console.log("machine-uptime: all assertions passed");
