# 15. Agents do not launch agents or touch unrelated tmux servers

- **What:** model guidance and a native shell text guard refuse other coding-agent launches and tmux commands except private `tmux -L <name>` servers successfully started in this task. Builders have the same guard. A new task forgets ownership; an existing socket is not claimed.
- **Why:** other sessions on the same machine are not part of this task.
- **Off switch:** the person's explicit request to run the agent or use the other tmux server (not a builder's generated goal). Version-only agent queries are reads. Casper's own picture-generation integration is unchanged.
- **Guard rails:** this is a command-text guard, not isolation from opaque scripts. The refusal is a plain note, before shell approval or execution.
- **A finding:** a known direct/wrapped coding-agent invocation runs without the person's request, or an unowned tmux command passes the guard.
