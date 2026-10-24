/** casper_skill_add for a task (src/skills/add-tool.ts): the AI's way to add a skill, after the person has seen its whole
 * text and said yes in Casper's approval box. */

import type { CasperApp } from "../app";
import type { RuntimeTool } from "../runtime/types";
import { holdsSecret } from "../secrets/refuse";
import { SKILL_ADD_YES, skillAddTool } from "../skills/add-tool";
import { recordedApproval } from "./approvals";
import { ownSecretValues } from "./network-host";
import { NO } from "./safe-choices";

export function skillAddToolFor(app: CasperApp): RuntimeTool {
  return skillAddTool({
    homeDir: app.homeDir(),
    canAsk: () => app.interactive && !app.closing,
    taken: () => (app.skillRegistry?.list() ?? []).map((skill) => skill.name),
    holdsSecret: (text) => holdsSecret(text, { values: ownSecretValues(app) }),
    show: (rows) => { if (!app.closing) app.terminal.writeRows(rows); },
    // The same box as every approval, but nothing answers it for the person: not /permissions all ("Yes to everything"),
    // which answers only the shell's own questions, and no remembered answer, since it offers none.
    confirm: async (preview, question, signal) =>
      await recordedApproval(app, preview, question, [{ label: NO }, { label: SKILL_ADD_YES }], signal) === SKILL_ADD_YES,
    tell: (text) => { if (!app.closing) app.output.write(text); },
    reload: () => app.reloadSkills(),
    loaded: (name) => app.skillRegistry?.list().some((skill) => skill.name === name && skill.source === "user") ?? false,
  });
}
