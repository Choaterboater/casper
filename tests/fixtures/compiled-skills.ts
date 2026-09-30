// Compiled probe: the bundled network skill text (text imports of skills/network/*/SKILL.md) must be inside the binary.
import { bundledSkills } from "../../src/skills/bundled";

console.log(JSON.stringify(bundledSkills().map((skill) => ({ name: skill.metadata.name, bytes: Buffer.byteLength(skill.body) }))));
