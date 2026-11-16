import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsIn,
  ArrowsOut,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  MagnifyingGlass,
  Pause,
  Play,
  Television,
  X,
} from "@phosphor-icons/react";
import { fetchArchiveTimeline, findFrameAt, FRAME_INTERVAL_MS, frameIndexAt, frameOrdinal, HISTORY_DAYS } from "./timelapse-archive.js";
import "./timelapse.css";

const ZOOM_OPTIONS = [
  { hours: 1, label: "1 giờ" },
  { hours: 6, label: "6 giờ" },
  { hours: 24, label: "24 giờ" },
];
const SPEEDS = [1, 2, 4];
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720].map((minutes) => minutes * MINUTE_MS);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatStamp(value) {
  return new Date(value).toLocaleString("vi-VN", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDayLabel(value) {
  return new Date(value).toLocaleDateString("vi-VN", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function formatDayShort(value) {
  const date = new Date(value);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const weekday = date.getDay();
  return `${weekday === 0 ? "CN" : `T${weekday + 1}`} ${day}/${month}`;
}

function cameraLabel(camera) {
  return (camera?.name || "").trim() || camera?.ip || "";
}

function cameraNameIncludesIp(camera) {
  const name = cameraLabel(camera);
  return Boolean(camera?.ip) && (name === camera.ip || name.includes(camera.ip));
}

function tickStep(span) {
  const target = span / 5;
  return TICK_STEPS.find((step) => step >= target) || 24 * HOUR_MS;
}

function buildTicks(start, end, dayStart) {
  const step = tickStep(end - start);
  const stepMinutes = Math.round(step / MINUTE_MS);
  const cursor = new Date(start);
  cursor.setSeconds(0, 0);
  if (stepMinutes < 60) {
    cursor.setMinutes(Math.ceil(cursor.getMinutes() / stepMinutes) * stepMinutes);
  } else {
    const stepHours = stepMinutes / 60;
    cursor.setMinutes(0);
    cursor.setHours(Math.ceil(cursor.getHours() / stepHours) * stepHours);
  }

  const ticks = [{ time: start, edge: "first" }];
  for (let time = cursor.getTime(); time < end; time += step) {
    if (time > start + step * 0.25) ticks.push({ time, edge: null });
  }
  ticks.push({ time: end, edge: "last" });

  return ticks.filter((tick, index, list) => {
    const previous = list[index - 1];
    return !previous || Math.abs(tick.time - previous.time) > step * 0.2;
  });
}

function formatTick(value, dayStart) {
  const date = new Date(value);
  const startDate = new Date(dayStart);
  const nextDay = date.getFullYear() !== startDate.getFullYear()
    || date.getMonth() !== startDate.getMonth()
    || date.getDate() !== startDate.getDate();
  if (nextDay && date.getHours() === 0 && date.getMinutes() === 0) return "24:00";
  return formatTime(value);
}

function dayIndexOf(timeline, time) {
  if (!timeline) return 0;
  const index = timeline.days.findIndex((item) => time >= item.start && time < item.end);
  return index === -1 ? timeline.days.length - 1 : index;
}

export default function TimelapseView({ networks = [], now, onMoveNetwork }) {
  const [referenceNow] = useState(() => now || Date.now());
  const cameraIndex = useMemo(() => {
    const list = [];
    networks.forEach((network) => {
      (network.cameras || []).forEach((camera) => {
        list.push({ networkId: network.id, networkName: network.name, camera });
      });
    });
    return list;
  }, [networks]);

  const [networkId, setNetworkId] = useState("");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(null);
  const [dayIndex, setDayIndex] = useState(HISTORY_DAYS - 1);
  const [zoomHours, setZoomHours] = useState(24);
  const [cursor, setCursor] = useState(referenceNow);
  const [viewStart, setViewStart] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [imageState, setImageState] = useState("ready");
  const [retryToken, setRetryToken] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const stageRef = useRef(null);
  const trackRef = useRef(null);
  const pickerButtonRef = useRef(null);
  const sheetRef = useRef(null);
  const searchRef = useRef(null);
  const dragRef = useRef(false);
  const dayRefs = useRef({});
  const dayStripRef = useRef(null);
  const cursorRef = useRef(cursor);

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  const visibleNetworks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return networks
      .filter((network) => !networkId || network.id === networkId)
      .map((network) => ({
        ...network,
        cameras: (network.cameras || []).filter((camera) => !needle || [camera.name, camera.ip].join(" ").toLowerCase().includes(needle)),
      }))
      .filter((network) => network.cameras.length);
  }, [networks, networkId, query]);

  const selected = useMemo(() => {
    if (selection) {
      const exact = cameraIndex.find((item) => item.networkId === selection.networkId && item.camera.ip === selection.ip);
      if (exact) return exact;
    }
    const fallbackNetwork = networks.find((network) => !networkId || network.id === networkId);
    const fallbackCamera = fallbackNetwork?.cameras?.[0];
    if (!fallbackCamera) return null;
    return cameraIndex.find((item) => item.networkId === fallbackNetwork.id && item.camera.ip === fallbackCamera.ip) || null;
  }, [cameraIndex, selection, networks, networkId]);

  const camera = selected?.camera || null;
  const [timeline, setTimeline] = useState(null);
  const [archiveState, setArchiveState] = useState("ready");
  const [archiveToken, setArchiveToken] = useState(0);

  // Load the camera's real archived frames; a camera with no history is an
  // empty timeline, not an error.
  useEffect(() => {
    if (!camera || !selected) {
      setTimeline(null);
      setArchiveState("ready");
      return undefined;
    }
    const controller = new AbortController();
    setArchiveState("loading");
    // Drop the previous camera's frames at once. Otherwise the old timeline
    // stays seekable while the new archive loads and the viewer can show an
    // image from a different camera.
    setTimeline(null);
    fetchArchiveTimeline(selected.networkId, camera.ip, controller.signal, referenceNow)
      .then((next) => {
        if (controller.signal.aborted) return;
        setTimeline(next);
        setArchiveState("ready");
        // Open on the newest archived frame: "now" is usually a few minutes
        // past it, which would otherwise read as a gap on first paint.
        if (next.frames.length) {
          setCursor(next.end);
          setViewStart(null);
          setDayIndex(next.days.length - 1);
        }
      })
      .catch((error) => {
        if (controller.signal.aborted || error.name === "AbortError") return;
        setTimeline(null);
        setArchiveState("error");
      });
    return () => controller.abort();
  }, [camera?.ip, selected?.networkId, referenceNow, archiveToken]);
  const safeDay = timeline ? clamp(dayIndex, 0, timeline.days.length - 1) : 0;
  const day = timeline?.days[safeDay] || null;
  const frame = timeline ? findFrameAt(timeline, cursor) : null;

  const windowMs = zoomHours * HOUR_MS;
  const maxWindowStart = day ? Math.max(day.end - windowMs, day.start) : 0;
  const windowStart = day
    ? clamp(viewStart === null ? cursor - windowMs / 2 : viewStart, day.start, maxWindowStart)
    : 0;
  const windowEnd = day ? Math.min(windowStart + windowMs, day.end) : 0;
  const windowSpan = Math.max(windowEnd - windowStart, FRAME_INTERVAL_MS);

  const ticks = useMemo(() => {
    if (!day) return [];
    return buildTicks(windowStart, windowEnd, day.start);
  }, [day, windowStart, windowEnd]);

  const availability = useMemo(() => {
    if (!timeline || !day) return [];
    const segments = [];
    let current = null;
    timeline.frames.forEach((item) => {
      if (item.time < windowStart || item.time > windowEnd) return;
      if (item.missing) {
        current = null;
        return;
      }
      if (current && item.time - current.end <= (timeline.tolerance || FRAME_INTERVAL_MS * 1.5)) {
        current.end = item.time;
      } else {
        current = { start: item.time, end: item.time };
        segments.push(current);
      }
    });
    return segments.map((segment) => ({
      left: ((segment.start - windowStart) / windowSpan) * 100,
      width: Math.max(((segment.end - segment.start) / windowSpan) * 100, 0.35),
    }));
  }, [timeline, day, windowStart, windowSpan]);

  useEffect(() => {
    if (!frame || frame.missing) {
      setImageState("ready");
      return;
    }
    setImageState("loading");
  }, [frame?.time, frame?.image, frame?.missing, retryToken]);

  useEffect(() => {
    setPlaying(false);
    setViewStart(null);
  }, [safeDay]);

  useEffect(() => {
    if (!pickerOpen) return;
    const button = dayRefs.current[safeDay];
    const strip = dayStripRef.current;
    if (button && strip) {
      const left = button.offsetLeft - strip.offsetLeft;
      if (left < strip.scrollLeft || left + button.offsetWidth > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = Math.max(left - 8, 0);
      }
    }
  }, [safeDay, pickerOpen]);

  useEffect(() => {
    function onFullscreen() {
      setFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    window.requestAnimationFrame(() => pickerButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const sheet = sheetRef.current;
    const focusables = () => Array.from(sheet?.querySelectorAll("button, input, select, [tabindex]:not([tabindex='-1'])") || [])
      .filter((node) => node.offsetParent !== null);
    window.requestAnimationFrame(() => searchRef.current?.focus());
    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker();
        return;
      }
      if (event.key !== "Tab" || !sheet) return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pickerOpen, closePicker]);

  const moveCursor = useCallback((next, recenter = false) => {
    if (!timeline) return;
    const bounded = clamp(next, timeline.start, timeline.end);
    const index = dayIndexOf(timeline, bounded);
    setCursor(bounded);
    if (index !== safeDay) {
      setDayIndex(index);
      setViewStart(null);
    } else if (recenter) {
      setViewStart(clamp(bounded - windowMs / 2, day.start, maxWindowStart));
    }
  }, [timeline, safeDay, windowMs, day, maxWindowStart]);

  useEffect(() => {
    if (!playing || !timeline) return undefined;
    const timer = window.setInterval(() => {
      const next = cursorRef.current + FRAME_INTERVAL_MS * speed;
      if (next >= timeline.end) {
        setCursor(timeline.end);
        setPlaying(false);
        return;
      }
      moveCursor(next, true);
    }, 600);
    return () => window.clearInterval(timer);
  }, [playing, speed, timeline, moveCursor]);

  useEffect(() => {
    const node = trackRef.current;
    if (!node || !day) return undefined;
    function onWheel(event) {
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : (event.shiftKey ? event.deltaY : 0);
      if (!horizontal || maxWindowStart <= day.start) return;
      event.preventDefault();
      setPlaying(false);
      setViewStart(clamp(windowStart + (horizontal / 600) * windowSpan, day.start, maxWindowStart));
    }
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [day, windowStart, windowSpan, maxWindowStart]);

  const seekFromEvent = useCallback((event) => {
    if (!day) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    setPlaying(false);
    if (viewStart === null) setViewStart(windowStart);
    moveCursor(windowStart + ratio * windowSpan);
  }, [day, viewStart, windowStart, windowSpan, moveCursor]);

  function step(direction) {
    if (!timeline?.frames.length) return;
    // Move to the adjacent real frame. Walking fixed intervals would jump
    // hours across a sparse archive and land inside another gap.
    const index = frameIndexAt(timeline, cursor);
    const nextIndex = clamp(index + direction, 0, timeline.frames.length - 1);
    setPlaying(false);
    moveCursor(timeline.frames[nextIndex].time, true);
  }

  function changeCamera(item) {
    setSelection({ networkId: item.networkId, ip: item.camera.ip });
    setPlaying(false);
    // Clear immediately; the load effect fills these in for the new camera.
    setTimeline(null);
    setArchiveState("loading");
    setCursor(referenceNow);
    setDayIndex(HISTORY_DAYS - 1);
    setViewStart(null);
    if (pickerOpen) closePicker();
  }

  function changeNetwork(value) {
    setPlaying(false);
    setNetworkId(value);
    const scope = value ? networks.filter((network) => network.id === value) : networks;
    const keep = selection && scope.some((network) => network.id === selection.networkId
      && (network.cameras || []).some((cameraItem) => cameraItem.ip === selection.ip));
    if (!keep) {
      const firstNetwork = scope.find((network) => (network.cameras || []).length);
      setSelection(firstNetwork ? { networkId: firstNetwork.id, ip: firstNetwork.cameras[0].ip } : null);
      setCursor(referenceNow);
      setDayIndex(timeline ? timeline.days.length - 1 : HISTORY_DAYS - 1);
      setViewStart(null);
    }
  }

  function selectDay(index) {
    if (!timeline) return;
    const target = timeline.days[index];
    setDayIndex(index);
    setPlaying(false);
    setCursor(Math.min(target.end, timeline.end) - FRAME_INTERVAL_MS);
    setViewStart(null);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageRef.current?.requestFullscreen();
    } catch (_) {
      setFullscreen(false);
    }
  }

  function togglePlay() {
    if (!playing && timeline && day && cursor >= timeline.end - FRAME_INTERVAL_MS) {
      setCursor(day.start);
      setViewStart(null);
    }
    setPlaying((value) => !value);
  }

  const browser = (
    <div className="tlBrowser">
      <div className="tlBrowserHead">
        <h2>Camera</h2>
        <span>{cameraIndex.length}</span>
      </div>
      <div className="tlFilters">
        <label className="tlField">
          <span>Mạng</span>
          <select onChange={(event) => changeNetwork(event.target.value)} value={networkId}>
            <option value="">Tất cả mạng</option>
            {networks.map((network) => <option key={network.id} value={network.id}>{network.name}</option>)}
          </select>
        </label>
        <div className="tlOrder" role="group" aria-label="Sắp xếp mạng">
          <button aria-label="Đưa mạng lên" className="tlOrderButton" disabled={!networkId || !onMoveNetwork || networks.findIndex((network) => network.id === networkId) <= 0} onClick={() => onMoveNetwork(networkId, -1)} title="Đưa mạng lên" type="button"><CaretUp aria-hidden="true" size={14} weight="bold" /></button>
          <button aria-label="Đưa mạng xuống" className="tlOrderButton" disabled={!networkId || !onMoveNetwork || (() => { const index = networks.findIndex((network) => network.id === networkId); return index < 0 || index === networks.length - 1; })()} onClick={() => onMoveNetwork(networkId, 1)} title="Đưa mạng xuống" type="button"><CaretDown aria-hidden="true" size={14} weight="bold" /></button>
        </div>
        <label className="tlSearch">
          <span className="visually-hidden">Tìm camera</span>
          <MagnifyingGlass aria-hidden="true" size={15} />
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Tìm camera hoặc IP"
            ref={searchRef}
            type="search"
            value={query}
          />
        </label>
      </div>
      <div className="tlCameraList">
        {visibleNetworks.map((network) => (
          <div className="tlCameraGroup" key={network.id}>
            <p className="tlGroupLabel">{network.name}<span>{network.cameras.length}</span></p>
            {network.cameras.map((item) => {
              const active = selected?.camera.ip === item.ip && selected?.networkId === network.id;
              const statusText = item.status === "online" ? "Trực tuyến" : item.status === "offline" ? "Ngoại tuyến" : "Chưa rõ trạng thái";
              return (
                <button
                  aria-current={active ? "true" : undefined}
                  className={`tlCameraRow ${active ? "active" : ""}`}
                  key={`${network.id}-${item.ip}`}
                  onClick={() => changeCamera({ networkId: network.id, camera: item })}
                  type="button"
                >
                  <span className={`tlDot ${item.status}`} aria-hidden="true" />
                  <span className="tlCameraText">
                    <strong>{cameraLabel(item)}</strong>
                    {/* Auto-named cameras repeat across ships ("Camera
                        192.168.0.65" exists on nine of them), so name the
                        network instead of repeating the IP. */}
                    {cameraNameIncludesIp(item)
                      ? <small>{network.name}</small>
                      : <small>{item.ip}</small>}
                  </span>
                  <span className="visually-hidden">{statusText}</span>
                </button>
              );
            })}
          </div>
        ))}
        {!visibleNetworks.length ? <p className="tlEmptyLine">Không có camera phù hợp.</p> : null}
      </div>
    </div>
  );

  const playheadPercent = day ? clamp(((cursor - windowStart) / windowSpan) * 100, 0, 100) : 0;
  const headLabelPercent = clamp(playheadPercent, 5, 95);
  const displayName = camera ? cameraLabel(camera) : "Chưa chọn camera";
  const selectedNetwork = selected?.networkName || "";

  return (
    <div className="tlView">
      <header className="tlTitleRow">
        <div className="tlTitleText">
          <h1>Xem lại ảnh camera</h1>
          <p>Xem lại ảnh camera đã lưu trong 5 ngày gần nhất.</p>
        </div>
        <div className="tlTitleMeta">
          <span className="tlDemoTag">Ảnh lưu trữ thật</span>
          <button className="tlPickerButton" onClick={() => setPickerOpen(true)} ref={pickerButtonRef} type="button">
            <Television aria-hidden="true" size={16} />Chọn camera
          </button>
        </div>
      </header>

      <div className="tlLayout">
        <div
          aria-label="Danh sách camera"
          aria-modal={pickerOpen ? "true" : undefined}
          className={pickerOpen ? "tlBrowserSheet open" : "tlBrowserSheet"}
          ref={sheetRef}
          role={pickerOpen ? "dialog" : undefined}
        >
          {browser}
          <button aria-label="Đóng danh sách camera" className="tlSheetClose" onClick={closePicker} type="button"><X size={18} /></button>
        </div>

        <section
          aria-hidden={pickerOpen ? "true" : undefined}
          aria-label="Trình xem timelapse"
          className="tlStagePanel"
          inert={pickerOpen ? "" : undefined}
        >
          <div className="tlStageHead">
            <div>
              <h2>{displayName}</h2>
              <p>
                {selected
                  ? [selectedNetwork, cameraNameIncludesIp(camera) ? "" : camera.ip].filter(Boolean).join(" · ")
                  : "Chọn một camera để xem ảnh."}
              </p>
            </div>
          </div>

          <div className="tlStage" ref={stageRef}>
            {frame && !frame.missing ? (
              imageState === "error" ? (
                <div className="tlStageEmpty">
                  <Television aria-hidden="true" size={28} />
                  <strong>Không tải được ảnh lưu trữ</strong>
                  <span>Ảnh có thể đã bị xóa hoặc đường truyền gián đoạn.</span>
                  <button onClick={() => { setImageState("loading"); setRetryToken((value) => value + 1); }} type="button">Thử lại</button>
                </div>
              ) : (
                <>
                  <img
                    alt={`Ảnh lưu trữ ${cameraLabel(camera)} lúc ${formatStamp(frame.time)}`}
                    className={imageState === "loading" ? "isLoading" : ""}
                    key={retryToken}
                    onError={() => setImageState("error")}
                    onLoad={() => setImageState("ready")}
                    src={frame.image}
                  />
                  {imageState === "loading" ? <span className="tlStageLoading">Đang tải ảnh…</span> : null}
                </>
              )
            ) : (
              <div className="tlStageEmpty">
                <Television aria-hidden="true" size={28} />
                <strong>{
                  archiveState === "loading"
                    ? "Đang tải dữ liệu lưu trữ"
                    : archiveState === "error"
                      ? "Không tải được dữ liệu lưu trữ"
                      : !camera
                        ? "Chưa có camera"
                        : timeline?.empty
                          ? "Camera này chưa có ảnh lưu trữ"
                          : frame?.missing
                            ? "Không có ảnh trong khoảng này"
                            : "Chưa có ảnh tại thời điểm này"
                }</strong>
                <span>{
                  archiveState === "loading"
                    ? "Đang đọc danh sách ảnh của camera."
                    : archiveState === "error"
                      ? "Máy chủ lưu trữ không phản hồi."
                      : !camera
                        ? "Dữ liệu camera chưa sẵn sàng."
                        : timeline?.empty
                          ? "Ảnh sẽ xuất hiện sau lần chụp kế tiếp."
                          : frame?.missing
                            ? "Khoảng trống này là thời gian camera không ghi được ảnh."
                            : "Chọn thời điểm khác trên dòng thời gian."
                }</span>
                {archiveState === "error" ? (
                  <button onClick={() => setArchiveToken((value) => value + 1)} type="button">Thử lại</button>
                ) : null}
              </div>
            )}
            {fullscreen ? <button aria-label="Thoát toàn màn hình" className="tlStageExit" onClick={toggleFullscreen} type="button"><ArrowsIn size={18} /></button> : null}
          </div>

          <div className="tlTransport">
            <div className="tlButtons">
              <button aria-label="Ảnh trước" disabled={!frame} onClick={() => step(-1)} type="button"><CaretLeft size={18} weight="bold" /></button>
              <button aria-label={playing ? "Tạm dừng" : "Phát"} className="tlPlay" disabled={!frame} onClick={togglePlay} type="button">
                {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
              </button>
              <button aria-label="Ảnh tiếp theo" disabled={!frame} onClick={() => step(1)} type="button"><CaretRight size={18} weight="bold" /></button>
            </div>
            <div className="tlTransportMeta">
              <span className="tlBigStamp">{frame ? formatTime(frame.time) : "--:--"}</span>
              <span className="tlMuted">{frame ? formatStamp(frame.time) : "Chưa có ảnh"}</span>
              <span className="tlMuted">Ảnh {frame ? frameOrdinal(timeline, frame.time).toLocaleString("vi-VN") : "--"} / {timeline?.frames.length.toLocaleString("vi-VN") || "--"}</span>
            </div>
            <div className="tlTransportTools">
              <div aria-label="Tốc độ phát" className="tlSpeed" role="group">
                {SPEEDS.map((value) => (
                  <button aria-pressed={speed === value} className={speed === value ? "active" : ""} key={value} onClick={() => setSpeed(value)} type="button">{value}×</button>
                ))}
              </div>
              <button aria-label={fullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"} onClick={toggleFullscreen} type="button">
                {fullscreen ? <ArrowsIn size={17} /> : <ArrowsOut size={17} />}
              </button>
            </div>
          </div>

          <div className="tlTimeline">
            <div className="tlTimelineTop">
              <div className="tlDayMeta">
                <strong>{day ? formatDayLabel(day.start) : "--"}</strong>
                <span className="tlMuted">{day ? `${day.captured.toLocaleString("vi-VN")} ảnh` : ""}</span>
              </div>
              <div aria-label="Khoảng thời gian hiển thị" className="tlZoom" role="group">
                {ZOOM_OPTIONS.map((option) => (
                  <button aria-pressed={zoomHours === option.hours} className={zoomHours === option.hours ? "active" : ""} key={option.hours} onClick={() => {
                    setZoomHours(option.hours);
                    setViewStart(cursor - (option.hours * HOUR_MS) / 2);
                  }} type="button">{option.label}</button>
                ))}
              </div>
            </div>

            <div
              aria-label="Dòng thời gian. Dùng phím trái phải để tua, Home và End để về đầu hoặc cuối khung."
              aria-valuemax={day?.end || 0}
              aria-valuemin={day?.start || 0}
              aria-valuenow={day ? clamp(cursor, day.start, day.end) : 0}
              aria-valuetext={frame ? formatStamp(frame.time) : "Chưa có ảnh"}
              className="tlRuler"
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
                if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
                if (event.key === "Home") { event.preventDefault(); setPlaying(false); setCursor(windowStart); }
                if (event.key === "End") { event.preventDefault(); setPlaying(false); setCursor(windowEnd); }
                if (event.key === "PageUp") { event.preventDefault(); setPlaying(false); setViewStart(clamp(windowStart - windowSpan / 2, day?.start || 0, maxWindowStart)); }
                if (event.key === "PageDown") { event.preventDefault(); setPlaying(false); setViewStart(clamp(windowStart + windowSpan / 2, day?.start || 0, maxWindowStart)); }
              }}
              onPointerCancel={() => { dragRef.current = false; }}
              onPointerDown={(event) => {
                dragRef.current = true;
                event.currentTarget.setPointerCapture?.(event.pointerId);
                seekFromEvent(event);
              }}
              onPointerMove={(event) => { if (dragRef.current) seekFromEvent(event); }}
              onPointerUp={() => { dragRef.current = false; }}
              ref={trackRef}
              role="slider"
              tabIndex={0}
            >
              <div className="tlTrack">
                {availability.map((segment, index) => (
                  <span className="tlAvailable" key={index} style={{ left: `${segment.left}%`, width: `${segment.width}%` }} />
                ))}
                <span className="tlPlayhead" style={{ left: `${playheadPercent}%` }}>
                  <span className="tlHeadTime" style={{ left: `${headLabelPercent}%` }}>{frame ? formatTime(frame.time) : "--:--"}</span>
                </span>
              </div>
              <div className="tlTicks">
                {ticks.map((tick) => {
                  const percent = ((tick.time - windowStart) / windowSpan) * 100;
                  return (
                    <span
                      className={`tlTick ${tick.edge ? `is-${tick.edge}` : ""}`}
                      key={`${tick.edge || "tick"}-${tick.time}`}
                      style={{ left: `${clamp(percent, 0, 100)}%` }}
                    >
                      {formatTick(tick.time, day?.start || 0)}
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="tlDays" ref={dayStripRef} role="group" aria-label="Năm ngày gần nhất">
              {timeline?.days.map((item) => (
                <button
                  aria-label={`${formatDayLabel(item.start)}, ${item.captured} ảnh`}
                  aria-pressed={item.index === safeDay}
                  className={`tlDay ${item.index === safeDay ? "active" : ""}`}
                  key={item.index}
                  onClick={() => selectDay(item.index)}
                  ref={(node) => { dayRefs.current[item.index] = node; }}
                  title={`${formatDayLabel(item.start)} · ${item.captured} ảnh`}
                  type="button"
                >
                  <span className="tlDayLabel">{formatDayShort(item.start)}</span>
                  <span className="tlDayBar" aria-hidden="true"><span style={{ width: `${Math.round(item.ratio * 100)}%` }} /></span>
                  <small>{Math.round(item.ratio * 100)}%</small>
                </button>
              ))}
            </div>

            <div className="tlLegend">
              <span><i className="tlLegendAvailable" aria-hidden="true" />Có ảnh</span>
              <span><i className="tlLegendGap" aria-hidden="true" />Thiếu ảnh</span>
              <span className="tlMuted">{timeline?.frames?.length ? `Lưu trữ từ ${formatStamp(timeline.frames[0].time)}` : "Chưa có ảnh lưu trữ"}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
