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
#   STALL_WORKERS    pgrep -f pattern for the test workers the dump looks into (default 'bun test --test-worker')
#   STALL_STACK_LIMIT  seconds one native stack capture may take before it is stopped (default 20)
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
workers=${STALL_WORKERS:-bun test --test-worker}
stack_limit=${STALL_STACK_LIMIT:-20}

mkdir -p "$(dirname "$log")" "$(dirname "$dump")"
: >"$log"
pidfile=$(mktemp)
flag=$(mktemp)
rm -f "$flag"

# The command gets its own session, so one signal to its process group reaches every worker it started.
isolate=()
if command -v setsid >/dev/null 2>&1; then isolate=(setsid); fi

# Runs a command with its output in a file, and stops it (politely, then by force) once it has taken
# <seconds>, so a stuck debugger cannot hold up the dump. Gives the command's exit code, or 124 if stopped.
bounded() {
  local limit=$1 out=$2 job ticks=0
  shift 2
  "$@" >"$out" 2>&1 &
  job=$!
  while kill -0 "$job" 2>/dev/null; do
    if [ "$ticks" -ge $((limit * 10)) ]; then
      kill -TERM "$job" 2>/dev/null
      sleep 1
      kill -KILL "$job" 2>/dev/null
      wait "$job" 2>/dev/null
      echo "(stopped after ${limit}s)" >>"$out"
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$job"
}

# Where a worker that is on the CPU is in its own code: macOS `sample` (built in), or gdb or eu-stack on
# Linux when the host has one. When the system will not let this user look into the process (Linux
# ptrace_scope, a hardened macOS binary), it tries once more through sudo if sudo needs no password.
# Whatever happens, it only writes what it saw; it never fails the dump.
native_stack() {
  local pid=$1 name="" out code
  out=$(mktemp)
  if [ "$(uname -s)" = Darwin ] && command -v sample >/dev/null 2>&1; then
    name=sample
    set -- sample "$pid" 3 -file "$out.sample"
  elif command -v gdb >/dev/null 2>&1; then
    name=gdb
    set -- gdb -batch -nx -p "$pid" -ex "thread apply all bt"
  elif command -v eu-stack >/dev/null 2>&1; then
    name=eu-stack
    set -- eu-stack -p "$pid"
  fi
  if [ -z "$name" ]; then
    echo "native stack: no native stack tool on this host (sample, gdb or eu-stack)"
    rm -f "$out"
    return 0
  fi
  echo "native stack ($name, stopped after ${stack_limit}s at most):"
  bounded "$stack_limit" "$out" "$@"
  code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 124 ] && sudo -n true >/dev/null 2>&1; then
    sed 's/^/  /' "$out"
    echo "  ($name failed as this user; trying again through sudo)"
    rm -f "$out.sample"
    bounded "$stack_limit" "$out" sudo -n "$@"
  fi
  sed 's/^/  /' "$out"
  if [ -s "$out.sample" ]; then sed 's/^/  /' "$out.sample"; fi
  rm -f "$out" "$out.sample" 2>/dev/null
  return 0
}

write_dump() {
  {
    echo "== Stall dump: no output for ${stall}s while the command was still running ($(date -u +%FT%TZ))"
    echo
    echo "== Processes (pid ppid etime stat wchan args)"
    ps -eo pid,ppid,etime,stat,wchan:20,args 2>/dev/null || ps -eo pid,ppid,etime,stat,args 2>&1
    echo
    echo "== Test workers"
    local pid state children
    for pid in $(pgrep -f "$workers" 2>/dev/null); do
      echo "-- worker $pid"
      ps -o pid,ppid,etime,stat,args -p "$pid" 2>&1 | tail -n +2
      # Children are picked from the full list by parent pid: the BSD ps on macOS has no --ppid.
      children=$(ps -eo pid,ppid,etime,stat,args 2>/dev/null | awk -v p="$pid" 'NR > 1 && $2 == p')
      echo "children (pid ppid etime stat args):"
      if [ -n "$children" ]; then echo "$children"; else echo "  none"; fi
      if [ -d "/proc/$pid" ]; then
        echo "wchan: $(cat "/proc/$pid/wchan" 2>&1)"
        echo "kernel stack:"
        cat "/proc/$pid/stack" 2>&1 | head -30
        echo "open files: $(ls "/proc/$pid/fd" 2>/dev/null | wc -l)"
      fi
      state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')
      case "$state" in
        R*) native_stack "$pid" ;;
        *) echo "native stack: not taken, the worker is not on the CPU (state ${state:-gone})" ;;
      esac
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
