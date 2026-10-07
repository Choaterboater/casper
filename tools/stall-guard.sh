#!/usr/bin/env bash
# Runs a command, streams its output to the screen and to a log, and cuts the run off if the log stops
# growing while the command is still alive (a stalled test suite), after writing a dump of what every
# process was doing. The exit code is the command's own; a stall exits 124.
#
#   tools/stall-guard.sh <log> <stall-seconds> <dump> -- <command> [args...]
#
# Environment (all optional):
#   STALL_POLL       seconds between checks of the log (default 5)
#   STALL_TEST_DIR   directory whose *.test.ts files are listed as printed / not printed (default tests)
#   STALL_GRACE      seconds between the polite kill and the forced kill (default 5)
set -uo pipefail

if [ "$#" -lt 5 ] || [ "$4" != "--" ]; then
  echo "usage: stall-guard.sh <log> <stall-seconds> <dump> -- <command> [args...]" >&2
  exit 2
fi
log=$1
stall=$2
dump=$3
shift 4
case "$stall" in '' | *[!0-9]*) echo "stall-guard: stall-seconds must be a whole number" >&2; exit 2 ;; esac
poll=${STALL_POLL:-5}
grace=${STALL_GRACE:-5}
test_dir=${STALL_TEST_DIR:-tests}

mkdir -p "$(dirname "$log")" "$(dirname "$dump")"
: >"$log"
pidfile=$(mktemp)
flag=$(mktemp)
rm -f "$flag"

# The command gets its own session, so one signal to its process group reaches every worker it started.
isolate=()
if command -v setsid >/dev/null 2>&1; then isolate=(setsid); fi

write_dump() {
  {
    echo "== Stall dump: no output for ${stall}s while the command was still running ($(date -u +%FT%TZ))"
    echo
    echo "== Processes (pid ppid etime stat wchan args)"
    ps -eo pid,ppid,etime,stat,wchan:20,args 2>/dev/null || ps -eo pid,ppid,etime,stat,args 2>&1
    echo
    echo "== Test workers"
    local pid
    for pid in $(pgrep -f 'bun test --test-worker' 2>/dev/null); do
      echo "-- worker $pid"
      ps -o pid,ppid,etime,stat,args -p "$pid" 2>&1 | tail -n +2
      echo "children:"
      ps -o pid,etime,stat,args --ppid "$pid" 2>/dev/null | tail -n +2 || true
      if [ -d "/proc/$pid" ]; then
        echo "wchan: $(cat "/proc/$pid/wchan" 2>&1)"
        echo "kernel stack:"
        cat "/proc/$pid/stack" 2>&1 | head -30
        echo "open files: $(ls "/proc/$pid/fd" 2>/dev/null | wc -l)"
      fi
    done
    echo
    echo "== Test files (from $test_dir)"
    local printed all
    printed=$(mktemp)
    all=$(mktemp)
    grep -oE "[A-Za-z0-9_./-]+\.test\.ts" "$log" | sed 's|^\./||' | sort -u >"$printed"
    (cd "$(dirname "$test_dir")" 2>/dev/null && ls "$(basename "$test_dir")"/*.test.ts 2>/dev/null) | sort -u >"$all"
    echo "printed: $(wc -l <"$printed" | tr -d ' ')   not printed: $(comm -13 "$printed" "$all" | wc -l | tr -d ' ')"
    echo "-- not printed (running, or never started):"
    comm -13 "$printed" "$all"
    echo "-- printed:"
    cat "$printed"
    rm -f "$printed" "$all"
    echo
    echo "== Last 40 lines of the log"
    tail -n 40 "$log"
  } >"$dump" 2>&1
}

# Every process below a pid, found before anything is signalled (a host without setsid has no group to signal).
descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    echo "$child"
    descendants "$child"
  done
}

stop_tree() {
  local sig=$1 root=$2 pid
  local all
  all="$(descendants "$root")"
  if [ -n "${isolate[*]:-}" ]; then kill "-$sig" -- "-$root" 2>/dev/null; fi
  for pid in $all "$root"; do kill "-$sig" "$pid" 2>/dev/null; done
}

(
  ${isolate[@]+"${isolate[@]}"} bash -c 'echo $$ >"$0"; exec "$@"' "$pidfile" "$@" 2>&1 | tee "$log"
  exit "${PIPESTATUS[0]}"
) &
runner=$!

(
  last_size=-1
  last_change=$SECONDS
  while kill -0 "$runner" 2>/dev/null; do
    sleep "$poll"
    size=$(wc -c <"$log" 2>/dev/null | tr -d ' ')
    if [ "$size" != "$last_size" ]; then
      last_size=$size
      last_change=$SECONDS
      continue
    fi
    if [ $((SECONDS - last_change)) -ge "$stall" ]; then
      pgid=$(cat "$pidfile" 2>/dev/null)
      [ -n "$pgid" ] || continue
      kill -0 "$pgid" 2>/dev/null || continue
      echo "stall-guard: no output for ${stall}s, writing $dump and stopping the run" >&2
      : >"$flag"
      write_dump
      stop_tree TERM "$pgid"
      sleep "$grace"
      stop_tree KILL "$pgid"
      exit 0
    fi
  done
) &
watcher=$!

wait "$runner"
code=$?
# The command is done; stop the watcher if it is still waiting for its next poll.
kill "$watcher" 2>/dev/null
wait "$watcher" 2>/dev/null
rm -f "$pidfile"
if [ -e "$flag" ]; then
  rm -f "$flag"
  echo "stall-guard: the run was cut off after ${stall}s without output; see $dump" >&2
  exit 124
fi
exit "$code"
