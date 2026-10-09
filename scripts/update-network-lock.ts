// Move Casper's pinned network server to another casper-network-mcp release:
//   bun scripts/update-network-lock.ts 0.2.0
// Downloads that release's casper-network-mcp.lock.txt from GitHub and writes it, plus the version, into
// src/mcp/network/. Run by a person when bumping the pin (the floor every Casper starts from); a running Casper
// fetches newer releases' locks itself and checks them with the same checkLock (src/mcp/network/releases.ts).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkLock } from "../src/mcp/network/releases";

export { checkLock };

const REPO = "https://github.com/Choaterboater/casper-network-mcp";
const DIR = path.resolve(import.meta.dir, "../src/mcp/network");

if (import.meta.main) {
  const version = process.argv[2] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("usage: bun scripts/update-network-lock.ts <version>, for example 0.2.0");
  const response = await fetch(`${REPO}/releases/download/v${version}/casper-network-mcp.lock.txt`, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`);
  const lock = await response.text();
  checkLock(lock, version);
  writeFileSync(path.join(DIR, "casper-network-mcp.lock.txt"), lock);
  const serverFile = path.join(DIR, "server.ts");
  const source = readFileSync(serverFile, "utf8");
  const updated = source.replace(/export const NETWORK_SERVER_VERSION = "[^"]+";/, `export const NETWORK_SERVER_VERSION = "${version}";`);
  if (updated === source && !source.includes(`"${version}"`)) throw new Error("could not find NETWORK_SERVER_VERSION in server.ts");
  writeFileSync(serverFile, updated);
  console.log(`Pinned casper-network-mcp ${version}. Check approxMB in server.ts, then run bun test tests/mcp-network-server.test.ts.`);
}
