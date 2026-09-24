# net-macfind

Answers "which switch port is this MAC address on?" from captured MAC address tables and LLDP
neighbor tables. All data is synthetic.

## Layout

- `src/tables.ts`: parsers for `show mac address-table` (IOS-XE), `show ethernet-switching table` (Junos)
  and `show mac-address-table` (AOS-CX), plus the matching LLDP neighbor tables. Done and tested.
- `src/inventory.ts`: loads a data directory: `inventory.json` lists
  `{ "device", "vendor", "mac": "<file>", "lldp": "<file>", "lags"?: { "<lag>": ["<member>", …] } }`,
  file names relative to the directory.
- `src/find.ts`: `findMac(devices, mac)`, the lookup.
- `src/mac.ts`: `normalizeMac` and `InvalidMacError`.

## Conventions

- MACs are compared in lowercase `aa:bb:cc:dd:ee:ff` form; input may be `aabb.ccdd.eeff`,
  `AA-BB-CC-DD-EE-FF` or `aa:bb:cc:dd:ee:ff` in any case.
- An **uplink** is a port whose LLDP neighbor's system name is another device in the inventory, or a LAG
  with such a member (LLDP runs on the physical member; MACs are learned on the LAG). Membership comes
  from the Junos LLDP "Parent Interface" column and the inventory's `lags`. A MAC
  learned on an uplink is only passing through; its real location is an edge port. A port whose LLDP
  neighbor is not in the inventory (an IP phone, an access point) is an edge port.
- CLIs export `main(argv, io)` and never call `process.exit`; HTTP handlers are
  `(request: Request) => Response | Promise<Response>` and return JSON errors `{ "error": "<code>" }`.
- Exit codes: 0 found, 1 not found, 64 usage error (including an invalid MAC).
- No runtime dependencies.
