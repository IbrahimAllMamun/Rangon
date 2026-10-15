#!/bin/bash
# Starts Redis and the Rangon API when they are not running, on a Webuzo
# account (docs/operations/webuzo-deployment.md). Copied to ~/rangon-start.sh;
# cron runs it every 5 minutes and at reboot, so it must be safe to run again
# and again: a healthy Redis and a healthy API are left alone.
#
# The web app is not here: Webuzo's Application Manager starts and stops it.
NODE=${RANGON_NODE:-/usr/local/apps/nodejs22/bin/node}
REDIS=${RANGON_REDIS:-$HOME/redis-7.2.5/src}
LOGS=$HOME/rangon-logs
mkdir -p "$LOGS"

redis_pass=$(cat "$HOME/.redis-pass")
if ! "$REDIS/redis-cli" -p 6380 -a "$redis_pass" --no-auth-warning ping > /dev/null 2>&1; then
  echo "$(date -Is) starting redis" >> "$LOGS/start.log"
  # Nothing in Redis outlives a restart on purpose: rate-limit counters and
  # cached feed pages only. So no saving to disk.
  "$REDIS/redis-server" --bind 127.0.0.1 --port 6380 --requirepass "$redis_pass" \
    --daemonize yes --save '' --appendonly no --logfile "$LOGS/redis.log"
fi

port=$(sed -n 's/^PORT=//p' "$HOME/rangon-api.env")
if ! curl -sf -o /dev/null --max-time 10 "http://127.0.0.1:$port/api/health/"; then
  # A process that is there but not answering is stopped first.
  if [ -f "$LOGS/api.pid" ] && kill -0 "$(cat "$LOGS/api.pid")" 2> /dev/null; then
    kill "$(cat "$LOGS/api.pid")"
    sleep 5
  fi
  echo "$(date -Is) starting the API" >> "$LOGS/start.log"
  cd "$HOME/rangon/apps/api-nest" || exit 1
  set -a
  # shellcheck disable=SC1091
  . "$HOME/rangon-db.env"
  # shellcheck disable=SC1091
  . "$HOME/rangon-api.env"
  set +a
  # --no-deprecation: pg 8 warns on every start that its ~/.pgpass support
  # is deprecated, and it is how this deployment gives the API its password.
  nohup "$NODE" --no-deprecation dist/main.js >> "$LOGS/api.log" 2>&1 &
  echo $! > "$LOGS/api.pid"
fi
