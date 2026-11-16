# AIBOX Monitor Webapp

React/Vite landing page for AIBOX status from `~/aibox-monitor`.

The app does not ping devices. It reads monitor config and latest monitor log lines, then writes `src/aibox-data.json`.

## Setup

```sh
npm install
npm run sync:data
npm run dev
```

## Build

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
