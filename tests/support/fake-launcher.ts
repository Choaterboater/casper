import { pathToFileURL } from "node:url";
import { startFakeServer } from "./fake-servers";

/**
 * The Windows side of fake-program.ts: built once into an .exe, and hard linked as each fake program. It runs the
 * <name>.fake.cjs next to its own .exe. A built .exe can't load packages from node_modules, so the MCP stand-ins are
 * built in here, and a fake's script starts one with fakeServer(name).
 */
(globalThis as { fakeServer?: typeof startFakeServer }).fakeServer = startFakeServer;
await import(pathToFileURL(`${process.execPath.replace(/\.exe$/i, "")}.fake.cjs`).href);
