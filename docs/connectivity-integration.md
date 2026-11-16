# Connectivity history integration

Independent per-link (LAN/USB) connectivity telemetry for AIBOX devices, shown as a
native **Connectivity** view in this dashboard.

## Architecture

```
AIBOX device (e.g. aibox8)
  aibox-connection-agent.service   # probes eth0/usb0 every 30 s, stores SQLite locally
        │  SSH  (dedicated key, batch mode)
        ▼
boxtest2 collector
  aibox-connection-collector.service  # pulls agent exports, stores collector SQLite
  FastAPI/uvicorn on 127.0.0.1:8787    # /api/fleet /api/history /api/export.csv
        │  loopback only
        ▼
boxtest2 dashboard
  scripts/server.js (Node, :5173)      # read-only same-origin proxy under /api/connectivity/*
  src/main.jsx ConnectivityView        # React view in the side rail
```

The browser never talks to the collector or to devices directly. It only calls the
dashboard origin; Node forwards fixed read-only GET requests to loopback `8787`.

## Paths on boxtest2

| Item | Path |
| --- | --- |
| Collector code | `/home/boxtest2/aibox-connection-log/aibox_connection/` |
| Collector config | `/home/boxtest2/aibox-connection-log/collector.json` |
| Collector database | `/home/boxtest2/.local/share/aibox-connection-log/collector.sqlite3` |
| Collector unit | `/etc/systemd/system/aibox-connection-collector.service` |
| Dashboard app | `/home/boxtest2/aibox-monitor-webapp` |
| Dashboard unit | `/home/boxtest2/.config/systemd/user/aibox-monitor-webapp.service` |
| Scoped backups | `/home/boxtest2/.aibox-integration-backup/<timestamp>/` |

## Enrolled machine mapping

The collector knows a fixed set of machines. `scripts/server.js` maps each collector
machine to the dashboard fleet entry:

```js
const connectivityMachineIds = {
  aibox8: { id: "td08", ip: "100.64.0.27" },
  "vtas-aibox3": { id: "oceanus", ip: "100.64.0.80" },
  "vta-aibox9": { id: "th05", ip: "100.64.0.81" },
  "vta-aibox10": { id: "th06", ip: "100.64.0.82" },
  "aibox-spare-3": { id: "th08", ip: "100.64.0.122" },
};
```

- `id` is the dashboard fleet ID (`td08`, label "Tàu TD-08").
- `ip` matches the fleet config entry, so the view can show the dashboard label.
- Devices with no collector entry are listed as **Not enrolled**, never as offline.
- `collector.json` enrollment is the authoritative list:

```json
{ "interval": 30, "database": ".../collector.sqlite3",
  "hosts": [
    { "machine": "aibox8", "ssh": "aibox8-collector" },
    { "machine": "vtas-aibox3", "ssh": "vtas-aibox3-collector" },
    { "machine": "vta-aibox9", "ssh": "vta-aibox9-collector" },
    { "machine": "vta-aibox10", "ssh": "vta-aibox10-collector" },
    { "machine": "aibox-spare-3", "ssh": "aibox-spare-3-collector" }
  ] }
```

### Enrolled agents

| Machine | SSH alias | Fleet ID | Fleet label | Device IP |
| --- | --- | --- | --- | --- |
| aibox8 | aibox8-collector | td08 | Tàu TD-08 | 100.64.0.27 |
| vtas-aibox3 | vtas-aibox3-collector | oceanus | Tàu Oceanus | 100.64.0.80 |
| vta-aibox9 | vta-aibox9-collector | th05 | Tàu TH-05 | 100.64.0.81 |
| vta-aibox10 | vta-aibox10-collector | th06 | Tàu TH-06 | 100.64.0.82 |
| aibox-spare-3 | aibox-spare-3-collector | th08 | TH08 | 100.64.0.122 |

All five run Ubuntu 22.04 + Python 3.10 with interfaces `eth0` (LAN) and `usb0` (USB).
Note: the four newer devices were provisioned from the same image and currently share
identical SSH host keys; the collector still pins them per IP in `known_hosts`.

## SSH host-key enrollment (per agent)

The collector authenticates with a dedicated key and strict host-key checking.

1. On boxtest2, create a dedicated key (once):
   `ssh-keygen -t ed25519 -f ~/.ssh/aibox_collector -N "" -C aibox-collector@boxtest2`
2. Verify the device host key fingerprint against a trusted source (an already
   trusted machine), do **not** blindly accept `ssh-keyscan` output.
3. Add the public key to the device's `~/.ssh/authorized_keys`.
4. Add an alias to `~/.ssh/config` (chmod 600):

```
Host aibox8-collector
  HostName 100.64.0.27
  User aibox8
  IdentityFile ~/.ssh/aibox_collector
  IdentitiesOnly yes
  ServerAliveInterval 20
```

5. Test before enrolling:
   `ssh aibox8-collector "/usr/local/bin/aibox-agent --export 0"`

## Resource limits (verified)

Collector unit: `Restart=always RestartSec=30`, `MemoryMax=256M`, `CPUQuota=25%`,
`TasksMax=64`, `NoNewPrivileges=true`, `ProtectSystem=strict`,
`ProtectHome=read-only`, `ReadWritePaths=.../aibox-connection-log`,
`PrivateTmp=true`, `User=boxtest2`.

Short soak (12×5 s with repeated fleet/history/UI requests): memory steady at ~40 MiB,
tasks 3–4, CPU well under quota. This is a short observation, not a long-term leak claim.

## Adding the next agent

1. Deploy the agent to the device and confirm `aibox-agent --export 0` returns JSON.
2. Enroll SSH as above (`Host <machine>-collector`).
3. Add `{ "machine": "<name>", "ssh": "<machine>-collector" }` to `collector.json`.
4. Add `"<name>": { "id": "<fleet-id>", "ip": "<fleet-ip>" }` to
   `connectivityMachineIds` in `scripts/server.js`, then rebuild the dashboard.
5. Restart both services and confirm the device shows under **Monitored devices**.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Connectivity banner "collection unavailable" | `systemctl status aibox-connection-collector`; `curl 127.0.0.1:8787/api/fleet` |
| Device shows "Not enrolled" | mapping in `scripts/server.js` and `collector.json` |
| Link stale flag | agent running on device; last probe older than 90 s |
| History empty | window/min-severity filters; collector DB growing |
| Proxy 502 | collector down or restarting; dashboard endpoints stay functional |

## Verification

```sh
# collector live
curl -s 127.0.0.1:8787/api/fleet
curl -s "127.0.0.1:8787/api/history?machine=aibox8&limit=5"

# dashboard proxy (same origin as the browser)
curl -s http://127.0.0.1:5173/api/connectivity/fleet
curl -s "http://127.0.0.1:5173/api/connectivity/history?machine=td08&link=LAN"
curl -sD - -o /dev/null "http://127.0.0.1:5173/api/connectivity/export.csv?machine=td08"
```

Expected parity: the collector tracks the device with at most one sampling interval
(30 s) of lag; the website sample timestamp equals the collector's latest record.

## History pagination

Probe history is paged: the browser requests 100 records per page via
`offset` and steps through them with the Newer/Older controls.

- `GET /api/history?machine=&limit=100&offset=0` — newest page first.
- `offset` is bounded `0..1000000`; `limit` stays `1..10000`.
- `kind` accepts a comma-separated list (e.g. `kind=incident,gap`) so the
  view can load incident/gap context for detail labels independently of the
  visible page.
- Severity filtering happens in SQL against a stored `severity` column, so
  `minimum_severity` no longer truncates results after the row limit.
- Records are ordered `ts DESC, seq DESC` for stable paging.

The collector stores `severity` per record (backfilled on first start after
upgrade). Rows already inserted without it are migrated automatically.

## Monitored-device reordering

The Connectivity view can reorder the Monitored devices list. Order is stored
per browser in `localStorage` under `aiboxConnectivityDeviceOrder` (array of
device IPs), so it never affects other users and needs no backend.

- **Reorder** toggles a mode with drag handles and Move up/Move down buttons
  (keyboard and mobile accessible); **Reset order** clears the preference.
- Order is resolved by device IP, so renaming a device keeps its position.
- Devices not in the saved list (newly enrolled) are appended in fleet order.
- Pure helpers live in `src/device-order.mjs`; covered by
  `scripts/test-device-order.mjs` (run via `npm test`).

## Rollback

Touched dashboard files are backed up under
`/home/boxtest2/.aibox-integration-backup/<timestamp>/`
(`server.js`, `test-server.js`, `main.jsx`, `styles.css`, `package.json`,
`index.html`). Restore the wanted files, then `npm run build` and
`systemctl --user restart aibox-monitor-webapp.service`. Disable the integration by
stopping `aibox-connection-collector.service`; existing dashboard views are unaffected.
