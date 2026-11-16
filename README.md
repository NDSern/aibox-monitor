# AIBOX Monitor

Python monitor service and React/Vite dashboard for the AIBOX fleet, in one repo.

## Layout

- `main.py`, `config.py`, `camera_probe.py`, `aibox_transport.py`, `shellfleet_transport/` — Python monitor (`aibox-monitor.service`).
- `src/`, `scripts/`, `index.html`, `vite.config.js` — dashboard (`aibox-monitor-webapp` user service).

## Python monitor

```sh
python3 -m pytest tests
python3 main.py
```

Reads `config.json` (ignored) and writes `aibox_monitor.log`.

## Dashboard

The app does not ping devices. It reads monitor config and latest monitor log lines, then writes `src/aibox-data.json`.

```sh
npm install
npm run sync:data
npm run dev
```

Build:

```sh
npm run sync:data
npm run build
```

Override monitor source path:

```sh
AIBOX_MONITOR_ROOT=/path/to/aibox-monitor npm run sync:data
```

## Connectivity history

Optional per-link LAN/USB telemetry from enrolled AIBOX devices, collected on
boxtest2 and proxied same-origin under `/api/connectivity/*`.
See [docs/connectivity-integration.md](docs/connectivity-integration.md).
