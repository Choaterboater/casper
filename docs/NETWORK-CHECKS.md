# Network checks

Casper can run ready-made checks on Ansible playbooks and device configs. They
run on your machine and cost no model tokens. Casper builds each command's
argument list itself and never runs it through a shell, so a file name can never
become a command.

The banner and `/status` list them: the ones that run after each change, the lab
checks you start yourself, and the ones Casper found but you have not saved:

```
checks    test, aruba-syntax — run after each change · lab: junos-commit, aoscx-check (device checks: Casper asks before each one) · found, not saved: junos-render (/verify add <name> saves one)
```

Run one with `/verify <name>`. The AI can run the ordinary ones and reports with
`casper_check`, and can ask for a lab check: Casper then asks you in a numbered box first.

## Named checks

Add them under `verify.checks` in `.casper/project.yaml`. Names are 1-32 lowercase
letters, digits or dashes, and cannot be `typecheck`, `lint`, `test` or `build`. You can
have up to 16.

`verify.checks` says what a check is. The older `verification.checks` list picks
which checks run.

```yaml
verify:
  checks:
    aruba-syntax:            # AOS-CX playbooks (aoscx-ansible)
      preset: ansible-syntax
      playbooks: [site.yml]
    junos-render:            # Junos playbooks (junos-ansible)
      preset: ansible-render
      playbooks: [checks/render.yml]
    junoser:
      preset: junoser
      files: [configs/]
    aoscx-yang:
      preset: yanglint
      models: [yang/10.17]
      modules: [yang/10.17/openconfig-vlan.yang]
      files: [data/vlans.json]
    aoscx-diff:              # a report, not a pass/fail check
      preset: hier-config
      platform: aoscx
      running: configs/sw1-running.cfg
      intended: configs/sw1-intended.cfg
    junos-commit:            # lab only, you start it
      preset: junos-commit
      inventory: lab.yml
      files: [changes/ntp.set]
    aoscx-check:             # lab only, you start it
      preset: ansible-check
      inventory: lab.yml
      playbooks: [site.yml]
```

| Preset | What runs | What it tells you |
|---|---|---|
| `ansible-syntax` | `ansible-playbook --syntax-check -i localhost, <playbook>` | Ansible can read the playbook. Ansible's docs say a syntax check does not run tasks. |
| `ansible-render` | `ansible-playbook -i localhost, <playbook>` | The Junos modules turn your data into config (`state: rendered`). Casper runs it only when every device task has `state: rendered` and every play targets localhost. |
| `junoser` | `junoser -c <file>` | Junoser can read the Junos config. Its grammar can lag new Junos releases, so "could not read" may mean newer syntax. |
| `yanglint` | `yanglint -t config -p <models> <modules> <data>` | The data fits the YANG models. For AOS-CX the models for each release come from github.com/aruba/aoscx-yang (Apache-2.0). |
| `hier-config` | A small Casper script that uses hier_config 3 from your project's Python | How many lines would change and how many would undo it. This is a report. It never passes or fails a task and never counts toward Verified. hier_config marks its Junos support as experimental. |
| `junos-commit` | Juniper's `juniper.device.config` module with `check: true` and `commit: false` | Your routers accept the change (commit check). Juniper's module does not commit. |
| `ansible-check` | `ansible-playbook --check --diff -i <inventory> <playbook>` | What the playbook would change on your switches. Labelled "dry run not guaranteed": some modules can still change devices in check mode. Its pass is shown, but on its own it never counts as Checks passed or Verified. |

Casper finds Ansible projects by itself: `ansible.cfg`, `galaxy.yml`,
`collections/requirements.yml`, or playbooks (YAML lists of plays with `hosts:`). It
finds `aruba-syntax`, `junos-syntax` and `junos-render` from the collections the
playbooks use. Your own `verify.checks` entries win.

Casper never adds a found check by itself, because each one runs Ansible on your
project. It lists them as "found, not saved". To save one:

- type `/verify add aruba-syntax`, or
- pick "Save aruba-syntax" on the row under a receipt, shown after a task that changed YAML.

Either one writes the setting into `.casper/project.yaml` and prints the exact line,
for example `verify.checks.aruba-syntax: { preset: ansible-syntax, playbooks: [ site.yml ] }`.
`/verify aruba-syntax` before that says the check is not saved and runs nothing.

### Not run

A missing tool, a missing Ansible collection, Windows or a vault password makes a
check read "not run". Casper never hands that to the model as a failure to fix.

```
– junoser  not run: junoser is not installed (gem install junoser)
– aruba-syntax  not run: the Ansible collection arubanetworks.aoscx is not installed (ansible-galaxy collection install arubanetworks.aoscx)
– aruba-syntax  not run: Ansible does not run on Windows; use WSL
```

### How Ansible is run

- Casper writes its own `ansible.cfg` for each run and points `ANSIBLE_CONFIG` at it.
  Your project's `ansible.cfg` is not read, so its vault password script, plugin
  folders and dynamic inventory are not used.
- Only the static inventory plugins (`host_list`, `yaml`, `ini`) are enabled.
- `-i` is always given: `localhost,` for syntax and render checks, your lab inventory for lab checks.
- The environment has `PATH` and little else: no provider keys and no `ANSIBLE_*`
  variables from your shell. Casper never runs vault password scripts. A playbook that
  needs a vault password reads "not run".
- Collections that sit next to a playbook (a `collections/` folder) still load. That is
  built into Ansible.
- All output is scrubbed of passwords and keys before you or the model see it.

The syntax, render, Junoser, yanglint and hier_config checks run in the shell sandbox. On
Linux it gives them no network at all and no writes outside the project, temp and package caches; on macOS
they reach only listed hosts. Where no sandbox runs (Windows, bubblewrap missing,
`--no-sandbox`) Casper does not claim they stay off the network: they do what each tool's
docs say. Lab checks run outside the sandbox, because they log in to your devices with your
own SSH keys; see [SECURITY.md](SECURITY.md).

## Risky config lines in the receipt

On by default. After a task changes config files (anything under a `configs/` or
`oxidized/` folder; `.cfg`, `.conf` and Junos `.set` files; and `.txt` backups and `.j2`,
`.jinja` templates under `config/`, `configs/`, `backups/`, `oxidized/` or `templates/`), the receipt lists each dangerous line the task
added and what it does; lines that were already there, and comment lines, are not listed.
It is for reading: never a pass or a fail.

```
risky   configs/sw1.cfg:6 reload (reboots the switch) · r1.set:2 set interfaces ge-0/0/0 disable (disables the interface)
```

Dangerous means it can cause an outage or lose data: reload/reboot, shutdown (not
`no shutdown`), erase/zeroize/format, factory resets, deleting files from flash, Junos
`load override`, `delete interfaces|vlans`, `set interfaces X disable`, rollbacks, software
installs and `clear …`. Descriptions, names, banners and quoted text are never read as
commands. Saving (`write memory`, `commit`) is not dangerous. At most 20 lines are listed
("and N more" after that), with secrets hidden. The checker is the same one GreenCLI uses (`src/network/risky-lines.ts`,
copied from GreenCLI; `bun scripts/sync-risky-lines.ts` re-copies it).

## Your lab

Lab checks (device checks) reach real devices. They can reach **any** device; nothing
reaches one without your answer:

1. **Casper asks first.** When the work needs a device check, the AI asks for it (or you
   type `/verify <name>`), and Casper shows a numbered box naming every device. You answer
   with a digit and Enter, typed after the box appeared (keys typed before it never answer
   it). The AI can't answer the box, auto mode never asks for one, a device check is never
   rerun on its own (not after a repair, not at the end of a task), and a failed one is never
   repaired without your answer. The one exception is yours: "Always for this project" on
   `junos-commit` lets *your own* `/verify` run it without the box, and only while the
   inventory, its host variables and the change file are exactly as they were; a check the
   AI asks for always shows the box. A run that cannot ask (`casper -p`, `--json`, a pipe)
   sends nothing and says so:

   ```
   – aoscx-check · not run: lab checks need your answer at the terminal, and this run cannot ask; nothing was sent
   ```
2. **The `lab` list only labels devices.** Devices not on it are named in the box
   (`Not marked lab: core-sw1 (10.1.2.3).`) so a production box can't slip in unseen. The
   list is optional, in `~/.casper/config.yaml` (or a profile):

   ```yaml
   lab:
     hosts:
       - 10.99.0.0/24
       - fd00:99::/64
       - lab-r1
   ```

   `/lab import <file>` adds devices from a file without editing anything: GreenCLI's
   export of its `lab`-tagged hosts (`{"hosts": [...]}`), or one host per line. Casper
   lists the new ones and asks `1 No · 2 Add them`; `/lab` shows the list and the file it
   comes from. When your profile has its own lab list (it replaces yours), the hosts go there.

   Entries are exact hostnames, single IP addresses or IP ranges. Casper does no DNS
   lookups and never guesses from a name: `lab-sw9` is not marked lab just because it
   says "lab". A host with `ansible_host` is matched by that address. A project file
   cannot set `lab`:

   ```
   lab is your setting, not the project's: move it from .casper/project.yaml to ~/.casper/config.yaml
   ```
3. **The inventory must be a plain YAML or INI file inside the project**, not a program
   or a link out of the project. That one is still refused.
4. **Ways a run can reach devices not listed in the box are warnings.** For
   `ansible-check`, Casper scans the playbook and every file it pulls in (task files,
   `vars_files`, roles in `roles/`, `group_vars`, `host_vars`) for `delegate_to`,
   `add_host`, `local_action`, `import_playbook`, `ansible_host`, SSH proxy settings,
   `provider:` or `host:` task settings, URLs, command modules, `pipe`/`url` lookups, and
   roles it cannot read, plus `check_mode: false` (that task really runs, even under
   `--check`) and plugin folders next to the playbook (`library/`, `filter_plugins/` …: local
   code). A jump host or proxy in the inventory's host variables is a warning too. The box
   lists up to five, then "+N more", and then there is no "Always":

   ```
   site.yml uses delegate_to (line 42), so it can reach devices not listed here.
   Host r1 sets ansible_ssh_common_args, so the connection can go through another machine.
   ```

The boxes:

```
Run junos-commit on 2 devices? It loads the change, runs commit check, then rolls back. lab-r1, core-r1
Not marked lab: core-r1 (10.1.2.3).
1 Skip · 2 Run it · 3 Always for this project

Run aoscx-check on 3 devices? It uses ansible --check, and a dry run is not guaranteed: some modules can still change the switches. lab-sw1, lab-sw2, lab-sw3
1 Skip · 2 Run it
```

Skip is first, so Enter never reaches a device.

When a lab check fails, Casper asks before anything else happens. Stop is first, so
Enter never starts a repair:

```
junos-commit failed on the lab. Casper did not ask the model to fix it, because each try touches lab devices.
1 Stop · 2 Ask the model to fix it
```

If you pick 2 and the model changes the files, the lab check asks again before it
runs on the lab again.

"Always for this project" exists only for `junos-commit`. It applies only while the
inventory, its hosts and the change file stay the same. `ansible-check` always asks.

What this does not cover: Casper checks the inventory and the playbook text. It
cannot block other network traffic yet. A playbook can still reach other machines in
ways a text check misses, and `ansible --check` can still change devices. Point lab
checks at gear you can rebuild.

## Where the pieces come from

These are all called as tools or imported, never copied into Casper:

- ansible-core (GPL-3.0): `ansible-playbook`, `ansible-inventory`.
- arubanetworks.aoscx (Apache-2.0), junipernetworks.junos (GPL-3.0) and juniper.device (Apache-2.0) Ansible collections.
- hier_config 3 (MIT, netdevops).
- Junoser (MIT, Shintaro Kojima).
- libyang `yanglint` (BSD-3-Clause) and aruba/aoscx-yang (Apache-2.0).
- IP range matching uses `node:net` BlockList, built into Bun.
