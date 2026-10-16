---
name: design-clearpass-nac
description: >-
  A method for designing or reviewing a ClearPass NAC deployment: intake questions, the design
  document's parts in order, decision tree and flow diagrams, cluster and certificates, rollout.
tags: [clearpass, cppm, nac, 802.1x]
casper-skill:
  platform: clearpass-nac
  triggers:
    strong: ["clearpass nac", "cppm nac", "clearpass cluster", "network access control"]
    weak: ["clearpass", "cppm", "nac"]
    unless: ["api", "python", "script", "pyclearpass", "sdk", "rest", "ise", "forescout", "portnox", "packetfence"]
  version: 1
---
# ClearPass NAC design

## When to use
Designing or reviewing a ClearPass Policy Manager (CPPM) NAC deployment: who connects, how, what
is checked, what they get, and where ClearPass runs. You know the product; this is the order of
work. For code that calls the ClearPass API, use network-clearpass-api instead.

## Intake questions
Ask once, short, with choices where you can. Write down what is unknown instead of guessing.
1. Client types: corporate laptops, non-domain or Linux laptops, phones and tablets, printers,
   VoIP, kiosks, IoT and headless devices, guests, contractors.
2. SSIDs and wired ports today, and the ones wanted after NAC.
3. Identity sources: AD/LDAP, Entra ID or Okta, an MDM (Intune …), an existing guest system.
4. Sites, regions and the WAN between them.
5. Where ClearPass runs: appliances or VMs on site, a cloud (Azure, AWS) or colo, or a cloud NAC.
6. High availability needs, and phases or a pilot scope.

## Design order
Write the design document in these parts, in this order:
1. Current state vs NAC state: SSIDs and VLANs today, then IT / OT / Guest-DMZ segmentation with
   fewer SSIDs.
2. Device inventory: each client type from intake, with count, owner and how it can authenticate.
3. Decision tree: device reaches ClearPass, then SSID or port, device type, checks (AD computer
   object, MDM-managed, MAC on a static or endpoint list, user group), then a ROLE. Every leaf has
   a rule ID (IT-FR-001, OT-FR-001, GU-FR-001 …); the last leaf is a default DENY.
4. One workflow per SSID or connection: START, SSID (open, PSK, 802.1X), method (EAP-TLS,
   PEAP-MSCHAPv2 machine or user, MAC auth with MAC caching, captive portal), source (AD,
   Endpoint DB, Guest DB, MDM), profiling and category, authorization attributes, enforcement
   (VLAN, role, ACL, CoA), STOP. Always an explicit fallback: portal VLAN or deny. Reuse the rule
   IDs from part 3.
5. Use-case table per role: device category · group · posture (healthy, unknown, quarantine) ·
   attributes · enforcement (allow, deny, isolated, internet only).
6. Guest: self-registration with email confirmation, sponsored with approval, MAC caching for
   return visits, placement in the DMZ.
7. IoT and BYOD registration: a form writes the Endpoint DB, then MAC auth puts the device in the
   IoT VLAN.
8. Services and their order: one service per flow; the first match wins.
9. Cluster and platform: publisher, standby publisher, subscribers, virtual IP for the publisher
   and for RADIUS, zones per region, a guest/DMZ cluster apart from the corporate one, regional
   clusters for a global rollout, sizing by endpoint count, appliance vs VM vs Azure or AWS (a
   load balancer in front of RADIUS), latency between members and from devices.
10. Protocols and certificates: RADIUS vs RadSec, the ports and firewall rules needed, the HTTPS
    certificate vs the RADIUS/EAP certificate, which CA clients trust, renewal.
11. Phased rollout: pilot sites, migration, then global; monitor mode before enforcement.
12. Day 2: Access Tracker and Insight, backups, upgrade order (publisher first), a certificate
    renewal calendar.

## Diagrams
Use Casper's `visualize` tool with `type: "flowchart"` for part 3 and for each workflow in part 4.
It saves editable .drawio and MindMesh files. Nodes take only `id`, `label`, `group` and `note`,
so put the kind in the label (START, decision, source, enforcement, STOP), the rule ID in the
`note`, and set `group` to the flow (SSID or port) so each flow gets one colour. Label decision
edges (yes, no, fallback). Draw part 9 with `type: "architecture"`: nodes, VIPs, load balancer,
sites and devices, with ports on the edges.

## Common traps
- Services are checked in order and the first match wins: a broad service above a narrow one
  takes its traffic.
- MAC auth is not authentication: a MAC is easy to spoof. Pair it with profiling and a limited role.
- Machine auth runs at boot, user auth at logon: plan the role for a machine with no user yet.
- CoA works only when the switch or controller is set up to accept it from ClearPass.
- Configuration changes are made on the publisher; subscribers hold a copy.
- With the publisher down, subscribers still authenticate but writes fail (new guest accounts,
  Onboard); plan the standby publisher.
- A virtual IP needs both nodes in one subnet; a standby publisher across a routed WAN gets none.
- Every node that answers EAP needs its own RADIUS/EAP certificate that clients trust.
- The guest portal's HTTPS certificate must come from a public CA, or guests see warnings.
- High latency or thin links between devices and a subscriber, or between members, slow EAP;
  check the clustering guide's numbers for your design.
- Run in monitor mode first; turn on enforcement only after Access Tracker shows the expected
  results.

## Public docs
- https://arubanetworking.hpe.com/techdocs/VSG/docs/110-policy-design/esp-policy-design-035-clearpass-design/
- https://arubanetworking.hpe.com/techdocs/NAC/clearpass/platform/clustering-design/
- https://arubanetworking.hpe.com/techdocs/NAC/clearpass/platform/
