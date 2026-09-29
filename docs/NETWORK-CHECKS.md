# Network checks

Casper can run ready-made checks on Ansible playbooks and device configs. They
run on your machine and cost no model tokens. Casper builds each command's
argument list itself and never runs it through a shell, so a file name can never
become a command.

The banner and `/status` list them: the ones that run after each change, the lab
checks you start yourself, and the ones Casper found but you have not saved:

```
checks    test, aruba-syntax — run after each change · lab: junos-commit, aoscx-check (you start these: /verify <name>) · found, not saved: junos-render (/verify add <name> saves one)
```

Run one with `/verify <name>`. The AI can run the ordinary ones and reports with
`casper_check`, never a lab check.

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
| `junos-commit` | Juniper's `juniper.device.config` module with `check: true` and `commit: false` | Your lab routers accept the change (commit check). Juniper's module does not commit. |
| `ansible-check` | `ansible-playbook --check --diff -i <inventory> <playbook>` | What the playbook would change on your lab switches. Labelled "dry run not guaranteed": some modules can still change devices in check mode. |

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

Casper does not claim these checks stay off the network. They do what each tool's
docs say. Casper cannot block their network traffic until the shell sandbox ships.

## Your lab

Lab checks reach real devices. They run only when all of these are true:

1. You started them with `/verify <name>` and picked 1 in the numbered ask. The
   model can never start one, auto mode never runs one, and a failed lab check is
   never repaired on its own. A run that cannot ask (`casper -p`, `--json`, a pipe)
   sends nothing and says so:

   ```
   – aoscx-check · not run: lab checks need your answer at the terminal, and this run cannot ask; nothing was sent
   ```
2. You declared your lab in `~/.casper/config.yaml` (or a profile):

   ```yaml
   lab:
     hosts:
       - 10.99.0.0/24
       - fd00:99::/64
       - lab-r1
   ```

   Entries are exact hostnames, single IP addresses or IP ranges. Casper does no DNS
   lookups and never guesses from a name: `lab-sw9` is not in the lab just because it
   says "lab". A project file cannot set `lab`:

   ```
   lab is your setting, not the project's: move it from .casper/project.yaml to ~/.casper/config.yaml
   ```
3. Every host in the check's inventory is on that list. A host with `ansible_host` is
   checked by that address. The inventory must be a plain YAML or INI file inside the
   project, not a program.
4. For `ansible-check`, the playbook and every file it pulls in (task files,
   `vars_files`, roles in `roles/`, `group_vars`, `host_vars`) name no other targets:
   no `delegate_to`, `add_host`, `local_action`, `import_playbook`, `ansible_host`,
   SSH proxy settings, `provider:` or `host:` task settings, URLs, command modules or
   `pipe`/`url` lookups. A role Casper cannot read (for example one from a collection) is
   refused as well.

```
Refused: junos-commit would reach core-sw1 (10.1.2.3), which is not in your lab list (~/.casper/config.yaml lab.hosts). Nothing was sent.
Refused: site.yml uses delegate_to (line 42), so it can reach hosts outside the lab inventory. Nothing was sent.
```

The asks:

```
Run junos-commit on your lab? It loads the change on 2 lab routers, runs commit check, then rolls back. lab-r1, lab-r2
1 Run on the lab · 2 Always for this project · 3 Skip

Run aoscx-check on your lab? It uses ansible --check, and a dry run is not guaranteed: some modules can still change the switches. lab-sw1, lab-sw2, lab-sw3
1 Run on the lab · 2 Skip
```

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
