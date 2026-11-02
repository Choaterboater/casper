# 60. A line you send stops a command that only waits

Date: 2026-11-02. Status: accepted (merged 2026-11-02 in #576). Amends [26](26-a-line-ends-a-wait.md) (a line you send ends a step that only waits).

## Decision

Decision 26 moved a slow shell command to the background when a line reached the AI, but not one with its own time
limit, one on Casper's ssh login, or one with 4 already in the background: the line waited for them. The AI's polls
are mostly those. In a session watching a NAS restart, the AI ran `while …; do ssh nas '…'; sleep 15; done` and
`sleep 90` with their own limits (60 s, 400 s); three lines ("all dockers down?", "can you look at the logs") sat
under `it reads this when its current step ends`, and the person pressed Esc twice, stopping the task.

Now a shell command that only waits or polls is **stopped** when a line reaches the AI, whatever its time limit, on
Casper's ssh login too, and with no room in the background:

- what counts (`src/sandbox/waits.ts`): a `sleep`; a `while`/`until` loop, or a `for` loop with a sleep, whose every
  command only looks or checks (Casper's look list, `docker ps`/`logs`/`inspect`, `systemctl status`/`is-active`,
  `journalctl`, `curl` GET or HEAD, `nc -z`, `ping`, `ps`, tests and variables); `ssh host …` running such a line;
  `tail -f`; and `timeout`, `watch` or `perl -e 'alarm N; exec …'` around a read;
- the AI reads `[The person sent you a message, so Casper stopped this command after N s: it only waited or checked,
  and changed nothing. …]` after the output so far, and the step ends with exit code 0;
- the screen gets one grey line: `– Stopped the wait (sleep 15 loop) to read your message`.

Every other command keeps decision 26: it moves to the background when it can, or runs on and the line waits.

## Guard rails

- Only a command that may change nothing is stopped. Every part of the line, in each loop, `$(…)`, `bash -c` and ssh
  command, must be on the list; an output redirect other than `/dev/null`, a background `&`, a here-document, a
  backtick, `eval`, a program named by a variable, `PATH=` and the like, a curl with data, upload, output file or
  another method, `docker exec`, ssh with no command or with options beyond how to connect, and anything else make it
  a command that is not stopped.
- A plain read with no wait (`cat log`, `ssh nas 'docker ps'`) is not stopped: it moves to the background as before.
- Only a line that reaches the AI stops a wait, as in decision 26. A queued line stops none.
- MCP calls, helpers, checks, service starts and the browser's sign-in window keep decision 26's rules.

A finding: a command that wrote, restarted, posted or ran something unknown stopped by a line; a wait stopped with no
line; or a stopped wait the screen or the AI wasn't told about.
