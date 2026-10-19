#!/usr/bin/env bash
set -euo pipefail
umask 077

cd /opt/agent-studio
exec 9>backups/.backup.lock
flock -n 9 || exit 0

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary="$(mktemp -d "backups/.partial.${stamp}.XXXXXX")"
trap 'rm -rf "$temporary"; rm -f data/hub/.backup.sqlite' EXIT

docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 6' > "$temporary/platform.dump"
if [[ -f data/hub/hub.sqlite ]]; then
  docker compose exec -T hub node -e 'const {DatabaseSync,backup}=require("node:sqlite"); const source=new DatabaseSync("/data/hub/hub.sqlite"); backup(source,"/data/hub/.backup.sqlite").then(()=>source.close()).catch(error => { source.close(); console.error(error); process.exitCode = 1; })'
  cp data/hub/.backup.sqlite "$temporary/hub.sqlite"
  rm -f data/hub/.backup.sqlite
fi
tar -C data/uploads -czf "$temporary/uploads.tar.gz" .
tar -C data/caddy -czf "$temporary/caddy.tar.gz" .
cp .env platform.env hub.env compose.yml "$temporary/"
( cd "$temporary" && sha256sum platform.dump uploads.tar.gz caddy.tar.gz .env platform.env hub.env compose.yml > manifest.sha256 )
if [[ -f "$temporary/hub.sqlite" ]]; then
  ( cd "$temporary" && sha256sum hub.sqlite >> manifest.sha256 )
fi
mv "$temporary" "backups/$stamp"
trap - EXIT
printf 'Agent Studio backup completed: %s\n' "$stamp"
