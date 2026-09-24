import { normalizeConfig } from "./normalize";
import type { Vendor } from "./vendor";

export interface RuleResult {
  readonly rule: "ntp" | "aaa" | "snmpv2-off";
  readonly passed: boolean;
  readonly detail: string;
}

function junos(lines: string[]): RuleResult[] {
  const ntp = lines.filter((line) => /^set system ntp server \S+/.test(line));
  const servers = lines.filter((line) => /^set system (tacplus|radius)-server \S+/.test(line));
  const order = lines.find((line) => line.startsWith("set system authentication-order "));
  const first = order?.replace("set system authentication-order ", "").replace(/[[\]]/g, " ").trim().split(/\s+/)[0];
  const communities = lines.flatMap((line) => /^set snmp community (\S+)/.exec(line)?.[1] ?? []).map((name) => name.replace(/^"|"$/g, ""));
  return result(ntp.length > 0, servers.length > 0, first === "tacplus" || first === "radius", [...new Set(communities)]);
}

function aoscx(lines: string[]): RuleResult[] {
  const ntp = lines.some((line) => /^ntp server \S+/.test(line)) && lines.includes("ntp enable");
  const servers = lines.some((line) => /^(tacacs|radius)-server host \S+/.test(line));
  const groups = new Set(lines.flatMap((line) => /^aaa group server (?:tacacs|radius) (\S+)/.exec(line)?.[1] ?? []));
  const login = lines.find((line) => line.startsWith("aaa authentication login default group "));
  const first = login?.split(/\s+/)[5];
  const communities = lines.flatMap((line) => /^snmp-server community (\S+)/.exec(line)?.[1] ?? []);
  return result(ntp, servers, first !== undefined && (first === "tacacs" || first === "radius" || groups.has(first)), [...new Set(communities)]);
}

function result(ntp: boolean, servers: boolean, loginUsesAaa: boolean, communities: string[]): RuleResult[] {
  return [
    { rule: "ntp", passed: ntp, detail: ntp ? "NTP server configured" : "no NTP server configured (or NTP not enabled)" },
    {
      rule: "aaa", passed: servers && loginUsesAaa,
      detail: !servers ? "no TACACS+ or RADIUS server configured" : !loginUsesAaa ? "login does not authenticate against TACACS+/RADIUS first" : "login uses TACACS+/RADIUS",
    },
    {
      rule: "snmpv2-off", passed: communities.length === 0,
      detail: communities.length ? `SNMPv1/v2c communities configured: ${communities.join(", ")}` : "no SNMPv1/v2c communities",
    },
  ];
}

export function checkCompliance(vendor: Vendor, text: string): RuleResult[] {
  const lines = normalizeConfig(vendor, text);
  return vendor === "junos" ? junos(lines) : aoscx(lines);
}
