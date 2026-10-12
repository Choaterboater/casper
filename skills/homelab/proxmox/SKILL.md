---
name: homelab-proxmox
description: >-
  Proxmox VE and Proxmox Backup Server: cluster and storage checks, VMs and LXC containers, API tokens,
  snapshots before a change, backups with vzdump and PBS.
tags: [proxmox, pve, pbs]
casper-skill:
  platform: proxmox
  triggers:
    strong: ["proxmox", "proxmox ve", "proxmox backup server", "pvesh", "pvecm", "pvesm", "pveversion", "vzdump", "proxmoxer"]
    weak: ["pve", "pbs", "qm", "pct"]
    context: ["vm", "vms", "lxc", "vmid", "ctid", "hypervisor", "datastore", "home lab", "homelab", "self hosted", "selfhosted"]
  version: 1
---
# Proxmox VE and Backup Server

## When to use
Checking or changing a Proxmox VE host or cluster (VMs with `qm`, LXC containers with `pct`, storage,
backups) from its shell, over ssh, or through the API on port 8006, and Proxmox Backup Server (PBS).

## Read first
These ask for data. Run them before you change anything.
- `pveversion -v`: versions of every package.
- `pvecm status`: cluster members and quorum ("Quorate: Yes").
- `pvesh get /cluster/resources --output-format json`: every node, VM, container and storage, with
  status, CPU, memory and disk use in one call. `--type vm` or `--type storage` narrows it.
- `qm list`, `pct list`: guests on this node; `qm config <vmid>`, `pct config <ctid>`.
- `pvesm status`: each storage, active or not, and how full.
- `pvesh get /nodes/<node>/tasks --errors 1`: recent failed tasks (backups, migrations).
- `qm listsnapshot <vmid>`, `pct listsnapshot <ctid>`.
- ZFS and thin LVM: `zpool status -x`, `lvs` (the `Data%` and `Meta%` of the thin pool).
- API: `GET https://<pve_host>:8006/api2/json/cluster/resources` with header
  `Authorization: PVEAPIToken=$PVE_TOKEN_ID=$PVE_TOKEN_SECRET`. The token ID is `user@realm!name`,
  for example `automation@pve!casper`. Both parts come from the environment, never from code.

## Changing things (Casper asks)
MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.
Casper also asks before a shell command reaches a new host.
- Snapshot first, with a name that says why, and give the undo line with the change.

```bash
# WRITE
qm snapshot <vmid> before-<change> --description "before <change>"
# change, then check the guest; undo: qm rollback <vmid> before-<change>
pct snapshot <ctid> before-<change>
# undo: pct rollback <ctid> before-<change>
```

WRITE: `qm shutdown <vmid>` (clean, through the guest agent or ACPI); `qm stop <vmid>` pulls the plug.

WRITE: `qm start <vmid>`, `pct start <ctid>`, `pct shutdown <ctid>`, `qm reboot <vmid>`.

WRITE: `qm set <vmid> --memory 4096`, `pct set <ctid> --cores 2`: show `qm config` before and after.

WRITE: `vzdump <vmid> --storage <storage> --mode snapshot` makes a backup (and fills that storage).

WRITE: `qm delsnapshot`, `qm destroy`, `pct destroy`: never without the user naming the guest.

WRITE: API calls with `POST`, `PUT` or `DELETE` (for example `POST /nodes/<node>/qemu/<vmid>/status/start`).

WRITE: `apt update && apt full-upgrade`, one node at a time, guests moved first; never `apt upgrade`.

## Common traps
- Token rights: a token with privilege separation (the default) has its own permissions, so a new
  token sees empty lists until you give it a role on a path (`/`, `/vms/<vmid>`, `/storage/<storage>`).
  Ask for the smallest role the task needs (PVEAuditor for reports). Only Proxmox's own permission
  check decides what a token may do.
- `user@pam` is a Linux user on the node; `user@pve` exists only in Proxmox. The token ID needs both
  the realm and the `!name`.
- The web and API certificate is self-signed by default: give your client the cluster CA
  (`/etc/pve/pve-root-ca.pem`) instead of turning certificate checks off.
- Quorum: a two-node cluster loses quorum when one node is down, and `/etc/pve` stops taking
  changes. Add a QDevice; lowering the expected votes needs the user's OK, as it can split the cluster.
- Storage full: a full thin pool (`lvs` Data% near 100) or ZFS pool pauses or corrupts guests. Old
  snapshots and backups on `local` are the usual cause. Snapshots are not backups.
- Snapshots need storage that supports them (ZFS, LVM-thin, Ceph, qcow2); raw disks on a plain
  directory or thick LVM can't. A VM with a passed-through PCI device can't snapshot its RAM.
- Backups: scheduled backup jobs live in Datacenter > Backup (`/etc/pve/jobs.cfg`). To PBS, check the datastore
  with `proxmox-backup-manager datastore list` on the PBS host; prune and garbage collection decide what
  is kept. A backup you have not restored once is a guess: test a restore to a new VMID.
- `qm` and `pct` act on the node you are on; a guest on another node needs that node (or the API path
  `/nodes/<node>/…`).

## Public docs
- https://pve.proxmox.com/pve-docs/
- https://pve.proxmox.com/wiki/Proxmox_VE_API
- https://pve.proxmox.com/pve-docs/pveum-plain.html
- https://pve.proxmox.com/wiki/Backup_and_Restore
- https://pbs.proxmox.com/docs/
