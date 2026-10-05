import { openSync } from "node:fs";

/**
 * The fake network server, holding one file open while it runs (HOLD_FILE), the way a running Python server holds
 * files in its venv. On Windows an open file keeps its folder from being renamed until the process ends.
 */
const file = process.env.HOLD_FILE;
if (file) openSync(file, "r");
await import("./fake-network-mcp");
