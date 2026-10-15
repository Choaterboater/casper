import { createReadTool } from "@earendil-works/pi-coding-agent";
import { resolveToolPath } from "../../src/platform/project-paths";

const [project, typed] = process.argv.slice(2);
const result = await createReadTool(project!).execute("tilde", { path: typed! });
console.log(JSON.stringify({ resolved: resolveToolPath(typed!, project!),
  text: result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") }));
