import { createReadTool } from "@earendil-works/pi-coding-agent";

// Model a machine without the build-time dependency tree. Never rename or modify
// installed dependencies. Embedded Bun filesystem reads must remain available.
const fs = require("node:fs");
const readFileSync = fs.readFileSync.bind(fs);
fs.readFileSync = (file: unknown, ...args: unknown[]) => {
  const name = String(file);
  if (name.endsWith(".wasm") && !name.includes("$bunfs") && !name.includes("~BUN")) {
    throw Object.assign(new Error("Build-time WASM is unavailable on this machine"), { code: "ENOENT" });
  }
  return readFileSync(file, ...args);
};

const result = await createReadTool(process.cwd()).execute("standalone-image", { path: process.argv[2]! });
const image = result.content.find(block => block.type === "image");
const resized = result.content.some(block => block.type === "text" && block.text.includes("original 2001x2"));
console.log(JSON.stringify({ imageRead: Boolean(image), mimeType: image?.mimeType, resized }));
process.exitCode = image ? 0 : 1;
