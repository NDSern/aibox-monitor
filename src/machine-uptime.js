// Machine (AIBOX) up/down timeline built from boot-history evidence.
//
// What the evidence supports:
//   - bootAt / reboots[].at   exact instants where a boot session began
//   - outages[] with cause "power" and bootAtAfter
//                             a reboot definitely happened inside this window
//   - outages[] with cause "network"
//                             the boot id did not change, so the machine kept
//                             running through the gap (inferred, not observed)
//
// What it does NOT support:
//   - The exact moment power was lost. An outage window starts when the box was
//     last seen alive, so the whole window is only an upper bound on downtime.
//     Rows therefore render power gaps as "inferred", never as measured.
//   - Any verdict at all before the first boot session or after the last
//     observation. Those regions are "unknown", not "off".
//
// Everything here is pure: no React, no fetch, so it can be unit-tested with
// plain node.

export const MACHINE_KINDS = Object.freeze({ RUNNING: "running", GAP: "gap", UNKNOWN: "unknown" });

const MINUTE_MS = 60_000;
// A boot session that starts within this distance of a previous one is the same
// boot observed twice (probe re-reads /proc), not a new power cycle.
const SESSION_MERGE_MS = 30_000;
// Holes shorter than this are rounding noise between adjacent spans, not a
// real gap in the evidence, so they must not render as an unknown sliver.
const HOLE_MIN_MS = 60_000;

function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function uniqSorted(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const out = [];
  for (const value of sorted) {
    if (!out.length || value - out[out.length - 1] > SESSION_MERGE_MS) out.push(value);
  }
  return out;
}

// Every box that serves a camera network, in a stable order. A scope served by
// several boxes gets several rows: we never pick one owner on the box's behalf.
export function machineRows(scopeId, aiboxes = []) {
  if (!scopeId) return [];
  return aiboxes
    .filter((box) => Array.isArray(box?.networks) && box.networks.includes(scopeId))
    .map((box) => ({
      ip: box.ip || "",
      name: box.name || box.ip || "AIBOX",
      machine: box.machine || null,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "vi"));
}

function bootSessions(machine) {
  const starts = [];
  const bootAt = toMs(machine?.bootAt);
  if (bootAt !== null) starts.push(bootAt);
  for (const reboot of machine?.reboots || []) {
    const at = toMs(reboot?.at);
    if (at !== null) starts.push(at);
  }
  return uniqSorted(starts);
}

function outageWindows(machine) {
  const windows = [];
  for (const outage of machine?.outages || []) {
    const start = toMs(outage?.startedAt);
    if (start === null) continue;
    const end = toMs(outage?.endedAt);
    windows.push({
      start,
      end,
      cause: outage?.cause === "power" || outage?.cause === "network" ? outage.cause : "unknown",
      bootAtAfter: toMs(outage?.bootAtAfter),
      provisionalStart: Boolean(outage?.provisionalStart),
    });
  }
  return windows.sort((a, b) => a.start - b.start);
}

function clip(span, from, to) {
  const start = Math.max(span.start, from);
  const end = Math.min(span.end, to);
  return end > start ? { ...span, start, end } : null;
}

// Merge spans that touch and share a kind AND the same confidence, so the
// caller draws one bar instead of a run of adjacent slivers. Observed and
// inferred stretches stay separate: merging them would hide which part of the
// bar is only reasoned about.
function coalesce(spans) {
  const out = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (
      last &&
      last.kind === span.kind &&
      last.inferred === span.inferred &&
      last.provisional === span.provisional &&
      last.reason === span.reason &&
      span.start <= last.end + 1
    ) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    out.push({ ...span });
  }
  return out;
}

// Split a running stretch around network outages. The machine stayed up (the
// boot id did not change), but inside the outage we have no direct observation,
// so that slice is marked inferred rather than presented as measured.
function splitByNetworkOutages(span, networkOutages) {
  const cuts = networkOutages
    .filter((outage) => outage.end !== null && outage.end > span.start && outage.start < span.end)
    .sort((a, b) => a.start - b.start);
  if (!cuts.length) return [span];

  const parts = [];
  let cursor = span.start;
  for (const outage of cuts) {
    const start = Math.max(outage.start, cursor);
    const end = Math.min(outage.end, span.end);
    if (start > cursor) parts.push({ ...span, start: cursor, end: start });
    if (end > start) {
      parts.push({
        ...span,
        start,
        end,
        inferred: true,
        provisional: false,
        reason: "unchanged-boot-id",
      });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < span.end) parts.push({ ...span, start: cursor, end: span.end });
  return parts;
}

// Build the machine row spans for one box over [windowStart, windowEnd).
//
// Returns { spans, boots, hasEvidence, note } where each span is
//   { start, end, kind, inferred, provisional, reason }
// and boots are the exact boot instants that fall inside the window.
export function buildMachineSpans(machine, windowStart, windowEnd) {
  const from = Number(windowStart);
  const to = Number(windowEnd);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { spans: [], boots: [], hasEvidence: false, note: "invalid-window" };
  }

  const sessions = bootSessions(machine);
  const observedAt = toMs(machine?.observedAt);
  const outages = outageWindows(machine);

  if (!sessions.length) {
    // No boot evidence at all: we cannot claim anything about power state.
    return {
      spans: [{ start: from, end: to, kind: MACHINE_KINDS.UNKNOWN, inferred: true, provisional: false, reason: "no-boot-evidence" }],
      boots: [],
      hasEvidence: false,
      note: "no-boot-evidence",
    };
  }

  // The box was observed alive until observedAt. With an open outage, the last
  // proof of life is the outage start instead.
  const openOutage = outages.find((outage) => outage.end === null);
  const lastAlive = openOutage ? openOutage.start : observedAt;
  const networkOutages = outages.filter((outage) => outage.cause === "network");
  const powerOutages = outages.filter((outage) => outage.cause === "power");

  // Raw running stretches come straight from boot sessions: a session starts at
  // a boot instant and ends at the next boot, the last proof of life, or the
  // next power outage (whichever comes first).
  const running = [];
  for (let index = 0; index < sessions.length; index += 1) {
    const start = sessions[index];
    const nextSession = sessions[index + 1] ?? Infinity;
    const nextPower = powerOutages.find((outage) => outage.start > start);
    const end = Math.min(nextSession, nextPower ? nextPower.start : Infinity, lastAlive ?? Infinity);
    if (Number.isFinite(end) && end > start) {
      running.push({
        start,
        end,
        kind: MACHINE_KINDS.RUNNING,
        inferred: false,
        provisional: false,
        reason: "boot-session",
      });
    }
  }

  // Gaps are only ever inferred, and only ever for power events.
  const gaps = [];
  for (const outage of powerOutages) {
    // A changed boot id proves a reboot happened; it does not prove the box was
    // off for the whole preceding window, so this stays "inferred".
    const end = Math.min(
      outage.bootAtAfter ?? Infinity,
      outage.end ?? Infinity,
    );
    if (Number.isFinite(end) && end > outage.start) {
      gaps.push({
        start: outage.start,
        end,
        kind: MACHINE_KINDS.GAP,
        inferred: true,
        provisional: outage.provisionalStart || outage.bootAtAfter === null,
        reason: outage.bootAtAfter === null ? "reboot-inferred" : "reboot-boot-id-changed",
      });
    }
  }

  // Everything the evidence does not cover is unknown, not "off".
  const known = [...running.flatMap((span) => splitByNetworkOutages(span, networkOutages)), ...gaps]
    .map((span) => clip(span, from, to))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  const spans = [];
  let cursor = from;
  for (const span of known) {
    // Ignore sub-second holes between adjacent spans: they are rounding
    // noise from the boot/outage instants, not real gaps in evidence.
    if (span.start - cursor > HOLE_MIN_MS) {
      spans.push({
        start: cursor,
        end: span.start,
        kind: MACHINE_KINDS.UNKNOWN,
        inferred: true,
        provisional: true,
        reason: "no-observation",
      });
    }
    spans.push(span);
    cursor = Math.max(cursor, span.end);
  }
  if (to - cursor > HOLE_MIN_MS) {
    spans.push({
      start: cursor,
      end: to,
      kind: MACHINE_KINDS.UNKNOWN,
      inferred: true,
      provisional: true,
      reason: "after-last-observation",
    });
  }

  const boots = sessions
    .filter((at) => at >= from && at < to)
    .map((at) => ({ at }));

  return {
    spans: coalesce(spans),
    boots,
    hasEvidence: true,
    note: machine?.reachable === false ? "unreachable-at-last-probe" : "",
  };
}

// Percentage bar for one span inside the window, matching the image timeline's
// scale. A run narrower than `minPercent` is widened so a brief reboot stays
// visible.
export function spanPercent(span, windowStart, windowEnd, minPercent = 0.35) {
  const span_ = windowEnd - windowStart;
  if (!Number.isFinite(span_) || span_ <= 0) return { left: 0, width: minPercent };
  const left = ((span.start - windowStart) / span_) * 100;
  const width = ((span.end - span.start) / span_) * 100;
  return {
    left: Math.min(Math.max(left, 0), 100),
    width: Math.max(width, minPercent) > 100 ? 100 : Math.max(width, minPercent),
  };
}

export function machineStateLabel(kind) {
  if (kind === MACHINE_KINDS.RUNNING) return "Đang chạy";
  if (kind === MACHINE_KINDS.GAP) return "Suy ra mất điện/khởi động lại";
  return "Không rõ";
}

export function machineReasonLabel(reason) {
  switch (reason) {
    case "boot-session":
      return "Thiết bị được quan sát thấy đang chạy";
    case "boot-id-changed":
    case "reboot-boot-id-changed":
      return "Boot ID đổi — có khởi động lại; thời điểm mất điện được suy ra";
    case "reboot-inferred":
      return "Có khởi động lại nhưng không rõ mốc bật máy";
    case "unchanged-boot-id":
      return "Mất kết nối nhưng Boot ID không đổi — máy vẫn chạy (suy luận)";
    case "no-observation":
      return "Không có dữ liệu cho khoảng này";
    case "after-last-observation":
      return "Sau lần quan sát cuối cùng";
    case "no-boot-evidence":
      return "Chưa có dữ liệu khởi động";
    default:
      return "Không đủ dữ liệu";
  }
}

// "2 giờ 05 phút" style duration, rounded to the minute so a 90-second reboot
// does not read as a long outage.
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0 phút";
  // Anything under a minute is reported as such: rounding 30 s up to "1 phút"
  // would overstate a very short reboot.
  if (ms < MINUTE_MS) return "dưới 1 phút";
  const totalMinutes = Math.round(ms / MINUTE_MS);
  if (totalMinutes < 1) return "dưới 1 phút";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} ngày`);
  if (hours) parts.push(`${hours} giờ`);
  if (minutes && !days) parts.push(`${minutes} phút`);
  return parts.join(" ") || "0 phút";
}
