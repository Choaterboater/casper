# 56. An ssh that only looks is no change; BatchMode and sudo -n keep Casper's terminal

Date: 2026-11-02. Status: proposed. Amends 48 (sudo box and terminal hand-over) and the remote-change rows of the
terminal (docs/TERMINAL_UX.md).

## Decision

- **Never asks, never handed over.** A plain ssh whose remote command uses sudo is still handed the terminal with `-t`
  (decision 48), except when nothing there can ask: `sudo -n` or `sudo --non-interactive`, and any ssh with
  `-o BatchMode=yes`. Those run as usual and the AI reads all their output.
- **The same read check over there.** Each command sent over ssh (split at `;`, `&&`, `||` and line ends) goes
  through the read check Casper uses for commands here, without the file checks (the files are on that machine),
  plus a short list of programs that only look at a server (`docker ps`, `systemctl is-active`, `ip a`, `ss`,
  `journalctl`, `getent`, Windows' `ver`) and `sudo -n` before any of them. Display only, never a permission.
- **Looks are one neutral line.** An ssh whose commands all only looked is `✓ Ran on nas: uname, docker --version, ls
  (looked only)`, with no ◆ row; the receipt's Devices row says `looked only`, and such a machine alone doesn't keep a
  card. Anything else gets the ◆ row with only the commands that may change things, counted: `sent 3 config lines` for
  a network device, `ran 2 commands that may change things` for a server.
- **Wrappers are seen through.** `perl -e 'alarm N; exec @ARGV' …` (macOS has no timeout), `timeout`, `gtimeout`,
  `env`, `nohup` and `sh -c "…"` name the command inside, on the step line, in the ◆ row and on the receipt. The host
  question sees the ssh inside them too, so it asks.

## Guard rail

A command the check can't read (a substitution, a write, an unknown program or option) is never a look: it keeps
the ◆ row, and the receipt keeps "Casper can't tell". A sudo that may ask still gets the terminal.

**Why:** the owner's NAS session. `ssh -o BatchMode=yes nas '… sudo -n docker --version'` lent the terminal and the
AI lost the output ("The top of that output scrolled off; re-running"), and `uname -m; id; ls` showed as
"◆ Changed on 192.0.2.31 (nas): sent 3 config lines" above eight lines, for his Windows PC too.
