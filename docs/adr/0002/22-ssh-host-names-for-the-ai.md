# 22. The AI reads the machines your ssh config names

Date: 2026-10-19. Status: accepted (owner's choice).

## Decision

`~/.ssh` stays private: a command or file tool that reads it is still refused. The refusal now also lists the
machines `~/.ssh/config` gives a name, as ssh reads them: `nas (admin@192.0.2.31)`, `router (192.0.2.1 port
2222)`, with a line to use `ssh <name>` and `scp <file> <name>:<path>`. A login that ssh refused, for a machine the
AI typed by its address, says which name the config gives it. A login that worked with a password typed in
Casper's box says it used that password, not a key.

Before, Casper read the config only to name the real address in the Reach question, and the AI never saw it. An AI
asked to reach a NAS set up as `Host nas` (its own user and key) then typed the address: ssh used no key and
the wrong user, the person was asked for a username and a password, and scp failed where ssh had used the password.
The AI then called the password login a key login. The owner chose to let the AI know the names instead.

## Guard rails

- Only the name, user, address and port, each resolved the way ssh resolves it (first value wins). Never a key, a key
  file's path, a proxy command or any other setting; patterns (`*`, `?`, `!`) and `Match` blocks are left out.
- The config file itself, keys, `known_hosts` and everything else in `~/.ssh` stay out of the AI's reach.
- At most 12 names are listed; a write to `~/.ssh` gets no names.
- Reaching a machine still asks first (`Reach …?`), with or without a name.
