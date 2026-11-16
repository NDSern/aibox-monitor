#!/usr/bin/env bash
set -euo pipefail

cd /home/boxtest2/aibox-monitor-webapp

while true; do
  /usr/bin/flock -w 120 /tmp/aibox-monitor-webapp-sync.lock /usr/bin/node scripts/sync-data.js || true
  sleep "${AIBOX_WEBAPP_REFRESH_SECONDS:-10}"
done &

exec /usr/bin/node scripts/server.js
