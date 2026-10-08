// Capture helper for the website: what the AI reads when it opens a switch backup.
// Runs Casper's own scrubber (the same function a native `read` goes through). Fake config, fake secrets.
// bun site/captures/secrets-demo.ts
import { Scrubber } from "../../src/secrets/netconan";
import { scrubToolOutput } from "../../src/secrets/tool-output";

const files: Record<string, string> = {
  "backups/core-cx-01.cfg": [
    "hostname core-cx-01",
    "user admin group administrators password ciphertext AQBapFakeFakeFake0123==",
    "radius-server host 192.0.2.10 key plaintext NotARealKey1 vrf mgmt",
    "snmp-server community LabCommunity",
    "interface 1/1/1",
    "    description uplink to dist-01",
    "    no shutdown",
  ].join("\n"),
  "backups/edge-mx-01.set": [
    "set system host-name edge-mx-01",
    "set system root-authentication encrypted-password \"$6$fakesalt$fakehashfakehash\"",
    "set snmp community LabRO authorization read-only",
    "set interfaces ge-0/0/0 description \"to core-cx-01\"",
  ].join("\n"),
};

const scrubber = new Scrubber({ env: { CASPER_NETCONAN: "off" } });
for (const [file, config] of Object.entries(files)) {
  const result = await scrubToolOutput(scrubber, "read", { path: file }, [config]);
  console.log(`── ${file} on disk ──`);
  console.log(config);
  console.log(`── ${file} as the AI reads it ──`);
  console.log(result?.texts.join("\n") ?? config);
  if (result?.note) console.log(result.note);
  console.log("");
}
