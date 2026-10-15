# 14. Casper installs its own updates quietly by default

- **What:** interactive sessions check daily, plus one extra probe about three minutes in, and attempt a
  background install at most once a day across sessions. The success-colour notice above the prompt says
  `✔ Update installed · restart to use it`. No model or tokens.
- **Why:** a downloaded tool should keep itself current without a forgotten manual command.
- **Same as:** Claude Code's native installer checks on startup and periodically, installing in the background
  for the next start ([setup](https://code.claude.com/docs/en/setup#auto-updates)).
- **Off switch:** **Updates: notify only** checks but never installs; **off** disables checks and notices too.
  User config `updates: auto | notify | off`; old true/false map to auto/off. `CASPER_NO_UPDATE_CHECK=1` and `CI`
  disable it. Project files and project-selected profiles cannot set it.
- **Guard rails:** exactly the manual `runUpdate` verification path, including signatures, SHA-256 and build
  provenance; idle interactive sessions only, never during checks or in one-shot/JSON runs. Submitted commands
  wait for an install already running. No restart or reload. A checkout only fast-forwards clean default-branch
  work tracking origin, with no local commits or untracked files, then frozen installs only if its lockfile changed.
  No stash, rebase or branch switch. Windows waits for exit through the checked WMI handoff; a private lock
  excludes other sessions. Failures stay out of the transcript, go to update.log, and leave a retry notice.
- **A finding:** a weaker verification path, an install overlapping task checks, a dirty/non-default/ahead checkout
  being changed, a project controlling the setting, or an automatic restart/reload.
