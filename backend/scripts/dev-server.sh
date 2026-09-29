#!/usr/bin/env bash
# Start/stop/restart the dev API without ever pattern-matching on the process
# command line: `pkill -f src/index.ts` matches the shell that runs it and takes
# the session down with it, so this script tracks a pidfile instead.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE=/tmp/nodewave-api.pid
LOGFILE=/tmp/nodewave-api.log

stop() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid=$(cat "$PIDFILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  echo "stopped"
}

start() {
  cd "$ROOT" || exit 1
  export PATH="$HOME/.bun/bin:$PATH"
  setsid nohup bun run src/index.ts > "$LOGFILE" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 40); do
    if curl -sf -m 2 http://localhost:3000/health > /dev/null 2>&1; then
      echo "started (pid $(cat "$PIDFILE"))"
      return 0
    fi
    sleep 0.5
  done
  echo "failed to start; log:"
  tail -20 "$LOGFILE"
  return 1
}

case "${1:-restart}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  log) tail -"${2:-40}" "$LOGFILE" ;;
  *) echo "usage: $0 {start|stop|restart|log [n]}"; exit 1 ;;
esac
