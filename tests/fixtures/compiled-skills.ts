// Compiled probe: the bundled network, home lab and design skill text (text imports of skills/{network,homelab,design}/*/SKILL.md) must be inside the binary.
import { bundledSkills, designSkills, homelabSkills } from "../../src/skills/bundled";

console.log(JSON.stringify([...bundledSkills(), ...homelabSkills(), ...designSkills()].map((skill) => ({ name: skill.metadata.name, bytes: Buffer.byteLength(skill.body) }))));
