// Compiled probe: the bundled flow text (a text import of SKILL.md files) must be inside the binary.
import { bundledFlows } from "../../src/flows/catalog";

console.log(JSON.stringify(bundledFlows().map((flow) => ({ name: flow.name, bytes: flow.body.length }))));
