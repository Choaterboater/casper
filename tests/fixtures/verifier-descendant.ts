import { writeFileSync } from "node:fs";

// A real descendant that needs forced cleanup. Unlike `sleep; touch`, SIGTERM
// cannot fast-forward this timer into writing the delayed-work marker.
process.on("SIGTERM", () => writeFileSync("term-received", ""));
setTimeout(() => writeFileSync("leaked", ""), 1000);
writeFileSync("started", String(process.pid));
