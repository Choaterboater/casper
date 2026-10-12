---
name: homelab-network-troubleshooting
description: >-
  Finding where network traffic stops, one layer at a time: link, address, gateway, DNS, path, ports,
  TLS, HTTP and MTU, then firewall rules and a packet capture.
tags: [traceroute, tcpdump, dns]
casper-skill:
  platform: nettrouble
  triggers:
    strong: ["traceroute", "tracert", "mtr", "tcpdump", "wireshark", "pcap", "packet loss", "packet capture", "dns not resolving", "dns resolution", "nslookup", "cannot ping", "can't ping", "no route to host", "destination host unreachable", "dhcp lease"]
    weak: ["connection refused", "connection timed out", "ping", "dns", "dig", "mtu", "default gateway", "dhcp", "ipv6", "iptables", "nftables", "ufw"]
    context: ["network", "firewall", "lan", "wifi", "wi fi", "subnet", "router", "vpn", "vlan", "resolver", "isp", "nas", "ethernet", "home lab", "homelab", "self hosted", "selfhosted"]
    unless: ["parser", "parse", "parsing", "visualizer", "component", "dissector", "simulation", "netcode", "crate", "library", "bindings", "module", "mock", "tests", "unit test", "jest", "flaky", "react", "toast", "hook", "column", "error message", "handle", "dev server", "websocket", "api gateway", "kong", "android", "ios", "generator"]
  version: 1
---
# Network troubleshooting

## When to use
Something on the network fails: a host can't be reached, a name does not resolve, a port refuses,
a page hangs, packets go missing. Go one layer at a time from the bottom and stop
at the first one that fails. Writing code that uses the network (a fetch, a health check, DNS records
in Terraform) is ordinary code: this skill is for finding where traffic stops.

## Read first
These only look. Linux first, then macOS and Windows.
1. Link and Wi-Fi: `ip -br link`, `ethtool <if>` (link detected, speed), `iw dev <if> link` (signal);
   macOS `ifconfig en0`; Windows `netsh wlan show interfaces`.
2. Address and DHCP: `ip -br addr`, `ip route`, `nmcli -f DHCP4 dev show <if>` (the lease); macOS
   `ipconfig getifaddr en0`, `ipconfig getpacket en0`, `netstat -rn`; Windows `ipconfig /all`. A 169.254
   address means no DHCP answer.
3. Gateway: `ping -c 4 <gateway>` (Windows `-n 4`), the `default via` address of `ip route`.
4. DNS: `dig host.example.com`, then the local resolver against a public one: `dig @<local resolver>
   host.example.com` and `dig @1.1.1.1 host.example.com`. systemd: `resolvectl status` (127.0.0.53 is the
   stub), `/etc/resolv.conf`; macOS `scutil --dns`; Windows `nslookup host.example.com`.
   Different answers: split DNS, or Pi-hole/AdGuard blocking.
5. Path: `traceroute -n <host>` or `mtr -rwc 50 <host>`; Windows `tracert -d <host>`.
6. Ports and listeners: `ss -tlnp` (Linux), `lsof -nP -iTCP -sTCP:LISTEN` (macOS), `nc -vz <host>
   <port>`, Windows `Test-NetConnection <host> -Port <port>`. Refused: nothing listens there, or a
   reject rule. Timed out: something drops it. A listener on 127.0.0.1 answers this machine only.
7. TLS: `openssl s_client -connect host.example.com:443 -servername host.example.com </dev/null`, piped
   to `openssl x509 -noout -dates -subject -issuer`; `-showcerts` prints the chain.
8. HTTP: `curl -v https://host.example.com/`; `curl -v --resolve host.example.com:443:192.0.2.10
   https://host.example.com/` tries one backend by address.
9. MTU: `ping -M do -s 1472 <host>` (Linux), `ping -D -s 1472 <host>` (macOS), `ping -f -l 1472 <host>`
   (Windows). 1472 plus 28 bytes of headers is 1500; go lower until it passes.
10. Firewall rules: `sudo nft list ruleset`, `sudo iptables -S`, `sudo ufw status verbose`, `sudo pfctl -sr` (macOS).
11. Docker: `docker exec <container> cat /etc/resolv.conf`, `docker network inspect <network>`,
    `docker port <container>`.

Packet capture: ask the user first, since a capture can hold passwords, cookies and private traffic.
`sudo tcpdump -ni <if> -c 100 host 192.0.2.10`. Keep a saved capture on this machine; never upload a
pcap or paste its payload.

## Changing things (Casper asks)
MCP: Casper's change box asks; don't ask again in chat. Else ask the user first; show the exact call.
Casper also asks before a shell command reaches a new host.
- Route, firewall, DNS and interface changes can cut off the shell you are in, mostly over ssh. Save
  the current rules first, keep the undo next to the change, make one change, then test again.

```bash
# WRITE
sudo nft list ruleset > nft-backup.conf   # the undo point
sudo nft add rule inet filter input tcp dport 8080 accept
# undo: sudo nft flush ruleset && sudo nft -f nft-backup.conf
```

WRITE: over ssh, schedule the undo first: `echo "nft flush ruleset; nft -f $PWD/nft-backup.conf" | sudo at now + 5 minutes`, and `sudo atrm <job>` once you are back in.

WRITE: `sudo iptables-save > iptables-backup.rules` first; undo with `sudo iptables-restore < iptables-backup.rules`.

WRITE: `sudo ufw allow from 192.0.2.0/24 to any port 22 proto tcp`; undo: `sudo ufw delete allow from 192.0.2.0/24 to any port 22 proto tcp`.

WRITE: `sudo ip route add 192.0.2.0/24 via 192.0.2.1`; undo: `sudo ip route del 192.0.2.0/24`. Gone after a reboot.

WRITE: `sudo resolvectl dns <if> 192.0.2.53`; undo: `sudo resolvectl revert <if>`.

WRITE: flush the DNS cache: `sudo resolvectl flush-caches` (systemd), `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` (macOS), `ipconfig /flushdns` (Windows).

## Common traps
- ICMP blocked: ping fails while TCP works. Test the real port with `nc -vz` before calling a host down.
  Loss at one middle hop of `mtr` that clears later is a router slowing its replies, not loss.
- IPv6 preferred but broken: the name has an AAAA record and connects hang. Compare `curl -4` and `curl -6`.
- VPN split tunnel: the VPN may own the default route or DNS. `ip route get 192.0.2.10` (macOS
  `route get`) shows the interface used; check the resolver per interface too.
- Captive portal: guest Wi-Fi sends every request to a sign-in page, so TLS fails. Open a plain http page.
- Double NAT: an ISP router in front of yours. Port forwards need both, and your router's WAN address
  is private (10/8, 172.16/12, 192.168/16) or carrier NAT (100.64/10).
- DNS cache: an old answer after a change. `dig` shows the TTL; flush (under Changing things); browsers
  keep their own cache.
- Asymmetric routing: replies leave by another interface or gateway and a stateful firewall drops them.
  Two NICs or two gateways are the usual cause; capture on both sides.
- Pi-hole/AdGuard: a blocked name answers all zeros or NXDOMAIN. Read its query log before blaming the app.
- MTU: small packets work, big ones (TLS handshakes, large pages) hang. PPPoE (1492), VPNs and tunnels
  are the usual cause: lower the MTU or clamp MSS.
- Docker: containers on a user network ask 127.0.0.11, Docker's own DNS, which forwards to the host's
  resolvers. `127.0.0.1:8080:80` is reachable from the host only; `network_mode: host` ignores `ports`.
  Published ports skip ufw. IPv6 is off in a network unless it enables it.

## Public docs
- https://man7.org/linux/man-pages/man8/ip-route.8.html
- https://man7.org/linux/man-pages/man8/ss.8.html
- https://www.tcpdump.org/manpages/tcpdump.1.html
- https://wiki.nftables.org/wiki-nftables/index.php/Main_Page
- https://curl.se/docs/manpage.html
- https://www.rfc-editor.org/rfc/rfc8899
- https://docs.docker.com/engine/network/
