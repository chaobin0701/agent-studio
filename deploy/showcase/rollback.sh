#!/usr/bin/env bash
set -euo pipefail

systemctl disable --now agent-studio-backup.timer 2>/dev/null || true
cd /opt/agent-studio
docker compose --profile worker stop edge hub worker api postgres

docker start hexu-support-postgres-1 >/dev/null
for attempt in {1..30}; do
  if [[ "$(docker inspect -f '{{.State.Health.Status}}' hexu-support-postgres-1)" == "healthy" ]]; then
    break
  fi
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' hexu-support-postgres-1)" == "healthy" ]]
docker start hexu-support-api-1 hexu-support-worker-1 >/dev/null
for attempt in {1..30}; do
  if [[ "$(docker inspect -f '{{.State.Health.Status}}' hexu-support-api-1)" == "healthy" ]]; then
    break
  fi
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' hexu-support-api-1)" == "healthy" ]]
docker start hexu-support-edge-1 >/dev/null
systemctl enable --now hexu-backup.timer
printf 'Old Hexu services restored. Verify both HTTPS domains before accepting traffic.\n'
