// Timeline built from the central substream archive.
// Frames are real capture times taken from the filename, so gaps are real
// missing captures rather than synthesised ones.
export const DAY_MS = 86_400_000;
export const FRAME_INTERVAL_MS = 180_000;
export const HISTORY_DAYS = 5;
const EXPECTED_PER_DAY = Math.round(DAY_MS / FRAME_INTERVAL_MS);

export function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function archiveUrl(networkId, ip, source) {
  return `/camera-archive/${encodeURIComponent(networkId)}/${encodeURIComponent(ip)}/${encodeURIComponent(source)}`;
}

// Turn an archive index response into the timeline shape the view renders.
export function buildArchiveTimeline(payload, networkId, ip, now = Date.now()) {
  const frames = (payload?.frames || [])
    .map((item) => ({
      time: item.epoch * 1000,
      image: archiveUrl(networkId, ip, item.source),
      // Real frames are never gaps; `missing` only appears on the synthetic
      // cursor result from findFrameAt.
      missing: false,
    }))
    .filter((frame) => Number.isFinite(frame.time))
    .sort((a, b) => a.time - b.time);

  const end = frames.length ? Math.min(frames[frames.length - 1].time, now) : now;
  const start = startOfDay(now - (HISTORY_DAYS - 1) * DAY_MS);

  const days = Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const dayStart = start + index * DAY_MS;
    const dayEnd = Math.min(dayStart + DAY_MS, now);
    const captured = frames.filter((frame) => frame.time >= dayStart && frame.time < dayStart + DAY_MS).length;
    return {
      index,
      start: dayStart,
      end: dayEnd,
      captured,
      total: EXPECTED_PER_DAY,
      ratio: Math.min(captured / EXPECTED_PER_DAY, 1),
    };
  });

  // Nominal cadence, estimated from this camera's own archive so a camera that
  // captures every 3 minutes does not read as 20% coverage on every day. The
  // median gap ignores outages because only short gaps are sampled.
  const gaps = [];
  for (let index = 1; index < frames.length; index += 1) {
    const gap = frames[index].time - frames[index - 1].time;
    if (gap >= 30_000 && gap <= 1_800_000) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const cadence = gaps.length ? gaps[Math.floor(gaps.length / 2)] : FRAME_INTERVAL_MS;
  // A capture is "on time" when it lands within this tolerance of the previous
  // one. Beyond it the interval is an outage, which renders as a gap instead of
  // reusing a neighbouring image.
  const tolerance = Math.max(cadence * 2, 60_000);

  // Coverage is measured only over the part of the day the archive actually
  // spans. Using a whole day made today read as a low percentage simply
  // because the archive started a few hours ago.
  const archiveStart = frames.length ? frames[0].time : end;
  const daysWithCoverage = days.map((item) => {
    const from = Math.max(item.start, archiveStart);
    const to = Math.min(item.end, end);
    const covered = Math.max(0, to - from);
    const expected = Math.max(1, Math.round(covered / cadence));
    return {
      ...item,
      total: expected,
      ratio: covered > 0 ? Math.min(item.captured / expected, 1) : 0,
    };
  });

  return {
    start,
    end,
    frames,
    days: daysWithCoverage,
    cadence,
    tolerance,
    empty: frames.length === 0,
  };
}

export async function fetchArchiveTimeline(networkId, ip, signal, now = Date.now()) {
  const response = await fetch(`/camera-archive/${encodeURIComponent(networkId)}/${encodeURIComponent(ip)}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`archive ${response.status}`);
  return buildArchiveTimeline(await response.json(), networkId, ip, now);
}

// Nearest real frame to a time. A cursor that falls beyond the usual capture
// interval from any frame is reported as a gap, which is what an outage looks
// like in the archive.
export function findFrameAt(timeline, time) {
  if (!timeline?.frames?.length) return null;
  const frames = timeline.frames;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (frames[mid].time < time) low = mid + 1;
    else high = mid;
  }
  const candidate = frames[low];
  const previous = frames[low - 1];
  const nearest = previous && Math.abs(previous.time - time) <= Math.abs(candidate.time - time)
    ? previous
    : candidate;
  // Only show an image for the capture that is actually nearest in time. Past
  // the tolerance the cursor is inside an outage, so report a gap rather than
  // reusing a frame from before or after it.
  const tolerance = timeline.tolerance || FRAME_INTERVAL_MS * 1.5;
  const gap = Math.abs(nearest.time - time) > tolerance;
  return gap ? { ...nearest, time, missing: true } : nearest;
}

// Index of the real frame nearest to `time`. Used for stepping between
// captures so one press lands on the next actual frame, however sparse.
export function frameIndexAt(timeline, time) {
  const frames = timeline?.frames || [];
  if (!frames.length) return -1;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (frames[mid].time < time) low = mid + 1;
    else high = mid;
  }
  const previous = low - 1;
  if (previous >= 0 && Math.abs(frames[previous].time - time) <= Math.abs(frames[low].time - time)) {
    return previous;
  }
  return low;
}

export function frameOrdinal(timeline, time) {
  const frames = timeline?.frames || [];
  if (!frames.length) return 0;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (frames[mid].time < time) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}
