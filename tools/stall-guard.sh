#!/usr/bin/env bash
# Runs a command, streams its output to the screen and to a log, and cuts the run off if the log stops
# growing while the command is still alive (a stalled test suite), after writing a dump of what every
# process was doing. The exit code is the command's own; a stall exits 124.
#
# After a stall, when Bun's log names the test files it was still running ("Interrupted while still
# running:", or a worker the stop ended) and nothing had failed, those files (and any that had not started)
# run once more on their own, under this guard with a shorter silence limit, and the exit code is that run's. One retry per job: a marker
# next to the dump stops a second one. Its log and dump sit next to the first ones, with -retry in the name.
#
#   tools/stall-guard.sh <log> <stall-seconds> <dump> -- <command> [args...]
#
# Environment (all optional):
#   STALL_POLL       seconds between checks of the log (default 5)
#   STALL_TEST_DIR   directory whose *.test.ts files are listed as printed / not printed (default tests)
#   STALL_GRACE      seconds between the polite kill and the forced kill (default 5)
#   STALL_WORKERS    pgrep -f pattern for the test workers the dump looks into (default 'bun test --test-worker')
#   STALL_STACK_LIMIT  seconds one native stack capture may take before it is stopped (default 20)
#   STALL_RETRY_STALL  silence limit for the retry (default 120, never more than <stall-seconds>)
#   STALL_RETRY_CMD    command the retry runs, with the files added at the end (default: bun test, with
#                      --parallel for more than one file)
#   STALL_NO_RETRY     1 never retries
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
      # How much of the log came before the stop: a worker crash in it was not caused by the stop.
      wc -c <"$log" | tr -d ' ' >"$flag"
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
if [ ! -e "$flag" ]; then exit "$code"; fi
before_stop=$(cat "$flag" 2>/dev/null)
case "$before_stop" in '' | *[!0-9]*) before_stop=0 ;; esac
rm -f "$flag"
echo "stall-guard: the run was cut off after ${stall}s without output; see $dump" >&2

# The files Bun lists after "Interrupted while still running:" and "file(s) had not started:", one per
# indented line (or on the header line itself), and a file whose worker the stop itself ended ("worker
# crashed: SIGTERM", when the workers get the signal before Bun does), colours stripped.
plain_log() { sed $'s/\x1b\\[[0-9;]*m//g' "$log"; }
interrupted_files() {
  plain_log | awk '
    /Interrupted while still running:/ || /file\(s\) had not started:/ {
      listing = 1
      rest = $0; sub(/^[^:]*:[ \t]*/, "", rest)
      if (rest ~ /\.test\.ts/) { split(rest, word, " "); print word[1] }
      next
    }
    listing && /^[ \t]+[^ \t]+\.test\.ts( \([0-9]+s\))?[ \t]*$/ { print $1; next }
    { listing = 0 }
    /\(worker crashed: SIG(TERM|KILL)\)/ {
      for (i = 1; i <= NF; i++) if ($i ~ /\.test\.ts$/) { print $i; break }
    }
  ' | sed 's|^\./||' | awk '!seen[$0]++'
}

if [ "${STALL_NO_RETRY:-0}" = 1 ]; then exit 124; fi
files=()
while IFS= read -r file; do if [ -n "$file" ]; then files+=("$file"); fi; done < <(interrupted_files)
if [ "${#files[@]}" -eq 0 ]; then exit 124; fi
# A failed test, an error outside a test (a file that would not load, a throw at its top level), or a worker
# that crashed on its own (any crash before the stop, or one after it that the stop's signals do not explain)
# makes the run red already.
failed_before() {
  plain_log | grep -qE '^\(fail\) |^# Unhandled error between tests' && return 0
  plain_log | grep 'worker crashed:' | grep -qvE 'worker crashed: SIG(TERM|KILL)\)' && return 0
  head -c "$before_stop" "$log" | sed $'s/\x1b\\[[0-9;]*m//g' | grep -q 'worker crashed:'
}
if failed_before; then
  echo "stall-guard: not retrying ${files[*]}: a test had already failed in this run" >&2
  exit 124
fi
marker="$(dirname "$dump")/.stall-guard-retried"
if [ -e "$marker" ]; then
  echo "stall-guard: not retrying ${files[*]}: this job already used its one retry" >&2
  exit 124
fi
: >"$marker"

retry_stall=${STALL_RETRY_STALL:-120}
if [ "$retry_stall" -gt "$stall" ]; then retry_stall=$stall; fi
if [ -n "${STALL_RETRY_CMD:-}" ]; then
  read -r -a again <<<"$STALL_RETRY_CMD"
elif [ "${#files[@]}" -eq 1 ]; then
  again=(bun test)
else
  again=(bun test --parallel)
fi
case "$log" in *.log) retry_log="${log%.log}-retry.log" ;; *) retry_log="$log-retry" ;; esac
case "$dump" in *.txt) retry_dump="${dump%.txt}-retry.txt" ;; *) retry_dump="$dump-retry" ;; esac
echo "stall-guard: retrying ${files[*]} once after a stall (silence limit ${retry_stall}s)" >&2
STALL_NO_RETRY=1 bash "${BASH_SOURCE[0]}" "$retry_log" "$retry_stall" "$retry_dump" -- "${again[@]}" "${files[@]}"
code=$?
if [ "$code" -eq 0 ]; then result=passed; else result="failed (exit $code)"; fi
echo "stall-guard: retried ${files[*]} once after a stall: $result; the stall's dump is $dump" >&2
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  echo "::warning title=stall-guard::retried ${files[*]} once after a stall: $result"
fi
exit "$code"
