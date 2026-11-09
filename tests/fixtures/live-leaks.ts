// The last review's leaks (decision 98): each output's final scrub hides a value that a running command's live lines
// showed. Made-up values. `full` is the command's whole output, `text` the progress text Pi passed (`full` when unset),
// `cut` whether Pi cut its start, `env` Casper's environment. tests/acp-live-output.test.ts sends each through the ACP
// mapper, and tests/secrets-live-drift.test.ts checks the final scrub hides each secret and every window is held.
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const vlans = Array.from({ length: 40 }, (_, at) => `  "vlan_${at}": "vlan ${at} description for the access layer",\n`).join("");
const tlsKey = String.raw`  "tls_key": "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBq7dXf2kLmN9pQrS3tUvW4xYz5AbCdEfGhIjKlMnOpQoAoGCCqGSM49\nAwEHoUQDQgAEZ1x2y3z4A5B6C7D8E9F0G1H2I3J4K5L6M7N8O9P0Q1R2S3T4U5V6\nW7X8Y9Z0a1b2c3d4==W7X8Y9\n-----END EC PRIVATE KEY-----\n",` + "\n";
const aos8 = pretty({ _data: ["version 8.10.0.0-8.10.0.0", "hostname mc-lab", "mgmt-user admin root 3f9a1c7e2b5d4f6a8c0e1b3d5f7a9c2e",
  "mgmt-user netops read-only 7c1e9f0a2b4d6f8a0c2e4f6b8d0a1c3e", "ip access-list session allowall", "wlan ssid-profile corp", "   essid corp",
  "   wpa-passphrase 8a1b2c3d4e5f60718293a4b5c6d7e8f9"] });
const cx = pretty({ snmp_communities: ["n3tw0rkRO", "pr1vRW"], cli: ["snmp-server community s3cr3tRO"] });
const dnac = `{\n  "r1": {\n    "show run | i snmp-server community": "snmp-server community R1c0mmRO RO\\n",\n    "show version": "${"Cisco IOS XE Software, Version 17.09.04a ".repeat(50)}"\n  },\n  "r2": {\n`
  + `    "show run | sec radius": "radius server ISE1\\n address ipv4 192.0.2.10 auth-port 1812 acct-port 1813\\n key 7 104D000A0618\\n",\n`
  + `    "show run | i snmp": "snmp-server location lab-2\\nsnmp-server community R2c0mmRO RO\\n"\n  }\n}\n`;
const multiEnv = { DEPLOY_SECRETS: "db_host=192.0.2.10\nPa55-w0rd-Line!\nkv-token-91x7q" };
export interface LiveLeak { case: string; full: string; text?: string; cut?: true; secrets: string[]; env?: Record<string, string> }
export const LIVE_LEAKS: LiveLeak[] = [
  // 1. JSON: the final's device pass reads each string of a whole-JSON output alone, and hides all under a secret-named key.
  { case: "pretty JSON: a list and a map under secret-named keys", secrets: ["Cmty0ne9x", "Cmty2two7", "MC4CAQAwBQYDK2VwBCIEIHq9Zf3XkRTz8bQ2vN7mLp4sMC4C"],
    full: `{\n${tlsKey}${vlans}  "snmp_communities": [\n    "Cmty0ne9x",\n    "Cmty2two7"\n  ],\n  "private_keys": {\n    "backup": "MC4CAQAwBQYDK2VwBCIEIHq9Zf3XkRTz8bQ2vN7mLp4sMC4C"\n  },\n  "done": true\n}\n` },
  { case: "pretty JSON: escaped newlines in a command runner's strings, its device line above the shown lines", full: dnac, secrets: ["104D000A0618", "R2c0mmRO"] },
  { case: "pretty JSON: an AOS 8 config as a list of lines, still arriving", full: aos8, text: aos8.slice(0, aos8.indexOf('    "ip access-list') + 8),
    secrets: ["3f9a1c7e2b5d4f6a8c0e1b3d5f7a9c2e", "7c1e9f0a2b4d6f8a0c2e4f6b8d0a1c3e"] },
  { case: "pretty JSON: an AOS-CX community list, still arriving", full: cx, text: cx.slice(0, cx.indexOf('  "cli"')), secrets: ["n3tw0rkRO", "pr1vRW"] },
  // 2. A certificate's or public key's armor on a line: the device rules still read it.
  { case: "one-line JSON: a public key and a passphrase", secrets: ["Ab12cd34ef"],
    full: String.raw`{"name":"edge","server_pubkey":"-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEq9Zf3XkRMFkwEwYHKoZIzj0CAQYI\nTz8bQ2vN7mLp4sWc1dEaY6uHjK0oIgF5rBxVTz8bQ2vN7mLp4sWc1dEaY6uH\n-----END PUBLIC KEY-----\n","wlan":{"cli":"wpa-passphrase Ab12cd34ef"}}` + "\n" },
  { case: "one-line JSON: a public key and a community", secrets: ["Pub1icK3yComm"],
    full: String.raw`{"ssh_pubkey":"-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----","cli":"snmp-server community Pub1icK3yComm RO"}` + "\n" },
  { case: "one-line JSON: Junos commands and a CA certificate", secrets: ["M1stC0mm", "Rad1usPlain"],
    full: String.raw`{"id":"x","additional_config_cmds":["set snmp community M1stC0mm authorization read-only","set system radius-server 192.0.2.10 secret Rad1usPlain"],"mist_nac":{"cacerts":["-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"]}}` + "\n" },
  { case: "one-line JSON: a CA certificate before a Junos community", secrets: ["s3cr3tRO"],
    full: String.raw`{"cacerts":["-----BEGIN CERTIFICATE-----\nMIIBfakeCERTbody\n-----END CERTIFICATE-----"],"additional_config_cmds":["set snmp community s3cr3tRO authorization read-only"]}` + "\n" },
  { case: "a log line naming a certificate, then a TACACS key", secrets: ["070C285F4D06"],
    full: "2026-11-09T10:00:00 provision: wrote -----BEGIN CERTIFICATE----- ... ; tacacs-server host 192.0.2.11 key 7 070C285F4D06\n" },
  { case: "a certificate's END run into the next command's community line, after a cut", secrets: ["Chain3dComm"], cut: true,
    full: "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIUQWERTYUIOPasdfghjklzxcvbnm1234567890ABCDEFGHIJ\n-----END CERTIFICATE-----snmp-server community Chain3dComm RO\nsnmp-server location lab\n",
    text: "MIIDdzCCAl+gAwIBAgIUQWERTYUIOPasdfghjklzxcvbnm1234567890ABCDEFGHIJ\n-----END CERTIFICATE-----snmp-server community Chain3dComm RO\nsnmp-server location lab\n" },
  // 3. A secret value of more than one line: the final hides it only whole, and its last line is not out yet.
  { case: "an environment value of three lines, its last line still arriving", env: multiEnv, secrets: ["Pa55-w0rd-Line!"],
    full: `loading\n${multiEnv.DEPLOY_SECRETS}\ndone\n`, text: `loading\n${multiEnv.DEPLOY_SECRETS.slice(0, multiEnv.DEPLOY_SECRETS.indexOf("kv-token") + 4)}` },
  // 4. A key's body of lines under 40 characters, with no BEGIN, before its END is out.
  { case: "a key's short lines with no BEGIN, before its END", secrets: ["cZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg"],
    full: "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nhmT8uKgYLviQMi0EAJP0Zik3xr8Njawx\nQk3TAbCdEfGh==\n-----END PRIVATE KEY-----\n",
    text: "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nhmT8uKgYLviQMi0EAJP0Zik3xr8Njawx\nQk3TAbCdEfGh==\n" },
];

/** The armor leak as plain text: a certificate's armor on a line with a community, a server key or a hash. */
export const ARMOR_LINES: ReadonlyArray<readonly [full: string, secret: string]> = [
  ["applied ca=-----BEGIN CERTIFICATE-----MIIBszCC-----END CERTIFICATE----- cmd=snmp-server community Xy7pQ2zz ro\n", "Xy7pQ2zz"],
  ["hostname sw1\n-----END CERTIFICATE----- radius-server host 192.0.2.1 key Zq9secretK\n", "Zq9secretK"],
  ["loaded -----BEGIN CERTIFICATE----- applied snmp-server community s3cr3tRO ro\n", "s3cr3tRO"],
  ["-----END PGP SIGNATURE----- enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0\n", "$1$mERr$hx5rVt7rPNoS4wqbXKX7m0"],
];

/** A secret typed into Casper of two lines, and its output with the second line still arriving. */
export const TYPED_TWO_LINES = { value: "hunter2-line-one\nline-two-xyz", full: "a\nhunter2-line-one\nline-two-xyz\nb\n", text: "a\nhunter2-line-one\nline-t" };

const pad = (at: number) => String(at).padStart(2, "0");
const rows = (count: number, row: (at: number) => string) => Array.from({ length: count }, (_, at) => row(at)).join("");
const shortKey = "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nhmT8uKgYLviQMi0EAJP0Zik3xr8Njawx\nQk3TAbCdEfGh==\n-----END PRIVATE KEY-----\n";
const shortKeyNoDigit = "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nhmTauKgYLviQMiaEAJPaZikbxrbNjawx\nQk3TAbCdEfGh==\n-----END PRIVATE KEY-----\n";
const markedEnv = (lines: string) => ({ case: "", env: multiEnv, secrets: ["Pa55-w0rd-Line!"], full: lines });
/** The review after: a device rule that took a table header's bar as a value, a key's short lines, a literal mark. */
export const LIVE_LEAKS_2: LiveLeak[] = [
  // 5. A table header above the shown lines, which a live device rule broke before the table rule read it.
  { case: "a Markdown table of device logins, its header above the shown lines", secrets: ["Adm1n-49x!"],
    full: `| Device | Address | User | Priv | Password |\n|---|---|---|---|---|\n${rows(50, (at) => `| sw-${pad(at)}.lab | 192.0.2.${at + 1} | admin | 15 | Adm1n-${pad(at)}x! |\n`)}` },
  { case: "an SNMPv3 table, its header above the shown lines", secrets: ["Sn3mpPr1v-59x"],
    full: `| Device | Address | User | Auth | Priv | Password |\n|---|---|---|---|---|---|\n${rows(60, (at) => `| sw-${pad(at)}.lab | 192.0.2.${at + 1} | netops | SHA | AES128 | Sn3mpPr1v-${at}x |\n`)}` },
  { case: "a box-drawn table with no rule under its header", secrets: ["R4d!us-49k"],
    full: `│ device    │ radius     │ secret      │\n${rows(50, (at) => `│ sw-${pad(at)}.lab │ 192.0.2.${at + 1} │ R4d!us-${pad(at)}k │\n`)}` },
  // 6. A key's body with no BEGIN, wrapped under 40 columns: its first line, or a line with no digit, before its END.
  { case: "a key's short first line with no BEGIN, its next line still arriving", secrets: ["cZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg"], full: shortKey,
    text: "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nhmT8" },
  { case: "a key's short lines with no BEGIN, the second with no digit", secrets: ["hmTauKgYLviQMiaEAJPaZikbxrbNjawx"], full: shortKeyNoDigit,
    text: "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nhmTauKgYLviQMiaEAJPaZikbxrbNjawx\n" },
  { case: "a key's short last line after a cut, before its END", secrets: ["bpY5Q1TPvWRs=="], cut: true,
    full: "x\nbpY5Q1TPvWRs3Abc\nbpY5Q1TPvWRs==\n-----END PRIVATE KEY-----\n", text: "bpY5Q1TPvWRs3Abc\nbpY5Q1TPvWRs==\n" },
  { case: "a password-like word just above a key with no BEGIN", secrets: ["Hunter2Pass"], text: "Hunter2Pass\n",
    full: "Hunter2Pass\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7q9Zf3XkRTz8b\nQ2vN7mLp4sWc1dEaY6uHjK0oIgF5rBxVd7Hq3WmN2pL8sKc4RtYu9EzXo1AbCdEf\n"
      + "GhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGhIjKlMnOpQrStUvWxYz01234==\n-----END PRIVATE KEY-----\n" },
  // A key's short body whose last line is a plain word: the word waits too, below a key-body line.
  { case: "a key's short lines with no BEGIN, its last line a plain word", secrets: ["cZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg", "hmTauKgYLviQMiaEAJPaZikbxrbNjawx"],
    full: "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nhmTauKgYLviQMiaEAJPaZikbxrbNjawx\nQkab\n-----END PRIVATE KEY-----\n",
    text: "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nhmTauKgYLviQMiaEAJPaZikbxrbNjawx\nQkab\n" },
  { case: "a key's one short line with no BEGIN, then a plain word", secrets: ["cZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg"],
    full: "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nAbcdef\n-----END PRIVATE KEY-----\n", text: "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nAbcdef\n" },
  { case: "a key wrapped at 19 columns after a cut, its last line a plain word", secrets: ["CVlS+PDOeyQvPplczzS"], cut: true,
    full: "xx\nAbCd0123efGH4567ijK\nefygZbD2bW27RSFzU5n\nCVlS+PDOeyQvPplczzS\nituujeqpcrm\n-----END PRIVATE KEY-----\nnext\n",
    text: "efygZbD2bW27RSFzU5n\nCVlS+PDOeyQvPplczzS\nituujeqpcrm\n" },
  { case: "a key's plain-word last line just under a cut line", secrets: ["Qkab"], cut: true, text: "awx\nQkab\n",
    full: "key follows\ncZQ0ZUBWeXfkQr6073/9uwyvXBifAwjg\nhmTauKgYLviQMiaEAJPaZikbxrbNjawx\nQkab\n-----END PRIVATE KEY-----\n" },
  { case: "a password above a plain word, both above a key with no BEGIN", secrets: ["Hunter2Pass9"], text: "admin password set to\nHunter2Pass9\nDone\n",
    full: "admin password set to\nHunter2Pass9\nDone\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7q9Zf3XkRTz8b\n"
      + "Q2vN7mLp4sWc1dEaY6uHjK0oIgF5rBxVd7Hq3WmN2pL8sKc4RtYu9EzXo1AbCdEf\n-----END PRIVATE KEY-----\n" },
  // 8. A Markdown header with no last bar, cut away: the final hides each row's cells from the password on, short ones too.
  { case: "a Markdown table with no last bar after a cut, its passwords two characters", secrets: ["Zq"], cut: true, text: "| u8 | Pw |\n| u9 | Zq |\n",
    full: `| user | password\n|---|---\n${rows(48, (at) => `| u${at % 10} | Pw |\n`)}| u8 | Pw |\n| u9 | Zq |\n` },
  // 7. Casper's truncated mark printed by the command itself, next to a value of several lines.
  { ...markedEnv("loading\n[...output truncated...]\ndb_host=192.0.2.10\nPa55-w0rd-Line!\nkv-token-91x7q\ndone\n"), case: "an environment value of three lines just below a printed truncated mark" },
  { ...markedEnv("loading\ndb_host=192.0.2.10\nPa55-w0rd-Line!\nkv-token-91x7q\n[...output truncated...]\ndone\nbye\n"), case: "an environment value of three lines just above a printed truncated mark" },
];

/** What the session's own hiding hides in the end's output and not in the shown lines alone: `values` are the ones it
 * hides (an ACP client's MCP values among them); `configs` is /secrets files. The final scrub changes none of them. */
export interface HideLeak { case: string; full: string; text?: string; secrets: string[]; values?: string[]; configs?: false; env?: Record<string, string> }
const todo = (count: number, word: string) => rows(count, (at) => `- [ ] ${word} ${pad(at)}: check the cabling and labels\n`);
/** Notes whose last 2,000 characters start just under `label`'s first line (`desks` and `dots` set where). */
const below = (label: string, desks: number, dots: number) => `# Office setup\n${todo(4, "rack")}${label}\n${todo(desks, "desk")}Ask facilities${".".repeat(dots)}\n`;
const serviceAccount = "{\n  \"type\": \"service_account\",\n  \"project_id\": \"demo-proj-123\",\n  \"private_key_id\": \"abc123def456\"\n}";
export const HIDE_LEAKS: HideLeak[] = [
  { case: "a value on the line under its \"password:\" label, the label above the shown lines", secrets: ["Bl-Wifi-2026!"],
    full: below("Guest Wi-Fi password:\nBl-Wifi-2026!\nPrinter: HP M404 in room 2", 43, 34) },
  { case: "a value under \"API token:\"", secrets: ["Zr8kQ2vL9xW4nT6pS1yU3"], full: below("API token:\nZr8kQ2vL9xW4nT6pS1yU3", 44, 20) },
  { case: "a value under \"--password\"", secrets: ["Dk-Pw-9911"], full: below("  --password\nDk-Pw-9911", 44, 30) },
  { case: "a value under \"Bearer\"", secrets: ["Op4qTr7sUv0wXy3zAb6cDe9f"], full: below("curl -H 'Authorization: Bearer\nOp4qTr7sUv0wXy3zAb6cDe9f' https://api.example.test/v1/me", 43, 10) },
  { case: "an ACP client's MCP value of two lines, its second still arriving", secrets: ["Kq7-first-half-of-key"],
    values: ["Kq7-first-half-of-key\nZp3-second-half-of-key"], full: "token parts:\nKq7-first-half-of-key\nZp3-second-half-of-key\nend\n",
    text: "token parts:\nKq7-first-half-of-key\nZp3" },
  { case: "an ACP client's MCP value of JSON lines, /secrets files off", secrets: ["demo-proj-123"], values: [serviceAccount], configs: false,
    full: `${serviceAccount}\n`, text: serviceAccount.slice(0, serviceAccount.indexOf("  \"private_key_id\"") + 4) },
  // The hiding reads the output as terminalText leaves it: no colour codes, a lone carriage return a line break.
  { case: "an ACP client's value of two lines, a colour reset after its first", secrets: ["Kq7-first-half-of-key"],
    values: ["Kq7-first-half-of-key\nZp3-second-half-of-key"], full: "parts:\nKq7-first-half-of-key\u001b[0m\nZp3-second-half-of-key\nend\n",
    text: "parts:\nKq7-first-half-of-key\u001b[0m\n" },
  { case: "an environment value of three lines, each line coloured", secrets: ["db_host=192.0.2.10"], env: multiEnv, values: [multiEnv.DEPLOY_SECRETS],
    full: "loading\n\u001b[32mdb_host=192.0.2.10\u001b[0m\n\u001b[32mPa55-w0rd-Line!\u001b[0m\n\u001b[32mkv-token-91x7q\u001b[0m\ndone\n",
    text: "loading\n\u001b[32mdb_host=192.0.2.10\u001b[0m\n" },
  { case: "an environment value's first two lines joined by a lone carriage return", secrets: ["Pa55-w0rd-Line!"], env: multiEnv, values: [multiEnv.DEPLOY_SECRETS],
    full: "x\ndb_host=192.0.2.10\rPa55-w0rd-Line!\nkv-token-91x7q\ndone\n", text: "x\ndb_host=192.0.2.10\rPa55-w0rd-Line!\n" },
  { case: "an ACP client's value of three lines, its first with a variation selector, each line cleared", secrets: ["Zp3-second-part-bb"],
    values: ["Kq7-first-part-aa\nZp3-second-part-bb\nMm5-third-part-cc"], full: "x\nKq7-first\uFE0F-part-aa\u001b[K\nZp3-second-part-bb\u001b[K\nMm5-third-part-cc\u001b[K\ndone\n",
    text: "x\nKq7-first\uFE0F-part-aa\u001b[K\nZp3-second-part-bb\u001b[K\n" },
];
