// Compiled probe: the bundled network and home lab skill text (text imports of skills/network/*/SKILL.md and skills/homelab/*/SKILL.md) must be inside the binary.
import { bundledSkills, homelabSkills } from "../../src/skills/bundled";

console.log(JSON.stringify([...bundledSkills(), ...homelabSkills()].map((skill) => ({ name: skill.metadata.name, bytes: Buffer.byteLength(skill.body) }))));
