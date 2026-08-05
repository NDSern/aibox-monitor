import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import useEmblaCarousel from "embla-carousel-react";
import {
  CaretLeft,
  CaretRight,
  ListBullets,
  MagnifyingGlass,
  Moon,
  Pause,
  Play,
  QuestionMark,
  SquaresFour,
  Sun,
  WifiHigh,
  WifiSlash,
} from "@phosphor-icons/react";
import "@fontsource-variable/ibm-plex-sans";
import "bootstrap/dist/css/bootstrap.min.css";
import "./styles.css";

const EMPTY_DATA = { generatedAt: "Loading...", aiboxes: [], networks: [] };
const STATUS_FILTERS = ["all", "offline", "online", "unknown"];
const DEFAULT_PANEL_SIZES = { aibox: 0.3, network: 0.68, attention: 0.48 };
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
      attention: clamp(Number(stored.attention) || DEFAULT_PANEL_SIZES.attention, 0.32, 0.68),
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
  if (status === "online") return "Online";
  if (status === "offline") return "Offline";
  return "Unknown";
}

function StatusSymbol({ status }) {
  const Icon = status === "online" ? WifiHigh : status === "offline" ? WifiSlash : QuestionMark;
  return <span aria-hidden="true" className={`connectivityIcon ${status}`}><Icon size="1em" weight="bold" /></span>;
}

function compactDeviceName(name) {
  return String(name || "")
    .replace(/^Cảng\s+/i, "")
    .replace(/\s*-\s*Hải Phòng\s*/i, " ")
    .replace(/\s*-\s*Vũng Tàu\s*/i, " ")
    .replace(/Gia Vũ\s*-\s*/i, "Gia Vũ · ")
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
  const cameraOrder = {};
  const sourceCameraOrder = layout?.cameraOrder && typeof layout.cameraOrder === "object" && !Array.isArray(layout.cameraOrder)
    ? layout.cameraOrder
    : {};
  Object.keys(sourceCameraOrder).forEach((networkId) => {
    cameraOrder[networkId] = Array.isArray(sourceCameraOrder[networkId]) ? sourceCameraOrder[networkId] : [];
  });
  return {
    aiboxOrder: Array.isArray(layout?.aiboxOrder) ? layout.aiboxOrder : [],
    cameraOrder,
  };
}

function formatGeneratedAt(value) {
  if (!value || value === "Loading...") return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function formatDataAge(value, now) {
  const generated = new Date(value).getTime();
  if (!value || Number.isNaN(generated)) return "waiting for data";
  const seconds = Math.max(0, Math.floor((now - generated) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function emptyNoteForm(note) {
  return { creator: note?.creator || "", content: note?.content || "" };
}

function formatDuration(since, now) {
  if (!since) return "";
  const started = new Date(since).getTime();
  if (Number.isNaN(started)) return "";
  const minutes = Math.max(0, Math.floor((now - started) / 60000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatAvailability(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return `${value === 100 ? "100" : value.toFixed(2)}%`;
}

function noteKey(type, id) {
  return `${type}:${id}`;
}

function asNoteList(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function noteTargetLabel(key, lookup) {
  return lookup[key] || key.replace(/^aibox:/, "AIBOX ").replace(/^network:/, "Network ");
}

function isDataLoaded(data) {
  return data.generatedAt && data.generatedAt !== "Loading...";
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
          <div aria-hidden={pageIndex !== safePage} className="autoDeckSlide" key={`page-${pageIndex}`}>
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

function PageIndicator({ label, meta, total }) {
  const count = Math.max(1, meta.count || 1);
  const page = modulo(meta.page || 0, count);
  const start = total ? page * Math.max(1, meta.capacity || 1) + 1 : 0;
  const end = Math.min(total, (page + 1) * Math.max(1, meta.capacity || 1));
  const totalLabel = label === "AIBOX" ? `AIBOX${total === 1 ? "" : "es"}` : `${label.toLowerCase()}${total === 1 ? "" : "s"}`;
  if (count === 1) return <span className="pageIndicator"><span>{total} {totalLabel} total</span></span>;
  return (
    <span className="pageIndicator" title={`${label} page ${page + 1} of ${count}, items ${start} to ${end} of ${total}`}>
      <span>{label} page</span> {page + 1} of {count} <small>Showing {start}-{end} of {total}</small>
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
      title={`${label}. Drag or use arrow keys.`}
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
    <section className="operationsRibbon" aria-label="Dashboard scope">
      <div className="ribbonLabel"><strong>Scope</strong><span>{focuses.length ? `${focuses.length} selected` : "All systems"}</span></div>
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
          <button aria-pressed={!focuses.length} className={`ribbonCard all ${!focuses.length ? "active" : ""}`} onClick={() => onFocus("all")} title="Show the complete operations overview" type="button">
            <header><strong>All systems</strong><span>Live overview</span></header>
            <div className="ribbonMetrics"><span>{aiboxes.length} AIBOXes</span><span>{networks.reduce((total, network) => total + network.cameras.length, 0)} cameras</span></div>
          </button>
          <button aria-pressed={focuses.includes("fleet")} className={`ribbonCard fleet ${focuses.includes("fleet") ? "active" : ""}`} onClick={() => onFocus("fleet")} title={`${onlineAiboxes} online, ${offlineAiboxes} offline, ${aiboxes.length} total AIBOXes`} type="button">
            <header><strong>AIBOX fleet</strong><span>{aiboxes.length} total</span></header>
            <div className="ribbonMetrics"><span className="online"><b>{onlineAiboxes}</b> online</span><span className="offline"><b>{offlineAiboxes}</b> offline</span>{unknownAiboxes ? <span className="unknown"><b>{unknownAiboxes}</b> unknown</span> : null}</div>
          </button>
          {networkSummaries.map((network) => (
            <button aria-pressed={focuses.includes(network.id)} className={`ribbonCard network ${focuses.includes(network.id) ? "active" : ""}`} key={network.id} onClick={() => onFocus(network.id)} title={`${network.name}: ${network.online} cameras online, ${network.offline} offline, ${network.unknown} unknown`} type="button">
              <header><strong>{compactDeviceName(network.name)}</strong><span>{network.cameras.length} cameras</span></header>
              <div className="ribbonMetrics"><span className="online"><b>{network.online}</b> online</span><span className="offline"><b>{network.offline}</b> offline</span>{network.unknown ? <span className="unknown"><b>{network.unknown}</b> unknown</span> : null}</div>
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
  const checkerSummary = checkers.length ? `${onlineCheckers}/${checkers.length} checkers online` : "No checker assigned";
  const cause = blind && onlineCheckers ? "Scope telemetry unavailable" : blind ? "No healthy checker" : degraded ? "Monitoring degraded" : "Monitoring healthy";
  const state = blind ? "blind" : degraded ? "degraded" : "healthy";
  const impact = blind ? `${unknownCameras} blind` : degraded ? `${onlineCheckers}/${checkers.length} online` : "Healthy";

  return (
    <button
      aria-label={`${network.name}: ${cause}. ${checkerSummary}. ${unknownCameras} cameras without telemetry${duration ? ` for ${duration}` : ""}. Focus network.`}
      className={`networkMonitorHealth ${state}`}
      onClick={() => onFocus(network.id)}
      title={`Focus ${network.name}`}
      type="button"
    >
      <span className="networkMonitorState"><strong>{cause}</strong><small>{checkerSummary}{duration ? ` · ${duration}` : ""}</small></span>
      <b>{impact}</b>
    </button>
  );
}

function NeedAttention({ aiboxes, networks, onFocusNetwork, onShowOffline }) {
  const panelRef = useRef(null);
  const [visibleIssueCount, setVisibleIssueCount] = useState(3);
  const offlineAiboxes = aiboxes
    .filter((box) => box.status === "offline")
    .sort((a, b) => new Date(a.statusSince || 0) - new Date(b.statusSince || 0));
  const affectedNetworks = networks.map((network) => {
    const offline = network.cameras.filter((camera) => camera.status === "offline").length;
    const unknown = network.cameras.filter((camera) => camera.status === "unknown").length;
    const checkers = network.monitorAiboxes || [];
    const onlineCheckers = checkers.filter((box) => box.status === "online").length;
    return { ...network, offline, unknown, affected: offline + unknown, checkers, onlineCheckers };
  }).filter((network) => network.affected).sort((a, b) => b.offline - a.offline || b.unknown - a.unknown);
  const issueCount = offlineAiboxes.length + affectedNetworks.length;
  const maximumVisible = Math.max(3, offlineAiboxes.length, affectedNetworks.length);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return undefined;
    const compact = window.matchMedia("(max-width: 1100px)");
    function update() {
      const next = compact.matches
        ? 3
        : clamp(Math.floor((panel.clientHeight - 88) / 40), 3, maximumVisible);
      setVisibleIssueCount((current) => current === next ? current : next);
    }
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    if (compact.addEventListener) compact.addEventListener("change", update);
    else compact.addListener(update);
    update();
    return () => {
      observer.disconnect();
      if (compact.removeEventListener) compact.removeEventListener("change", update);
      else compact.removeListener(update);
    };
  }, [maximumVisible]);

  return (
    <aside className="attentionPanel" aria-label="Current operational issues" ref={panelRef}>
      <header>
        <div className="attentionTitle"><span aria-hidden="true">!</span><div><h2>Current issues</h2><p>Live outages and missing telemetry</p></div></div>
        <strong className="attentionWindow">{issueCount} active</strong>
      </header>
      <div className="attentionList">
        <div className="attentionCategory">
          <div className="attentionCategoryHead"><strong>AIBOX outages</strong><span>{offlineAiboxes.length} offline</span></div>
          {offlineAiboxes.length ? offlineAiboxes.slice(0, visibleIssueCount).map((box) => (
            <button className="attentionDevice" key={box.ip} onClick={onShowOffline} title={`Show offline AIBOXes. ${box.name}`} type="button">
              <StatusSymbol status="offline" /><span><strong>{compactDeviceName(box.name)}</strong><small>Offline {formatDuration(box.statusSince, Date.now())}</small></span><b>{formatAvailability(box.availability)}</b>
            </button>
          )) : <div className="attentionEmpty">No current outages</div>}
        </div>
        <div className="attentionCategory">
          <div className="attentionCategoryHead"><strong>Camera networks</strong><span>{affectedNetworks.length} affected</span></div>
          {affectedNetworks.length ? affectedNetworks.slice(0, visibleIssueCount).map((network) => (
            <button className="attentionDevice" key={network.id} onClick={() => onFocusNetwork(network.id)} title={`Focus ${network.name}`} type="button">
              <StatusSymbol status={network.offline ? "offline" : "unknown"} /><span><strong>{compactDeviceName(network.name)}</strong><small>{network.monitorStatus === "unknown" ? `${network.checkers.length ? `${network.onlineCheckers}/${network.checkers.length} checkers` : "No checker"} · telemetry blind` : network.offline ? `${network.offline} offline` : `${network.unknown} unknown`}</small></span><b>{network.affected}/{network.cameras.length}</b>
            </button>
          )) : <div className="attentionEmpty">All cameras reporting</div>}
        </div>
      </div>
    </aside>
  );
}

function DashboardRecentNotes({ notes, lookup, now, onOpen }) {
  return (
    <aside className="dashboardNotesPanel" aria-label="Recent operator notes">
      <header><h2>Recent notes</h2><span>{notes.length ? `${notes.length} newest` : "Live updates"}</span></header>
      {notes.length ? (
        <div className={`dashboardNoteList count-${Math.min(3, notes.length)}`}>
          {notes.slice(0, 3).map((note) => {
            const age = formatDuration(note.createdAt, now);
            return (
              <button className="dashboardNoteItem" key={`${note.key}-${note.id}`} onClick={() => onOpen(note.key)} type="button">
                <span className="dashboardNoteTarget">{noteTargetLabel(note.key, lookup)}</span>
                <strong>{note.content}</strong>
                <small>{note.creator}{age ? ` · ${age} ago` : ""}</small>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="dashboardNotesEmpty"><strong>No shared notes</strong><span>Operator notes will appear here.</span></div>
      )}
    </aside>
  );
}

function FleetPager({ label, page, pageCount, pageSize, total, onPage }) {
  if (!total) return <span className="fleetPageRange" role="status">No results</span>;
  const start = page * pageSize + 1;
  const end = Math.min(total, start + pageSize - 1);
  return (
    <div className="fleetPager" aria-label={`${label} pages`}>
      <span className="fleetPageRange" role="status">{start}-{end} of {total}</span>
      <button aria-label={`Previous ${label} page`} disabled={page <= 0} onClick={() => onPage(page - 1)} type="button"><CaretLeft aria-hidden="true" size={16} weight="bold" /></button>
      <span className="fleetPageCount">{page + 1}/{pageCount}</span>
      <button aria-label={`Next ${label} page`} disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)} type="button"><CaretRight aria-hidden="true" size={16} weight="bold" /></button>
    </div>
  );
}

function App() {
  const [data, setData] = useState(EMPTY_DATA);
  const [loadError, setLoadError] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [notes, setNotes] = useState({});
  const [layout, setLayout] = useState({ aiboxOrder: [], cameraOrder: {} });
  const [layoutError, setLayoutError] = useState("");
  const [draggedAiboxIp, setDraggedAiboxIp] = useState("");
  const [dragInsert, setDragInsert] = useState({ ip: "", position: "before" });
  const [draggedCamera, setDraggedCamera] = useState({ networkId: "", ip: "" });
  const [cameraInsert, setCameraInsert] = useState({ networkId: "", ip: "", position: "before" });
  const [noteForms, setNoteForms] = useState({});
  const [noteError, setNoteError] = useState("");
  const [activeNote, setActiveNote] = useState(null);
  const [savingKey, setSavingKey] = useState("");
  const [deletingNoteId, setDeletingNoteId] = useState("");
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useState(initialTheme);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [activeView, setActiveView] = useState("dashboard");
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
  const [networkGroupPage, setNetworkGroupPage] = useState(0);
  const [networkPageMeta, setNetworkPageMeta] = useState({ capacity: 1, count: 1, page: 0 });
  const [cameraStep, setCameraStep] = useState(0);
  const [cameraPageMeta, setCameraPageMeta] = useState({});
  const [fleetSection, setFleetSection] = useState("aiboxes");
  const [fleetAiboxPage, setFleetAiboxPage] = useState(0);
  const [fleetNetworkId, setFleetNetworkId] = useState("");
  const [fleetCameraPage, setFleetCameraPage] = useState(0);
  const aiboxDirectionRef = useRef(1);
  const resizeResumeTimerRef = useRef(0);
  const dialogRef = useRef(null);
  const dialogOpenerRef = useRef(null);
  const dashboardWorkspaceRef = useRef(null);
  const aiboxPanelRef = useRef(null);
  const networkOverviewRef = useRef(null);
  const networkInsightsRef = useRef(null);
  const documentVisible = useDocumentVisible();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const mobileDashboard = useMediaQuery("(max-width: 760px)");
  const tabletDashboard = useMediaQuery("(max-width: 1100px)");
  const desktopFleet = useMediaQuery("(min-width: 901px) and (min-height: 621px)");
  const wideFleet = useMediaQuery("(min-width: 1400px)");
  const mediumFleet = useMediaQuery("(min-width: 1200px)");
  const lowHeightFleet = useMediaQuery("(max-height: 760px)");

  const aiboxes = data.aiboxes ?? [];
  const cameraNetworks = data.networks ?? [];
  const loaded = isDataLoaded(data);
  const online = aiboxes.filter((box) => box.status === "online").length;
  const offline = aiboxes.filter((box) => box.status === "offline").length;
  const unknown = aiboxes.length - online - offline;
  const networks = new Set(aiboxes.flatMap((box) => box.networks)).size;
  const cameraCount = cameraNetworks.reduce((total, network) => total + network.cameras.length, 0);
  const filteredNetworks = useMemo(() => cameraNetworks
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
    .filter((network) => network.cameras.length || [network.name, network.id].join(" ").toLowerCase().includes(query.trim().toLowerCase())), [cameraNetworks, query]);
  const orderedFilteredNetworks = useMemo(() => filteredNetworks.map((network) => ({
    ...network,
    cameras: applySavedOrder(network.cameras || [], layout.cameraOrder?.[network.id] || [], (camera) => camera.ip),
  })), [filteredNetworks, layout.cameraOrder]);
  const orderedCameraNetworks = useMemo(() => cameraNetworks.map((network) => ({
    ...network,
    cameras: applySavedOrder(network.cameras || [], layout.cameraOrder?.[network.id] || [], (camera) => camera.ip),
  })), [cameraNetworks, layout.cameraOrder]);
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
  const isStale = loaded && dataAgeMs > 45_000;
  const updateState = loadError ? "disconnected" : (isUpdating || !loaded) ? "updating" : isStale ? "stale" : "live";
  const updateLabel = loadError ? "Disconnected" : (isUpdating || !loaded) ? "Updating" : isStale ? "Stale" : "Live";
  const dashboardAlerts = [
    loadError ? { tone: "danger", text: `Status unavailable. Automatic retry active: ${loadError}` } : null,
    noteError ? { tone: "warning", text: `Notes unavailable: ${noteError}` } : null,
    layoutError ? { tone: "warning", text: `Device order unavailable: ${layoutError}` } : null,
  ].filter(Boolean);

  const targetLookup = useMemo(() => {
    const lookup = {};
    aiboxes.forEach((box) => {
      lookup[noteKey("aibox", box.ip)] = `${box.name} · ${box.ip}`;
      lookup[box.ip] = `${box.name} · ${box.ip}`;
    });
    cameraNetworks.forEach((network) => {
      lookup[noteKey("network", network.id)] = `${network.name} · ${network.id}`;
    });
    return lookup;
  }, [aiboxes, cameraNetworks]);

  const recentNotes = useMemo(() => Object.keys(notes)
    .flatMap((key) => asNoteList(notes[key]).map((note) => ({ ...note, key })))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5), [notes]);

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
  const fleetAiboxPageSize = wideFleet ? 8 : mediumFleet ? 6 : 4;
  const fleetAiboxPageCount = Math.max(1, Math.ceil(fleetAiboxes.length / fleetAiboxPageSize));
  const safeFleetAiboxPage = clamp(fleetAiboxPage, 0, fleetAiboxPageCount - 1);
  const visibleFleetAiboxes = desktopFleet
    ? fleetAiboxes.slice(safeFleetAiboxPage * fleetAiboxPageSize, (safeFleetAiboxPage + 1) * fleetAiboxPageSize)
    : fleetAiboxes;
  const selectedFleetNetwork = orderedCameraNetworks.find((network) => network.id === fleetNetworkId) || orderedCameraNetworks[0] || null;
  const fleetCameraPageSize = lowHeightFleet
    ? wideFleet ? 12 : mediumFleet ? 8 : 6
    : wideFleet ? 24 : mediumFleet ? 16 : 12;
  const fleetCameraPageCount = Math.max(1, Math.ceil((selectedFleetNetwork?.cameras.length || 0) / fleetCameraPageSize));
  const safeFleetCameraPage = clamp(fleetCameraPage, 0, fleetCameraPageCount - 1);
  const visibleFleetCameras = desktopFleet
    ? (selectedFleetNetwork?.cameras || []).slice(safeFleetCameraPage * fleetCameraPageSize, (safeFleetCameraPage + 1) * fleetCameraPageSize)
    : [];
  const safeAiboxPage = clamp(aiboxPage, 0, Math.max(0, aiboxPageMeta.count - 1));
  const canDragAiboxes = manageMode && activeView === "fleet" && statusFilter === "all" && loaded;
  const activeNetworkGroups = useMemo(() => chunkItems(dashboardNetworks, Math.max(1, networkPageMeta.capacity || 1)), [dashboardNetworks, networkPageMeta.capacity]);
  const safeNetworkGroup = modulo(networkGroupPage, activeNetworkGroups.length);
  const currentNetworkGroup = activeNetworkGroups[safeNetworkGroup] || [];
  const currentCameraPageCount = Math.max(1, ...currentNetworkGroup.map((network) => cameraPageMeta[network.id]?.count || 1));
  const playbackBlocked = activeView !== "dashboard"
    || !loaded
    || !documentVisible
    || reducedMotion
    || mobileDashboard
    || autoplayPaused
    || searchFocused
    || Boolean(activeNote)
    || Boolean(activeConfig)
    || Boolean(draggedAiboxIp)
    || Boolean(draggedCamera.ip)
    || Boolean(resizingPanel);

  const updateAiboxPageMeta = useCallback((meta) => {
    setAiboxPageMeta((current) => current.capacity === meta.capacity && current.count === meta.count && current.page === meta.page ? current : meta);
  }, []);

  const updateNetworkPageMeta = useCallback((meta) => {
    setNetworkPageMeta((current) => current.capacity === meta.capacity && current.count === meta.count && current.page === meta.page ? current : meta);
  }, []);

  const updateCameraPageMeta = useCallback((networkId, meta) => {
    setCameraPageMeta((current) => {
      const previous = current[networkId];
      if (previous && previous.capacity === meta.capacity && previous.count === meta.count && previous.page === meta.page) return current;
      return { ...current, [networkId]: meta };
    });
  }, []);

  const advanceCameraScene = useCallback((direction) => {
    if (direction < 0) {
      if (cameraStep > 0) setCameraStep(cameraStep - 1);
      else {
        setNetworkGroupPage((group) => modulo(group - 1, Math.max(1, networkPageMeta.count)));
        setCameraStep(0);
      }
      return;
    }
    if (cameraStep + 1 < currentCameraPageCount) setCameraStep(cameraStep + 1);
    else {
      setNetworkGroupPage((group) => modulo(group + 1, Math.max(1, networkPageMeta.count)));
      setCameraStep(0);
    }
  }, [cameraStep, currentCameraPageCount, networkPageMeta.count]);

  const advancePlayback = useCallback((direction = 1) => {
    aiboxDirectionRef.current = direction < 0 ? -1 : 1;
    setAiboxPage((page) => modulo(page + direction, Math.max(1, aiboxPageMeta.count)));
    advanceCameraScene(direction);
  }, [advanceCameraScene, aiboxPageMeta.count]);

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
    setNetworkGroupPage(0);
    setCameraStep(0);
    setFleetAiboxPage(0);
  }, [dashboardFocuses, query, statusFilter]);

  useEffect(() => {
    setFleetAiboxPage((page) => clamp(page, 0, fleetAiboxPageCount - 1));
  }, [fleetAiboxPageCount]);

  useEffect(() => {
    if (!orderedCameraNetworks.length) {
      setFleetNetworkId("");
      return;
    }
    if (!orderedCameraNetworks.some((network) => network.id === fleetNetworkId)) setFleetNetworkId(orderedCameraNetworks[0].id);
  }, [fleetNetworkId, orderedCameraNetworks]);

  useEffect(() => {
    setFleetCameraPage(0);
  }, [fleetNetworkId]);

  useEffect(() => {
    setFleetCameraPage((page) => clamp(page, 0, fleetCameraPageCount - 1));
  }, [fleetCameraPageCount]);

  useEffect(() => {
    setAiboxPage((page) => clamp(page, 0, Math.max(0, aiboxPageMeta.count - 1)));
  }, [aiboxPageMeta.count]);

  useEffect(() => {
    setNetworkGroupPage((page) => modulo(page, Math.max(1, networkPageMeta.count)));
  }, [networkPageMeta.count]);

  useEffect(() => {
    setCameraStep((step) => modulo(step, currentCameraPageCount));
  }, [currentCameraPageCount]);

  useEffect(() => {
    if (playbackBlocked || aiboxPageMeta.count <= 1) return undefined;
    const lastPage = aiboxPageMeta.count - 1;
    const timer = window.setTimeout(() => {
      const direction = aiboxPage <= 0 ? 1 : aiboxPage >= lastPage ? -1 : aiboxDirectionRef.current;
      aiboxDirectionRef.current = direction;
      setAiboxPage((page) => clamp(page + direction, 0, lastPage));
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [aiboxPage, aiboxPageMeta.count, playbackBlocked]);

  useEffect(() => {
    if (playbackBlocked || (networkPageMeta.count <= 1 && currentCameraPageCount <= 1)) return undefined;
    const timer = window.setTimeout(() => advanceCameraScene(1), 12_000);
    return () => window.clearTimeout(timer);
  }, [advanceCameraScene, cameraStep, currentCameraPageCount, networkGroupPage, networkPageMeta.count, playbackBlocked]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
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
          setNoteError("");
        }
      } catch (error) {
        if (!cancelled) setNoteError(error.message);
      }
    }

    loadNotes();
    const timer = setInterval(loadNotes, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
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
        if (!cancelled) setLayoutError(error.message);
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

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      if (!cancelled) setIsUpdating(true);
      try {
        const response = await fetch(`/aibox-data.json?t=${Date.now()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const nextData = await response.json();
        if (!cancelled) {
          setData(nextData);
          setLoadError("");
        }
      } catch (error) {
        if (!cancelled) setLoadError(error.message);
      } finally {
        if (!cancelled) setIsUpdating(false);
      }
    }

    loadData();
    const timer = setInterval(loadData, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

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
    openNote({ key, title: noteTargetLabel(key, targetLookup), subtitle: "Saved note target" }, "list");
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
      const element = panel === "aibox" ? dashboardWorkspaceRef.current : panel === "network" ? networkOverviewRef.current : networkInsightsRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const rawRatio = panel === "network"
        ? (moveEvent.clientX - rect.left) / Math.max(1, rect.width)
        : (moveEvent.clientY - rect.top) / Math.max(1, rect.height);
      const aiboxMinimum = clamp(aiboxMinHeight / Math.max(1, dashboardWorkspaceRef.current?.clientHeight || 1), 0.05, 0.62);
      const limits = panel === "aibox" ? [aiboxMinimum, 0.62] : panel === "network" ? [0.48, 0.82] : [0.32, 0.68];
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
      setLayoutError(error.message);
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
      setConfigError(error.message);
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
    setConfigMessage(result.syncError ? `Config saved. Data sync failed: ${result.syncError}` : "Config saved. Monitor data refreshed.");
    setConfigError("");
    setConfigConfirm(null);
    fetch(`/aibox-data.json?t=${Date.now()}`).then((response) => response.ok ? response.json() : null).then((nextData) => {
      if (nextData) setData(nextData);
    }).catch(() => {});
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
      setConfigError(error.message);
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
      setConfigError(error.message);
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
      setNoteError("");
    } catch (error) {
      setNoteError(error.message);
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
      setNoteError("");
    } catch (error) {
      setNoteError(error.message);
    } finally {
      setDeletingNoteId("");
    }
  }

  function renderStatusPill(item) {
    const duration = formatDuration(item.statusSince, now);
    return (
      <span className={`pill ${item.status}`} title={item.statusSince ? `Since ${formatGeneratedAt(item.statusSince)}` : undefined}>
        <span>{statusLabel(item.status)}</span>
        {duration ? <span className="statusTimer">{duration}</span> : null}
      </span>
    );
  }

  function renderNoteControls(target, noteList) {
    const drawerId = "note-drawer";
    const mode = noteList.length ? "list" : "add";
    const isOpen = activeNote?.key === target.key;
    return (
      <div className="aiboxNoteTray">
        <button
          aria-controls={drawerId}
          aria-expanded={isOpen}
          className="noteAction btn btn-sm btn-primary rounded-pill"
          onClick={() => openNote(target, mode)}
          type="button"
        >
          {noteList.length ? `Notes (${noteList.length})` : "+ Note"}
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
        <button className="noteBackdrop" aria-label="Close notes" onClick={closeNote} type="button" />
        <aside className="noteDrawer noteDrawer--notes" id="note-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="note-drawer-title" aria-describedby="note-drawer-subtitle">
          <div className="noteHero">
            <div>
              <span className="noteKicker">Notes for</span>
              <strong className="noteTargetTitle" id="note-drawer-title">{target.title}</strong>
              <span className="noteTargetSubtitle mono" id="note-drawer-subtitle">{target.subtitle}</span>
            </div>
            <button className="btn btn-sm btn-outline-secondary rounded-pill" onClick={closeNote} type="button">Close</button>
          </div>

          <div className="noteDrawerMeta">
            <span className="noteBadge">{noteList.length} notes</span>
            <span>Live updates</span>
            <span>Newest first</span>
          </div>

          <div className="noteTabs" aria-label="Note actions">
            <button aria-pressed={activeNote.mode === "list"} className={`noteTab ${activeNote.mode === "list" ? "active" : ""}`} onClick={() => setActiveNote({ ...target, mode: "list" })} type="button">Notes</button>
            <button aria-pressed={activeNote.mode === "add"} className={`noteTab ${activeNote.mode === "add" ? "active" : ""}`} onClick={() => setActiveNote({ ...target, mode: "add" })} type="button">New note</button>
          </div>

          {activeNote.mode === "add" ? (
          <form className="noteDrawerBody noteComposer" onSubmit={(event) => saveNote(event, target)}>
            <div>
              <label className="form-label" htmlFor={`creator-${target.key}`}>Created by</label>
              <input className="form-control noteInput" id={`creator-${target.key}`} onChange={(event) => updateNoteForm(target.key, "creator", event.target.value)} required type="text" value={form.creator} />
            </div>
            <div>
              <label className="form-label" htmlFor={`content-${target.key}`}>Note</label>
              <textarea className="form-control noteInput" id={`content-${target.key}`} onChange={(event) => updateNoteForm(target.key, "content", event.target.value)} required rows="7" value={form.content} />
            </div>
            <div className="noteComposerActions">
              <button className="btn btn-outline-secondary rounded-pill" onClick={closeNote} type="button">Cancel</button>
              <button className="btn btn-primary rounded-pill noteSave" disabled={savingKey === target.key} type="submit">
                {savingKey === target.key ? "Saving..." : "Save note"}
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
                      <div>
                        <span className="noteAvatar">{String(note.creator || "?").trim().slice(0, 2).toUpperCase()}</span>
                        <strong>{note.creator}</strong>
                      </div>
                      <span>{formatGeneratedAt(note.createdAt)}</span>
                    </div>
                    <div className="noteItemContent">{note.content}</div>
                    <div className="noteOutputActions">
                      <button className="noteDelete" aria-label={`Delete note by ${note.creator}`} disabled={deletingNoteId === note.id} onClick={() => deleteNote(target, note)} type="button">
                        {deletingNoteId === note.id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="noteEmptyState">
                <strong>No notes yet</strong>
                <p>Record device condition, next action, or handoff details.</p>
                <button className="btn btn-primary rounded-pill" onClick={() => openNote(target, "add")} type="button">Write first note</button>
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
        <button className="noteBackdrop" aria-label="Close config tools" onClick={closeConfig} type="button" />
        <aside className="noteDrawer configDrawer" id="config-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="config-drawer-title">
          <div className="noteDrawerHeader">
            <div>
              <strong id="config-drawer-title">Configuration tools</strong>
              <span>Edit AIBOXes and camera lists from monitor config.</span>
            </div>
            <button className="btn btn-sm btn-outline-secondary rounded-pill" onClick={closeConfig} type="button">Close</button>
          </div>

          <div className="noteTabs" aria-label="Config sections">
            <button aria-pressed={activeConfig.tab === "aiboxes"} className={`noteTab ${activeConfig.tab === "aiboxes" ? "active" : ""}`} onClick={() => setActiveConfig({ tab: "aiboxes" })} type="button">AIBOXes</button>
            <button aria-pressed={activeConfig.tab === "cameras"} className={`noteTab ${activeConfig.tab === "cameras" ? "active" : ""}`} onClick={() => setActiveConfig({ tab: "cameras" })} type="button">Cameras</button>
          </div>

          <div className="noteDrawerBody configBody">
            <div className="configAdminRow">
              <label className="visually-hidden" htmlFor="config-admin-token">Admin token</label>
              <input className="form-control noteInput" id="config-admin-token" onChange={(event) => setAdminToken(event.target.value)} placeholder="Admin token if enabled" type="password" value={adminToken} />
              <button className="btn btn-outline-primary rounded-pill" onClick={() => { window.sessionStorage.setItem("aiboxAdminToken", adminToken); loadConfig(); }} type="button">Unlock</button>
            </div>
            {configError ? <div className="alert alert-warning rounded-4">{configError}</div> : null}
            {configMessage ? <div className="alert alert-success rounded-4">{configMessage}</div> : null}
            {!configData ? <div className="emptyState compact">Loading config...</div> : null}

            {configData && activeConfig.tab === "aiboxes" ? (
              <div className="configStack">
                <button className="btn btn-primary rounded-pill" onClick={startAddAibox} type="button">Add AIBOX</button>
                {(activeConfig.mode === "add-aibox" || activeConfig.mode === "edit-aibox") ? (
                  <form className="configForm" onSubmit={async (event) => {
                    event.preventDefault();
                    const endpoint = "/api/config/aibox";
                    const ok = await saveConfigItem(activeConfig.mode === "edit-aibox" ? "PUT" : "POST", endpoint, aiboxForm);
                    if (ok) setActiveConfig({ tab: "aiboxes" });
                  }}>
                    <div className="configFormGrid">
                      <label>ID<input className="form-control noteInput" required value={aiboxForm.id} onChange={(event) => updateAiboxForm("id", event.target.value)} /></label>
                      <label>Name<input className="form-control noteInput" required value={aiboxForm.name} onChange={(event) => updateAiboxForm("name", event.target.value)} /></label>
                      <label>User<input className="form-control noteInput" required value={aiboxForm.user} onChange={(event) => updateAiboxForm("user", event.target.value)} /></label>
                      <label>IP<input className="form-control noteInput" required value={aiboxForm.ip} onChange={(event) => updateAiboxForm("ip", event.target.value)} /></label>
                      <label>Networks<input className="form-control noteInput" value={aiboxForm.networks} onChange={(event) => updateAiboxForm("networks", event.target.value)} placeholder="comma-separated" /></label>
                      <label>Target interface<input className="form-control noteInput" value={aiboxForm["target-interface"] || ""} onChange={(event) => updateAiboxForm("target-interface", event.target.value)} placeholder="for example eth0" /></label>
                      <label>Resource recipients<input className="form-control noteInput" value={aiboxForm.resource_recipients} onChange={(event) => updateAiboxForm("resource_recipients", event.target.value)} placeholder="comma-separated" /></label>
                      <label>Recipient group<select className="form-select noteInput" value={aiboxForm.status_recipient_group} onChange={(event) => updateAiboxForm("status_recipient_group", event.target.value)}>{groups.map((group) => <option key={group} value={group}>{group}</option>)}</select></label>
                    </div>
                    <label className="form-check"><input className="form-check-input" type="checkbox" checked={Boolean(aiboxForm["check-devices"])} onChange={(event) => updateAiboxForm("check-devices", event.target.checked)} /> Check devices</label>
                    <label className="form-check"><input className="form-check-input" type="checkbox" checked={Boolean(aiboxForm["check-resource"])} onChange={(event) => updateAiboxForm("check-resource", event.target.checked)} /> Check resource</label>
                    <div className="configActions"><button className="btn btn-outline-secondary rounded-pill" onClick={() => setActiveConfig({ tab: "aiboxes" })} type="button">Cancel</button><button className="btn btn-primary rounded-pill" disabled={configSaving} type="submit">{configSaving ? "Saving..." : "Save AIBOX"}</button></div>
                  </form>
                ) : null}
                {aiboxesConfig.map((box) => (
                  <article className="configItem" key={box.id}>
                    <div><strong>{box.name}</strong><span className="mono">{box.id} · {box.ip}</span><small>{box.networks?.join(", ") || "No network"}</small></div>
                    <div className="configActions"><button className="btn btn-outline-primary rounded-pill" onClick={() => startEditAibox(box)} type="button">Edit</button><button className="btn btn-outline-danger rounded-pill" onClick={() => setConfigConfirm({ type: "aibox", id: box.id, label: box.name })} type="button">Delete</button></div>
                  </article>
                ))}
              </div>
            ) : null}

            {configData && activeConfig.tab === "cameras" ? (
              <div className="configStack">
                <button className="btn btn-primary rounded-pill" onClick={() => startAddCamera()} type="button">Add camera</button>
                {(activeConfig.mode === "add-camera" || activeConfig.mode === "edit-camera") ? (
                  <form className="configForm" onSubmit={async (event) => {
                    event.preventDefault();
                    const ok = await saveConfigItem(activeConfig.mode === "edit-camera" ? "PUT" : "POST", "/api/config/camera", cameraForm);
                    if (ok) setActiveConfig({ tab: "cameras" });
                  }}>
                    <div className="configFormGrid">
                      <label>Network<select className="form-select noteInput" required value={cameraForm.scopeId} onChange={(event) => updateCameraForm("scopeId", event.target.value)}>{scopes.map((scope) => <option key={scope.id} value={scope.id}>{scope.name} ({scope.id})</option>)}</select></label>
                      <label>Camera IP<input className="form-control noteInput" required value={cameraForm.ip} onChange={(event) => updateCameraForm("ip", event.target.value)} /></label>
                      <label>Camera name<input className="form-control noteInput" required value={cameraForm.name} onChange={(event) => updateCameraForm("name", event.target.value)} /></label>
                    </div>
                    <div className="configActions"><button className="btn btn-outline-secondary rounded-pill" onClick={() => setActiveConfig({ tab: "cameras" })} type="button">Cancel</button><button className="btn btn-primary rounded-pill" disabled={configSaving} type="submit">{configSaving ? "Saving..." : "Save camera"}</button></div>
                  </form>
                ) : null}
                {scopes.map((scope) => (
                  <section className="configNetwork" key={scope.id}>
                    <div className="configNetworkHead"><div><strong>{scope.name}</strong><span className="mono">{scope.id}</span></div><button className="btn btn-outline-primary rounded-pill" onClick={() => startAddCamera(scope.id)} type="button">Add here</button></div>
                    {Object.keys(scope.targets || {}).map((ip) => (
                      <article className="configItem compact" key={`${scope.id}-${ip}`}>
                        <div><strong>{scope.targets[ip]}</strong><span className="mono">{ip}</span></div>
                        <div className="configActions"><button className="btn btn-outline-primary rounded-pill" onClick={() => startEditCamera(scope.id, ip, scope.targets[ip])} type="button">Edit</button><button className="btn btn-outline-danger rounded-pill" onClick={() => setConfigConfirm({ type: "camera", scopeId: scope.id, ip, label: scope.targets[ip] })} type="button">Delete</button></div>
                      </article>
                    ))}
                  </section>
                ))}
              </div>
            ) : null}
          </div>

          {configConfirm ? (
            <div className="configConfirm">
              <strong>Delete {configConfirm.label}?</strong>
              <span>This writes a backup before changing config.</span>
              <div className="configActions"><button className="btn btn-outline-secondary rounded-pill" onClick={() => setConfigConfirm(null)} type="button">Cancel</button><button className="btn btn-danger rounded-pill" disabled={configSaving} onClick={() => configConfirm.type === "aibox" ? deleteConfigItem(`/api/config/aibox?id=${encodeURIComponent(configConfirm.id)}`) : deleteConfigItem(`/api/config/camera?scopeId=${encodeURIComponent(configConfirm.scopeId)}&ip=${encodeURIComponent(configConfirm.ip)}`)} type="button">{configSaving ? "Deleting..." : "Delete"}</button></div>
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
    <main className={`page ${theme} dashboardShell ${activeView === "fleet" ? "fleetShell" : "dashboardOnlyShell"} ${resizingPanel ? "isResizing" : ""}`} data-bs-theme={theme}>
      <a className="skipLink" href="#main-content">Skip to content</a>
      <aside className="sideRail" aria-label="Primary navigation">
        <button className="railLogo" onClick={() => { setActiveView("dashboard"); focusDashboard("all"); }} type="button" aria-label="Open dashboard">A</button>
        <nav className="railNav">
          <button aria-label="Operations overview" aria-pressed={activeView === "dashboard"} className={`railButton ${activeView === "dashboard" ? "active" : ""}`} onClick={() => { setActiveView("dashboard"); focusDashboard("all"); }} type="button" title="Operations overview"><SquaresFour aria-hidden="true" size={20} weight="fill" /><span>Overview</span></button>
          <button aria-label="Fleet detail" aria-pressed={activeView === "fleet"} className={`railButton ${activeView === "fleet" ? "active" : ""}`} onClick={() => setActiveView("fleet")} type="button" title="Fleet detail"><ListBullets aria-hidden="true" size={20} weight="bold" /><span>Fleet</span></button>
        </nav>
        <div className="railBottom">
          <button aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`} aria-pressed={theme === "dark"} className="railUtility" onClick={() => setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))} type="button">{theme === "dark" ? <Sun aria-hidden="true" size={18} weight="bold" /> : <Moon aria-hidden="true" size={18} weight="bold" />}<span>{theme === "dark" ? "Light" : "Dark"}</span></button>
        </div>
      </aside>
      <div className="appFrame" id="main-content">
        <header className="topBar">
          <div className="brandLine"><strong>AIBOX Monitor</strong><span /><em>{activeView === "dashboard" ? "Operations overview" : "Fleet detail"}</em></div>
          <div className="topTools">
            <div className={`topStatus ${updateState}`} aria-live="polite"><span />{updateLabel}</div>
            <div className="topUpdated" aria-live="polite" title={formatGeneratedAt(data.generatedAt)}>Updated {formatDataAge(data.generatedAt, now)}</div>
            {activeView === "dashboard" ? (
              <div className="playbackControls" aria-label="Automatic dashboard rotation controls">
                <span className="playbackLabel">{mobileDashboard ? "Pages" : "Rotation"}</span>
                <button aria-label="Previous dashboard pages" onClick={() => advancePlayback(-1)} type="button"><CaretLeft aria-hidden="true" size={16} weight="bold" /></button>
                {!mobileDashboard ? <button aria-label={autoplayPaused ? "Resume automatic dashboard rotation" : "Pause automatic dashboard rotation"} aria-pressed={autoplayPaused} className="playbackToggle" onClick={() => setAutoplayPaused((paused) => !paused)} type="button">{autoplayPaused || reducedMotion ? <Play aria-hidden="true" size={15} weight="fill" /> : <Pause aria-hidden="true" size={15} weight="fill" />}</button> : null}
                <button aria-label="Next dashboard pages" onClick={() => advancePlayback(1)} type="button"><CaretRight aria-hidden="true" size={16} weight="bold" /></button>
              </div>
            ) : null}
            {activeView === "dashboard" ? <button className="layoutResetButton" onClick={resetPanelSizes} type="button" title="Restore default panel sizes">Reset panels</button> : null}
            {activeView === "dashboard" ? (
              <label className="searchBox">
                <span>Search</span>
                <MagnifyingGlass aria-hidden="true" size={16} weight="bold" /><input aria-label="Search devices" onBlur={() => setSearchFocused(false)} onChange={(event) => setQuery(event.target.value)} onFocus={() => setSearchFocused(true)} placeholder="Search devices..." type="search" value={query} />
              </label>
            ) : null}
          </div>
        </header>

        <div aria-live="polite" className="statusAlerts">
          {dashboardAlerts.map((alert) => <div className={`alert alert-${alert.tone} rounded-4`} key={alert.text}>{alert.text}</div>)}
        </div>

        {activeView === "dashboard" ? (
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
                    <h2>AIBOX fleet</h2>
                    <div aria-label="AIBOX status summary" className="statusCounters">
                      <button aria-label={`${online} online AIBOXes. Show online devices.`} className="statusCounter online" onClick={() => { setActiveView("fleet"); setStatusFilter("online"); }} type="button"><strong>{online}</strong><span>Online</span></button>
                      <button aria-label={`${offline} offline AIBOXes. Show offline devices.`} className="statusCounter offline" onClick={() => { setActiveView("fleet"); setStatusFilter("offline"); }} type="button"><strong>{offline}</strong><span>Offline</span></button>
                      <button aria-label={`${aiboxes.length} total AIBOXes. Show all devices.`} className="statusCounter total" onClick={() => { setActiveView("fleet"); setStatusFilter("all"); }} type="button"><strong>{aiboxes.length}</strong><span>Total</span></button>
                    </div>
                  </div>
                  <div className="matrixHeaderActions"><PageIndicator label="AIBOX" meta={{ ...aiboxPageMeta, page: safeAiboxPage }} total={dashboardAiboxes.length} /><span aria-hidden="true" className={`rotationProgress ${playbackBlocked ? "paused" : ""}`} key={`aibox-progress-${safeAiboxPage}-${playbackBlocked}`} style={{ "--rotation-duration": "8s" }} /></div>
                </div>
                <MeasuredPageDeck
                  activePage={aiboxPage}
                  ariaLabel="Automatically rotating AIBOX fleet status"
                  className="aiboxAutoDeck"
                  items={dashboardAiboxes}
                  maxColumns={mobileDashboard ? 2 : tabletDashboard ? 4 : 8}
                  maxRows={mobileDashboard ? 4 : 3}
                  minHeight={mobileDashboard ? 36 : 32}
                  minRows={1}
                  minWidth={mobileDashboard ? 145 : 168}
                  onPageMeta={updateAiboxPageMeta}
                  renderItem={(box) => (
                    <article aria-label={`${box.name}, IP ${box.ip}, ${statusLabel(box.status)}`} className={`matrixTile ${box.status} ${draggedAiboxIp === box.ip ? "dragging" : ""} ${dragInsert.ip === box.ip ? `dragOver insert-${dragInsert.position}` : ""}`} draggable={canDragAiboxes} key={box.ip} onDragEnd={handleAiboxDragEnd} onDragOver={(event) => handleAiboxDragOver(event, box.ip, "x")} onDragStart={(event) => handleAiboxDragStart(event, box.ip)} onDrop={(event) => handleAiboxDrop(event, box.ip)} title={`${box.name} · ${box.ip}`}>
                       <StatusSymbol status={box.status} /><RollingName name={compactDeviceName(box.name)} /><small className="tileAvailability" title="Rolling 7-day availability">{formatAvailability(box.availability)}</small>
                    </article>
                  )}
                  wrapPages={false}
                />
            </section> : null}

            {showAiboxPanel && showNetworkPanel ? <ResizeHandle axis="y" label="Resize AIBOX and network panels" onKeyDown={(event) => handleResizeKey("aibox", "y", event)} onPointerDown={(event) => startPanelResize("aibox", event)} /> : null}

            {showNetworkPanel ? <section className="dashboardLower">
              <div
                className="networkOverview"
                ref={networkOverviewRef}
                style={{ "--network-size": `${panelSizes.network}fr`, "--insights-size": `${1 - panelSizes.network}fr` }}
              >
                <div className="matrixPanel networkMatrix">
                <div className="matrixHeader networkMatrixHeader"><div className="networkHeaderLead"><h2>{!isFullDashboard && dashboardNetworks.length === 1 ? compactDeviceName(dashboardNetworks[0]?.name || "NETWORK") : "Camera networks"}</h2><div aria-label="Camera status summary" className="statusCounters"><span className="statusCounter online"><strong>{visibleCameraOnline}</strong><span>Online</span></span><span className="statusCounter offline"><strong>{visibleCameraOffline}</strong><span>Offline</span></span><span className="statusCounter unknown"><strong>{visibleCameraUnknown}</strong><span>Unknown</span></span><span className="statusCounter total"><strong>{visibleCameraCount}</strong><span>Total</span></span></div></div><div className="networkPlaybackMeta"><PageIndicator label="Network" meta={{ ...networkPageMeta, page: networkGroupPage }} total={dashboardNetworks.length} /><span className="cameraStepIndicator"><span>Cameras </span>{cameraStep + 1}/{currentCameraPageCount}</span><span aria-hidden="true" className={`rotationProgress camera ${playbackBlocked ? "paused" : ""}`} key={`camera-progress-${networkGroupPage}-${cameraStep}-${playbackBlocked}`} style={{ "--rotation-duration": "12s" }} /></div></div>
                <MeasuredPageDeck
                  activePage={networkGroupPage}
                  ariaLabel="Automatically rotating network camera status"
                  className="networkAutoDeck"
                  items={dashboardNetworks}
                  maxColumns={isFullDashboard || dashboardNetworks.length > 1 ? (mobileDashboard ? 1 : tabletDashboard ? 2 : 3) : 1}
                  maxRows={1}
                  minHeight={100}
                  minWidth={mobileDashboard ? 275 : tabletDashboard ? 300 : 360}
                  onPageMeta={updateNetworkPageMeta}
                  renderItem={(network) => {
                    const networkSummary = network.cameras.reduce((summary, camera) => ({ ...summary, [camera.status]: (summary[camera.status] || 0) + 1 }), {});
                    return (
                      <article className="networkMatrixTile" key={network.id} title={`${network.name} · ${network.id}`}>
                        <header className="networkMatrixHead">
                          <div><strong>{compactDeviceName(network.name)}</strong><span className="mono">{network.id}</span></div>
                          <div className="networkStatusMini" aria-label={`${networkSummary.online || 0} online, ${networkSummary.offline || 0} offline, ${networkSummary.unknown || 0} unknown, ${network.cameras.length} total cameras`}><span className="good"><strong>{networkSummary.online || 0}</strong><small>on</small></span><span className="bad"><strong>{networkSummary.offline || 0}</strong><small>off</small></span><span className="unknown"><strong>{networkSummary.unknown || 0}</strong><small>unknown</small></span><span className="total"><strong>{network.cameras.length}</strong><small>total</small></span></div>
                        </header>
                        <NetworkMonitorHealth network={network} now={now} onFocus={focusDashboard} />
                        <MeasuredPageDeck activePage={cameraStep} ariaLabel={`${network.name} automatically rotating cameras`} className="cameraAutoDeck" items={network.cameras} maxColumns={mobileDashboard ? 2 : 4} minHeight={mobileDashboard ? 32 : 34} minWidth={mobileDashboard ? 130 : 132} onPageMeta={(meta) => updateCameraPageMeta(network.id, meta)} renderItem={(camera) => (
                          <div aria-label={`${camera.name}, IP ${camera.ip}, ${statusLabel(camera.status)}`} className={`networkCameraTile ${camera.status} ${draggedCamera.networkId === network.id && draggedCamera.ip === camera.ip ? "dragging" : ""} ${cameraInsert.networkId === network.id && cameraInsert.ip === camera.ip ? `dragOver insert-${cameraInsert.position}` : ""}`} draggable="false" key={`${network.id}-${camera.ip}`} title={`${camera.name} · ${camera.ip}`}>
                             <StatusSymbol status={camera.status} /><RollingName className="cameraIp mono" name={camera.ip} />{typeof camera.availability === "number" ? <small className="tileAvailability" title="Rolling 7-day availability">{formatAvailability(camera.availability)}</small> : null}
                          </div>
                        )} />
                      </article>
                    );
                  }}
                  />
                </div>
                {isFullDashboard ? <ResizeHandle axis="x" label="Resize network and insight panels" onKeyDown={(event) => handleResizeKey("network", "x", event)} onPointerDown={(event) => startPanelResize("network", event)} /> : null}
                {isFullDashboard ? <div
                  className="networkInsights"
                  ref={networkInsightsRef}
                  style={{ "--attention-size": `${panelSizes.attention}fr`, "--notes-size": `${1 - panelSizes.attention}fr` }}
                >
                  <NeedAttention aiboxes={aiboxes} networks={cameraNetworks} onFocusNetwork={focusDashboard} onShowOffline={() => { setActiveView("fleet"); setStatusFilter("offline"); }} />
                  <ResizeHandle axis="y" label="Resize attention and recent notes panels" onKeyDown={(event) => handleResizeKey("attention", "y", event)} onPointerDown={(event) => startPanelResize("attention", event)} />
                  <DashboardRecentNotes notes={recentNotes} lookup={targetLookup} now={now} onOpen={openNoteTargetByKey} />
                </div> : null}
              </div>
            </section> : null}
            </div>
          </div>
        ) : (
          <div className={`container-xxl fleetDetailView ${desktopFleet ? "desktopFleet" : "flowFleet"}`}>
            <section className="hero controlDeck fleetCommandBand">
              <div className="heroCopy">
                <p className="eyebrow">Fleet operations</p>
                <h1>Control room</h1>
                <p className="subtitle">Inspect outages, camera health, and operator handoffs without leaving the workspace.</p>
              </div>
              {desktopFleet ? (
                <div className="fleetViewSwitch" aria-label="Fleet workspaces">
                  <button aria-pressed={fleetSection === "aiboxes"} className={fleetSection === "aiboxes" ? "active" : ""} onClick={() => setFleetSection("aiboxes")} type="button"><strong>{aiboxes.length}</strong><span>AIBOXes</span></button>
                  <button aria-pressed={fleetSection === "cameras"} className={fleetSection === "cameras" ? "active" : ""} onClick={() => setFleetSection("cameras")} type="button"><strong>{cameraCount}</strong><span>Cameras</span></button>
                  <button aria-pressed={fleetSection === "notes"} className={fleetSection === "notes" ? "active" : ""} onClick={() => setFleetSection("notes")} type="button"><strong>{recentNotes.length}</strong><span>Notes</span></button>
                </div>
              ) : null}
              <div className="heroControls">
                <button className="heroAction primary" onClick={() => { setManageMode((value) => !value); if (!manageMode) loadConfig(); }} type="button">{manageMode ? "Finish managing" : "Manage fleet"}</button>
                <button className="heroAction secondary" onClick={() => { setActiveView("dashboard"); focusDashboard("all"); }} type="button">Operations overview</button>
              </div>
            </section>

            <section className="summaryGrid" aria-label="Status summary">
              <Stat label="Offline" value={offline} tone="bad" active={statusFilter === "offline"} onClick={() => { setFleetSection("aiboxes"); setStatusFilter(statusFilter === "offline" ? "all" : "offline"); }} />
              <Stat label="Online" value={online} tone="good" active={statusFilter === "online"} onClick={() => { setFleetSection("aiboxes"); setStatusFilter(statusFilter === "online" ? "all" : "online"); }} />
              <Stat label="Unknown" value={unknown} tone="muted" active={statusFilter === "unknown"} onClick={() => { setFleetSection("aiboxes"); setStatusFilter(statusFilter === "unknown" ? "all" : "unknown"); }} />
              <Stat label="Total AIBOXes" value={aiboxes.length} active={statusFilter === "all"} onClick={() => { setFleetSection("aiboxes"); setStatusFilter("all"); }} />
              <Stat label="Networks" value={networks || cameraNetworks.length} />
              <Stat label="Cameras" value={cameraCount} />
            </section>

            <div className="fleetWorkspace">
              {(!desktopFleet || fleetSection === "aiboxes") ? (
                <section className="fleetWorkspacePanel panel card border-0" id="fleet-section">
                  <div className="card-body">
                    <div className="sectionHeader fleetSectionHeader">
                      <div>
                        <h2 className="mb-0">AIBOX fleet</h2>
                        <p className="sectionMeta mb-0">{filteredAiboxes.length} of {aiboxes.length} configured{canDragAiboxes ? " · Drag to reorder" : " · Current connectivity and availability"}</p>
                      </div>
                      <div className="fleetTools">
                        {manageMode ? <button className="btn btn-primary" onClick={() => openConfig("aiboxes")} type="button">Add/edit AIBOX</button> : null}
                        <input aria-label="Search AIBOXes" className="form-control searchInput" onChange={(event) => setQuery(event.target.value)} placeholder="Search name, IP, network" type="search" value={query} />
                      </div>
                    </div>
                    <div className="fleetControlRow">
                      <div className="filterRow" role="group" aria-label="Status filters">
                        {STATUS_FILTERS.map((filter) => (
                          <button aria-pressed={statusFilter === filter} className={`filterChip ${statusFilter === filter ? "active" : ""}`} key={filter} onClick={() => setStatusFilter(filter)} type="button">{filter === "all" ? "All" : statusLabel(filter)}</button>
                        ))}
                      </div>
                      {desktopFleet ? <FleetPager label="AIBOX" page={safeFleetAiboxPage} pageCount={fleetAiboxPageCount} pageSize={fleetAiboxPageSize} total={fleetAiboxes.length} onPage={setFleetAiboxPage} /> : null}
                    </div>
                    {!loaded ? <div className="aiboxGrid fleetPagedGrid">{renderSkeletons()}</div> : fleetAiboxes.length ? (
                      <div className="aiboxGrid fleetPagedGrid">
                        {visibleFleetAiboxes.map((box) => {
                          const target = { key: noteKey("aibox", box.ip), fallbackKey: box.ip, title: box.name, subtitle: box.ip };
                          const noteList = getNotes(target);
                          return (
                            <div className={`aiboxShell ${draggedAiboxIp === box.ip ? "dragging" : ""} ${dragInsert.ip === box.ip ? `dragOver insert-${dragInsert.position}` : ""}`} draggable={canDragAiboxes} key={box.ip} onDragEnd={handleAiboxDragEnd} onDragOver={(event) => handleAiboxDragOver(event, box.ip, "y")} onDragStart={(event) => handleAiboxDragStart(event, box.ip)} onDrop={(event) => handleAiboxDrop(event, box.ip)}>
                              <article className={`aiboxPill ${box.status}`}>
                                <div className="aiboxPillTop">
                                  {canDragAiboxes ? <span className="dragHandle" title="Drag to reorder" aria-hidden="true">⋮⋮</span> : null}
                                  <StatusSymbol status={box.status} />
                                  <div className="aiboxTitleBlock"><strong>{box.name}</strong><span className="mono">{box.ip}</span></div>
                                  {renderStatusPill(box)}
                                </div>
                                <div className="aiboxMeta"><span>{box.networks.length ? box.networks.join(", ") : "No network"}</span><span className="availabilityBadge">Availability {formatAvailability(box.availability)}</span>{noteList.length ? <span className="noteBadge insidePill">{noteList.length} notes</span> : null}{renderNoteControls(target, noteList)}</div>
                                <p title={box.monitors.length ? box.monitors.join(", ") : "No monitors configured"}>{box.monitors.length ? box.monitors.join(", ") : "No monitors configured"}</p>
                              </article>
                            </div>
                          );
                        })}
                      </div>
                    ) : <div className="emptyState">No AIBOX matches the current filter.</div>}
                  </div>
                </section>
              ) : null}

              {(!desktopFleet || fleetSection === "cameras") ? (
                <section className="fleetWorkspacePanel panel card border-0" id="fleet-camera-section">
                  <div className="card-body">
                    <div className="sectionHeader fleetSectionHeader">
                      <div><h2 className="mb-0">Cameras by network</h2><p className="sectionMeta mb-0">{cameraCount} cameras · Select a network to inspect current state</p></div>
                      {manageMode ? <button className="btn btn-primary" onClick={() => openConfig("cameras")} type="button">Add/edit cameras</button> : null}
                    </div>
                    {desktopFleet && orderedCameraNetworks.length ? (
                      <div className="fleetNetworkSelector" role="group" aria-label="Camera networks">
                        {orderedCameraNetworks.map((network) => {
                          const affected = network.cameras.filter((camera) => camera.status !== "online").length;
                          return <button aria-pressed={selectedFleetNetwork?.id === network.id} className={selectedFleetNetwork?.id === network.id ? "active" : ""} key={network.id} onClick={() => setFleetNetworkId(network.id)} type="button"><strong>{compactDeviceName(network.name)}</strong><span>{affected ? `${affected} affected` : "All reporting"}</span><b>{network.cameras.length}</b></button>;
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
                          const camerasToRender = desktopFleet ? visibleFleetCameras : network.cameras;
                          return (
                            <article className={`networkCard ${hasProblem ? "hasProblem" : ""}`} key={network.id}>
                              <div className="networkHead">
                                <div className="min-w-0"><div className="networkTitleLine"><h3>{network.name}</h3>{noteList.length ? <span className="noteBadge insideNetwork">{noteList.length} notes</span> : null}</div><p className="mono">{network.id}</p></div>
                                <div className="cameraSummary" aria-label="Camera status summary"><span className="miniStatus good">{cameraSummary.online || 0} on</span><span className="miniStatus bad">{cameraSummary.offline || 0} off</span><span className="miniStatus muted">{cameraSummary.unknown || 0} unk</span><span className="miniStatus total">{network.cameras.length} total</span></div>
                              </div>
                              <div className="networkMeta"><span title={network.monitors.length ? network.monitors.join(", ") : "-"}>Monitored by: {network.monitors.length ? network.monitors.join(", ") : "-"}</span>{desktopFleet ? <div className="networkMetaActions"><FleetPager label="camera" page={safeFleetCameraPage} pageCount={fleetCameraPageCount} pageSize={fleetCameraPageSize} total={network.cameras.length} onPage={setFleetCameraPage} />{renderNoteControls(target, noteList)}</div> : renderNoteControls(target, noteList)}</div>
                              <div className="cameraGrid fleetCameraPagedGrid" style={{ "--fleet-camera-rows": lowHeightFleet ? 2 : 4 }}>
                                {camerasToRender.map((camera) => (
                                  <div aria-label={`${camera.name}, IP ${camera.ip}, ${statusLabel(camera.status)}, availability ${formatAvailability(camera.availability)}`} className={`cameraCard ${camera.status} ${draggedCamera.networkId === network.id && draggedCamera.ip === camera.ip ? "dragging" : ""} ${cameraInsert.networkId === network.id && cameraInsert.ip === camera.ip ? `dragOver insert-${cameraInsert.position}` : ""}`} draggable={manageMode && loaded} key={`${network.id}-${camera.ip}`} onDragEnd={handleCameraDragEnd} onDragOver={(event) => handleCameraDragOver(event, network.id, camera.ip, "x")} onDragStart={(event) => handleCameraDragStart(event, network.id, camera.ip)} onDrop={(event) => handleCameraDrop(event, network.id, camera.ip)} title={`${camera.name} · ${camera.ip} · ${formatAvailability(camera.availability)}`}>
                                    <div className="cameraTop"><strong>{camera.name}</strong>{renderStatusPill(camera)}</div>
                                    <div className="cameraMeta"><span className="mono">{camera.ip}</span><span className="availabilityBadge cameraAvailability">{formatAvailability(camera.availability)}</span></div>
                                  </div>
                                ))}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : <div className="emptyState">No camera networks configured.</div>}
                  </div>
                </section>
              ) : null}

              {(!desktopFleet || fleetSection === "notes") ? (
                <section className="fleetWorkspacePanel recentPanel panel card border-0">
                  <div className="card-body">
                    <div className="sectionHeader"><div><h2 className="mb-0">Recent notes</h2><p className="sectionMeta mb-0">Newest operator comments across fleet and networks</p></div><span className="networkCount">{recentNotes.length} shown</span></div>
                    {recentNotes.length ? <div className="recentNoteGrid">{recentNotes.map((note) => <button className="recentNote" key={`${note.key}-${note.id}`} onClick={() => openNoteTargetByKey(note.key)} type="button"><span>{noteTargetLabel(note.key, targetLookup)}</span><strong>{note.content}</strong><small>{note.creator} · {formatGeneratedAt(note.createdAt)}</small></button>)}</div> : <div className="emptyState compact">No shared notes yet.</div>}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        )}
      </div>
      {renderNoteDrawer()}
      {renderConfigDrawer()}
      <button className={`backToTop ${showTopButton ? "visible" : ""}`} onClick={scrollToTop} type="button" aria-label="Back to start of page">↑ Top</button>
    </main>
  );
}

function Stat({ label, value, tone = "normal", active = false, onClick }) {
  const content = (
    <>
      <div>{label}</div>
      <strong>{value}</strong>
    </>
  );
  if (!onClick) return <article className={`stat ${tone} h-100`}>{content}</article>;
  return (
    <button aria-pressed={active} className={`stat statButton ${tone} ${active ? "active" : ""}`} onClick={onClick} type="button">
      {content}
    </button>
  );
}

createRoot(document.getElementById("root")).render(<App />);
