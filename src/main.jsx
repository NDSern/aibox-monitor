import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import useEmblaCarousel from "embla-carousel-react";
import {
  ArrowClockwise,
  ArrowsIn,
  ArrowsOut,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  ClockCounterClockwise,
  Cube,
  DotsSixVertical,
  DownloadSimple,
  GearSix,
  ListBullets,
  MagnifyingGlass,
  Moon,
  NotePencil,
  Pause,
  Play,
  QuestionMark,
  SquaresFour,
  Sun,
  Television,
  Trash,
  Waveform,
  WifiHigh,
  WifiSlash,
  X,
} from "@phosphor-icons/react";
import "@fontsource-variable/ibm-plex-sans";
import "bootstrap/dist/css/bootstrap.min.css";
import "./styles.css";
import { loadDeviceOrder, moveDevice, orderDevices, saveDeviceOrder } from "./device-order.mjs";
import { buildAiboxOfflineReasons, buildTvGroups, buildTvOfflineNetworks, buildTvOfflineReasons, buildTvSiteLabels } from "./tv-groups.mjs";
import TimelapseView from "./TimelapseView.jsx";
import { mergeArchiveInventory } from "./timelapse-inventory.js";

const EMPTY_DATA = { generatedAt: null, sourceUpdatedAt: null, aiboxes: [], networks: [] };
const STATUS_FILTERS = ["all", "offline", "online", "unknown"];
const DEFAULT_PANEL_SIZES = { aibox: 0.3, network: 0.68 };
const PROJECTION_STALE_MS = 45_000;
const SOURCE_STALE_MS = 120_000;
const VIEW_PATHS = { tv: "/tv", dashboard: "/overview", fleet: "/fleet", connectivity: "/connectivity", timelapse: "/timelapse" };

function viewFromPath() {
  const pathname = window.location.pathname.replace(/\/+$/, "");
  return Object.keys(VIEW_PATHS).find((view) => VIEW_PATHS[view] === pathname) || "tv";
}
const EMPTY_AIBOX_FORM = {
  id: "",
  name: "",
  user: "",
  ip: "",
  networks: "",
  "target-interface": "",
  status_recipient_group: "default_group",
  resource_recipients: "",
  "check-devices": false,
  "check-resource": false,
};
const EMPTY_CAMERA_FORM = { scopeId: "", currentIp: "", ip: "", name: "" };

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function initialPanelSizes() {
  try {
    const stored = JSON.parse(window.localStorage.getItem("aiboxDashboardPanelSizes") || "{}");
    return {
      aibox: clamp(Number(stored.aibox) || DEFAULT_PANEL_SIZES.aibox, 0.05, 0.62),
      network: clamp(Number(stored.network) || DEFAULT_PANEL_SIZES.network, 0.48, 0.82),
    };
  } catch {
    return DEFAULT_PANEL_SIZES;
  }
}

function initialTheme() {
  const storedTheme = window.localStorage.getItem("theme");
  if (storedTheme === "dark" || storedTheme === "light") return storedTheme;
  return "dark";
}

function statusLabel(status) {
  if (status === "online") return "Kết nối";
  if (status === "offline") return "Mất kết nối";
  return "Chưa rõ";
}

function uiError(message) {
  const labels = {
    "Failed to fetch": "Không thể kết nối tới máy chủ.",
    "Invalid status snapshot": "Dữ liệu trạng thái không hợp lệ.",
    "Missing note fields": "Vui lòng nhập tên và nội dung ghi chú.",
    "Missing required AIBOX fields": "Vui lòng nhập đủ thông tin AIBOX bắt buộc.",
    "AIBOX id already exists": "Mã AIBOX đã tồn tại.",
    "AIBOX IP already exists": "Địa chỉ IP của AIBOX đã tồn tại.",
    "Unknown recipient group": "Nhóm nhận thông báo không tồn tại.",
    "AIBOX not found": "Không tìm thấy AIBOX.",
    "Missing AIBOX id": "Thiếu mã AIBOX.",
    "Network not found": "Không tìm thấy mạng.",
    "Missing camera fields": "Vui lòng nhập đủ thông tin camera.",
    "Camera IP already exists in this network": "IP camera đã tồn tại trong mạng này.",
    "Camera not found": "Không tìm thấy camera.",
    "Unauthorized": "Mã quản trị không hợp lệ hoặc chưa được nhập.",
    "Forbidden": "Bạn chưa có quyền thực hiện thao tác này.",
  };
  if (labels[message]) return labels[message];
  if (/^HTTP \d+$/.test(message)) return `Máy chủ trả về lỗi ${message}.`;
  return "Không thể hoàn tất yêu cầu. Vui lòng thử lại.";
}

function StatusSymbol({ status }) {
  const Icon = status === "online" ? WifiHigh : status === "offline" ? WifiSlash : QuestionMark;
  return <span aria-hidden="true" className={`connectivityIcon ${status}`}><Icon size="1em" weight="bold" /></span>;
}

function cameraTileLabel(camera) {
  const name = String(camera.name || "").trim();
  const isPlaceholder = !name || name.toLowerCase() === `camera ${camera.ip}`.toLowerCase();
  return isPlaceholder ? { label: camera.ip, isIp: true } : { label: name, isIp: false };
}

function compactDeviceName(name) {
  return String(name || "")
    .replace(/^Cảng\s+/i, "")
    .replace(/\s*-\s*Hải Phòng\s*/i, " ")
    .replace(/\s*-\s*Vũng Tàu\s*/i, " ")
    .replace(/Gia Minh\s*-\s*/i, "Gia Minh · ")
    .trim();
}

function applySavedOrder(items, order, keyFn) {
  const orderMap = new Map((order || []).map((key, index) => [key, index]));
  return items.slice().sort((a, b) => {
    const aKey = keyFn(a);
    const bKey = keyFn(b);
    const aIndex = orderMap.has(aKey) ? orderMap.get(aKey) : Number.MAX_SAFE_INTEGER;
    const bIndex = orderMap.has(bKey) ? orderMap.get(bKey) : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return 0;
  });
}

function mergedOrder(order, sourceKeys) {
  const sourceSet = new Set(sourceKeys);
  const kept = (order || []).filter((key) => sourceSet.has(key));
  const seen = new Set(kept);
  return kept.concat(sourceKeys.filter((key) => !seen.has(key)));
}

function moveToPosition(order, movingKey, targetKey, position) {
  if (!movingKey || !targetKey || movingKey === targetKey) return order;
  const next = order.filter((key) => key !== movingKey);
  const targetIndex = next.indexOf(targetKey);
  if (targetIndex === -1) return order;
  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, movingKey);
  return next;
}

function normalizeClientLayout(layout) {
  const cameraOrder = Object.create(null);
  const sourceCameraOrder = layout?.cameraOrder && typeof layout.cameraOrder === "object" && !Array.isArray(layout.cameraOrder)
    ? layout.cameraOrder
    : {};
  Object.keys(sourceCameraOrder).forEach((networkId) => {
    cameraOrder[networkId] = Array.isArray(sourceCameraOrder[networkId]) ? sourceCameraOrder[networkId] : [];
  });
  return {
    aiboxOrder: Array.isArray(layout?.aiboxOrder) ? layout.aiboxOrder : [],
    cameraOrder,
    networkOrder: Array.isArray(layout?.networkOrder) ? layout.networkOrder : [],
  };
}

function formatGeneratedAt(value) {
  if (!value) return "Đang chờ dữ liệu";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function formatDataAge(value, now) {
  const generated = new Date(value).getTime();
  if (!value || Number.isNaN(generated)) return "đang chờ dữ liệu";
  const seconds = Math.max(0, Math.floor((now - generated) / 1000));
  if (seconds < 60) return `${seconds} giây trước`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} giờ trước` : `${Math.floor(hours / 24)} ngày trước`;
}

function emptyNoteForm(note) {
  return { creator: note?.creator || "", content: note?.content || "" };
}

function formatDuration(since, now) {
  if (!since) return "";
  const started = new Date(since).getTime();
  if (Number.isNaN(started)) return "";
  const minutes = Math.max(0, Math.floor((now - started) / 60000));
  if (minutes < 1) return "<1 phút";
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours} giờ ${remainingMinutes} phút`;
  const days = Math.floor(hours / 24);
  return `${days} ngày ${hours % 24} giờ`;
}

function formatAvailability(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value === 100 ? "100" : Math.min(99.99, value).toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function noteKey(type, id) {
  return `${type}:${id}`;
}

function asNoteList(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function noteTargetLabel(key, lookup) {
  return lookup[key] || key.replace(/^aibox:/, "AIBOX ").replace(/^network:/, "Mạng ");
}

function isDataLoaded(data) {
  return Boolean(
    data
    && data.generatedAt
    && !Number.isNaN(new Date(data.generatedAt).getTime())
    && Array.isArray(data.aiboxes)
    && Array.isArray(data.networks)
  );
}

function modulo(value, length) {
  if (length <= 0) return 0;
  return ((value % length) + length) % length;
}

function chunkItems(items, size) {
  const safeSize = Math.max(1, size);
  if (!items.length) return [[]];
  return Array.from({ length: Math.ceil(items.length / safeSize) }, (_, index) => items.slice(index * safeSize, (index + 1) * safeSize));
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    function update() { setMatches(media.matches); }
    update();
    if (media.addEventListener) media.addEventListener("change", update);
    else media.addListener(update);
    return () => {
      if (media.removeEventListener) media.removeEventListener("change", update);
      else media.removeListener(update);
    };
  }, [query]);
  return matches;
}

function useDocumentVisible() {
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    function update() { setVisible(document.visibilityState === "visible"); }
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function useScrollAwarePageAdvance({ blocked, enabled, onAdvance, onDuration, pageKey, rootRef }) {
  useEffect(() => {
    if (blocked || !enabled) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;

    let advanceTimer = 0;
    let evaluateTimer = 0;
    let frame = 0;
    let tracked = [];
    let hasEvaluated = false;
    const handlers = new Map();

    function activeTracks() {
      return Array.from(root.querySelectorAll(".rollingName.isOverflowing .rollingNameTrack")).filter((track) => {
        let node = track.parentElement;
        while (node && node !== root) {
          if (node.classList.contains("autoDeckSlide") && node.getAttribute("aria-hidden") === "true") return false;
          node = node.parentElement;
        }
        return true;
      });
    }

    function sameTracks(next) {
      return next.length === tracked.length && next.every((track, index) => track === tracked[index]);
    }

    function clearTracking() {
      window.clearTimeout(advanceTimer);
      for (const [track, handler] of handlers) track.removeEventListener("animationiteration", handler);
      handlers.clear();
    }

    function evaluate() {
      const next = activeTracks();
      if (hasEvaluated && sameTracks(next)) return;
      hasEvaluated = true;
      clearTracking();
      tracked = next;

      if (!tracked.length) {
        onDuration(4_000);
        advanceTimer = window.setTimeout(onAdvance, 4_000);
        return;
      }

      let remaining = tracked.length;
      let longestScroll = 0;
      for (const track of tracked) {
        const animation = track.getAnimations().find((item) => item.animationName === "rollingName");
        const duration = Number(animation?.effect?.getTiming().duration) || 7_500;
        longestScroll = Math.max(longestScroll, duration);
        const handler = (event) => {
          if (event.animationName !== "rollingName") return;
          track.removeEventListener("animationiteration", handler);
          handlers.delete(track);
          animation?.pause();
          remaining -= 1;
          if (!remaining) advanceTimer = window.setTimeout(onAdvance, 1_000);
        };
        handlers.set(track, handler);
        track.addEventListener("animationiteration", handler);
        if (animation) {
          animation.currentTime = 0;
          animation.play();
        }
      }
      onDuration(longestScroll + 1_000);
    }

    function scheduleEvaluation() {
      window.clearTimeout(evaluateTimer);
      evaluateTimer = window.setTimeout(evaluate, 0);
    }

    const observer = new MutationObserver(scheduleEvaluation);
    observer.observe(root, { attributes: true, attributeFilter: ["aria-hidden", "class"], childList: true, subtree: true });
    frame = window.requestAnimationFrame(evaluate);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(evaluateTimer);
      clearTracking();
    };
  }, [blocked, enabled, onAdvance, onDuration, pageKey, rootRef]);
}

function RollingName({ className = "", name }) {
  const viewportRef = useRef(null);
  const trackRef = useRef(null);
  const textRef = useRef(null);
  const [scrollDistance, setScrollDistance] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text || typeof ResizeObserver === "undefined") return undefined;
    let frame = 0;
    function measure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = Math.max(0, Math.ceil(text.getBoundingClientRect().width - viewport.clientWidth));
        setScrollDistance((current) => current === next ? current : next);
      });
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(text);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [name]);

  useEffect(() => {
    if (!scrollDistance) return;
    const animation = trackRef.current?.getAnimations()[0];
    if (animation) animation.startTime = 0;
  }, [scrollDistance]);

  return (
    <strong className={`rollingName ${className} ${scrollDistance ? "isOverflowing" : ""}`.trim()} ref={viewportRef}>
      <span className="rollingNameTrack" ref={trackRef} style={{ "--rolling-distance": `${-scrollDistance}px` }}>
        <span className="rollingNameText" ref={textRef}>{name}</span>
      </span>
    </strong>
  );
}

function MeasuredPageDeck({
  activePage,
  ariaLabel,
  className,
  itemKey,
  items,
  maxColumns,
  maxRows = Number.MAX_SAFE_INTEGER,
  minHeight,
  minRows = 1,
  minWidth,
  onPageMeta,
  renderItem,
  wrapPages = true,
}) {
  const [emblaRef, emblaApi] = useEmblaCarousel({ align: "start", containScroll: "trimSnaps", duration: 20, loop: false, watchDrag: false });
  const [viewportNode, setViewportNode] = useState(null);
  const [fit, setFit] = useState({ columns: 1, rows: 1, capacity: 1 });
  const setViewport = useCallback((node) => {
    setViewportNode(node);
    emblaRef(node);
  }, [emblaRef]);

  useEffect(() => {
    if (!viewportNode || typeof ResizeObserver === "undefined") return undefined;
    let frame = 0;
    function measure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const style = window.getComputedStyle(viewportNode);
        const columnGap = parseFloat(style.getPropertyValue("--deck-column-gap")) || 5;
        const rowGap = parseFloat(style.getPropertyValue("--deck-row-gap")) || 5;
        const width = viewportNode.clientWidth;
        const height = viewportNode.clientHeight;
        const columns = Math.max(1, Math.min(maxColumns, Math.max(1, items.length), Math.floor((width + columnGap) / (minWidth + columnGap))));
        const rows = Math.max(1, Math.min(maxRows, Math.max(minRows, Math.floor((height + rowGap) / (minHeight + rowGap)))));
        const capacity = Math.max(1, columns * rows);
        setFit((current) => current.columns === columns && current.rows === rows ? current : { columns, rows, capacity });
      });
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewportNode);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [items.length, maxColumns, maxRows, minHeight, minRows, minWidth, viewportNode]);

  const pages = useMemo(() => chunkItems(items, fit.capacity), [fit.capacity, items]);
  const pageCount = pages.length;
  const safePage = wrapPages ? modulo(activePage, pageCount) : clamp(activePage, 0, Math.max(0, pageCount - 1));

  useEffect(() => {
    if (emblaApi) emblaApi.scrollTo(safePage);
  }, [emblaApi, safePage]);

  useEffect(() => {
    if (onPageMeta) onPageMeta({ capacity: fit.capacity, count: pageCount, page: safePage });
  }, [fit.capacity, onPageMeta, pageCount, safePage]);

  return (
    <div aria-label={ariaLabel} className={`autoDeckViewport ${className || ""}`} ref={setViewport} role="region">
      <div className="autoDeckTrack">
        {pages.map((pageItems, pageIndex) => (
          <div aria-hidden={pageIndex !== safePage} className="autoDeckSlide" inert={pageIndex !== safePage ? "" : undefined} key={`page-${pageIndex}`}>
            <div
              className="autoPageGrid"
              style={{
                "--deck-columns": fit.columns,
                "--deck-rows": fit.rows,
              }}
            >
              {pageItems.map((item, itemIndex) => renderItem(item, itemIndex, pageIndex))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const CAMERA_PILL_MIN = 132;
const CAMERA_PILL_HEIGHT = 38;
const CAMERA_PILL_GAP = 5;
const NETWORK_TILE_CHROME = 104;
// Camera columns inside a network box are always a multiple of three, so the
// grid grows 3 -> 6 -> 9 instead of taking whatever width happens to fit.
const CAMERA_COLUMN_UNIT = 3;
const CAMERA_COLUMN_MAX_UNITS = 3;
const EMPTY_NETWORK_FIT = { columns: 3, height: 0, left: 0, overflows: false, span: 1, top: 0, width: 0 };

/**
 * Largest multiple of CAMERA_COLUMN_UNIT columns whose pills still fit `width`.
 * Falls back to 1 unit (3 columns) when even that is wider than the box.
 */
function networkTileColumns(width) {
  const inner = Math.max(0, width - 18);
  const fitted = Math.max(1, Math.floor((inner + CAMERA_PILL_GAP) / (CAMERA_PILL_MIN + CAMERA_PILL_GAP)));
  // Cap at 9 columns: 3, 6, 9 only.
  const units = Math.min(CAMERA_COLUMN_MAX_UNITS, Math.max(1, Math.floor(fitted / CAMERA_COLUMN_UNIT)));
  return units * CAMERA_COLUMN_UNIT;
}

/**
 * Natural tile height for a camera count at a given width. A tile taller than
 * the board is pinned to the board height and scrolls its camera grid instead.
 */
function networkTileSize(cameraCount, width, maxHeight, rowHeight, chrome) {
  const columns = networkTileColumns(width);
  const rows = Math.max(1, Math.ceil(Math.max(cameraCount, 1) / columns));
  const content = rows * rowHeight + Math.max(0, rows - 1) * CAMERA_PILL_GAP;
  // Round up: a fractional height leaves the last row clipped by a sub-pixel,
  // which shows up as a one-line scrollbar on an otherwise fitting box.
  const natural = Math.ceil(chrome + content);
  const overflows = natural > Math.ceil(maxHeight) + 0.5;
  return { columns, height: overflows ? Math.ceil(maxHeight) : natural, rows, overflows };
}

/**
 * Page packer for the network board.
 *
 * Each page is a 3-column grid. A tile takes 1, 2, or 3 of those columns — the
 * narrowest span whose camera grid (in multiples of three camera columns) shows
 * every pill at full page height. Tiles drop into the shortest free slot so
 * vertical gaps close up; anything that no longer fits starts a new page, and
 * pages advance horizontally like the AIBOX deck.
 */
function packNetworkPages(items, width, maxHeight, gap, rowHeight, chrome, gridColumns) {
  const GRID_COLUMNS = Math.max(1, Math.min(3, gridColumns || 3));
  if (!width || !maxHeight) {
    return { pages: [items.map(() => null)] };
  }

  const columnWidth = (width - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
  const pages = [];
  let current = [];
  let tracks = new Array(GRID_COLUMNS).fill(0);

  const flush = () => {
    if (current.length) pages.push(current);
    current = [];
    tracks = new Array(GRID_COLUMNS).fill(0);
  };

  for (const item of items) {
    const cameraCount = item && Array.isArray(item.cameras) ? item.cameras.length : 0;

    // Choose the narrowest span that fits the page height.
    let placement = null;
    for (let span = 1; span <= GRID_COLUMNS; span += 1) {
      const tileWidth = columnWidth * span + gap * (span - 1);
      const size = networkTileSize(cameraCount, tileWidth, maxHeight, rowHeight, chrome);
      if (!size.overflows) {
        placement = { columns: size.columns, height: size.height, overflows: false, span };
        break;
      }
    }
    if (!placement) {
      // Even the full width overflows: pin it to the page height and let its
      // own camera grid scroll.
      const size = networkTileSize(cameraCount, width, maxHeight, rowHeight, chrome);
      placement = { columns: size.columns, height: Math.ceil(maxHeight), overflows: true, span: GRID_COLUMNS };
    }

    const findSlot = () => {
      let best = null;
      for (let start = 0; start + placement.span <= GRID_COLUMNS; start += 1) {
        let top = 0;
        for (let index = start; index < start + placement.span; index += 1) {
          top = Math.max(top, tracks[index]);
        }
        if (top + placement.height <= maxHeight + 0.5 && (!best || top < best.top - 0.5)) {
          best = { start, top };
        }
      }
      return best;
    };

    let slot = findSlot();
    if (!slot && current.length) {
      flush();
      slot = findSlot();
    }
    if (!slot) slot = { start: 0, top: 0 };

    for (let index = slot.start; index < slot.start + placement.span; index += 1) {
      tracks[index] = slot.top + placement.height + gap;
    }
    current.push({
      columns: placement.columns,
      height: placement.height,
      left: slot.start * (columnWidth + gap),
      overflows: placement.overflows,
      span: placement.span,
      top: slot.top,
      width: columnWidth * placement.span + gap * (placement.span - 1),
    });
  }
  flush();

  return { pages: pages.length ? pages : [[]] };
}

function NetworkBoard({ ariaLabel, activePage, className, gridColumns = 3, items, onPageMeta, renderItem }) {
  const [node, setNode] = useState(null);
  const [size, setSize] = useState({ height: 0, width: 0 });
  // Pill height and tile chrome are measured, not assumed: both change with the
  // viewport (pill 38px desktop, 41px mobile) and with dashboard density.
  const [metrics, setMetrics] = useState({ rowHeight: CAMERA_PILL_HEIGHT, chrome: NETWORK_TILE_CHROME });

  const setViewport = useCallback((element) => {
    setNode(element);
  }, []);

  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    let frame = 0;
    function measure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = { height: node.clientHeight, width: node.clientWidth };
        setSize((current) => current.height === next.height && current.width === next.width ? current : next);
      });
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [node]);

  // Measure one rendered pill and the tile chrome from every visible tile, not
  // just the first one: a long network name wraps the header, so the tallest
  // chrome is what the packer must budget for or the wrapped tiles scroll.
  useEffect(() => {
    if (!node) return undefined;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const tiles = node.querySelectorAll(".networkMatrixTile");
      const pill = node.querySelector(".networkCameraTile");
      const grid = node.querySelector(".networkCameraGrid");
      if (!tiles.length || !pill || !grid) {
        requestAnimationFrame(run);
        return;
      }
      // Row pitch comes from the resolved grid tracks: a pill is 37.6px but the
      // row it occupies is taller, so measuring the pill alone undersizes boxes.
      const gridStyle = getComputedStyle(grid);
      const trackSizes = (gridStyle.gridTemplateRows || "").split(" ").map((value) => parseFloat(value)).filter((value) => value > 0);
      const rowHeight = trackSizes.length ? Math.max(...trackSizes) : pill.getBoundingClientRect().height + (parseFloat(gridStyle.rowGap) || 0);

      let chrome = 0;
      for (const tile of tiles) {
        const header = tile.querySelector(".networkMatrixHead");
        const health = tile.querySelector(".networkMonitorHealth");
        if (!header || !health) continue;
        const style = getComputedStyle(tile);
        const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        // Borders count toward a tile's outer size but are not part of its
        // content box, so omitting them undersizes every box by 2px.
        const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
        const rowGap = parseFloat(style.rowGap) || 0;
        chrome = Math.max(
          chrome,
          pad + border + header.getBoundingClientRect().height + health.getBoundingClientRect().height + rowGap * 2,
        );
      }
      if (!rowHeight || !chrome) {
        requestAnimationFrame(run);
        return;
      }
      setMetrics((current) => (
        Math.abs(current.rowHeight - rowHeight) < 0.25 && Math.abs(current.chrome - chrome) < 0.25
          ? current
          : { rowHeight, chrome }
      ));
    };
    const frame = requestAnimationFrame(run);
    // Web fonts land after first paint and change header metrics; re-measure so
    // the boxes are sized against the settled layout.
    let observer = null;
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (!cancelled) requestAnimationFrame(run); });
    }
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => requestAnimationFrame(run));
      observer.observe(node);
    }
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (observer) observer.disconnect();
    };
  }, [node, items]);

  const layout = useMemo(
    () => packNetworkPages(items, size.width, size.height, CAMERA_PILL_GAP, metrics.rowHeight, metrics.chrome, gridColumns),
    [items, size.width, size.height, metrics.rowHeight, metrics.chrome, gridColumns],
  );

  const pageCount = Math.max(1, layout.pages.length);
  const safePage = modulo(activePage, pageCount);
  const page = layout.pages[safePage] || [];

  useEffect(() => {
    if (onPageMeta) onPageMeta({ capacity: Math.max(1, page.length), count: pageCount, page: safePage });
  }, [onPageMeta, page.length, pageCount, safePage]);

  // Each page is its own slide; the track translates horizontally exactly like
  // the AIBOX deck, so paging reads left to right instead of scrolling down.
  const pageOffsets = [];
  let runningOffset = 0;
  for (const entry of layout.pages) {
    pageOffsets.push(runningOffset);
    runningOffset += entry ? entry.length : 0;
  }

  return (
    <div aria-label={ariaLabel} className={`autoDeckViewport networkBoardViewport ${className || ""}`} ref={setViewport} role="region" tabIndex={0}>
      <div
        className="networkBoardTrack"
        style={{
          "--network-board-height": `${size.height}px`,
          "--network-board-width": `${size.width}px`,
          // Pixel translation: a percentage would resolve against the whole
          // track (pageCount x viewport), not against one page.
          transform: `translateX(-${safePage * size.width}px)`,
        }}
      >
        {layout.pages.map((pageLayout, pageIndex) => (
          <div
            aria-hidden={pageIndex !== safePage}
            className="networkBoardPage"
            inert={pageIndex !== safePage ? "" : undefined}
            key={`network-page-${pageIndex}`}
          >
            {pageLayout.map((fit, index) => {
              const item = items[pageOffsets[pageIndex] + index];
              if (!item) return null;
              // The first paint happens before the viewport has been measured,
              // so pages still contain placeholder slots. Render them at zero
              // size instead of dereferencing null.
              return renderItem(item, fit || EMPTY_NETWORK_FIT, pageIndex);
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function useAutoScroll(active, axis = "y") {
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !active) return undefined;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
    const horizontal = axis === "x";
    const read = () => horizontal ? element.scrollLeft : element.scrollTop;
    const write = (value) => { if (horizontal) element.scrollLeft = value; else element.scrollTop = value; };
    const extent = () => horizontal
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight;
    const HOLD_MS = 2400;
    // Keep a full sweep to a fixed reading time regardless of content length.
    const SWEEP_MS = horizontal ? 45000 : 0;
    let frame = 0;
    let last = 0;
    let position = read();
    let holdUntil = performance.now() + HOLD_MS;
    const paused = () => element.matches(":hover, :focus-within");
    const step = (now) => {
      const delta = last ? Math.min(now - last, 100) : 0;
      last = now;
      const end = extent();
      if (Math.abs(read() - position) > 2) position = read();
      if (end <= 1 || paused()) {
        position = read();
      } else if (now >= holdUntil) {
        if (position >= end) {
          position = 0;
          write(0);
          holdUntil = now + HOLD_MS;
        } else {
          // Horizontal: pace the whole track; vertical: fixed 0.02 px/ms.
          const speed = SWEEP_MS ? Math.max(0.02, end / SWEEP_MS) : 0.02;
          position = Math.min(end, position + delta * speed);
          write(position);
          if (position >= end) holdUntil = now + HOLD_MS;
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active, axis]);
  return ref;
}

function useCameraAutoScroll(active) {
  return useAutoScroll(active, "y");
}

const HOVER_PREVIEW_DELAY_MS = 260;
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 180;
const PREVIEW_MARGIN = 12;
const PREVIEW_OFFSET = 16;

// Latest saved snapshot for a camera, shown beside the pointer on hover/focus.
// It deliberately never falls back to another camera or a placeholder image:
// a missing or broken snapshot reads as "Chưa có ảnh".
function CameraHoverPreview({ camera, network, anchor, theme, onClose }) {
  const [imageState, setImageState] = useState("loading");
  const [position, setPosition] = useState(null);
  const pointerRef = useRef(anchor);
  const nodeRef = useRef(null);
  const frameRef = useRef(0);

  useEffect(() => {
    setImageState(camera.status === "online" ? "loading" : "idle");
  }, [camera.ip, camera.status]);

  const place = useCallback((point) => {
    pointerRef.current = point;
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      const source = pointerRef.current;
      if (!source) return;
      // Measure the real card instead of guessing: the caption height depends
      // on the label, and a wrong estimate lets the card run off-screen.
      const card = nodeRef.current;
      const width = card ? card.offsetWidth : PREVIEW_WIDTH;
      const height = card ? card.offsetHeight : PREVIEW_HEIGHT + 66;
      let left = source.x + PREVIEW_OFFSET;
      let top = source.y + PREVIEW_OFFSET;
      if (left + width + PREVIEW_MARGIN > window.innerWidth) left = source.x - width - PREVIEW_OFFSET;
      if (top + height + PREVIEW_MARGIN > window.innerHeight) top = source.y - height - PREVIEW_OFFSET;
      const next = {
        left: clamp(left, PREVIEW_MARGIN, Math.max(PREVIEW_MARGIN, window.innerWidth - width - PREVIEW_MARGIN)),
        top: clamp(top, PREVIEW_MARGIN, Math.max(PREVIEW_MARGIN, window.innerHeight - height - PREVIEW_MARGIN)),
      };
      // Comparing before storing keeps the post-mount re-clamp from looping.
      setPosition((current) => current && current.left === next.left && current.top === next.top ? current : next);
    });
  }, []);

  useEffect(() => {
    place(anchor);
    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [anchor, place]);

  useEffect(() => {
    if (!position) return;
    place(pointerRef.current || anchor);
  }, [position, anchor, place]);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!position) return null;

  const label = cameraTileLabel(camera).label;
  const online = camera.status === "online";
  const message = camera.status === "online" ? null : statusLabel(camera.status) === "Mất kết nối" ? "Camera ngoại tuyến" : "Chưa rõ trạng thái";

  // Portalled to <body>: the camera deck sits inside transformed and
  // overflow-hidden containers, so position:fixed would resolve against them
  // and the card could escape the viewport clamp.
  return createPortal(
    <div aria-hidden="true" className={`cameraHoverPreview ${theme === "dark" ? "isDark" : "isLight"} ${camera.status}`} onMouseMove={(event) => place({ x: event.clientX, y: event.clientY })} ref={nodeRef} role="presentation" style={{ left: `${position.left}px`, top: `${position.top}px`, width: `${PREVIEW_WIDTH}px` }}>
      <div className="cameraPreviewFrame">
        {online ? (
          <>
            <img
              alt=""
              onError={() => setImageState("error")}
              onLoad={() => setImageState("ready")}
              src={`/camera-snapshots/${network.id}/${camera.ip}.jpg`}
            />
            {imageState !== "ready" ? <span className="cameraPreviewNote">{imageState === "error" ? "Chưa có ảnh" : "Đang tải ảnh…"}</span> : null}
          </>
        ) : <span className="cameraPreviewNote">{message}</span>}
      </div>
      <div className="cameraPreviewMeta">
        <strong>{label}</strong>
        <span>{network.name} · {camera.ip}</span>
        <small>{statusLabel(camera.status)}</small>
      </div>
    </div>,
    document.body,
  );
}

// The camera pill owns the hover/focus lifecycle so the preview follows the
// pointer across neighbouring pills without flicker.
function CameraPill({ camera, network, theme, onHoverChange }) {
  const tile = cameraTileLabel(camera);
  const [anchor, setAnchor] = useState(null);
  const hoverTimerRef = useRef(0);
  const anchorRef = useRef(null);

  const close = useCallback(() => {
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = 0;
    anchorRef.current = null;
    setAnchor(null);
    onHoverChange(false);
  }, [onHoverChange]);

  useEffect(() => close, [close]);

  const open = useCallback((point) => {
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      anchorRef.current = point;
      setAnchor(point);
      onHoverChange(true);
    }, HOVER_PREVIEW_DELAY_MS);
  }, [onHoverChange]);

  const move = useCallback((event) => {
    const point = { x: event.clientX, y: event.clientY };
    if (!anchorRef.current) {
      // Waiting out the delay: restart from the newest pointer position.
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = window.setTimeout(() => {
        anchorRef.current = point;
        setAnchor(point);
        onHoverChange(true);
      }, HOVER_PREVIEW_DELAY_MS);
      return;
    }
    setAnchor(point);
  }, [onHoverChange]);

  const methodLabel = camera.method === "image" ? "Kiểm tra hình ảnh" : camera.method === "ping-fallback" ? "Ping dự phòng" : camera.method === "ping" ? "Kiểm tra ping" : "Chưa thể kiểm tra";

  return (
    <>
      <article
        aria-label={`${camera.name}, IP ${camera.ip}, ${statusLabel(camera.status)}, ${methodLabel}`}
        className={`networkCameraTile ${camera.status}`}
        key={`${network.id}-${camera.ip}`}
        onBlur={close}
        onFocus={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          open({ x: box.right, y: box.top });
        }}
        onMouseEnter={(event) => open({ x: event.clientX, y: event.clientY })}
        onMouseLeave={close}
        onMouseMove={move}
        title={`${camera.name} · ${camera.ip} · ${methodLabel}`}
      >
        <StatusSymbol status={camera.status} /><RollingName className={tile.isIp ? "cameraIp mono" : "cameraName"} name={tile.label} /><small aria-label={methodLabel} className={`cameraMethod ${camera.method === "image" ? "image" : camera.method === "unknown" ? "unknown" : "ping"}`}>{camera.method === "image" ? "ẢNH" : camera.method === "ping-fallback" ? "PING*" : camera.method === "ping" ? "PING" : "—"}</small>{camera.quality === "lagging" ? <small aria-label="Trễ" className="cameraMethod lag" title={`Trễ (${camera.valid}/${camera.validTotal} khung hình hợp lệ)`}>TRỄ</small> : null}{typeof camera.availability === "number" ? <small className="tileAvailability" title="Tỷ lệ thời gian kết nối">{formatAvailability(camera.availability)}</small> : null}
      </article>
      {anchor ? <CameraHoverPreview anchor={anchor} camera={camera} network={network} onClose={close} theme={theme} /> : null}
    </>
  );
}

function NetworkCameraGrid({ cameras, columns, label, networkId, render }) {
  const scrollRef = useCameraAutoScroll(true);
  return (
    <div
      aria-label={`${label}: camera`}
      className="networkCameraGrid"
      ref={scrollRef}
      role="group"
      style={{ "--camera-columns": columns }}
      tabIndex={0}
    >
      {cameras.map((camera) => render(camera, networkId))}
    </div>
  );
}

function PageIndicator({ label, meta, total }) {
  const count = Math.max(1, meta.count || 1);
  const page = modulo(meta.page || 0, count);
  const start = total ? page * Math.max(1, meta.capacity || 1) + 1 : 0;
  const end = Math.min(total, (page + 1) * Math.max(1, meta.capacity || 1));
  const totalLabel = label === "AIBOX" ? label : label.toLowerCase();
  if (count === 1) return <span className="pageIndicator"><span>Tổng {total} {totalLabel}</span></span>;
  return (
    <span className="pageIndicator" title={`${label}: trang ${page + 1}/${count}, mục ${start} đến ${end}/${total}`}>
      <span>{label}: trang</span> {page + 1}/{count} <small>Hiển thị {start}–{end}/{total}</small>
    </span>
  );
}

function ResizeHandle({ axis, label, onKeyDown, onPointerDown }) {
  return (
    <div
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      className={`dashboardResizeHandle axis-${axis}`}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      role="separator"
      tabIndex="0"
      title={`${label}. Kéo hoặc dùng phím mũi tên.`}
    ><span /></div>
  );
}

function OperationsRibbon({ aiboxes, focuses, networks, onFocus, paused }) {
  const viewportRef = useRef(null);
  const interactionTimerRef = useRef(0);
  const [interacting, setInteracting] = useState(false);
  const onlineAiboxes = aiboxes.filter((box) => box.status === "online").length;
  const offlineAiboxes = aiboxes.filter((box) => box.status === "offline").length;
  const unknownAiboxes = aiboxes.length - onlineAiboxes - offlineAiboxes;
  const networkSummaries = networks.map((network) => ({
    ...network,
    online: network.cameras.filter((camera) => camera.status === "online").length,
    offline: network.cameras.filter((camera) => camera.status === "offline").length,
    unknown: network.cameras.filter((camera) => camera.status === "unknown").length,
  }));
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || paused || interacting) return undefined;
    const timer = window.setInterval(() => {
      if (viewport.scrollWidth <= viewport.clientWidth + 2) return;
      const maxScroll = viewport.scrollWidth - viewport.clientWidth;
      const nextScroll = viewport.scrollLeft >= maxScroll - 8
        ? 0
        : Math.min(maxScroll, viewport.scrollLeft + Math.min(260, viewport.clientWidth * 0.75));
      viewport.scrollTo({ left: nextScroll, behavior: "smooth" });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [interacting, paused, aiboxes, networks]);

  useEffect(() => () => window.clearTimeout(interactionTimerRef.current), []);

  function pauseForInteraction() {
    window.clearTimeout(interactionTimerRef.current);
    setInteracting(true);
  }

  function resumeAfterInteraction() {
    window.clearTimeout(interactionTimerRef.current);
    interactionTimerRef.current = window.setTimeout(() => setInteracting(false), 5_000);
  }

  return (
    <section className="operationsRibbon" aria-label="Phạm vi giám sát">
      <div className="ribbonLabel"><strong>Phạm vi</strong><span>{focuses.length ? `Đã chọn ${focuses.length}` : "Toàn hệ thống"}</span></div>
      <div
        className="ribbonViewport"
        onBlur={resumeAfterInteraction}
        onFocus={pauseForInteraction}
        onMouseEnter={pauseForInteraction}
        onMouseLeave={resumeAfterInteraction}
        onPointerDown={pauseForInteraction}
        onPointerUp={resumeAfterInteraction}
        ref={viewportRef}
        tabIndex="0"
      >
        <div className="ribbonTrack">
          <button aria-pressed={!focuses.length} className={`ribbonCard all ${!focuses.length ? "active" : ""}`} onClick={() => onFocus("all")} title="Xem tổng quan toàn hệ thống" type="button">
            <header><strong>Toàn hệ thống</strong><span>Tổng quan trực tiếp</span></header>
            <div className="ribbonMetrics"><span>{aiboxes.length} AIBOX</span><span>{networks.reduce((total, network) => total + network.cameras.length, 0)} camera</span></div>
          </button>
          <button aria-pressed={focuses.includes("fleet")} className={`ribbonCard fleet ${focuses.includes("fleet") ? "active" : ""}`} onClick={() => onFocus("fleet")} title={`${onlineAiboxes} kết nối, ${offlineAiboxes} mất kết nối, tổng ${aiboxes.length} AIBOX`} type="button">
            <header><strong>Hệ thống AIBOX</strong><span>Tổng {aiboxes.length}</span></header>
            <div className="ribbonMetrics"><span className="online"><b>{onlineAiboxes}</b> kết nối</span><span className="offline"><b>{offlineAiboxes}</b> mất kết nối</span>{unknownAiboxes ? <span className="unknown"><b>{unknownAiboxes}</b> chưa rõ</span> : null}</div>
          </button>
          {networkSummaries.map((network) => (
            <button aria-pressed={focuses.includes(network.id)} className={`ribbonCard network ${focuses.includes(network.id) ? "active" : ""}`} key={network.id} onClick={() => onFocus(network.id)} title={`${network.name}: ${network.online} camera kết nối, ${network.offline} mất kết nối, ${network.unknown} chưa rõ`} type="button">
              <header><strong>{compactDeviceName(network.name)}</strong><span>{network.cameras.length} camera</span></header>
              <div className="ribbonMetrics"><span className="online"><b>{network.online}</b> kết nối</span><span className="offline"><b>{network.offline}</b> mất kết nối</span>{network.unknown ? <span className="unknown"><b>{network.unknown}</b> chưa rõ</span> : null}</div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function NetworkMonitorHealth({ network, now, onFocus }) {
  const checkers = network.monitorAiboxes || [];
  const onlineCheckers = checkers.filter((box) => box.status === "online").length;
  const unknownCameras = (network.cameras || []).filter((camera) => camera.status === "unknown").length;
  const blind = network.monitorStatus !== "online";
  const degraded = !blind && onlineCheckers < checkers.length;
  const degradedSince = checkers
    .filter((box) => box.status !== "online" && box.statusSince)
    .sort((a, b) => new Date(a.statusSince) - new Date(b.statusSince))[0]?.statusSince;
  const since = blind
    ? network.monitorStatusSince || (network.cameras || []).find((camera) => camera.status === "unknown" && camera.statusSince)?.statusSince
    : degraded ? degradedSince : null;
  const duration = formatDuration(since, now);
  const checkerSummary = checkers.length ? `${onlineCheckers}/${checkers.length} máy kiểm tra kết nối` : "Chưa gán máy kiểm tra";
  const cause = blind && onlineCheckers ? "Chưa có dữ liệu khu vực" : blind ? "Không có máy kiểm tra hoạt động" : degraded ? "Giám sát suy giảm" : "Giám sát bình thường";
  const state = blind ? "blind" : degraded ? "degraded" : "healthy";
  const impact = blind ? `${unknownCameras} chưa rõ` : degraded ? `${onlineCheckers}/${checkers.length} kết nối` : "Bình thường";

  return (
    <button
      aria-label={`${network.name}: ${cause}. ${checkerSummary}. ${unknownCameras} camera thiếu dữ liệu${duration ? ` trong ${duration}` : ""}. Xem mạng này.`}
      className={`networkMonitorHealth ${state}`}
      onClick={() => onFocus(network.id)}
      title={`Xem ${network.name}`}
      type="button"
    >
      <span className="networkMonitorState"><strong>{cause}</strong><small>{checkerSummary}{duration ? ` · ${duration}` : ""}</small></span>
      <b>{impact}</b>
    </button>
  );
}

const CONNECTIVITY_SEVERITY_LABELS = ["Bình thường", "Cảnh báo", "Suy giảm", "Nghiêm trọng"];
const CONNECTIVITY_WINDOWS = [
  { hours: 6, label: "6 giờ" },
  { hours: 24, label: "24 giờ" },
  { hours: 168, label: "7 ngày" },
  { hours: 720, label: "30 ngày" },
  { hours: 0, label: "Toàn bộ" },
];

function clampSeverity(value) {
  return Math.min(3, Math.max(0, Number(value) || 0));
}

function severityLabel(value) {
  return CONNECTIVITY_SEVERITY_LABELS[clampSeverity(value)];
}

function sampleSeverityLevel(sample) {
  if (!sample) return 0;
  if (sample.state === "offline") return 3;
  return clampSeverity(sample.severity != null ? sample.severity : (sample.opened || sample.closed || {}).worst_severity);
}

function sampleSeverityLabel(sample) {
  if (sample?.kind === "diagnostic") return "Chẩn đoán";
  if (!sample) return "Chưa có dữ liệu";
  if (sample.state === "offline") return "Mất kết nối";
  return severityLabel(sample.severity != null ? sample.severity : (sample.opened || sample.closed || {}).worst_severity);
}

const CONNECTIVITY_STALE_MS = 180_000;

function machineReachability(machine, box, now) {
  const offline = Boolean(box && box.status === "offline");
  const collected = machine?.collection?.collected;
  const collectedMs = typeof collected === "number" ? collected * 1000 : collected ? Date.parse(collected) : null;
  const collectionError = String(machine?.collection?.error || "").trim();
  // Four distinct states, because they mean different things to an operator:
  //   failed  - the collector reached nothing (ssh/agent error); no new data.
  //   missing - collector succeeded but the agent has never returned a record.
  //   stale   - data exists but is older than the freshness window.
  //   ok      - fresh.
  const missing = collectedMs == null || Number.isNaN(collectedMs);
  const stale = !missing && (now - collectedMs) > CONNECTIVITY_STALE_MS;
  const failed = Boolean(collectionError) && !offline;
  return { offline, stale, missing, failed, collectionError, collectedMs };
}

function ReachabilityChip({ reach, box }) {
  if (reach.offline) {
    return <span className="reachChip offline" title={box?.statusSince ? `Mất kết nối từ ${formatGeneratedAt(box.statusSince)}` : "Thiết bị mất kết nối"}>Mất kết nối</span>;
  }
  if (reach.failed) {
    return <span className="reachChip failed" title={`Máy thu thập không lấy được dữ liệu: ${reach.collectionError}`}>Lỗi thu thập</span>;
  }
  if (reach.missing) {
    return <span className="reachChip missing" title="Chưa từng nhận dữ liệu kết nối từ thiết bị">Chưa có dữ liệu</span>;
  }
  if (reach.stale) {
    return <span className="reachChip stale" title="Chưa nhận dữ liệu gần đây từ thiết bị">Dữ liệu cũ</span>;
  }
  return <span className="reachChip online" title="Có thể kết nối thiết bị">Trực tiếp</span>;
}

function formatProbeTime(value) {
  if (typeof value !== "number") return formatGeneratedAt(value);
  return formatGeneratedAt(value * 1000);
}

function primaryAddress(sample) {
  const address = (sample?.addresses || []).find((item) => item.family === "inet");
  return address ? address.local : "—";
}

function targetsSummary(sample) {
  const targets = sample?.targets || [];
  if (!targets.length) return "—";
  const worstLoss = targets.reduce((maximum, target) => Math.max(maximum, Number(target.loss) || 0), 0);
  return `${targets.length} phép đo${worstLoss ? ` · mất gói tối đa ${worstLoss}%` : ""}`;
}

function systemRoute(sample) {
  const route = (sample?.system_default_path || [])[0];
  if (!route) return "—";
  const gateway = route.gateway && route.gateway !== "0.0.0.0" ? route.gateway : "";
  return [route.dev, gateway ? `qua ${gateway}` : ""].filter(Boolean).join(" ") || route.dst || "—";
}

function timeBounds(early, late) {
  if (early != null && late != null) return `${formatProbeTime(early)}–${formatProbeTime(late)}`;
  const single = late != null ? late : early;
  return single != null ? formatProbeTime(single) : "chưa rõ";
}

function incidentDetail(record) {
  const parts = [];
  const opened = record.opened;
  const closed = record.closed;
  const category = (value) => ({ outage: "mất kết nối", lag: "độ trễ", normal: "bình thường" })[value] || value || "chưa rõ loại";
  if (closed) parts.push(`Sự cố ${category(closed.category)} đã kết thúc · mức cao nhất ${severityLabel(closed.worst_severity)}${closed.peak_rtt_ms != null ? ` · đỉnh ${Math.round(closed.peak_rtt_ms)} ms` : ""}${closed.duration_seconds != null ? ` · kéo dài khoảng ${Math.round(closed.duration_seconds / 60)} phút` : ""} · phục hồi ${timeBounds(closed.end_previous, closed.end)}`);
  if (opened) parts.push(`Sự cố ${category(opened.category)} bắt đầu · mức độ ${severityLabel(opened.worst_severity)} · từ ${timeBounds(opened.start_previous, opened.start)}`);
  return parts.join(" · ") || "Cập nhật sự cố";
}

const CONNECTIVITY_PAGE_SIZE = 100;

function ConnectivityView({ aiboxes, now }) {
  const [fleet, setFleet] = useState(null);
  const [fleetError, setFleetError] = useState("");
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [machineId, setMachineId] = useState("");
  const [link, setLink] = useState("");
  const [kind, setKind] = useState("");
  const [windowHours, setWindowHours] = useState(24);
  const [minimumSeverity, setMinimumSeverity] = useState(0);
  const [page, setPage] = useState(0);
  const [context, setContext] = useState([]);
  const [order, setOrder] = useState(() => loadDeviceOrder(window.localStorage));
  const [reorderMode, setReorderMode] = useState(false);
  const [orderWarning, setOrderWarning] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const visible = useDocumentVisible();

  // Age is measured against the response time reported by the server, so client
  // clock drift and poll lag cannot make a healthy feed look old.
  const clock = typeof fleet?.fetchedAt === "number" ? fleet.fetchedAt * 1000 : now;
  const machines = fleet?.machines ?? [];
  const enrolled = machines.filter((machine) => machine.enrolled);
  const orderedEnrolled = useMemo(() => orderDevices(enrolled, order), [enrolled, order]);
  const activeMachine = machines.find((machine) => machine.id === machineId) || enrolled[0] || null;
  const activeKey = activeMachine ? (activeMachine.id || activeMachine.machine) : "";
  const aiboxByIp = useMemo(() => Object.fromEntries(aiboxes.map((box) => [box.ip, box])), [aiboxes]);
  const waitingMachines = fleet?.waitingMachines ?? [];
  const activeBox = activeMachine ? aiboxByIp[activeMachine.ip] || null : null;
  const activeReach = activeMachine ? machineReachability(activeMachine, activeBox, clock) : null;
  const activeLastKnown = Boolean(activeReach && (activeReach.offline || activeReach.failed || activeReach.stale || activeReach.missing));
  const mappedIps = new Set(machines.map((machine) => machine.ip).filter(Boolean));
  const waitingIps = new Set(waitingMachines.map((machine) => machine.ip));
  const unenrolled = aiboxes.filter((box) => !mappedIps.has(box.ip) && !waitingIps.has(box.ip));
  const exportParams = new URLSearchParams();
  if (activeKey) exportParams.set("machine", activeKey);
  if (windowHours) exportParams.set("since", String(Math.floor(Date.now() / 1000) - windowHours * 3600));
  const exportHref = `/api/connectivity/export.csv?${exportParams.toString()}`;
  const openIncidents = useMemo(() => {
    const opened = new Set();
    const closed = new Set();
    context.forEach((record) => {
      if (record.opened && record.opened.incident_id) opened.add(record.opened.incident_id);
      if (record.closed && record.closed.incident_id) closed.add(record.closed.incident_id);
    });
    return new Set([...opened].filter((incidentId) => !closed.has(incidentId)));
  }, [context]);
  const incidentCount = useMemo(() => {
    const ids = new Set();
    context.forEach((record) => {
      if (record.kind !== "incident") return;
      if (record.opened && record.opened.incident_id) ids.add(record.opened.incident_id);
      if (record.closed && record.closed.incident_id) ids.add(record.closed.incident_id);
    });
    return ids.size;
  }, [context]);
  const gapTimesByLink = useMemo(() => {
    const grouped = {};
    context.forEach((record) => {
      if (record.kind !== "gap") return;
      const key = record.link || "";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(record.ts);
    });
    return grouped;
  }, [context]);
  const hasNext = history.length >= CONNECTIVITY_PAGE_SIZE;

  function persistOrder(ips) {
    setOrder(ips);
    setOrderWarning(!saveDeviceOrder(window.localStorage, ips));
  }

  function applyMove(from, to) {
    const ips = orderedEnrolled.map((machine) => machine.ip);
    persistOrder(moveDevice(ips, from, to));
  }

  function resetOrder() {
    persistOrder([]);
  }

  function clearDrag() {
    setDragIndex(null);
    setDragOverIndex(null);
  }

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    let controller = null;
    async function loadFleet() {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/api/connectivity/fleet?t=${Date.now()}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json();
        if (!cancelled) {
          setFleet(next);
          setFleetError("");
        }
      } catch (error) {
        if (!cancelled && error.name !== "AbortError") setFleetError(uiError(error.message));
      }
    }
    loadFleet();
    const timer = setInterval(loadFleet, 30_000);
    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(timer);
    };
  }, [visible]);

  useEffect(() => {
    setPage(0);
  }, [activeKey, link, kind, minimumSeverity, windowHours]);

  useEffect(() => {
    if (!activeKey || !visible) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    async function loadContext() {
      try {
        const params = new URLSearchParams({ machine: activeKey, kind: "incident,gap", limit: "500" });
        if (link) params.set("link", link);
        if (windowHours) params.set("since", String(Math.floor(Date.now() / 1000) - windowHours * 3600));
        const response = await fetch(`/api/connectivity/history?${params.toString()}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json();
        if (!cancelled) setContext(Array.isArray(next) ? next : []);
      } catch (error) {
        if (!cancelled && error.name !== "AbortError") setContext([]);
      }
    }
    loadContext();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeKey, link, windowHours, visible]);

  useEffect(() => {
    if (!activeKey || !visible) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    async function loadHistory() {
      setHistoryLoading(true);
      try {
        const params = new URLSearchParams({ machine: activeKey, limit: String(CONNECTIVITY_PAGE_SIZE), offset: String(page * CONNECTIVITY_PAGE_SIZE) });
        if (link) params.set("link", link);
        if (kind) params.set("kind", kind);
        if (minimumSeverity) params.set("minimum_severity", String(minimumSeverity));
        if (windowHours) params.set("since", String(Math.floor(Date.now() / 1000) - windowHours * 3600));
        const response = await fetch(`/api/connectivity/history?${params.toString()}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json();
        if (!cancelled) {
          setHistory(Array.isArray(next) ? next : []);
          setHistoryError("");
        }
      } catch (error) {
        if (!cancelled && error.name !== "AbortError") setHistoryError(uiError(error.message));
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    }
    loadHistory();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeKey, link, kind, minimumSeverity, windowHours, visible, page]);

  function machineLabel(machine) {
    const box = aiboxByIp[machine.ip];
    return box ? compactDeviceName(box.name) : machine.label || machine.machine;
  }

  return (
    <div className="container-xxl connectivityView">
      <section className="hero controlDeck connectivityHero">
        <div className="heroCopy">
          <p className="eyebrow">Dữ liệu đường truyền</p>
          <h1 id="connectivity-heading">Lịch sử kết nối</h1>
          <p className="subtitle">Lịch sử kiểm tra LAN và USB độc lập, thu thập từ từng AIBOX.</p>
        </div>
        <div className="heroControls">
          <a className="heroAction secondary" href={exportHref} download><DownloadSimple aria-hidden="true" size={14} weight="bold" />Xuất CSV</a>
        </div>
      </section>

      {fleetError ? <div className="alert alert-danger rounded-4" role="alert"><span>Không thể thu thập dữ liệu kết nối: {fleetError}</span></div> : null}

      <section className="summaryGrid connectivitySummary" aria-label="Tổng hợp kết nối">
        <Stat label="Đang thu thập" value={enrolled.length} />
        <Stat label="Thiết bị giám sát" value={aiboxes.length} />
        <Stat label="Chưa đăng ký" value={unenrolled.length} tone={unenrolled.length ? "muted" : "normal"} />
        <Stat label="Bản ghi hiển thị" value={history.length} />
      </section>

      <section className="connectivityWorkspace">
        <div className="connectivityPanel panel card border-0">
          <div className="card-body">
            <div className="sectionHeader connectivityDeviceHeader">
              <div><h2 className="mb-0">Thiết bị giám sát <span className="sectionMeta">· {enrolled.length} đang theo dõi · {waitingMachines.length} đang chờ</span></h2><p className="sectionMeta mb-0">Khả năng kết nối thiết bị và trạng thái LAN / USB độc lập.</p></div>
              <div className="connectivityDeviceControls">
                <button aria-pressed={reorderMode} className="filterChip" onClick={() => setReorderMode((value) => !value)} type="button">{reorderMode ? "Hoàn tất" : "Sắp xếp"}</button>
                {reorderMode ? <button className="filterChip" disabled={!order.length} onClick={resetOrder} type="button">Đặt lại thứ tự</button> : null}
              </div>
            </div>
            {orderWarning ? <p className="connectivityOrderWarning" role="status">Không thể lưu thứ tự trong trình duyệt này.</p> : null}
            {reorderMode ? <p className="sectionMeta connectivityReorderHint mb-0">Kéo tay nắm hoặc dùng nút mũi tên để sắp xếp. Thứ tự được lưu trong trình duyệt này.</p> : null}
            <div className="connectivityDeviceList" role="group" aria-label="Thiết bị giám sát">
              {enrolled.length ? orderedEnrolled.map((machine, index) => {
                const box = aiboxByIp[machine.ip];
                const reach = machineReachability(machine, box, clock);
                const lastKnown = reach.offline || reach.failed || reach.stale || reach.missing;
                const cardClassName = `connectivityDeviceCard ${activeKey === machine.id ? "active" : ""} ${reach.offline ? "deviceOffline" : reach.failed || reach.stale || reach.missing ? "deviceStale" : ""}`;
                const cardBody = (
                  <>
                    <span className="connectivityDeviceHead">
                      <strong>{machineLabel(machine)}</strong>
                      <ReachabilityChip reach={reach} box={box} />
                    </span>
                    <span className="mono">{machine.ip || machine.machine}{lastKnown ? " · dữ liệu gần nhất" : ""}</span>
                    <span className="connectivityDeviceMeta">
                      {(["LAN", "USB"]).map((name) => {
                        const sample = machine.links?.[name]?.sample;
                        const stale = lastKnown || machine.links?.[name]?.stale;
                        return <span className={`miniStatus ${stale ? "muted" : sample?.state === "online" ? "good" : sample?.state === "offline" ? "bad" : "muted"}`} key={name}>{name} {sample ? `${stale ? "Gần nhất: " : ""}${statusLabel(sample.state)}` : "Chưa có dữ liệu"}</span>;
                      })}
                    </span>
                  </>
                );
                if (!reorderMode) {
                  return (
                    <button aria-pressed={activeKey === machine.id} className={cardClassName} key={machine.machine} onClick={() => setMachineId(machine.id)} type="button">
                      {cardBody}
                    </button>
                  );
                }
                const isLast = index === orderedEnrolled.length - 1;
                return (
                  <div className={`connectivityReorderItem${dragIndex === index ? " dragging" : ""}${dragOverIndex === index && dragIndex !== null && dragIndex !== index ? " dragOver" : ""}`} key={machine.machine} onDragOver={(event) => { event.preventDefault(); if (dragOverIndex !== index) setDragOverIndex(index); }} onDrop={(event) => { event.preventDefault(); if (dragIndex !== null) applyMove(dragIndex, index); clearDrag(); }}>
                    <span aria-hidden="true" className="reorderHandle" draggable onDragEnd={clearDrag} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDragIndex(index); }} title={`Kéo ${machineLabel(machine)}`}><DotsSixVertical size="1.1em" weight="bold" /></span>
                    <button aria-pressed={activeKey === machine.id} className={cardClassName} onClick={() => setMachineId(machine.id)} type="button">
                      <span className="reorderPosition">{String(index + 1).padStart(2, "0")}</span>
                      <span className="reorderIdentity"><strong>{machineLabel(machine)}</strong><span>{machine.ip}</span></span>
                      <ReachabilityChip reach={reach} box={box} />
                    </button>
                    <span className="reorderNetworkStates">{["LAN", "USB"].map((name) => { const sample = machine.links?.[name]?.sample; return <span key={name}>{name} {sample ? `${lastKnown || machine.links?.[name]?.stale ? "Gần nhất: " : ""}${statusLabel(sample.state)}` : "Chưa có dữ liệu"}</span>; })}</span>
                    <span className="reorderControls">
                      <button aria-label={`Đưa ${machineLabel(machine)} lên`} className="reorderButton" disabled={index === 0} onClick={() => applyMove(index, index - 1)} type="button"><CaretUp size="1em" weight="bold" /></button>
                      <button aria-label={`Đưa ${machineLabel(machine)} xuống`} className="reorderButton" disabled={isLast} onClick={() => applyMove(index, index + 1)} type="button"><CaretDown size="1em" weight="bold" /></button>
                    </span>
                  </div>
                );
              }) : <p className="emptyState compact">{fleetError ? "Không thể kết nối dịch vụ thu thập." : "Chưa có thiết bị thu thập dữ liệu."}</p>}
            </div>
            {waitingMachines.length ? (
              <details className="connectivityUnenrolled" open>
                <summary>{waitingMachines.length} thiết bị đang chờ bộ theo dõi · chưa có dữ liệu đường truyền</summary>
                <div className="connectivityWaitingList">
                  {waitingMachines.map((machine) => {
                    const box = aiboxByIp[machine.ip];
                    return (
                      <article className="connectivityWaitingCard" key={machine.machine}>
                        <strong>{box ? compactDeviceName(box.name) : machine.label || machine.machine}</strong>
                        <span className="mono">{machine.ip}</span>
                        <span className="reachChip stale">Đang chờ bộ theo dõi</span>
                        <span className="connectivityWaitingLinks"><span>LAN · Chưa có dữ liệu</span><span>USB · Chưa có dữ liệu</span></span>
                      </article>
                    );
                  })}
                </div>
              </details>
            ) : null}
            {unenrolled.length ? (
              <details className="connectivityUnenrolled">
                <summary>{unenrolled.length} thiết bị chưa có yêu cầu theo dõi kết nối</summary>
                <p>{unenrolled.map((box) => compactDeviceName(box.name)).join(", ")}</p>
              </details>
            ) : null}
          </div>
        </div>

        {activeMachine ? (
          <div className="connectivityPanel panel card border-0">
            <div className="card-body">
              <div className="sectionHeader">
                <div>
                  <h2 className="mb-0">{machineLabel(activeMachine)} · trạng thái đường truyền <ReachabilityChip reach={activeReach} box={activeBox} /></h2>
                  <p className="sectionMeta mb-0">{activeReach.offline ? "Thiết bị mất kết nối · hiển thị số đo gần nhất. " : activeReach.failed ? "Máy thu thập không lấy được dữ liệu · hiển thị số đo gần nhất. " : activeReach.missing ? "Chưa từng nhận dữ liệu kết nối từ thiết bị. " : activeReach.stale ? "Chưa có mẫu gần đây · hiển thị số đo gần nhất. " : ""}{activeMachine.collection?.error ? `Lỗi thu thập: ${uiError(activeMachine.collection.error)}` : `Vị trí đọc ${activeMachine.collection?.cursor ?? "—"} · thu thập ${activeMachine.collection?.collected ? formatProbeTime(activeMachine.collection.collected) : "chưa thực hiện"}`}</p>
                </div>
              </div>
              <div className="connectivityLinkGrid">
                {(["LAN", "USB"]).map((name) => {
                  const entry = activeMachine.links?.[name];
                  const sample = entry?.sample;
                  return (
                    <article className={`linkCard ${sample?.state || "unknown"} ${entry?.stale || activeLastKnown ? "stale" : ""}${activeLastKnown ? " lastKnown" : ""}`} key={name}>
                      <header className="linkCardHead">
                        <h3>{name} <span className="mono">{sample?.interface || "—"}</span></h3>
                        <span className={`severityChip sev-${sampleSeverityLevel(sample)}`}>{sampleSeverityLabel(sample)}</span>
                      </header>
                      {sample ? (
                        <dl className="linkMetrics">
                          <div><dt>Trạng thái</dt><dd>{statusLabel(sample.state)}</dd></div>
                          <div><dt>RTT</dt><dd>{sample.rtt_ms != null ? `${sample.rtt_ms.toFixed(1)} ms` : "—"}</dd></div>
                          <div><dt>Mất gói</dt><dd>{sample.loss_percent != null ? `${sample.loss_percent}%` : "—"}</dd></div>
                          <div><dt>Tín hiệu</dt><dd>{sample.carrier_down ? "Mất" : "Có"}</dd></div>
                          <div><dt>Địa chỉ</dt><dd className="mono">{primaryAddress(sample)}</dd></div>
                          <div><dt>Đích kiểm tra</dt><dd>{targetsSummary(sample)}</dd></div>
                          <div><dt>Định tuyến</dt><dd className="mono">{systemRoute(sample)}</dd></div>
                        </dl>
                      ) : <p className="emptyState compact">Chưa ghi nhận mẫu dữ liệu.</p>}
                      {sample ? <p className="linkCardFoot">{activeLastKnown ? "Phép đo gần nhất đã biết" : "Phép đo mới nhất"} {formatProbeTime(sample.ts)}{entry?.stale ? <b className="staleFlag">dữ liệu cũ</b> : null}</p> : null}
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        <div className="connectivityPanel panel card border-0">
          <div className="card-body">
            <div className="sectionHeader">
              <div><h2 className="mb-0">Lịch sử kiểm tra</h2><p className="sectionMeta mb-0">{historyLoading ? "Đang tải…" : `${history.length} bản ghi trên trang ${page + 1} · ${incidentCount} sự cố${historyError ? ` · lỗi: ${historyError}` : ""}`}</p></div>
              <div className="connectivityPager" role="group" aria-label="Trang lịch sử">
                <button className="filterChip" disabled={page === 0 || historyLoading} onClick={() => setPage((value) => Math.max(0, value - 1))} type="button">Mới hơn</button>
                <span className="connectivityPageLabel">Trang {page + 1}</span>
                <button className="filterChip" disabled={!hasNext || historyLoading} onClick={() => setPage((value) => value + 1)} type="button">Cũ hơn</button>
              </div>
            </div>
            <div className="connectivityControls">
              <div className="filterRow" role="group" aria-label="Lọc đường truyền">
                {[["", "Tất cả đường truyền"], ["LAN", "LAN"], ["USB", "USB"]].map(([value, label]) => (
                  <button aria-pressed={link === value} className={`filterChip ${link === value ? "active" : ""}`} key={value || "all"} onClick={() => setLink(value)} type="button">{label}</button>
                ))}
              </div>
              <div className="filterRow" role="group" aria-label="Lọc loại bản ghi">
                {[["", "Tất cả loại"], ["measurement", "Phép đo"], ["incident", "Sự cố"], ["gap", "Gián đoạn"], ["diagnostic", "Nhật ký hệ thống"]].map(([value, label]) => (
                  <button aria-pressed={kind === value} className={`filterChip ${kind === value ? "active" : ""}`} key={value || "all"} onClick={() => setKind(value)} type="button">{label}</button>
                ))}
              </div>
              <label className="connectivitySelect"><span>Khoảng thời gian</span>
                <select aria-label="Khoảng lịch sử" onChange={(event) => setWindowHours(Number(event.target.value))} value={windowHours}>
                  {CONNECTIVITY_WINDOWS.map((option) => <option key={option.hours} value={option.hours}>{option.label}</option>)}
                </select>
              </label>
              <label className="connectivitySelect"><span>Mức độ tối thiểu</span>
                <select aria-label="Mức độ tối thiểu" onChange={(event) => setMinimumSeverity(Number(event.target.value))} value={minimumSeverity}>
                  {CONNECTIVITY_SEVERITY_LABELS.map((label, index) => <option key={label} value={index}>{index === 0 ? "Tất cả" : label}</option>)}
                </select>
              </label>
            </div>
            {history.length ? (
              <div className="connectivityTableWrap">
                <article aria-hidden="true" className="connectivityRow connectivityRowHead">
                  <span>Thời gian</span><span>Loại</span><span>Đường truyền</span><span>Mức độ</span><span>Chi tiết</span>
                </article>
                <div className="connectivityRows" role="list">
                  {history.map((record) => {
                    const severity = sampleSeverityLevel(record);
                    const type = record.kind === "measurement" ? "Phép đo" : record.kind === "incident" ? "Sự cố" : record.kind === "diagnostic" ? "Nhật ký" : "Gián đoạn";
                    let detail = record.kind === "measurement"
                      ? `${record.interface || "—"} · ${record.state === "offline" ? "mất kết nối · " : ""}RTT ${record.rtt_ms != null ? `${record.rtt_ms.toFixed(1)} ms` : "—"} · mất gói ${record.loss_percent != null ? `${record.loss_percent}%` : "—"} · ${targetsSummary(record)}`
                      : record.kind === "incident" ? incidentDetail(record) : record.kind === "diagnostic" ? `${record.source}: ${record.message}`
                        : record.reason === "agent started; prior incident continuity unknown" ? "Bộ theo dõi khởi động; chưa rõ tính liên tục của sự cố trước đó"
                          : record.reason === "clock jump or monitoring gap" ? "Đồng hồ thay đổi hoặc giám sát gián đoạn" : (record.reason || "Giám sát gián đoạn");
                    if (record.kind === "incident" && record.opened && record.opened.incident_id && openIncidents.has(record.opened.incident_id)) {
                      const gaps = gapTimesByLink[record.link] || [];
                      detail += gaps.some((ts) => ts > record.ts) ? " · giám sát gián đoạn, chưa xác định phục hồi" : " · chưa ghi nhận phục hồi trong khoảng thời gian này";
                    }
                    return (
                      <article className={`connectivityRow ${record.kind}`} key={record.id || `${record.machine}-${record.link}-${record.ts}`} role="listitem">
                        <time dateTime={new Date(record.ts * 1000).toISOString()}>{formatProbeTime(record.ts)}</time>
                        <span className="connectivityType">{type}</span>
                        <span className="mono">{record.link || "—"}</span>
                        <span className={`severityChip sev-${severity}`}>{sampleSeverityLabel(record)}</span>
                        <span className="connectivityDetail" title={detail}>{detail}</span>
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : <div className="emptyState">{historyLoading ? "Đang tải lịch sử kiểm tra…" : historyError ? "Không thể tải lịch sử kiểm tra." : "Không có bản ghi phù hợp bộ lọc."}</div>}
          </div>
        </div>
      </section>
    </div>
  );
}

const TV_REFRESH_NOTE = "Giám sát vận hành · cập nhật mỗi 10 giây";
// Sites whose Camera summary shows offline cause counts instead of connection counts.
const CAUSE_SITE_IDS = new Set(["mxa", "giaminh", "ships"]);

function tvTime(at, options) {
  const date = new Date(at);
  return at != null && Number.isFinite(date.getTime()) ? date.toLocaleTimeString("vi-VN", options) : "—";
}

function TvDeviceSummary({ label, summary, unknownLabel, footer, causes, allOnline }) {
  let offset = 0;
  // A group with nothing to report should read as one plain statement rather
  // than a legend of zeroes. Empty groups are not "all online".
  const healthy = allOnline && summary.total > 0 && summary.online === summary.total && !summary.offline && !summary.unknown;
  const name = (status) => status === "unknown" ? unknownLabel : statusLabel(status);
  // When outage causes are known, the ring splits the non-online arc the same
  // way the legend does, instead of painting it all as one red block. Devices
  // the cause rules did not attribute stay "Chưa rõ", so the ring still adds up
  // to the total printed inside it.
  const resolvedCauses = causes ? causes.map((cause) => ({ ...cause })) : null;
  if (resolvedCauses) {
    const attributed = resolvedCauses.reduce((sum, cause) => sum + cause.count, 0);
    const remainder = summary.total - summary.online - attributed;
    if (remainder > 0) {
      const unknown = resolvedCauses.find((cause) => cause.key === "unknown");
      if (unknown) unknown.count += remainder;
      else resolvedCauses.push({ key: "unknown", label: "Chưa rõ", count: remainder });
    }
  }
  const ring = resolvedCauses
    ? [{ status: "online", count: summary.online }, ...resolvedCauses.map((cause) => ({ status: cause.key, count: cause.count }))]
    : (unknownLabel ? ["online", "offline", "unknown"] : ["online", "offline"]).map((status) => ({ status, count: summary[status] }));
  const segments = ring.filter((segment) => segment.count > 0).map((segment) => {
    const length = summary.total ? segment.count / summary.total * 100 : 0;
    const item = { status: segment.status, count: segment.count, length, offset };
    offset += length;
    return item;
  });
  return (
    <div className="tvDeviceSummary">
      <svg className="tvDonut" viewBox="0 0 80 80" role="img" aria-label={`${label}: tổng ${summary.total}, ${summary.online} kết nối, ${summary.offline} mất kết nối${unknownLabel ? `, ${summary.unknown} ${unknownLabel.replace("Mất", "mất")}` : ""}`}>
        <circle className="tvDonutTrack" cx="40" cy="40" r="33" fill="none" strokeWidth="8" />
        {segments.filter((segment) => segment.length > 0).map((segment) => <circle key={segment.status} className={`tvDonutSegment ${segment.status}`} cx="40" cy="40" r="33" fill="none" strokeWidth="8" pathLength="100" strokeDasharray={`${segment.length} ${100 - segment.length}`} strokeDashoffset={-segment.offset} transform="rotate(-90 40 40)" />)}
        <text className="tvDonutTotal" x="40" y="38" textAnchor="middle">{summary.total}</text>
        <text className="tvDonutLabel" x="40" y="53" textAnchor="middle">{label}</text>
      </svg>
      <div className="tvDonutInfo">
        {healthy ? (
          <p className="tvAllOnline">ALL ONLINE</p>
        ) : resolvedCauses ? (
          <dl className="tvCauseLegend">
            {/* Only causes that actually occurred; a zero is noise beside the ring. */}
            {resolvedCauses.filter((cause) => cause.count > 0).map((cause) => (
              <div key={cause.key}><dt><i aria-hidden="true" className={cause.key} />{cause.label}</dt><dd>{cause.count}</dd></div>
            ))}
          </dl>
        ) : (
          <dl className="tvDonutLegend">
          {["offline", "online", "unknown"].filter((status) => status !== "unknown" || unknownLabel).map((status) => <div key={status} title={status === "unknown" ? "Camera không kiểm tra được vì AIBOX giám sát đang mất kết nối" : undefined}><dt><i aria-hidden="true" className={status} />{name(status)}</dt><dd>{summary[status]}</dd></div>)}
          </dl>
        )}
        {healthy || causes || !footer ? null : footer}
      </div>
    </div>
  );
}

function TvTrendChart({ id, label, lines, points, emptyNote }) {
  const totals = lines.map((line) => ({
    ...line,
    total: (() => {
      for (let index = points.length - 1; index >= 0; index -= 1) {
        if (typeof points[index][line.key] === "number") return points[index][line.key];
      }
      return 0;
    })(),
  }));
  const peak = Math.max(0, ...points.flatMap((point) => lines.map((line) => point[line.key] || 0)));
  const maximum = Math.max(2, Math.ceil(peak / 2) * 2);
  const frameRef = useRef(null);
  const [size, setSize] = useState({ width: 480, height: 140 });
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(240, Math.round(entry.contentRect.width));
      const height = Math.max(120, Math.round(entry.contentRect.height));
      setSize((current) => current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [points.length > 0]);
  const left = 36;
  const right = size.width - 20;
  const bottom = size.height - 24;
  const x = (index) => left + (index + 0.5) / Math.max(1, points.length) * (right - left);
  const y = (value) => bottom - value / maximum * (bottom - 16);
  const pointWidth = (right - left) / Math.max(1, points.length);
  const tickStep = [1, 2, 3, 4, 6, 12].find((step) => step * pointWidth >= 48) || 24;
  const ticks = points.flatMap((point, index) => new Date(point.to).getHours() % tickStep === 0 ? [index] : []);
  // Reason history starts when the recorder was deployed; buckets before the
  // first snapshot must not read as "zero offline cameras", so each run of
  // consecutive sampled buckets becomes its own polyline (or a dot if alone).
  const segmentsFor = (key) => {
    const segments = [];
    let current = null;
    points.forEach((point, index) => {
      if (typeof point[key] !== "number") { current = null; return; }
      if (!current) { current = { key: `${key}-${index}`, points: [] }; segments.push(current); }
      current.points.push({ index, value: point[key] });
    });
    return segments;
  };
  const titleId = `tv-trend-${id}-title`;
  const descId = `tv-trend-${id}-description`;
  const hasHistory = points.some((point) => lines.some((line) => point[line.key]));
  return (
    <figure aria-labelledby={titleId} className="tvTrendChartBlock">
      <figcaption className="tvChartLegend">
        <h3 id={titleId}>{label}</h3>
        {totals.map((line) => <span className={line.className} key={line.key}><i aria-hidden="true" />{line.label} <strong className="tvSeriesValue">{line.total}</strong></span>)}
      </figcaption>
      <div className="tvTrendFrame" ref={frameRef}><svg className="tvTrendChart" viewBox={`0 0 ${size.width} ${size.height}`} width={size.width} height={size.height} role="img" aria-labelledby={`${titleId} ${descId}`}>
        <desc id={descId}>{`Số ${label.toLowerCase()} mất kết nối vào cuối mỗi giờ trong 24 giờ qua. Chi tiết có trong bảng dữ liệu bên dưới.`}</desc>
        {[0, maximum / 2, maximum].map((value) => <g key={value}><line className="tvChartGrid" x1={left} x2={right} y1={y(value)} y2={y(value)} /><text className="tvChartAxis" x="27" y={y(value) + 4} textAnchor="end">{value}</text></g>)}
        {ticks.map((index) => <text className="tvChartAxis" key={index} x={x(index)} y={size.height - 4} textAnchor="middle">{tvTime(points[index].to, { hour: "2-digit", minute: "2-digit", hour12: false })}</text>)}
        {lines.map((line) => <g className={line.className} key={line.key}>
          {segmentsFor(line.key).map((segment) => segment.points.length === 1
            ? <circle className="tvChartLine" key={segment.key} cx={x(segment.points[0].index)} cy={y(segment.points[0].value)} r="2.5" fill="currentColor" />
            : <polyline className="tvChartLine" key={segment.key} points={segment.points.map(({ index, value }) => `${x(index)},${y(value)}`).join(" ")} fill="none" strokeWidth="2.5" />)}
        </g>)}
      </svg></div>
      <table className="visually-hidden"><caption>{`Số ${label.toLowerCase()} mất kết nối vào cuối mỗi giờ`}</caption><thead><tr><th scope="col">Thời điểm</th>{lines.map((line) => <th key={line.key} scope="col">{line.label}</th>)}</tr></thead><tbody>{points.map((point) => <tr key={point.from}><th scope="row">{formatGeneratedAt(point.to)}</th>{lines.map((line) => <td key={line.key}>{point[line.key] || 0}</td>)}</tr>)}</tbody></table>
      {hasHistory || !emptyNote ? null : <p className="tvChartNote">{emptyNote}</p>}
    </figure>
  );
}

function TvOfflineReasons({ series }) {
  const points = Array.isArray(series) ? series : [];
  return (
    <section aria-labelledby="tv-trend-title" className="tvPanel tvTrendPanel">
      <header className="tvPanelHeader"><h2 id="tv-trend-title">Mất kết nối theo giờ</h2><span>24 giờ qua</span></header>
      {points.length ? (
        <div className="tvTrendCharts">
          <TvTrendChart
            emptyNote="Chưa có lịch sử nguyên nhân AIBOX trong 24 giờ qua."
            id="aibox"
            label="AIBOX"
            lines={[
              { key: "aiboxPower", label: "Mất nguồn", className: "tvSeriesBad" },
              { key: "aiboxNetwork", label: "Mất mạng", className: "tvSeriesWarn" },
              { key: "aiboxUnknown", label: "Chưa rõ", className: "tvSeriesMuted" },
            ]}
            points={points}
          />
          <TvTrendChart
            emptyNote="Chưa có lịch sử nguyên nhân trong 24 giờ qua."
            id="camera"
            label="Camera"
            lines={[
              { key: "cameraPower", label: "Mất nguồn", className: "tvSeriesBad" },
              { key: "cameraNetwork", label: "Mất mạng", className: "tvSeriesWarn" },
              { key: "cameraUnknown", label: "Chưa rõ", className: "tvSeriesMuted" },
            ]}
            points={points}
          />
        </div>
      ) : <p className="tvEmpty">Đang chờ lịch sử trạng thái.</p>}
    </section>
  );
}

function useTvAutoScroll(ref, active) {
  useEffect(() => {
    const element = ref.current;
    if (!element || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
    let frame = 0;
    let last = 0;
    let position = element.scrollTop;
    let holdUntil = performance.now() + 3000;
    const paused = () => element.matches(":hover, :focus-within");
    const step = (now) => {
      const delta = last ? Math.min(now - last, 100) : 0;
      last = now;
      const end = element.scrollHeight - element.clientHeight;
      if (Math.abs(element.scrollTop - position) > 2) position = element.scrollTop;
      if (end <= 1 || paused()) {
        position = element.scrollTop;
      } else if (now >= holdUntil) {
        if (position >= end) {
          position = 0;
          element.scrollTop = 0;
          holdUntil = now + 3000;
        } else {
          position = Math.min(end, position + delta * 0.025);
          element.scrollTop = position;
          if (position >= end) holdUntil = now + 3000;
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [ref, active]);
}

function TvNotableList({ columnLabel, countLabel, emptyLabel, items, now, title }) {
  return (
    <div className="tvNotableList">
      <h3>{title} <span className="tvSeriesBad">{items.length}</span></h3>
      {items.length ? (
        <div aria-label={title} className="tvEventScroll" role="region" tabIndex={0}>
          <table className={`tvEventTable${countLabel ? " tvEventTableCount" : ""}`}>
            <caption className="visually-hidden">Thời điểm mất kết nối, vị trí, {columnLabel.toLowerCase()} và thời gian mất kết nối</caption>
            <thead><tr><th scope="col">Từ</th><th scope="col">Vị trí</th><th scope="col">{columnLabel}</th>{countLabel ? <th scope="col">{countLabel}</th> : null}<th scope="col">Thời gian</th></tr></thead>
            <tbody>
              {items.map((item) => {
                const since = Date.parse(item.since) ? item.since : "";
                const label = item.detail ? `${item.name} · ${item.detail}` : item.name;
                return (
                  <tr key={item.key}>
                    <td className="tvEventTime">{since ? <time dateTime={since}>{tvTime(since, { hour: "2-digit", minute: "2-digit", hour12: false })} {new Date(since).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })}</time> : "—"}</td>
                    <td className="tvEventScope">{item.site || "—"}</td>
                    <td className="tvEventDevice" title={label}><strong>{item.name}</strong>{item.detail ? <span> · {item.detail}</span> : null}</td>
                    {countLabel ? <td className="tvEventCount"><span className="tvBad">{item.count}</span>/{item.total}</td> : null}
                    <td className="tvEventStatus"><span className="tvBad"><i aria-hidden="true" />{since ? formatDuration(since, now) : "Chưa rõ"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="tvEmpty">{emptyLabel}</p>}
    </div>
  );
}

function buildTvSimSummary(fleet, aiboxes) {
  const names = new Map((aiboxes || []).map((box) => [box.ip, compactDeviceName(box.name) || box.ip]));
  const sims = (fleet?.machines || []).flatMap((machine) => {
    const sample = machine.links?.USB?.sample;
    if (!sample) return [];
    return [{ key: machine.id || machine.ip, name: names.get(machine.ip) || machine.label || machine.machine || machine.ip, online: sample.state === "online", rtt: Number(sample.rtt_ms), loss: Number(sample.loss_percent), since: Number(machine.usbOfflineSince) }];
  });
  const online = sims.filter((sim) => sim.online);
  const rtts = online.map((sim) => sim.rtt).filter(Number.isFinite);
  return {
    total: sims.length, online: online.length, offline: sims.length - online.length,
    rtt: rtts.length ? Math.round(rtts.reduce((sum, value) => sum + value, 0) / rtts.length) : null,
    offlineSims: sims.filter((sim) => !sim.online).sort((a, b) => a.name.localeCompare(b.name, "vi")),
  };
}

function TvDashboard({ data, loadError, isUpdating, onRefresh, notes, noteLookup, noteError, onAddNote, onOpenNote }) {
  const notesScrollRef = useRef(null);
  const simScrollRef = useRef(null);
  const [fleet, setFleet] = useState(null);
  useTvAutoScroll(notesScrollRef, notes.length > 0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/connectivity/fleet?t=${Date.now()}`, { cache: "no-store" });
        const result = response.ok ? await response.json() : null;
        if (!cancelled) setFleet(result?.available === false ? null : result);
      } catch (_) {
        if (!cancelled) setFleet(null);
      }
    };
    load();
    const timer = window.setInterval(load, 30000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const [tvNow, setTvNow] = useState(() => Date.now());
  const [tvFullscreen, setTvFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setTvNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onChange = () => setTvFullscreen(Boolean(document.fullscreenElement || document.webkitFullscreenElement));
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  const toggleFullscreen = async () => {
    setFullscreenError("");
    try {
      const root = document.documentElement;
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        await (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      }
    } catch (_) {
      setFullscreenError("Không thể bật toàn màn hình. Hãy dùng chế độ toàn màn hình của trình duyệt.");
    }
  };

  const siteGroups = useMemo(() => buildTvGroups(data), [data.aiboxes, data.networks]);
  // A site row with no devices carries no information; drop it so the
  // remaining rows can use the freed vertical space.
  const visibleSiteGroups = useMemo(
    () => siteGroups.filter((group) => group.machines.total > 0 || group.cameras.total > 0),
    [siteGroups],
  );
  const siteLabels = useMemo(() => buildTvSiteLabels(data), [data.aiboxes, data.networks]);
  // Per-site offline cause counts (Mất nguồn / Mất mạng / Chưa rõ) for the
  // Camera summaries. Reuses the same classification as the trend chart.
  const causeCounts = useMemo(() => {
    const bySite = new Map();
    buildTvOfflineReasons(data).forEach((reason) => {
      reason.sites.forEach((site) => {
        const entry = bySite.get(site.label) || {};
        entry[reason.id] = site.count;
        bySite.set(site.label, entry);
      });
    });
    return bySite;
  }, [data]);
  // AIBOX causes come from boot evidence: a box that rebooted while it was
  // unreachable lost power; one that kept the same boot session only lost its
  // link. Boxes still down have no evidence yet and stay "unknown".
  const aiboxCauseCounts = useMemo(() => buildAiboxOfflineReasons(data), [data]);
  const offlineNetworks = useMemo(() => buildTvOfflineNetworks(data), [data.networks]);
  const totals = siteGroups.reduce((sum, group) => ({
    aiboxOnline: sum.aiboxOnline + group.machines.online, aiboxOffline: sum.aiboxOffline + group.machines.offline,
    cameraOnline: sum.cameraOnline + group.cameras.online, cameraOffline: sum.cameraOffline + group.cameras.offline,
  }), { aiboxOnline: 0, aiboxOffline: 0, cameraOnline: 0, cameraOffline: 0 });
  const deviceTotals = { aibox: (data.aiboxes || []).length, camera: (data.networks || []).reduce((sum, network) => sum + (network.cameras || []).length, 0) };
  const sim = useMemo(() => buildTvSimSummary(fleet, data.aiboxes), [fleet, data.aiboxes]);
  useTvAutoScroll(simScrollRef, sim.offlineSims.length > 0);
  const offlineAiboxes = (Array.isArray(data.aiboxes) ? data.aiboxes : [])
    .filter((box) => box.status === "offline")
    .sort((a, b) => (Date.parse(a.statusSince) || Infinity) - (Date.parse(b.statusSince) || Infinity));
  const generatedLabel = tvTime(data.generatedAt, { hour: "2-digit", minute: "2-digit", hour12: false });
  const dateLabel = new Date(tvNow).toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  const clockLabel = tvTime(tvNow, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const stale = tvNow - new Date(data.generatedAt).getTime() > PROJECTION_STALE_MS
    || tvNow - new Date(data.sourceUpdatedAt || data.generatedAt).getTime() > SOURCE_STALE_MS;
  const connectionState = loadError ? "offline" : stale ? "stale" : "live";
  const statusDetail = loadError ? "Mất kết nối tới máy chủ giám sát — đang thử kết nối lại…" : fullscreenError || (stale ? "Đang hiển thị trạng thái gần nhất." : "");

  return (
    <div className="tvView" lang="vi">
      <header className="tvBanner">
        <div className="tvBrand">
          <h1>Giám sát AIBOX</h1>
          <p>{TV_REFRESH_NOTE}</p>
        </div>
        <section aria-labelledby="tv-changes-title" className="tvOfflineSummary">
          <h2 id="tv-changes-title">Thiết bị offline</h2>
          <dl className="tvChangeList">
            <div><dt>AIBOX</dt><dd><span className="tvSeriesBad">{totals.aiboxOffline}</span><span className="tvChangeTotal">/{deviceTotals.aibox}</span></dd></div>
            <div><dt>Camera</dt><dd><span className="tvSeriesBad">{totals.cameraOffline}</span><span className="tvChangeTotal">/{deviceTotals.camera}</span></dd></div>
          </dl>
        </section>
        <div className="tvConnection">
          <span className="tvLiveStatus" data-state={connectionState} role="status" title={statusDetail || undefined}><i aria-hidden="true" />{loadError ? "Mất kết nối" : stale ? "Dữ liệu chưa cập nhật" : "Đang nhận dữ liệu"}{statusDetail ? <span className="visually-hidden">. {statusDetail}</span> : null}</span>
          <span className="tvUpdated">Cập nhật lúc {generatedLabel}</span>
        </div>
        <div className="tvClockBlock">
          <time className="tvClock" dateTime={new Date(tvNow).toISOString()}>{clockLabel}</time>
          <span className="tvDate">{dateLabel}</span>
        </div>
        <div className="tvActions">
          <button aria-label="Làm mới dữ liệu" disabled={isUpdating} onClick={onRefresh} title="Làm mới dữ liệu" type="button"><ArrowClockwise aria-hidden="true" size={20} /><span>Làm mới</span></button>
          <button aria-label={tvFullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"} aria-pressed={tvFullscreen} className="tvFullscreenButton" onClick={toggleFullscreen} title={tvFullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"} type="button">{tvFullscreen ? <ArrowsIn aria-hidden="true" size={20} /> : <ArrowsOut aria-hidden="true" size={20} />}<span>{tvFullscreen ? "Thu nhỏ" : "Toàn màn hình"}</span></button>
        </div>
      </header>

      <div className="tvOverviewGrid">
      <section aria-label="Trạng thái theo khu vực" className="tvSiteRows">
        {visibleSiteGroups.map((group) => {
          const outage = group.longestOutage;
          const offlineCount = group.machines.offline + group.cameras.offline;
          const device = outage ? outage.kind === "camera" ? cameraTileLabel(outage) : { label: compactDeviceName(outage.name) || outage.ip, isIp: !outage.name || outage.name === outage.ip } : null;
          return (
            <article aria-labelledby={`tv-site-${group.id}`} className={`tvPanel tvSiteRow${group.id === "other" ? " tvSiteRow--other" : ""}${CAUSE_SITE_IDS.has(group.id) ? " tvSiteRow--causes" : ""}`} key={group.id}>
              <div className="tvSiteName"><h2 id={`tv-site-${group.id}`}>{group.label}</h2></div>
              {CAUSE_SITE_IDS.has(group.id) ? (
                <TvDeviceSummary
                  causes={[
                    { key: "power", label: "Mất nguồn", count: aiboxCauseCounts.get(group.label)?.power || 0 },
                    { key: "network", label: "Mất mạng", count: aiboxCauseCounts.get(group.label)?.network || 0 },
                    { key: "unknown", label: "Chưa rõ", count: aiboxCauseCounts.get(group.label)?.unknown || 0 },
                  ]}
                  allOnline
                  label="AIBOX"
                  summary={group.machines}
                />
              ) : <TvDeviceSummary label="AIBOX" summary={group.machines} />}
              {CAUSE_SITE_IDS.has(group.id) ? (
                <TvDeviceSummary
                  causes={[
                    { key: "power", label: "Mất nguồn", count: causeCounts.get(group.label)?.power || 0 },
                    { key: "network", label: "Mất mạng", count: causeCounts.get(group.label)?.network || 0 },
                    { key: "unknown", label: "Chưa rõ", count: causeCounts.get(group.label)?.unknown || 0 },
                  ]}
                  allOnline
                  label="Camera"
                  summary={group.cameras}
                  unknownLabel="Mất AIBOX"
                />
              ) : <TvDeviceSummary label="Camera" summary={group.cameras} unknownLabel="Mất AIBOX" />}
              <div className="tvSiteOutage">
                <span>Mất kết nối lâu nhất{group.undatedOffline ? " đã rõ" : ""}: </span>
                <strong className={offlineCount ? "tvBad" : "tvMuted"}>{outage ? formatDuration(outage.statusSince, tvNow) : offlineCount ? "Chưa rõ thời điểm" : "Không có"}</strong>
                {outage ? <span className="tvOutageDevice"> · {outage.kind === "camera" ? "Camera" : "AIBOX"} {device.label}{[outage.scope, device.isIp ? "" : outage.ip].filter(Boolean).map((part) => <span key={part}> · {part}</span>)}</span> : null}
                {group.undatedOffline ? <span className="tvWarn"> · {group.undatedOffline} thiết bị chưa rõ thời điểm bắt đầu</span> : null}
              </div>
            </article>
          );
        })}
      </section>

      <div className="tvAnalysisPanels">
        <TvOfflineReasons series={data.statusSeries} />
        <section aria-labelledby="tv-sim-title" className="tvPanel tvSiteRow tvSimRow">
          <div className="tvSiteName"><h2 id="tv-sim-title">SIM 4G</h2></div>
          {fleet ? <>
            <TvDeviceSummary label="SIM" summary={sim} footer={<p className="tvSiteAverage">Độ trễ TB <strong>{sim.rtt == null ? "—" : `${sim.rtt} ms`}</strong></p>} />
            <div className="tvSimOffline">
              <h3>SIM mất kết nối <span className="tvSeriesBad">{sim.offlineSims.length}</span></h3>
              {sim.offlineSims.length ? (
                <ul aria-label="SIM mất kết nối" className="tvSimList" ref={simScrollRef} tabIndex={0}>
                  {sim.offlineSims.map((item) => (
                    <li key={item.key}>
                      <strong>{item.name}</strong>
                      {Number.isFinite(item.loss) ? <span> · mất gói {Math.round(item.loss)}%</span> : null}
                      <span className="tvBad"> · {Number.isFinite(item.since) && item.since > 0 ? formatDuration(item.since * 1000, tvNow) : "Chưa rõ"}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="tvEmpty">Không có SIM mất kết nối</p>}
            </div>
          </> : <p className="tvSimUnavailable">Chưa có dữ liệu SIM</p>}
        </section>
      </div>
      </div>

      <div className="tvDetailsGrid">
        <section aria-labelledby="tv-events-title" className="tvPanel tvEventsPanel">
          <header className="tvPanelHeader"><h2 id="tv-events-title">Đáng chú ý</h2><span>Lâu nhất trước</span></header>
          <div className="tvNotableGrid">
            <TvNotableList
              columnLabel="AIBOX"
              emptyLabel="Không có AIBOX mất kết nối"
              items={offlineAiboxes.map((box) => {
                const named = box.name && box.name !== box.ip;
                return { key: box.ip, since: box.statusSince, site: siteLabels.get(box.ip), name: named ? box.name : box.ip, detail: named ? box.ip : "" };
              })}
              now={tvNow}
              title="AIBOX mất kết nối"
            />
            <TvNotableList
              columnLabel="Mạng"
              countLabel="Camera"
              emptyLabel="Không có camera mất kết nối"
              items={offlineNetworks.map((network) => ({ key: network.id, since: network.statusSince, site: network.site, name: network.name, count: network.offline, total: network.total }))}
              now={tvNow}
              title="Camera mất kết nối"
            />
          </div>
        </section>

        <section aria-labelledby="tv-notes-title" className="tvPanel tvNotesPanel">
          <header className="tvPanelHeader"><h2 id="tv-notes-title">Ghi chú <span className="tvNoteCount">{notes.length}</span></h2><button aria-controls="note-drawer" aria-label="Thêm ghi chú" className="tvAddNote" onClick={onAddNote} title="Thêm ghi chú" type="button"><NotePencil aria-hidden="true" size={18} /></button></header>
          {noteError ? <p className="tvNotesError tvBad" role="alert">Ghi chú: {noteError}</p> : null}
          {notes.length ? (
            <div aria-label="Ghi chú mới nhất trước" className="tvNotesScroll" ref={notesScrollRef} role="region" tabIndex={0}>
              {notes.map((note) => (
                <button className="tvNoteItem" key={`${note.key}-${note.id}`} onClick={() => onOpenNote(note.key)} type="button">
                  <span className="tvNoteTarget">{noteTargetLabel(note.key, noteLookup)}</span>
                  <span className="tvNoteContent">{note.content}</span>
                  <span className="tvNoteMeta">{note.creator} · {new Date(note.createdAt).toLocaleString("vi-VN")}</span>
                </button>
              ))}
            </div>
          ) : <p className="tvEmpty">Chưa có ghi chú. Thêm ghi chú để bàn giao ca trực.</p>}
        </section>
      </div>

    </div>
  );
}

function App() {
  const [data, setData] = useState(EMPTY_DATA);
  const [loadError, setLoadError] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [notes, setNotes] = useState({});
  const [layout, setLayout] = useState({ aiboxOrder: [], cameraOrder: {}, networkOrder: [] });
  const [layoutError, setLayoutError] = useState("");
  const [draggedAiboxIp, setDraggedAiboxIp] = useState("");
  const [draggedNetworkId, setDraggedNetworkId] = useState("");
  const [dragNetworkInsert, setDragNetworkInsert] = useState({ id: "", position: "before" });
  const [networkReorderMode, setNetworkReorderMode] = useState(false);
  const [dragInsert, setDragInsert] = useState({ ip: "", position: "before" });
  const [draggedCamera, setDraggedCamera] = useState({ networkId: "", ip: "" });
  const [cameraInsert, setCameraInsert] = useState({ networkId: "", ip: "", position: "before" });
  const [noteForms, setNoteForms] = useState({});
  const [noteLoadError, setNoteLoadError] = useState("");
  const [noteWriteError, setNoteWriteError] = useState("");
  const noteError = noteWriteError || noteLoadError;
  const [activeNote, setActiveNote] = useState(null);
  const [savingKey, setSavingKey] = useState("");
  const [deletingNoteId, setDeletingNoteId] = useState("");
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useState(initialTheme);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [activeView, setActiveViewState] = useState(viewFromPath);
  const setActiveView = useCallback((view) => {
    const currentPath = window.location.pathname;
    const pathname = VIEW_PATHS[view] || "/tv";
    const url = `${pathname}${window.location.search}${window.location.hash}`;
    const state = { ...window.history.state, aiboxView: view };
    if (pathname !== currentPath) window.history.pushState(state, "", url);
    else window.history.replaceState(state, "", url);
    setActiveViewState(view);
  }, []);
  useEffect(() => {
    if (window.location.pathname === "/") window.history.replaceState(window.history.state, "", `/tv${window.location.search}${window.location.hash}`);
    const onPopState = () => setActiveViewState(viewFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const [dashboardFocuses, setDashboardFocuses] = useState([]);
  const [panelSizes, setPanelSizes] = useState(initialPanelSizes);
  const [aiboxMinHeight, setAiboxMinHeight] = useState(0);
  const [resizingPanel, setResizingPanel] = useState("");
  const [showTopButton, setShowTopButton] = useState(false);
  const [manageMode, setManageMode] = useState(false);
  const [activeConfig, setActiveConfig] = useState(null);
  const [configData, setConfigData] = useState(null);
  const [configError, setConfigError] = useState("");
  const [configMessage, setConfigMessage] = useState("");
  const [configSaving, setConfigSaving] = useState(false);
  const [adminToken, setAdminToken] = useState(window.sessionStorage.getItem("aiboxAdminToken") || "");
  const [aiboxForm, setAiboxForm] = useState(EMPTY_AIBOX_FORM);
  const [cameraForm, setCameraForm] = useState(EMPTY_CAMERA_FORM);
  const [configConfirm, setConfigConfirm] = useState(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [autoplayPaused, setAutoplayPaused] = useState(false);
  const [aiboxPage, setAiboxPage] = useState(0);
  const [aiboxPageMeta, setAiboxPageMeta] = useState({ capacity: 1, count: 1, page: 0 });
  const [networkPage, setNetworkPage] = useState(0);
  const [networkPageMeta, setNetworkPageMeta] = useState({ capacity: 1, count: 1, page: 0 });
  const [networkRotationDuration] = useState(6e3);
  const networkPanelRef = useRef(null);
  const [aiboxRotationDuration, setAiboxRotationDuration] = useState(4_000);
  const [fleetSection, setFleetSection] = useState("aiboxes");
  const [fleetNetworkId, setFleetNetworkId] = useState("");
  const aiboxDirectionRef = useRef(1);
  const resizeResumeTimerRef = useRef(0);
  const dialogRef = useRef(null);
  const dialogOpenerRef = useRef(null);
  const dataRequestRef = useRef(null);
  const dashboardWorkspaceRef = useRef(null);
  const aiboxPanelRef = useRef(null);
  const networkOverviewRef = useRef(null);
  const documentVisible = useDocumentVisible();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const mobileDashboard = useMediaQuery("(max-width: 760px)");
  const tabletDashboard = useMediaQuery("(max-width: 1100px)");
  const desktopFleet = useMediaQuery("(min-width: 901px) and (min-height: 621px)");
  const ultraWideFleet = useMediaQuery("(min-width: 1600px)");
  const wideFleet = useMediaQuery("(min-width: 1400px)");
  const mediumFleet = useMediaQuery("(min-width: 1200px)");

  const aiboxes = data.aiboxes ?? [];
  const cameraNetworks = data.networks ?? [];
  // Cameras discovered on boxes that were offline during the archive rollout.
  // Only the timelapse view consumes them, so they stay out of TV/overview.
  const [archiveInventory, setArchiveInventory] = useState(null);
  useEffect(() => {
    let stopped = false;
    fetch(`/camera-archive-inventory.json?t=${Date.now()}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => { if (!stopped && payload) setArchiveInventory(payload); })
      .catch(() => {});
    return () => { stopped = true; };
  }, []);
  const timelapseNetworks = useMemo(
    () => mergeArchiveInventory(cameraNetworks, archiveInventory),
    [cameraNetworks, archiveInventory],
  );
  const loaded = isDataLoaded(data);
  const online = aiboxes.filter((box) => box.status === "online").length;
  const offline = aiboxes.filter((box) => box.status === "offline").length;
  const unknown = aiboxes.length - online - offline;
  const networks = new Set(aiboxes.flatMap((box) => box.networks)).size;
  const cameraCount = cameraNetworks.reduce((total, network) => total + network.cameras.length, 0);
  const siteOrderedNetworks = useMemo(() => applySavedOrder(cameraNetworks, layout.networkOrder, (network) => network.id), [cameraNetworks, layout.networkOrder]);
  const filteredNetworks = useMemo(() => siteOrderedNetworks
    .map((network) => {
      const needle = query.trim().toLowerCase();
      const cameras = network.cameras || [];
      if (!needle) return { ...network, cameras };
      const networkMatches = [network.name, network.id, ...(network.monitors || [])].join(" ").toLowerCase().includes(needle);
      return {
        ...network,
        cameras: networkMatches ? cameras : cameras.filter((camera) => [camera.name, camera.ip].join(" ").toLowerCase().includes(needle)),
      };
    })
    .filter((network) => network.cameras.length || [network.name, network.id].join(" ").toLowerCase().includes(query.trim().toLowerCase())), [siteOrderedNetworks, query]);
  const orderedFilteredNetworks = useMemo(() => filteredNetworks.map((network) => ({
    ...network,
    cameras: applySavedOrder(network.cameras || [], layout.cameraOrder?.[network.id] || [], (camera) => camera.ip),
  })), [filteredNetworks, layout.cameraOrder]);
  const orderedCameraNetworks = useMemo(() => siteOrderedNetworks.map((network) => ({
    ...network,
    cameras: applySavedOrder(network.cameras || [], layout.cameraOrder?.[network.id] || [], (camera) => camera.ip),
  })), [siteOrderedNetworks, layout.cameraOrder]);
  const selectedNetworkIds = useMemo(() => dashboardFocuses.filter((target) => target !== "fleet"), [dashboardFocuses]);
  const isFullDashboard = dashboardFocuses.length === 0;
  const showAiboxPanel = isFullDashboard || dashboardFocuses.includes("fleet");
  const showNetworkPanel = isFullDashboard || selectedNetworkIds.length > 0;
  const dashboardFocusMode = isFullDashboard ? "all" : showAiboxPanel && showNetworkPanel ? "combined" : showAiboxPanel ? "fleet" : "network";
  const dashboardNetworks = useMemo(() => {
    if (!selectedNetworkIds.length) return isFullDashboard ? orderedFilteredNetworks : [];
    const needle = query.trim().toLowerCase();
    return orderedCameraNetworks
      .filter((network) => selectedNetworkIds.includes(network.id))
      .map((network) => {
        if (!needle) return network;
        const networkMatches = [network.name, network.id, ...(network.monitors || [])].join(" ").toLowerCase().includes(needle);
        return {
          ...network,
          cameras: networkMatches ? network.cameras : network.cameras.filter((camera) => [camera.name, camera.ip].join(" ").toLowerCase().includes(needle)),
        };
      });
  }, [isFullDashboard, orderedCameraNetworks, orderedFilteredNetworks, query, selectedNetworkIds]);
  const visibleCameras = dashboardNetworks.flatMap((network) => network.cameras || []);
  const visibleCameraCount = visibleCameras.length;
  const visibleCameraOnline = visibleCameras.filter((camera) => camera.status === "online").length;
  const visibleCameraOffline = visibleCameras.filter((camera) => camera.status === "offline").length;
  const visibleCameraUnknown = visibleCameraCount - visibleCameraOnline - visibleCameraOffline;
  const dataAgeMs = loaded ? now - new Date(data.generatedAt).getTime() : 0;
  const sourceUpdatedAt = data.sourceUpdatedAt || data.generatedAt;
  const sourceAgeMs = loaded ? now - new Date(sourceUpdatedAt).getTime() : 0;
  const projectionStale = loaded && dataAgeMs > PROJECTION_STALE_MS;
  const sourceStale = loaded && sourceAgeMs > SOURCE_STALE_MS;
  const isStale = projectionStale || sourceStale;
  const dataCurrent = loaded && !loadError && !isStale;
  const updateState = loadError ? "disconnected" : (isUpdating || !loaded) ? "updating" : isStale ? "stale" : "live";
  const updateLabel = loadError ? "Mất kết nối" : (isUpdating || !loaded) ? "Đang cập nhật" : isStale ? "Dữ liệu cũ" : "Trực tiếp";
  const dashboardAlerts = [
    loadError ? { action: "Thử lại", tone: "danger", text: `Không lấy được trạng thái. Đang hiển thị dữ liệu gần nhất: ${loadError}` } : null,
    !loadError && projectionStale && !sourceStale ? { action: "Làm mới", tone: "warning", text: `Bảng giám sát chưa cập nhật. Dữ liệu tạo ${formatDataAge(data.generatedAt, now)}.` } : null,
    noteError ? { tone: "warning", text: `Lỗi ghi chú: ${noteError}` } : null,
    layoutError ? { tone: "warning", text: `Lỗi thứ tự thiết bị: ${layoutError}` } : null,
  ].filter(Boolean);

  const targetLookup = useMemo(() => {
    const lookup = { "tv:board": "Bảng TV" };
    aiboxes.forEach((box) => {
      lookup[noteKey("aibox", box.ip)] = `${box.name} · ${box.ip}`;
      lookup[box.ip] = `${box.name} · ${box.ip}`;
    });
    cameraNetworks.forEach((network) => {
      lookup[noteKey("network", network.id)] = `${network.name} · ${network.id}`;
    });
    return lookup;
  }, [aiboxes, cameraNetworks]);

  const fleetNotes = useMemo(() => Object.keys(notes)
    .flatMap((key) => asNoteList(notes[key]).map((note) => ({ ...note, key })))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)), [notes]);

  const filteredAiboxes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = aiboxes
      .filter((box) => statusFilter === "all" || box.status === statusFilter)
      .filter((box) => {
        if (!needle) return true;
        const haystack = [box.name, box.ip, ...box.networks, ...box.monitors].join(" ").toLowerCase();
        return haystack.includes(needle);
      });
    return filtered;
  }, [aiboxes, query, statusFilter]);
  const dashboardAiboxes = useMemo(() => applySavedOrder(filteredAiboxes, layout.aiboxOrder, (box) => box.ip), [filteredAiboxes, layout.aiboxOrder]);
  const fleetAiboxes = useMemo(() => applySavedOrder(filteredAiboxes, layout.aiboxOrder, (box) => box.ip), [filteredAiboxes, layout.aiboxOrder]);
  const fleetAiboxColumns = !desktopFleet
    ? 1
    : ultraWideFleet
      ? fleetAiboxes.length > 27 ? 10 : 9
    : wideFleet
      ? fleetAiboxes.length > 24 ? 8 : fleetAiboxes.length > 18 ? 7 : 6
      : mediumFleet
        ? fleetAiboxes.length > 24 ? 8 : fleetAiboxes.length > 18 ? 7 : 6
        : fleetAiboxes.length > 20 ? 6 : 5;
  const selectedFleetNetwork = orderedCameraNetworks.find((network) => network.id === fleetNetworkId) || orderedCameraNetworks[0] || null;
  const fleetNoteColumns = !desktopFleet
    ? 1
    : ultraWideFleet
      ? fleetNotes.length > 30 ? 7 : fleetNotes.length > 18 ? 6 : fleetNotes.length > 8 ? 5 : 4
      : wideFleet
        ? fleetNotes.length > 24 ? 6 : fleetNotes.length > 12 ? 5 : fleetNotes.length > 5 ? 4 : 3
        : mediumFleet
          ? fleetNotes.length > 18 ? 5 : fleetNotes.length > 8 ? 4 : 3
          : fleetNotes.length > 12 ? 4 : 3;
  const safeAiboxPage = clamp(aiboxPage, 0, Math.max(0, aiboxPageMeta.count - 1));
  const canDragAiboxes = manageMode && activeView === "fleet" && statusFilter === "all" && loaded;
  const canDragNetworks = manageMode && activeView === "fleet" && loaded;
  // A camera preview floating over the board counts as interaction, so the
  // overview carousel must not rotate the page out from under the pointer.
  const [previewOpen, setPreviewOpen] = useState(false);
  const handlePreviewOpenChange = useCallback((open) => {
    setPreviewOpen((current) => (current === open ? current : open));
  }, []);
  const playbackBlocked = activeView !== "dashboard"
    || previewOpen
    || !loaded
    || !documentVisible
    || reducedMotion
    || mobileDashboard
    || autoplayPaused
    || searchFocused
    || Boolean(activeNote)
    || Boolean(activeConfig)
    || Boolean(draggedAiboxIp)
    || Boolean(draggedNetworkId)
    || Boolean(draggedCamera.ip)
    || Boolean(resizingPanel);

  const updateAiboxPageMeta = useCallback((meta) => {
    setAiboxPageMeta((current) => current.capacity === meta.capacity && current.count === meta.count && current.page === meta.page ? current : meta);
  }, []);

  const updateNetworkPageMeta = useCallback((meta) => {
    setNetworkPageMeta((current) => current.capacity === meta.capacity && current.count === meta.count && current.page === meta.page ? current : meta);
  }, []);

  // Two independent observers (duration updates + page mutation) can both ask
  // for the next page within the same render cycle, which produced a visible
  // double-step. A short guard collapses those into one advance.
  const networkAdvanceGuardRef = useRef(0);
  const networkDirectionRef = useRef(1);
  const advanceNetworkPage = useCallback(() => {
    const now = Date.now();
    if (now - networkAdvanceGuardRef.current < 2500) return;
    networkAdvanceGuardRef.current = now;
    const lastPage = networkPageMeta.count - 1;
    setNetworkPage((page) => {
      // Direction is remembered, otherwise the deck bounces 1<->2 forever and
      // never returns to the first page.
      let direction = networkDirectionRef.current;
      if (page <= 0) direction = 1;
      else if (page >= lastPage) direction = -1;
      networkDirectionRef.current = direction;
      return clamp(page + direction, 0, lastPage);
    });
  }, [networkPageMeta.count]);

  const advanceAiboxPage = useCallback(() => {
    const lastPage = aiboxPageMeta.count - 1;
    setAiboxPage((page) => {
      const direction = page <= 0 ? 1 : page >= lastPage ? -1 : aiboxDirectionRef.current;
      aiboxDirectionRef.current = direction;
      return clamp(page + direction, 0, lastPage);
    });
  }, [aiboxPageMeta.count]);

  const advancePlayback = useCallback((direction = 1) => {
    aiboxDirectionRef.current = direction < 0 ? -1 : 1;
    setAiboxPage((page) => modulo(page + direction, Math.max(1, aiboxPageMeta.count)));
    setNetworkPage((page) => modulo(page + direction, Math.max(1, networkPageMeta.count)));
  }, [aiboxPageMeta.count, networkPageMeta.count]);

  useEffect(() => {
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("aiboxDashboardPanelSizes", JSON.stringify(panelSizes));
  }, [panelSizes]);

  useEffect(() => () => window.clearTimeout(resizeResumeTimerRef.current), []);

  useEffect(() => {
    const networkIds = new Set(cameraNetworks.map((network) => network.id));
    setDashboardFocuses((current) => {
      const next = current.filter((target) => target === "fleet" || networkIds.has(target));
      return next.length === current.length ? current : next;
    });
  }, [cameraNetworks]);

  useEffect(() => {
    const workspace = dashboardWorkspaceRef.current;
    const panel = aiboxPanelRef.current;
    if (activeView !== "dashboard" || !workspace || !panel || !showAiboxPanel) return undefined;
    const header = panel.querySelector(".aiboxMatrixHeader");
    const pill = panel.querySelector(".matrixTile");
    if (!header || !pill) return undefined;
    function measure() {
      const panelStyle = window.getComputedStyle(panel);
      const headerStyle = window.getComputedStyle(header);
      const height = Math.ceil(
        parseFloat(panelStyle.paddingTop)
        + parseFloat(panelStyle.paddingBottom)
        + parseFloat(panelStyle.borderTopWidth)
        + parseFloat(panelStyle.borderBottomWidth)
        + header.getBoundingClientRect().height
        + parseFloat(headerStyle.marginTop)
        + parseFloat(headerStyle.marginBottom)
        + pill.getBoundingClientRect().height
      );
      setAiboxMinHeight((current) => current === height ? current : height);
      const minimumRatio = clamp(height / Math.max(1, workspace.clientHeight), 0.05, 0.62);
      setPanelSizes((current) => current.aibox >= minimumRatio ? current : { ...current, aibox: minimumRatio });
    }
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    observer.observe(header);
    observer.observe(pill);
    measure();
    return () => observer.disconnect();
  }, [activeView, dashboardAiboxes.length, showAiboxPanel]);

  useEffect(() => {
    setAiboxPage(0);
    setNetworkPage(0);
  }, [dashboardFocuses, query, statusFilter]);

  useEffect(() => {
    setNetworkPage((page) => clamp(page, 0, Math.max(0, networkPageMeta.count - 1)));
  }, [networkPageMeta.count]);

  useEffect(() => {
    if (!orderedCameraNetworks.length) {
      setFleetNetworkId("");
      return;
    }
    if (!orderedCameraNetworks.some((network) => network.id === fleetNetworkId)) setFleetNetworkId(orderedCameraNetworks[0].id);
  }, [fleetNetworkId, orderedCameraNetworks]);

  useEffect(() => {
    setAiboxPage((page) => clamp(page, 0, Math.max(0, aiboxPageMeta.count - 1)));
  }, [aiboxPageMeta.count]);

  useScrollAwarePageAdvance({
    blocked: playbackBlocked,
    enabled: aiboxPageMeta.count > 1,
    onAdvance: advanceAiboxPage,
    onDuration: setAiboxRotationDuration,
    pageKey: aiboxPage,
    rootRef: aiboxPanelRef,
  });

  // The scroll-aware scheduler only re-arms when the tracked marquees change,
  // which stalls a simple page deck. A plain interval per page mirrors the
  // AIBOX cadence without that dependency.
  useEffect(() => {
    if (playbackBlocked || networkPageMeta.count <= 1) return undefined;
    const root = networkPanelRef.current;
    let timer = 0;
    let cancelled = false;
    // Hold the page while someone is reading it with the keyboard or mouse, but
    // keep re-arming: a skipped advance must not stop the carousel for good.
    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        if (cancelled) return;
        if (root && root.matches(":hover, :focus-within")) {
          timer = window.setTimeout(schedule, 1500);
          return;
        }
        advanceNetworkPage();
      }, Math.max(4000, networkRotationDuration));
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [advanceNetworkPage, networkPage, networkPageMeta.count, networkRotationDuration, playbackBlocked]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    function updateTopButton() {
      setShowTopButton(window.scrollY > 500);
    }
    updateTopButton();
    window.addEventListener("scroll", updateTopButton, { passive: true });
    return () => window.removeEventListener("scroll", updateTopButton);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadNotes() {
      try {
        const response = await fetch(`/api/notes?t=${Date.now()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const nextNotes = await response.json();
        if (!cancelled) {
          setNotes(nextNotes);
          setNoteLoadError("");
        }
      } catch (error) {
        if (!cancelled) setNoteLoadError(uiError(error.message));
      }
    }

    loadNotes();
    const timer = setInterval(loadNotes, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const editingRef = useRef(false);
  editingRef.current = Boolean(activeNote || activeConfig);

  useEffect(() => {
    const current = document.querySelector('script[type="module"][src*="/assets/index."]')?.getAttribute("src");
    if (!current) return undefined;

    async function checkBuild() {
      try {
        const response = await fetch(`/?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const latest = (await response.text()).match(/src="(\/assets\/index\.[^"]+\.js)"/)?.[1];
        if (latest && latest !== current && !editingRef.current) window.location.reload();
      } catch (_) {
        // Server unreachable; try again on the next interval.
      }
    }

    const timer = setInterval(checkBuild, 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!activeNote && !activeConfig) return undefined;
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => dialog?.querySelector("button, input, select, textarea")?.focus());
    function containDialogFocus(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNote();
        closeConfig();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])")]
        .filter((element) => element.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", containDialogFocus);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", containDialogFocus);
    };
  }, [activeNote, activeConfig]);

  useEffect(() => {
    let cancelled = false;

    async function loadLayout() {
      try {
        const response = await fetch(`/api/layout?t=${Date.now()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const nextLayout = await response.json();
        if (!cancelled) {
          setLayout(normalizeClientLayout(nextLayout));
          setLayoutError("");
        }
      } catch (error) {
        if (!cancelled) setLayoutError(uiError(error.message));
      }
    }

    loadLayout();
    const timer = setInterval(() => {
      if (!draggedAiboxIp && !draggedCamera.ip) loadLayout();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [draggedAiboxIp, draggedCamera.ip]);

  const loadData = useCallback(async () => {
    dataRequestRef.current?.abort();
    const controller = new AbortController();
    dataRequestRef.current = controller;
    setIsUpdating(true);
    try {
      const response = await fetch(`/aibox-data.json?t=${Date.now()}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextData = await response.json();
      if (!isDataLoaded(nextData)) throw new Error("Invalid status snapshot");
      setData((current) => {
        if (!isDataLoaded(current)) return nextData;
        return new Date(nextData.generatedAt).getTime() >= new Date(current.generatedAt).getTime() ? nextData : current;
      });
      setLoadError("");
    } catch (error) {
      if (error.name !== "AbortError") setLoadError(uiError(error.message));
    } finally {
      if (dataRequestRef.current === controller) {
        dataRequestRef.current = null;
        setIsUpdating(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!documentVisible) return undefined;
    let stopped = false;
    let timer = 0;
    async function poll() {
      await loadData();
      if (!stopped) timer = window.setTimeout(poll, 10_000);
    }
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      dataRequestRef.current?.abort();
    };
  }, [documentVisible, loadData]);

  function getNotes(target) {
    const primary = asNoteList(notes[target.key]).map((note) => ({ ...note, key: target.key }));
    const fallback = asNoteList(target.fallbackKey ? notes[target.fallbackKey] : null)
      .map((note) => ({ ...note, key: target.fallbackKey }));
    return primary.concat(fallback);
  }

  function openNote(target, mode) {
    if (activeNote?.key === target.key && activeNote.mode === mode) {
      closeNote();
      return;
    }
    dialogOpenerRef.current = document.activeElement;
    setActiveNote({ ...target, mode });
    setNoteForms((current) => ({ ...current, [target.key]: current[target.key] || emptyNoteForm() }));
  }

  function openNoteTargetByKey(key) {
    const box = aiboxes.find((item) => noteKey("aibox", item.ip) === key || item.ip === key);
    if (box) {
      openNote({ key: noteKey("aibox", box.ip), fallbackKey: box.ip, title: box.name, subtitle: box.ip }, "list");
      return;
    }
    const network = cameraNetworks.find((item) => noteKey("network", item.id) === key);
    if (network) {
      openNote({ key: noteKey("network", network.id), title: network.name, subtitle: network.id }, "list");
      return;
    }
    openNote({ key, title: noteTargetLabel(key, targetLookup), subtitle: "Đối tượng ghi chú đã lưu" }, "list");
  }

  function closeNote() {
    setActiveNote(null);
    window.requestAnimationFrame(() => dialogOpenerRef.current?.focus());
  }

  function closeConfig() {
    setActiveConfig(null);
    setConfigConfirm(null);
    window.requestAnimationFrame(() => dialogOpenerRef.current?.focus());
  }

  function focusDashboard(target) {
    setDashboardFocuses((current) => {
      if (target === "all") return [];
      return current.includes(target) ? current.filter((focus) => focus !== target) : [...current, target];
    });
    setStatusFilter("all");
    aiboxDirectionRef.current = 1;
    setAiboxPage(0);
    setNetworkGroupPage(0);
    setCameraStep(0);
  }

  function resetPanelSizes() {
    window.clearTimeout(resizeResumeTimerRef.current);
    setResizingPanel("layout");
    setPanelSizes(DEFAULT_PANEL_SIZES);
    resizeResumeTimerRef.current = window.setTimeout(() => setResizingPanel(""), 180);
  }

  function changePanelSize(panel, delta) {
    const aiboxMinimum = clamp(aiboxMinHeight / Math.max(1, dashboardWorkspaceRef.current?.clientHeight || 1), 0.05, 0.62);
    const limits = panel === "aibox" ? [aiboxMinimum, 0.62] : panel === "network" ? [0.48, 0.82] : [0.32, 0.68];
    setPanelSizes((current) => ({ ...current, [panel]: clamp(current[panel] + delta, limits[0], limits[1]) }));
  }

  function handleResizeKey(panel, axis, event) {
    const direction = axis === "x"
      ? event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0
      : event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    window.clearTimeout(resizeResumeTimerRef.current);
    setResizingPanel(panel);
    changePanelSize(panel, direction * 0.02);
    resizeResumeTimerRef.current = window.setTimeout(() => setResizingPanel(""), 180);
  }

  function startPanelResize(panel, event) {
    if (mobileDashboard) return;
    event.preventDefault();
    window.clearTimeout(resizeResumeTimerRef.current);
    setResizingPanel(panel);
    const move = (moveEvent) => {
      const element = panel === "aibox" ? dashboardWorkspaceRef.current : networkOverviewRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const rawRatio = panel === "network"
        ? (moveEvent.clientX - rect.left) / Math.max(1, rect.width)
        : (moveEvent.clientY - rect.top) / Math.max(1, rect.height);
      const aiboxMinimum = clamp(aiboxMinHeight / Math.max(1, dashboardWorkspaceRef.current?.clientHeight || 1), 0.05, 0.62);
      const limits = panel === "aibox" ? [aiboxMinimum, 0.62] : [0.48, 0.82];
      setPanelSizes((current) => ({ ...current, [panel]: clamp(rawRatio, limits[0], limits[1]) }));
    };
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      resizeResumeTimerRef.current = window.setTimeout(() => setResizingPanel(""), 180);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }

  async function saveLayout(nextLayout) {
    try {
      const response = await fetch("/api/layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextLayout),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setLayout(normalizeClientLayout(result));
      setLayoutError("");
    } catch (error) {
      setLayoutError(uiError(error.message));
    }
  }

  function reorderFleetAibox(targetIp, position = "before") {
    if (!canDragAiboxes || !draggedAiboxIp || draggedAiboxIp === targetIp) return;
    const sourceOrder = aiboxes.map((box) => box.ip);
    const currentOrder = mergedOrder(layout.aiboxOrder, sourceOrder);
    const nextOrder = moveToPosition(currentOrder, draggedAiboxIp, targetIp, position);
    if (nextOrder === currentOrder) return;
    const nextLayout = { ...layout, aiboxOrder: nextOrder };
    setLayout(nextLayout);
    saveLayout(nextLayout);
  }

  function handleAiboxDragStart(event, ip) {
    if (!canDragAiboxes) return;
    setDraggedAiboxIp(ip);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", ip);
  }

  function handleAiboxDragOver(event, ip, axis = "y") {
    if (!canDragAiboxes || !draggedAiboxIp || draggedAiboxIp === ip) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const midpoint = axis === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    const pointer = axis === "x" ? event.clientX : event.clientY;
    setDragInsert({ ip, position: pointer < midpoint ? "before" : "after" });
  }

  function handleAiboxDrop(event, ip) {
    if (!canDragAiboxes) return;
    event.preventDefault();
    reorderFleetAibox(ip, dragInsert.ip === ip ? dragInsert.position : "before");
    setDraggedAiboxIp("");
    setDragInsert({ ip: "", position: "before" });
  }

  function handleAiboxDragEnd() {
    setDraggedAiboxIp("");
    setDragInsert({ ip: "", position: "before" });
  }

  function reorderFleetNetwork(targetId, position = "before") {
    if (!canDragNetworks || !draggedNetworkId || draggedNetworkId === targetId) return;
    const sourceOrder = cameraNetworks.map((network) => network.id);
    const currentOrder = mergedOrder(layout.networkOrder, sourceOrder);
    const nextOrder = moveToPosition(currentOrder, draggedNetworkId, targetId, position);
    if (nextOrder === currentOrder) return;
    const nextLayout = { ...layout, networkOrder: nextOrder };
    setLayout(nextLayout);
    saveLayout(nextLayout);
  }

  function reorderFleetNetworkByStep(networkId, step) {
    if (!canDragNetworks) return;
    const sourceOrder = cameraNetworks.map((network) => network.id);
    const currentOrder = mergedOrder(layout.networkOrder, sourceOrder);
    const from = currentOrder.indexOf(networkId);
    const to = from + step;
    if (from === -1 || to < 0 || to >= currentOrder.length) return;
    const nextOrder = currentOrder.slice();
    nextOrder[from] = currentOrder[to];
    nextOrder[to] = currentOrder[from];
    const nextLayout = { ...layout, networkOrder: nextOrder };
    setLayout(nextLayout);
    saveLayout(nextLayout);
  }

  function handleNetworkDragStart(event, networkId) {
    if (!canDragNetworks) return;
    setDraggedNetworkId(networkId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", networkId);
  }

  function handleNetworkDragOver(event, networkId) {
    if (!canDragNetworks || !draggedNetworkId || draggedNetworkId === networkId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    setDragNetworkInsert({ id: networkId, position: event.clientY < rect.top + rect.height / 2 ? "before" : "after" });
  }

  function handleNetworkDrop(event, networkId) {
    if (!canDragNetworks) return;
    event.preventDefault();
    reorderFleetNetwork(networkId, dragNetworkInsert.id === networkId ? dragNetworkInsert.position : "before");
    setDraggedNetworkId("");
    setDragNetworkInsert({ id: "", position: "before" });
  }

  function handleNetworkDragEnd() {
    setDraggedNetworkId("");
    setDragNetworkInsert({ id: "", position: "before" });
  }

  function resetFleetNetworkOrder() {
    if (!canDragNetworks) return;
    const nextLayout = { ...layout, networkOrder: [] };
    setLayout(nextLayout);
    saveLayout(nextLayout);
  }

  function reorderCamera(networkId, targetIp, position = "before") {
    if (!loaded || draggedCamera.networkId !== networkId || !draggedCamera.ip || draggedCamera.ip === targetIp) return;
    const network = cameraNetworks.find((item) => item.id === networkId);
    if (!network) return;
    const sourceOrder = (network.cameras || []).map((camera) => camera.ip);
    const currentOrder = mergedOrder(layout.cameraOrder?.[networkId] || [], sourceOrder);
    const nextOrder = moveToPosition(currentOrder, draggedCamera.ip, targetIp, position);
    if (nextOrder === currentOrder) return;
    const nextLayout = {
      ...layout,
      cameraOrder: {
        ...(layout.cameraOrder || {}),
        [networkId]: nextOrder,
      },
    };
    setLayout(nextLayout);
    saveLayout(nextLayout);
  }

  function handleCameraDragStart(event, networkId, ip) {
    if (!loaded) return;
    setDraggedCamera({ networkId, ip });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${networkId}:${ip}`);
  }

  function handleCameraDragOver(event, networkId, ip, axis = "x") {
    if (!loaded || draggedCamera.networkId !== networkId || !draggedCamera.ip || draggedCamera.ip === ip) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const midpoint = axis === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    const pointer = axis === "x" ? event.clientX : event.clientY;
    setCameraInsert({ networkId, ip, position: pointer < midpoint ? "before" : "after" });
  }

  function handleCameraDrop(event, networkId, ip) {
    if (!loaded) return;
    event.preventDefault();
    reorderCamera(networkId, ip, cameraInsert.networkId === networkId && cameraInsert.ip === ip ? cameraInsert.position : "before");
    setDraggedCamera({ networkId: "", ip: "" });
    setCameraInsert({ networkId: "", ip: "", position: "before" });
  }

  function handleCameraDragEnd() {
    setDraggedCamera({ networkId: "", ip: "" });
    setCameraInsert({ networkId: "", ip: "", position: "before" });
  }

  async function loadConfig() {
    try {
      const response = await fetch(`/api/config?t=${Date.now()}`, { headers: adminHeaders() });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setConfigData(result.config);
      setConfigError("");
      return result.config;
    } catch (error) {
      setConfigError(uiError(error.message));
      return null;
    }
  }

  function adminHeaders(extra = {}) {
    return adminToken ? { ...extra, "X-Admin-Token": adminToken } : extra;
  }

  function openConfig(tab = "aiboxes") {
    dialogOpenerRef.current = document.activeElement;
    setActiveConfig({ tab });
    setConfigMessage("");
    loadConfig();
  }

  function afterConfigSaved(result) {
    setConfigData(result.config);
    setConfigMessage(result.syncError ? `Đã lưu cấu hình. Đồng bộ thất bại: ${uiError(result.syncError)}` : "Đã lưu cấu hình và cập nhật dữ liệu giám sát.");
    setConfigError("");
    setConfigConfirm(null);
    loadData();
  }

  async function saveConfigItem(method, endpoint, payload) {
    setConfigSaving(true);
    setConfigMessage("");
    try {
      const response = await fetch(endpoint, {
        method,
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      afterConfigSaved(result);
      return true;
    } catch (error) {
      setConfigError(uiError(error.message));
      return false;
    } finally {
      setConfigSaving(false);
    }
  }

  async function deleteConfigItem(endpoint) {
    setConfigSaving(true);
    setConfigMessage("");
    try {
      const response = await fetch(endpoint, { method: "DELETE", headers: adminHeaders() });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      afterConfigSaved(result);
    } catch (error) {
      setConfigError(uiError(error.message));
    } finally {
      setConfigSaving(false);
    }
  }

  function startAddAibox() {
    setAiboxForm({ ...EMPTY_AIBOX_FORM, status_recipient_group: configData?.default_status_recipient_group || "default_group" });
    setActiveConfig({ tab: "aiboxes", mode: "add-aibox" });
  }

  function startEditAibox(aibox) {
    setAiboxForm({
      ...EMPTY_AIBOX_FORM,
      ...aibox,
      currentId: aibox.id,
      networks: (aibox.networks || []).join(", "),
      resource_recipients: (aibox.resource_recipients || []).join(", "),
    });
    setActiveConfig({ tab: "aiboxes", mode: "edit-aibox" });
  }

  function startAddCamera(scopeId) {
    setCameraForm({ ...EMPTY_CAMERA_FORM, scopeId: scopeId || configData?.target_scopes?.[0]?.id || "" });
    setActiveConfig({ tab: "cameras", mode: "add-camera" });
  }

  function startEditCamera(scopeId, ip, name) {
    setCameraForm({ scopeId, currentIp: ip, ip, name });
    setActiveConfig({ tab: "cameras", mode: "edit-camera" });
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updateNoteForm(key, field, value) {
    setNoteForms((current) => ({ ...current, [key]: { ...emptyNoteForm(), ...current[key], [field]: value } }));
  }

  function updateAiboxForm(field, value) {
    setAiboxForm((current) => ({ ...current, [field]: value }));
  }

  function updateCameraForm(field, value) {
    setCameraForm((current) => ({ ...current, [field]: value }));
  }

  async function saveNote(event, target) {
    event.preventDefault();
    const form = { ...emptyNoteForm(), ...noteForms[target.key] };
    setSavingKey(target.key);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: target.key, creator: form.creator, content: form.content }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setNotes((current) => ({ ...current, [target.key]: result }));
      setNoteForms((current) => ({ ...current, [target.key]: emptyNoteForm() }));
      setActiveNote({ ...target, mode: "list" });
      setNoteWriteError("");
    } catch (error) {
      setNoteWriteError(uiError(error.message));
    } finally {
      setSavingKey("");
    }
  }

  async function deleteNote(target, note) {
    setDeletingNoteId(note.id);
    try {
      const deleteKey = note.key || target.key;
      const response = await fetch(`/api/notes?key=${encodeURIComponent(deleteKey)}&noteId=${encodeURIComponent(note.id)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setNotes((current) => {
        const nextNotes = { ...current };
        const nextList = asNoteList(nextNotes[deleteKey]).filter((item) => item.id !== note.id);
        if (nextList.length) nextNotes[deleteKey] = nextList;
        else delete nextNotes[deleteKey];
        return nextNotes;
      });
      setNoteForms((current) => ({ ...current, [target.key]: emptyNoteForm() }));
      setNoteWriteError("");
    } catch (error) {
      setNoteWriteError(uiError(error.message));
    } finally {
      setDeletingNoteId("");
    }
  }

  function renderStatusPill(item) {
    const duration = formatDuration(item.statusSince, now);
    return (
      <span className={`pill ${item.status}`} title={item.statusSince ? `Từ ${formatGeneratedAt(item.statusSince)}` : undefined}>
        <span>{statusLabel(item.status)}</span>
        {duration ? <span className="statusTimer">{duration}</span> : null}
      </span>
    );
  }

  function renderNoteControls(target, noteList) {
    const drawerId = "note-drawer";
    const mode = noteList.length ? "list" : "add";
    const isOpen = activeNote?.key === target.key;
    const noteCount = noteList.length;
    return (
      <div className="aiboxNoteTray">
        <button
          aria-controls={drawerId}
          aria-expanded={isOpen}
          aria-label={noteCount ? `Mở ${noteCount} ghi chú cho ${target.title}` : `Thêm ghi chú cho ${target.title}`}
          className={`noteAction btn btn-sm ${noteCount ? "hasNotes" : ""}`}
          onClick={() => openNote(target, mode)}
          type="button"
        >
          <NotePencil aria-hidden="true" size={14} weight="bold" />
          <span className="noteActionLabel">{noteCount ? "Ghi chú" : "Thêm ghi chú"}</span>
          {noteCount ? <strong aria-hidden="true" className="noteCountIndicator">{noteCount}</strong> : null}
        </button>
      </div>
    );
  }

  function renderNoteDrawer() {
    if (!activeNote) return null;
    const target = activeNote;
    const noteList = getNotes(target);
    const form = noteForms[target.key] || emptyNoteForm();
    return (
      <div className="noteDrawerWrap" role="presentation">
        <button className="noteBackdrop" aria-label="Đóng ghi chú" onClick={closeNote} type="button" />
        <aside className="noteDrawer noteDrawer--notes" id="note-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="note-drawer-title" aria-describedby="note-drawer-subtitle">
          <div className="noteHero">
            <div className="noteTarget">
              <span className="noteKicker">Ghi chú cho</span>
              <strong className="noteTargetTitle" id="note-drawer-title">{target.title}</strong>
              <span className="noteTargetSubtitle mono" id="note-drawer-subtitle">{target.subtitle}</span>
            </div>
            <button aria-label="Đóng ghi chú" className="noteClose" onClick={closeNote} type="button"><X aria-hidden="true" size={18} weight="bold" /></button>
          </div>

          <div className="noteDrawerMeta">
            <span className="noteBadge">{noteList.length} đã lưu</span>
            <span>Mới nhất trước</span>
          </div>

          <div className="noteTabs" aria-label="Thao tác ghi chú">
            <button aria-pressed={activeNote.mode === "list"} className={`noteTab ${activeNote.mode === "list" ? "active" : ""}`} onClick={() => setActiveNote({ ...target, mode: "list" })} type="button"><ListBullets aria-hidden="true" size={16} weight="bold" /><span>Ghi chú</span></button>
            <button aria-pressed={activeNote.mode === "add"} className={`noteTab ${activeNote.mode === "add" ? "active" : ""}`} onClick={() => setActiveNote({ ...target, mode: "add" })} type="button"><NotePencil aria-hidden="true" size={16} weight="bold" /><span>Ghi chú mới</span></button>
          </div>

          {noteError ? <p className="noteDrawerError" role="alert">Ghi chú: {noteError}</p> : null}

          {activeNote.mode === "add" ? (
          <form className="noteDrawerBody noteComposer" onSubmit={(event) => saveNote(event, target)}>
            <div className="noteField">
              <label className="form-label" htmlFor={`creator-${target.key}`}><span>Người ghi</span><small>Tên người bàn giao</small></label>
              <input autoComplete="name" className="form-control noteInput" id={`creator-${target.key}`} onChange={(event) => updateNoteForm(target.key, "creator", event.target.value)} placeholder="Tên của bạn" required type="text" value={form.creator} />
            </div>
            <div className="noteField noteField--message">
              <label className="form-label" htmlFor={`content-${target.key}`}><span>Nội dung bàn giao</span><small>Tình trạng, việc cần làm hoặc thông tin liên quan</small></label>
              <textarea className="form-control noteInput" id={`content-${target.key}`} onChange={(event) => updateNoteForm(target.key, "content", event.target.value)} placeholder="Mô tả thay đổi và công việc người trực tiếp theo cần thực hiện…" required rows="7" value={form.content} />
            </div>
            <div className="noteComposerActions">
              <button className="btn btn-outline-secondary" onClick={closeNote} type="button">Hủy</button>
              <button className="btn btn-primary noteSave" disabled={savingKey === target.key} type="submit">
                {savingKey === target.key ? "Đang lưu…" : "Lưu ghi chú"}
              </button>
            </div>
          </form>
        ) : (
          <div className="noteDrawerBody noteOutput">
            {noteList.length ? (
              <div className="noteList">
                {[...noteList].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((note) => (
                  <article className="noteItem" key={`${note.key || target.key}-${note.id}`}>
                    <div className="noteItemHeader">
                      <div className="noteItemIdentity">
                        <span className="noteAvatar">{String(note.creator || "?").trim().slice(0, 2).toUpperCase()}</span>
                        <div><strong>{note.creator}</strong><small>Ghi chú vận hành</small></div>
                      </div>
                      <time dateTime={note.createdAt}>{formatGeneratedAt(note.createdAt)}</time>
                    </div>
                    <div className="noteItemContent">{note.content}</div>
                    <div className="noteOutputActions">
                      <button className="noteDelete" aria-label={`Xóa ghi chú của ${note.creator}`} disabled={deletingNoteId === note.id} onClick={() => deleteNote(target, note)} type="button">
                        <Trash aria-hidden="true" size={14} weight="bold" /><span>{deletingNoteId === note.id ? "Đang xóa…" : "Xóa"}</span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="noteEmptyState">
                <span className="noteEmptyIcon"><NotePencil aria-hidden="true" size={22} weight="bold" /></span>
                <strong>Chưa có ghi chú</strong>
                <p>Ghi lại tình trạng thiết bị, việc cần làm hoặc thông tin bàn giao.</p>
                <button className="btn btn-primary" onClick={() => openNote(target, "add")} type="button">Viết ghi chú đầu tiên</button>
              </div>
            )}
          </div>
        )}
        </aside>
      </div>
    );
  }

  function renderConfigDrawer() {
    if (!activeConfig) return null;
    const groups = Object.keys(configData?.recipient_groups || {});
    const scopes = configData?.target_scopes || [];
    const aiboxesConfig = configData?.aiboxes || [];
    return (
      <div className="noteDrawerWrap" role="presentation">
        <button className="noteBackdrop" aria-label="Đóng cấu hình" onClick={closeConfig} type="button" />
        <aside className="noteDrawer configDrawer" id="config-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="config-drawer-title">
          <div className="noteDrawerHeader">
            <div>
              <strong id="config-drawer-title">Công cụ cấu hình</strong>
              <span>Chỉnh sửa danh sách AIBOX và camera trong cấu hình giám sát.</span>
            </div>
            <button className="btn btn-sm btn-outline-secondary rounded-pill" onClick={closeConfig} type="button">Đóng</button>
          </div>

          <div className="noteTabs" aria-label="Mục cấu hình">
            <button aria-pressed={activeConfig.tab === "aiboxes"} className={`noteTab ${activeConfig.tab === "aiboxes" ? "active" : ""}`} onClick={() => setActiveConfig({ tab: "aiboxes" })} type="button">AIBOX</button>
            <button aria-pressed={activeConfig.tab === "cameras"} className={`noteTab ${activeConfig.tab === "cameras" ? "active" : ""}`} onClick={() => setActiveConfig({ tab: "cameras" })} type="button">Camera</button>
          </div>

          <div className="noteDrawerBody configBody">
            <div className="configAdminRow">
              <label className="visually-hidden" htmlFor="config-admin-token">Mã quản trị</label>
              <input className="form-control noteInput" id="config-admin-token" onChange={(event) => setAdminToken(event.target.value)} placeholder="Mã quản trị nếu được bật" type="password" value={adminToken} />
              <button className="btn btn-outline-primary rounded-pill" onClick={() => { window.sessionStorage.setItem("aiboxAdminToken", adminToken); loadConfig(); }} type="button">Mở khóa</button>
            </div>
            {configError ? <div className="alert alert-warning rounded-4">{configError}</div> : null}
            {configMessage ? <div className="alert alert-success rounded-4">{configMessage}</div> : null}
            {!configData ? <div className="emptyState compact">Đang tải cấu hình…</div> : null}

            {configData && activeConfig.tab === "aiboxes" ? (
              <div className="configStack">
                <button className="btn btn-primary rounded-pill" onClick={startAddAibox} type="button">Thêm AIBOX</button>
                {(activeConfig.mode === "add-aibox" || activeConfig.mode === "edit-aibox") ? (
                  <form className="configForm" onSubmit={async (event) => {
                    event.preventDefault();
                    const endpoint = "/api/config/aibox";
                    const ok = await saveConfigItem(activeConfig.mode === "edit-aibox" ? "PUT" : "POST", endpoint, aiboxForm);
                    if (ok) setActiveConfig({ tab: "aiboxes" });
                  }}>
                    <div className="configFormGrid">
                      <label>ID<input className="form-control noteInput" required value={aiboxForm.id} onChange={(event) => updateAiboxForm("id", event.target.value)} /></label>
                      <label>Tên<input className="form-control noteInput" required value={aiboxForm.name} onChange={(event) => updateAiboxForm("name", event.target.value)} /></label>
                      <label>Tài khoản<input className="form-control noteInput" required value={aiboxForm.user} onChange={(event) => updateAiboxForm("user", event.target.value)} /></label>
                      <label>IP<input className="form-control noteInput" required value={aiboxForm.ip} onChange={(event) => updateAiboxForm("ip", event.target.value)} /></label>
                      <label>Mạng<input className="form-control noteInput" value={aiboxForm.networks} onChange={(event) => updateAiboxForm("networks", event.target.value)} placeholder="Phân cách bằng dấu phẩy" /></label>
                      <label>Giao diện mạng đích<input className="form-control noteInput" value={aiboxForm["target-interface"] || ""} onChange={(event) => updateAiboxForm("target-interface", event.target.value)} placeholder="Ví dụ: eth0" /></label>
                      <label>Người nhận cảnh báo tài nguyên<input className="form-control noteInput" value={aiboxForm.resource_recipients} onChange={(event) => updateAiboxForm("resource_recipients", event.target.value)} placeholder="Phân cách bằng dấu phẩy" /></label>
                      <label>Nhóm nhận thông báo<select className="form-select noteInput" value={aiboxForm.status_recipient_group} onChange={(event) => updateAiboxForm("status_recipient_group", event.target.value)}>{groups.map((group) => <option key={group} value={group}>{group}</option>)}</select></label>
                    </div>
                    <label className="form-check"><input className="form-check-input" type="checkbox" checked={Boolean(aiboxForm["check-devices"])} onChange={(event) => updateAiboxForm("check-devices", event.target.checked)} /> Kiểm tra thiết bị</label>
                    <label className="form-check"><input className="form-check-input" type="checkbox" checked={Boolean(aiboxForm["check-resource"])} onChange={(event) => updateAiboxForm("check-resource", event.target.checked)} /> Kiểm tra tài nguyên</label>
                    <div className="configActions"><button className="btn btn-outline-secondary rounded-pill" onClick={() => setActiveConfig({ tab: "aiboxes" })} type="button">Hủy</button><button className="btn btn-primary rounded-pill" disabled={configSaving} type="submit">{configSaving ? "Đang lưu…" : "Lưu AIBOX"}</button></div>
                  </form>
                ) : null}
                {aiboxesConfig.map((box) => (
                  <article className="configItem" key={box.id}>
                    <div><strong>{box.name}</strong><span className="mono">{box.id} · {box.ip}</span><small>{box.networks?.join(", ") || "Chưa có mạng"}</small></div>
                    <div className="configActions"><button className="btn btn-outline-primary rounded-pill" onClick={() => startEditAibox(box)} type="button">Sửa</button><button className="btn btn-outline-danger rounded-pill" onClick={() => setConfigConfirm({ type: "aibox", id: box.id, label: box.name })} type="button">Xóa</button></div>
                  </article>
                ))}
              </div>
            ) : null}

            {configData && activeConfig.tab === "cameras" ? (
              <div className="configStack">
                <button className="btn btn-primary rounded-pill" onClick={() => startAddCamera()} type="button">Thêm camera</button>
                {(activeConfig.mode === "add-camera" || activeConfig.mode === "edit-camera") ? (
                  <form className="configForm" onSubmit={async (event) => {
                    event.preventDefault();
                    const ok = await saveConfigItem(activeConfig.mode === "edit-camera" ? "PUT" : "POST", "/api/config/camera", cameraForm);
                    if (ok) setActiveConfig({ tab: "cameras" });
                  }}>
                    <div className="configFormGrid">
                      <label>Mạng<select className="form-select noteInput" required value={cameraForm.scopeId} onChange={(event) => updateCameraForm("scopeId", event.target.value)}>{scopes.map((scope) => <option key={scope.id} value={scope.id}>{scope.name} ({scope.id})</option>)}</select></label>
                      <label>IP camera<input className="form-control noteInput" required value={cameraForm.ip} onChange={(event) => updateCameraForm("ip", event.target.value)} /></label>
                      <label>Tên camera<input className="form-control noteInput" required value={cameraForm.name} onChange={(event) => updateCameraForm("name", event.target.value)} /></label>
                    </div>
                    <div className="configActions"><button className="btn btn-outline-secondary rounded-pill" onClick={() => setActiveConfig({ tab: "cameras" })} type="button">Hủy</button><button className="btn btn-primary rounded-pill" disabled={configSaving} type="submit">{configSaving ? "Đang lưu…" : "Lưu camera"}</button></div>
                  </form>
                ) : null}
                {scopes.map((scope) => (
                  <section className="configNetwork" key={scope.id}>
                    <div className="configNetworkHead"><div><strong>{scope.name}</strong><span className="mono">{scope.id}</span></div><button className="btn btn-outline-primary rounded-pill" onClick={() => startAddCamera(scope.id)} type="button">Thêm vào mạng này</button></div>
                    {Object.keys(scope.targets || {}).map((ip) => (
                      <article className="configItem compact" key={`${scope.id}-${ip}`}>
                        <div><strong>{scope.targets[ip]}</strong><span className="mono">{ip}</span></div>
                        <div className="configActions"><button className="btn btn-outline-primary rounded-pill" onClick={() => startEditCamera(scope.id, ip, scope.targets[ip])} type="button">Sửa</button><button className="btn btn-outline-danger rounded-pill" onClick={() => setConfigConfirm({ type: "camera", scopeId: scope.id, ip, label: scope.targets[ip] })} type="button">Xóa</button></div>
                      </article>
                    ))}
                  </section>
                ))}
              </div>
            ) : null}
          </div>

          {configConfirm ? (
            <div className="configConfirm">
              <strong>Xóa {configConfirm.label}?</strong>
              <span>Hệ thống tạo bản sao lưu trước khi thay đổi cấu hình.</span>
              <div className="configActions"><button className="btn btn-outline-secondary rounded-pill" onClick={() => setConfigConfirm(null)} type="button">Hủy</button><button className="btn btn-danger rounded-pill" disabled={configSaving} onClick={() => configConfirm.type === "aibox" ? deleteConfigItem(`/api/config/aibox?id=${encodeURIComponent(configConfirm.id)}`) : deleteConfigItem(`/api/config/camera?scopeId=${encodeURIComponent(configConfirm.scopeId)}&ip=${encodeURIComponent(configConfirm.ip)}`)} type="button">{configSaving ? "Đang xóa…" : "Xóa"}</button></div>
            </div>
          ) : null}
        </aside>
      </div>
    );
  }

  function renderSkeletons() {
    return Array.from({ length: 6 }).map((_, index) => <div className="skeletonCard" key={index} />);
  }

  return (
    <main className={`page ${theme} dashboardShell ${activeView === "dashboard" ? "dashboardOnlyShell" : activeView === "connectivity" ? "connectivityShell" : activeView === "tv" ? "tvShell" : activeView === "timelapse" ? "timelapseShell dashboardOnlyShell" : "fleetShell"} ${resizingPanel ? "isResizing" : ""} ${loaded && !dataCurrent ? "lastKnownData" : ""}`} data-bs-theme={theme}>
      <a className="skipLink" href="#main-content">Đến nội dung chính</a>
      <aside className="sideRail" aria-label="Điều hướng chính">
        <button className="railLogo" onClick={() => { setActiveView("dashboard"); focusDashboard("all"); }} type="button" aria-label="Mở tổng quan" title="AIBOX"><Cube aria-hidden="true" size={22} weight="bold" /></button>
        <nav className="railNav">
          <button aria-label="Tổng quan vận hành" aria-pressed={activeView === "dashboard"} className={`railButton ${activeView === "dashboard" ? "active" : ""}`} onClick={() => { setActiveView("dashboard"); focusDashboard("all"); }} type="button" title="Tổng quan vận hành"><SquaresFour aria-hidden="true" size={20} weight="fill" /><span>Tổng quan</span></button>
          <button aria-label="Chi tiết thiết bị" aria-pressed={activeView === "fleet"} className={`railButton ${activeView === "fleet" ? "active" : ""}`} onClick={() => setActiveView("fleet")} type="button" title="Chi tiết thiết bị"><ListBullets aria-hidden="true" size={20} weight="bold" /><span>Thiết bị</span></button>
          <button aria-label="USB" aria-pressed={activeView === "connectivity"} className={`railButton ${activeView === "connectivity" ? "active" : ""}`} onClick={() => setActiveView("connectivity")} type="button" title="USB"><Waveform aria-hidden="true" size={20} weight="bold" /><span>USB</span></button>
          <button aria-label="Màn hình TV" aria-pressed={activeView === "tv"} className={`railButton ${activeView === "tv" ? "active" : ""}`} onClick={() => setActiveView("tv")} type="button" title="Màn hình TV"><Television aria-hidden="true" size={20} weight="bold" /><span>TV</span></button>
          <button aria-label="Camera" aria-pressed={activeView === "timelapse"} className={`railButton ${activeView === "timelapse" ? "active" : ""}`} onClick={() => setActiveView("timelapse")} type="button" title="Camera"><ClockCounterClockwise aria-hidden="true" size={20} weight="bold" /><span>Camera</span></button>
        </nav>
        <div className="railBottom">
          <button aria-label={`Dùng giao diện ${theme === "dark" ? "sáng" : "tối"}`} aria-pressed={theme === "dark"} className="railUtility" onClick={() => setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))} type="button">{theme === "dark" ? <Sun aria-hidden="true" size={18} weight="bold" /> : <Moon aria-hidden="true" size={18} weight="bold" />}<span>{theme === "dark" ? "Sáng" : "Tối"}</span></button>
        </div>
      </aside>
      <div className="appFrame" id="main-content">
        {activeView !== "tv" ? (<>
        <header className="topBar">
          <div className="brandLine"><strong>Giám sát AIBOX</strong><span /><em>{activeView === "dashboard" ? "Tổng quan vận hành" : activeView === "connectivity" ? "Lịch sử kết nối" : activeView === "tv" ? "Màn hình TV" : activeView === "timelapse" ? "Timelapse" : "Chi tiết thiết bị"}</em></div>
          <div className="topTools">
            <div className={`topStatus ${updateState}`}><span />{updateLabel}</div>
            <div className="topUpdated" title={formatGeneratedAt(data.generatedAt)}>Cập nhật {formatDataAge(data.generatedAt, now)}</div>
            {activeView === "dashboard" ? (
              <div className="playbackControls" aria-label="Điều khiển tự động chuyển trang">
                <span className="playbackLabel">{mobileDashboard ? "Trang" : "Chuyển trang"}</span>
                <button aria-label="Trang trước" onClick={() => advancePlayback(-1)} type="button"><CaretLeft aria-hidden="true" size={16} weight="bold" /></button>
                {!mobileDashboard ? <button aria-label={autoplayPaused ? "Tiếp tục tự động chuyển trang" : "Tạm dừng tự động chuyển trang"} aria-pressed={autoplayPaused} className="playbackToggle" onClick={() => setAutoplayPaused((paused) => !paused)} type="button">{autoplayPaused || reducedMotion ? <Play aria-hidden="true" size={15} weight="fill" /> : <Pause aria-hidden="true" size={15} weight="fill" />}</button> : null}
                <button aria-label="Trang tiếp theo" onClick={() => advancePlayback(1)} type="button"><CaretRight aria-hidden="true" size={16} weight="bold" /></button>
              </div>
            ) : null}
            {activeView === "dashboard" ? <button className="layoutResetButton" onClick={resetPanelSizes} type="button" title="Khôi phục kích thước khung mặc định">Đặt lại khung</button> : null}
            {activeView === "dashboard" ? (
              <label className="searchBox">
                <span>Tìm kiếm</span>
                <MagnifyingGlass aria-hidden="true" size={16} weight="bold" /><input aria-label="Tìm thiết bị" onBlur={() => setSearchFocused(false)} onChange={(event) => setQuery(event.target.value)} onFocus={() => setSearchFocused(true)} placeholder="Tìm thiết bị…" type="search" value={query} />
              </label>
            ) : null}
          </div>
        </header>

        <div aria-live="polite" className="statusAlerts">
          {dashboardAlerts.map((alert) => <div className={`alert alert-${alert.tone} rounded-4`} key={alert.text}><span>{alert.text}</span>{alert.action ? <button onClick={loadData} type="button">{alert.action}</button> : null}</div>)}
        </div>
        </>) : null}

        {!loaded ? (
          <section aria-busy="true" aria-live="polite" className="dashboardLoading" role="status">
            <div className="loadingMark" aria-hidden="true" />
            <strong>{loadError ? "Không lấy được dữ liệu trạng thái" : "Đang tải trạng thái thiết bị"}</strong>
            <span>{loadError ? "Kiểm tra dịch vụ giám sát rồi thử lại." : "Đang chờ dữ liệu giám sát hợp lệ đầu tiên."}</span>
            {loadError ? <button onClick={loadData} type="button">Thử lại</button> : null}
          </section>
        ) : activeView === "tv" ? (
          <TvDashboard data={data} loadError={loadError} isUpdating={isUpdating} onRefresh={loadData} notes={fleetNotes} noteLookup={targetLookup} noteError={noteError} onAddNote={() => openNote({ key: "tv:board", title: "Bảng TV", subtitle: "Ghi chú vận hành chung" }, "add")} onOpenNote={openNoteTargetByKey} />
        ) : activeView === "dashboard" ? (
          <div className={`dashboardCanvas focus-${dashboardFocusMode}`}>
            <OperationsRibbon aiboxes={aiboxes} focuses={dashboardFocuses} networks={cameraNetworks} onFocus={focusDashboard} paused={playbackBlocked} />
            <div
              className="dashboardWorkspace"
              ref={dashboardWorkspaceRef}
              style={{ "--aibox-min-height": `${aiboxMinHeight}px`, "--aibox-size": `${panelSizes.aibox}fr`, "--lower-size": `${1 - panelSizes.aibox}fr` }}
            >
            {showAiboxPanel ? <section className="matrixPanel aiboxMatrixPanel" ref={aiboxPanelRef}>
                <div className="matrixHeader aiboxMatrixHeader">
                  <div className="aiboxHeaderLead">
                    <h2>Hệ thống AIBOX</h2>
                    <div aria-label="Tổng hợp trạng thái AIBOX" className="statusCounters">
                      <button aria-label={`${online} AIBOX kết nối. Xem thiết bị kết nối.`} className="statusCounter online" onClick={() => { setActiveView("fleet"); setStatusFilter("online"); }} type="button"><strong>{online}</strong><span>Kết nối</span></button>
                      <button aria-label={`${offline} AIBOX mất kết nối. Xem thiết bị mất kết nối.`} className="statusCounter offline" onClick={() => { setActiveView("fleet"); setStatusFilter("offline"); }} type="button"><strong>{offline}</strong><span>Mất kết nối</span></button>
                      <button aria-label={`Tổng ${aiboxes.length} AIBOX. Xem tất cả thiết bị.`} className="statusCounter total" onClick={() => { setActiveView("fleet"); setStatusFilter("all"); }} type="button"><strong>{aiboxes.length}</strong><span>Tổng</span></button>
                    </div>
                  </div>
                  <div className="matrixHeaderActions"><PageIndicator label="AIBOX" meta={{ ...aiboxPageMeta, page: safeAiboxPage }} total={dashboardAiboxes.length} /><span aria-hidden="true" className={`rotationProgress ${playbackBlocked ? "paused" : ""}`} key={`aibox-progress-${safeAiboxPage}-${aiboxRotationDuration}-${playbackBlocked}`} style={{ "--rotation-duration": `${aiboxRotationDuration}ms` }} /></div>
                </div>
                {dashboardAiboxes.length ? <MeasuredPageDeck
                  activePage={aiboxPage}
                  ariaLabel="Trạng thái AIBOX tự động chuyển trang"
                  className="aiboxAutoDeck"
                  items={dashboardAiboxes}
                  maxColumns={mobileDashboard ? 2 : tabletDashboard ? 4 : 8}
                  maxRows={mobileDashboard ? 4 : Number.MAX_SAFE_INTEGER}
                  minHeight={mobileDashboard ? 36 : 32}
                  minRows={1}
                  minWidth={mobileDashboard ? 145 : 168}
                  onPageMeta={updateAiboxPageMeta}
                  renderItem={(box) => (
                    <article aria-label={`${box.name}, IP ${box.ip}, ${statusLabel(box.status)}`} className={`matrixTile ${box.status}`} key={box.ip} title={`${box.name} · ${box.ip}`}>
                        <StatusSymbol status={box.status} /><RollingName name={compactDeviceName(box.name)} /><small className="tileAvailability" title="Tỷ lệ thời gian kết nối">{formatAvailability(box.availability)}</small>
                    </article>
                  )}
                  wrapPages={false}
                /> : <div className="emptyState compact dashboardEmpty">Không có AIBOX phù hợp bộ lọc.</div>}
            </section> : null}

            {showAiboxPanel && showNetworkPanel ? <ResizeHandle axis="y" label="Đổi kích thước khung AIBOX và mạng" onKeyDown={(event) => handleResizeKey("aibox", "y", event)} onPointerDown={(event) => startPanelResize("aibox", event)} /> : null}

            {showNetworkPanel ? <section className="dashboardLower">
              <div
                className="networkOverview"
                ref={networkOverviewRef}
              >
                <div className="matrixPanel networkMatrix" ref={networkPanelRef}>
                <div className="matrixHeader networkMatrixHeader"><div className="networkHeaderLead"><h2>{!isFullDashboard && dashboardNetworks.length === 1 ? compactDeviceName(dashboardNetworks[0]?.name || "MẠNG") : "Mạng camera"}</h2><div aria-label="Tổng hợp trạng thái camera" className="statusCounters"><span className="statusCounter online"><strong>{visibleCameraOnline}</strong><span>Kết nối</span></span><span className="statusCounter offline"><strong>{visibleCameraOffline}</strong><span>Mất kết nối</span></span><span className="statusCounter unknown"><strong>{visibleCameraUnknown}</strong><span>Chưa rõ</span></span><span className="statusCounter total"><strong>{visibleCameraCount}</strong><span>Tổng</span></span></div></div><div className="matrixHeaderActions"><PageIndicator label="Mạng" meta={{ ...networkPageMeta, page: networkPage }} total={dashboardNetworks.length} /><span aria-hidden="true" className={`rotationProgress ${playbackBlocked ? "paused" : ""}`} key={`network-progress-${networkPage}-${networkRotationDuration}-${playbackBlocked}`} style={{ "--rotation-duration": `${networkRotationDuration}ms` }} /></div></div>
                {dashboardNetworks.length ? <NetworkBoard
                  activePage={networkPage}
                  ariaLabel="Trạng thái mạng camera"
                  className="networkAutoDeck"
                  gridColumns={mobileDashboard ? 1 : tabletDashboard ? 2 : 3}
                  items={dashboardNetworks}
                  onPageMeta={updateNetworkPageMeta}
                  renderItem={(network, fit) => {
                    const networkSummary = network.cameras.reduce((summary, camera) => ({ ...summary, [camera.status]: (summary[camera.status] || 0) + 1 }), {});
                    return (
                      <article className={`networkMatrixTile ${fit.overflows ? "isOverflowing" : ""}`} key={network.id} style={{ height: `${fit.height}px`, left: `${fit.left}px`, top: `${fit.top}px`, width: `${fit.width}px` }} title={`${network.name} · ${network.id}`}>
                        <header className="networkMatrixHead">
                          <div><strong>{compactDeviceName(network.name)}</strong><span className="mono">{network.id}</span></div>
                          <div className="networkStatusMini" aria-label={`${networkSummary.online || 0} kết nối, ${networkSummary.offline || 0} mất kết nối, ${networkSummary.unknown || 0} chưa rõ, tổng ${network.cameras.length} camera`}><span className="good"><strong>{networkSummary.online || 0}</strong><small>kết nối</small></span><span className="bad"><strong>{networkSummary.offline || 0}</strong><small>mất</small></span><span className="unknown"><strong>{networkSummary.unknown || 0}</strong><small>chưa rõ</small></span><span className="total"><strong>{network.cameras.length}</strong><small>tổng</small></span></div>
                        </header>
                        <NetworkMonitorHealth network={network} now={now} onFocus={focusDashboard} />
                        <NetworkCameraGrid cameras={network.cameras} columns={fit.columns || 3} label={network.name} networkId={network.id} render={(camera) => (
                          <CameraPill camera={camera} key={`${network.id}-${camera.ip}`} network={network} onHoverChange={handlePreviewOpenChange} theme={theme} />
                        )} />
                      </article>
                    );
                  }}
                  /> : <div className="emptyState compact dashboardEmpty">Không có mạng camera phù hợp phạm vi hiện tại.</div>}
                </div>
              </div>
            </section> : null}
            </div>
          </div>
        ) : activeView === "timelapse" ? (
          <TimelapseView networks={timelapseNetworks} />
        ) : activeView === "fleet" ? (
          <div className={`container-xxl fleetDetailView ${desktopFleet ? "desktopFleet" : "flowFleet"}`}>
            <section className="hero controlDeck fleetCommandBand">
              <div className="heroCopy">
                <p className="eyebrow">Vận hành hệ thống</p>
                <h1>Quản lý thiết bị</h1>
                <p className="subtitle">Kết nối, tình trạng camera và ghi chú vận hành.</p>
              </div>
              {desktopFleet ? (
                <div className="fleetViewSwitch" aria-label="Các nhóm thiết bị và ghi chú">
                  <button aria-pressed={fleetSection === "aiboxes"} className={fleetSection === "aiboxes" ? "active" : ""} onClick={() => setFleetSection("aiboxes")} type="button"><strong>{aiboxes.length}</strong><span>AIBOX</span></button>
                  <button aria-pressed={fleetSection === "cameras"} className={fleetSection === "cameras" ? "active" : ""} onClick={() => setFleetSection("cameras")} type="button"><strong>{cameraCount}</strong><span>Camera</span></button>
                  <button aria-pressed={fleetSection === "notes"} className={fleetSection === "notes" ? "active" : ""} onClick={() => setFleetSection("notes")} type="button"><strong>{fleetNotes.length}</strong><span>Ghi chú</span></button>
                </div>
              ) : null}
              <div className="heroControls">
                <button className="heroAction primary" onClick={() => { setManageMode((value) => !value); if (!manageMode) loadConfig(); }} type="button"><GearSix aria-hidden="true" size={14} weight="bold" />{manageMode ? "Kết thúc chỉnh sửa" : "Quản lý thiết bị"}</button>
                <button className="heroAction secondary" onClick={() => { setActiveView("dashboard"); focusDashboard("all"); }} type="button">Tổng quan vận hành</button>
              </div>
            </section>

            <section className="summaryGrid fleetSummary" aria-label="Tổng hợp trạng thái">
              <Stat label="Mất kết nối" value={offline} tone="bad" active={fleetSection === "aiboxes" && statusFilter === "offline"} onClick={() => { setFleetSection("aiboxes"); setStatusFilter(statusFilter === "offline" ? "all" : "offline"); }} />
              <Stat label="Kết nối" value={online} tone="good" active={fleetSection === "aiboxes" && statusFilter === "online"} onClick={() => { setFleetSection("aiboxes"); setStatusFilter(statusFilter === "online" ? "all" : "online"); }} />
              <Stat label="Chưa rõ" value={unknown} tone="muted" active={fleetSection === "aiboxes" && statusFilter === "unknown"} onClick={() => { setFleetSection("aiboxes"); setStatusFilter(statusFilter === "unknown" ? "all" : "unknown"); }} />
              <Stat label="Tổng AIBOX" value={aiboxes.length} active={fleetSection === "aiboxes" && statusFilter === "all"} onClick={() => { setFleetSection("aiboxes"); setStatusFilter("all"); }} />
              <Stat ariaLabel="Xem mạng camera và chi tiết" label="Mạng" value={networks || cameraNetworks.length} active={fleetSection === "cameras"} onClick={() => setFleetSection("cameras")} />
              <Stat ariaLabel="Xem chi tiết tất cả camera" label="Camera" value={cameraCount} onClick={() => setFleetSection("cameras")} />
            </section>

            <div className="fleetWorkspace">
              {(!desktopFleet || fleetSection === "aiboxes") ? (
                <section className="fleetWorkspacePanel panel card border-0" id="fleet-section">
                  <div className="card-body">
                    <div className="sectionHeader fleetSectionHeader">
                      <div>
                        <h2 className="mb-0">Hệ thống AIBOX</h2>
                        <p className="sectionMeta mb-0">{filteredAiboxes.length}/{aiboxes.length} đã cấu hình{canDragAiboxes ? " · Kéo để sắp xếp" : " · Trạng thái và tỷ lệ thời gian kết nối"}</p>
                      </div>
                      <div className="fleetTools">
                        {manageMode ? <button className="btn btn-primary" onClick={() => openConfig("aiboxes")} type="button">Thêm/sửa AIBOX</button> : null}
                        <label className="fleetSearch"><MagnifyingGlass aria-hidden="true" size={15} weight="bold" /><input aria-label="Tìm AIBOX" className="form-control searchInput" onChange={(event) => setQuery(event.target.value)} placeholder="Tìm tên, IP, mạng" type="search" value={query} /></label>
                      </div>
                    </div>
                    <div className="fleetControlRow">
                      <div className="filterRow" role="group" aria-label="Lọc trạng thái">
                        {STATUS_FILTERS.map((filter) => (
                          <button aria-label={filter === "all" ? "Xem tất cả AIBOX" : `Xem AIBOX ${statusLabel(filter).toLowerCase()}`} aria-pressed={statusFilter === filter} className={`filterChip ${statusFilter === filter ? "active" : ""}`} key={filter} onClick={() => setStatusFilter(filter)} type="button">{filter === "all" ? "Tất cả" : statusLabel(filter)}</button>
                        ))}
                      </div>
                      {desktopFleet ? <span className="fleetVisibleCount">Hiển thị {fleetAiboxes.length}</span> : null}
                    </div>
                    {!loaded ? <div className="aiboxGrid fleetPagedGrid">{renderSkeletons()}</div> : fleetAiboxes.length ? (
                      <div className={`aiboxGrid fleetPagedGrid ${fleetAiboxColumns >= 7 ? "denseFleetGrid" : ""}`} style={{ "--fleet-aibox-columns": fleetAiboxColumns }}>
                        {fleetAiboxes.map((box) => {
                          const target = { key: noteKey("aibox", box.ip), fallbackKey: box.ip, title: box.name, subtitle: box.ip };
                          const noteList = getNotes(target);
                          return (
                            <div className={`aiboxShell ${draggedAiboxIp === box.ip ? "dragging" : ""} ${dragInsert.ip === box.ip ? `dragOver insert-${dragInsert.position}` : ""}`} draggable={canDragAiboxes} key={box.ip} onDragEnd={handleAiboxDragEnd} onDragOver={(event) => handleAiboxDragOver(event, box.ip, "y")} onDragStart={(event) => handleAiboxDragStart(event, box.ip)} onDrop={(event) => handleAiboxDrop(event, box.ip)}>
                              <article className={`aiboxPill ${box.status}`}>
                                <div className="aiboxPillTop">
                                  {canDragAiboxes ? <span className="dragHandle" title="Kéo để sắp xếp" aria-hidden="true">⋮⋮</span> : null}
                                  <StatusSymbol status={box.status} />
                                  <div className="aiboxTitleBlock"><strong title={box.name}>{compactDeviceName(box.name)}</strong><span className="mono">{box.ip}</span></div>
                                  {renderStatusPill(box)}
                                </div>
                                <div className="aiboxMeta"><span className="aiboxNetwork">{box.networks.length ? box.networks.join(", ") : "Chưa có mạng"}</span><span className="availabilityBadge"><small>Tỷ lệ kết nối</small>{formatAvailability(box.availability)}</span>{renderNoteControls(target, noteList)}</div>
                                <p className="aiboxMonitors" title={box.monitors.length ? box.monitors.join(", ") : "Chưa cấu hình giám sát"}><span>{box.monitors.length ? `${box.monitors.length} bộ giám sát` : "Chưa có bộ giám sát"}</span><b>{box.monitors.length ? box.monitors.join(", ") : "Chưa cấu hình"}</b></p>
                              </article>
                            </div>
                          );
                        })}
                      </div>
                    ) : <div className="emptyState">Không có AIBOX phù hợp bộ lọc hiện tại.</div>}
                  </div>
                </section>
              ) : null}

              {(!desktopFleet || fleetSection === "cameras") ? (
                <section className="fleetWorkspacePanel panel card border-0" id="fleet-camera-section">
                  <div className="card-body">
                    <div className="sectionHeader fleetSectionHeader">
                      <div><h2 className="mb-0">Camera theo mạng</h2><p className="sectionMeta mb-0">{cameraCount} camera · {canDragNetworks && networkReorderMode ? "Kéo tay nắm hoặc dùng mũi tên để sắp xếp mạng" : "Chọn mạng để xem trạng thái hiện tại"}</p></div>
                      {manageMode ? (
                        <div className="fleetNetworkControls">
                          {desktopFleet && canDragNetworks ? <button aria-pressed={networkReorderMode} className="filterChip" onClick={() => setNetworkReorderMode((value) => !value)} type="button">{networkReorderMode ? "Hoàn tất" : "Sắp xếp mạng"}</button> : null}
                          {desktopFleet && canDragNetworks && networkReorderMode ? <button className="filterChip" disabled={!layout.networkOrder.length} onClick={resetFleetNetworkOrder} type="button">Đặt lại thứ tự</button> : null}
                          <button className="btn btn-primary" onClick={() => openConfig("cameras")} type="button">Thêm/sửa camera</button>
                        </div>
                      ) : null}
                    </div>
                    {desktopFleet && canDragNetworks && networkReorderMode && orderedCameraNetworks.length ? (
                      <div className="fleetNetworkReorderList" role="group" aria-label="Sắp xếp mạng camera">
                        {orderedCameraNetworks.map((network, index) => {
                          const affected = network.cameras.filter((camera) => camera.status !== "online").length;
                          const name = compactDeviceName(network.name);
                          return (
                            <div className={`fleetNetworkReorderItem${draggedNetworkId === network.id ? " dragging" : ""}${dragNetworkInsert.id === network.id ? ` dragOver insert-${dragNetworkInsert.position}` : ""}`} key={network.id} onDragOver={(event) => handleNetworkDragOver(event, network.id)} onDrop={(event) => handleNetworkDrop(event, network.id)}>
                              <span aria-hidden="true" className="reorderHandle" draggable onDragEnd={handleNetworkDragEnd} onDragStart={(event) => handleNetworkDragStart(event, network.id)} title={`Kéo ${name}`}><DotsSixVertical size="1.1em" weight="bold" /></span>
                              <span className="reorderPosition">{String(index + 1).padStart(2, "0")}</span>
                              <span className="reorderIdentity"><strong>{name}</strong><span>{network.cameras.length} camera · {affected ? `${affected} bị ảnh hưởng` : "Đều có kết nối"}</span></span>
                              <span className="reorderControls">
                                <button aria-label={`Đưa ${name} lên`} className="reorderButton" disabled={index === 0} onClick={() => reorderFleetNetworkByStep(network.id, -1)} type="button"><CaretUp size="1em" weight="bold" /></button>
                                <button aria-label={`Đưa ${name} xuống`} className="reorderButton" disabled={index === orderedCameraNetworks.length - 1} onClick={() => reorderFleetNetworkByStep(network.id, 1)} type="button"><CaretDown size="1em" weight="bold" /></button>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : desktopFleet && orderedCameraNetworks.length ? (
                      <div className="fleetNetworkSelector" role="group" aria-label="Mạng camera">
                        {orderedCameraNetworks.map((network) => {
                          const affected = network.cameras.filter((camera) => camera.status !== "online").length;
                          const selected = selectedFleetNetwork?.id === network.id;
                          return (
                            <button aria-label={`${selected ? "Đang xem" : "Xem"} ${network.cameras.length} camera tại ${network.name}`} aria-pressed={selected} className={selected ? "active" : ""} key={network.id} onClick={() => setFleetNetworkId(network.id)} type="button">
                              <strong>{compactDeviceName(network.name)}</strong>
                              <span>{affected ? `${affected} bị ảnh hưởng` : "Đều có kết nối"}</span>
                              <b>{network.cameras.length}</b>
                              <span className="networkSelectorAction">{selected ? "Đang xem camera" : "Xem camera"}<CaretRight aria-hidden="true" size={12} weight="bold" /></span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    {!loaded ? <div className="d-grid gap-3">{renderSkeletons()}</div> : orderedCameraNetworks.length ? (
                      <div className="fleetNetworkStage">
                        {(desktopFleet ? [selectedFleetNetwork].filter(Boolean) : orderedCameraNetworks).map((network) => {
                          const target = { key: noteKey("network", network.id), title: network.name, subtitle: network.id };
                          const noteList = getNotes(target);
                          const cameraSummary = network.cameras.reduce((summary, camera) => ({ ...summary, [camera.status]: (summary[camera.status] || 0) + 1 }), {});
                          const hasProblem = (cameraSummary.offline || 0) + (cameraSummary.unknown || 0) > 0;
                          return (
                            <article className={`networkCard ${hasProblem ? "hasProblem" : ""}`} key={network.id}>
                              <div className="networkHead">
                                <div className="min-w-0"><div className="networkTitleLine"><h3>{network.name}</h3></div><p className="mono">{network.id}</p></div>
                                <div className="cameraSummary" aria-label="Tổng hợp trạng thái camera"><span className="miniStatus good"><b>{cameraSummary.online || 0}</b> kết nối</span><span className="miniStatus bad"><b>{cameraSummary.offline || 0}</b> mất kết nối</span><span className="miniStatus muted"><b>{cameraSummary.unknown || 0}</b> chưa rõ</span><span className="miniStatus total"><b>{network.cameras.length}</b> tổng</span></div>
                              </div>
                              <div className="networkMeta"><span title={network.monitors.length ? network.monitors.join(", ") : "-"}>Giám sát bởi: {network.monitors.length ? network.monitors.join(", ") : "-"}</span>{desktopFleet ? <div className="networkMetaActions"><span className="fleetVisibleCount">Hiển thị {network.cameras.length}</span>{renderNoteControls(target, noteList)}</div> : renderNoteControls(target, noteList)}</div>
                              <div className="cameraDetailList" role="list">
                                <div className="cameraDetailHeader" aria-hidden="true"><span>Camera</span><span>Địa chỉ IP</span><span>Trạng thái</span><span>Tỷ lệ kết nối</span><span>Từ lúc</span></div>
                                {network.cameras.map((camera) => (
                                   <article aria-label={`${camera.name}, IP ${camera.ip}, ${statusLabel(camera.status)}, ${camera.method === "image" ? "kiểm tra hình ảnh" : camera.method === "ping-fallback" ? "ping dự phòng" : camera.method === "ping" ? "kiểm tra ping" : "chưa thể kiểm tra"}, tỷ lệ thời gian kết nối ${formatAvailability(camera.availability)}`} className={`cameraDetailRow ${camera.status} ${draggedCamera.networkId === network.id && draggedCamera.ip === camera.ip ? "dragging" : ""} ${cameraInsert.networkId === network.id && cameraInsert.ip === camera.ip ? `dragOver insert-${cameraInsert.position}` : ""}`} draggable={manageMode && loaded} key={`${network.id}-${camera.ip}`} onDragEnd={handleCameraDragEnd} onDragOver={(event) => handleCameraDragOver(event, network.id, camera.ip, "y")} onDragStart={(event) => handleCameraDragStart(event, network.id, camera.ip)} onDrop={(event) => handleCameraDrop(event, network.id, camera.ip)} role="listitem" title={`${camera.name} · ${camera.ip} · ${camera.method === "image" ? "Kiểm tra hình ảnh" : camera.method === "ping-fallback" ? "Ping dự phòng" : camera.method === "ping" ? "Kiểm tra ping" : "Chưa thể kiểm tra"} · ${formatAvailability(camera.availability)}`}>
                                    <span className="cameraDetailName"><StatusSymbol status={camera.status} /><strong>{camera.name}</strong></span>
                                    <span className="cameraDetailIp mono">{camera.ip}</span>
                                    <span className="cameraDetailStatus">{renderStatusPill(camera)}<small className="cameraMethodLabel">{camera.method === "image" ? "Hình ảnh" : camera.method === "ping-fallback" ? "Ping dự phòng" : camera.method === "ping" ? "Ping" : "Chưa kiểm tra"}</small>{camera.quality === "lagging" ? <small className="cameraMethod lag" title={`Trễ (${camera.valid}/${camera.validTotal} khung hình hợp lệ)`}>TRỄ</small> : null}</span>
                                    {camera.quality === "lagging" && camera.valid != null ? <p className="cameraSnapshotNote">{camera.valid}/{camera.validTotal} ảnh gần nhất có hình ảnh rõ.</p> : null}
                                    {(camera.method === "image" || camera.method === "ping-fallback") ? <img alt={`Ảnh mới nhất từ ${camera.name}`} className="cameraSnapshot" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} src={`/camera-snapshots/${network.id}/${camera.ip}.jpg`} /> : null}
                                    <span className="cameraDetailAvailability">{typeof camera.availability === "number" ? (<><span className="availabilityBar" aria-hidden="true"><span style={{ "--fill": `${Math.min(100, Math.max(0, camera.availability))}%` }} /></span><b>{formatAvailability(camera.availability)}</b></>) : <b className="availabilityNa">—</b>}</span>
                                    <span className="cameraDetailSince" title={camera.statusSince ? formatGeneratedAt(camera.statusSince) : "Chưa ghi nhận thay đổi trạng thái"}>{camera.statusSince ? <time dateTime={camera.statusSince}>{formatGeneratedAt(camera.statusSince)}</time> : "—"}</span>
                                  </article>
                                ))}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : <div className="emptyState">Chưa cấu hình mạng camera.</div>}
                  </div>
                </section>
              ) : null}

              {(!desktopFleet || fleetSection === "notes") ? (
                <section className="fleetWorkspacePanel recentPanel panel card border-0" id="fleet-notes-section">
                  <div className="card-body">
                    <div className="sectionHeader fleetSectionHeader"><div><h2 className="mb-0">Ghi chú vận hành</h2><p className="sectionMeta mb-0">Ghi chú chung của AIBOX và mạng camera, mới nhất trước</p></div><span className="fleetVisibleCount">Hiển thị {fleetNotes.length}</span></div>
                    {fleetNotes.length ? (
                      <div className={`recentNoteGrid fleetNotesGrid ${fleetNoteColumns >= 5 ? "denseFleetNotesGrid" : ""}`} style={{ "--fleet-note-columns": fleetNoteColumns }}>
                        {fleetNotes.map((note) => {
                          const targetLabel = noteTargetLabel(note.key, targetLookup);
                          const targetType = note.key === "tv:board" ? "TV" : note.key.startsWith("network:") ? "Mạng" : "AIBOX";
                          return (
                            <button aria-label={`Mở ghi chú cho ${targetLabel}`} className="recentNote fleetNoteCard" key={`${note.key}-${note.id}`} onClick={() => openNoteTargetByKey(note.key)} type="button">
                              <span className="fleetNoteHead"><b>{targetType}</b><span title={targetLabel}>{targetLabel}</span></span>
                              <strong title={note.content}>{note.content}</strong>
                              <span className="fleetNoteMeta"><span>{note.creator}</span><time dateTime={note.createdAt}>{formatGeneratedAt(note.createdAt)}</time></span>
                            </button>
                          );
                        })}
                      </div>
                    ) : <div className="emptyState compact">Chưa có ghi chú chung.</div>}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        ) : (
          <ConnectivityView aiboxes={aiboxes} now={now} />
        )}
      </div>
      {renderNoteDrawer()}
      {renderConfigDrawer()}
      <button className={`backToTop ${showTopButton ? "visible" : ""}`} onClick={scrollToTop} type="button" aria-label="Về đầu trang">↑ Đầu trang</button>
    </main>
  );
}

function Stat({ ariaLabel, label, value, tone = "normal", active = false, onClick }) {
  const content = (
    <>
      <div>{label}</div>
      <strong>{value}</strong>
    </>
  );
  if (!onClick) return <article className={`stat ${tone} h-100`}>{content}</article>;
  return (
    <button aria-label={ariaLabel || (label === "Tổng AIBOX" ? "Xem tất cả AIBOX" : `Lọc AIBOX theo ${label.toLowerCase()}`)} aria-pressed={active} className={`stat statButton ${tone} ${active ? "active" : ""}`} onClick={onClick} type="button">
      {content}
    </button>
  );
}

createRoot(document.getElementById("root")).render(<App />);
