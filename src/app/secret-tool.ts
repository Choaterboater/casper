/** casper_secret for a task (src/secrets/secret-tool.ts): Casper's own hidden box, in the same one-at-a-time queue as every
 * approval, and only where Casper has its full terminal (piped input can't hide what is typed). */

import type { CasperApp } from "../app";
import { secretTool } from "../secrets/secret-tool";
import { git } from "../security/git";
import type { RuntimeTool } from "../runtime/types";
import { withLoginDisplay } from "../tui/login";
import { oneAtATime } from "./approvals";
import { projectPrivatePaths } from "./wiring";

export function secretToolFor(app: CasperApp): RuntimeTool {
  const seam = app.secretInput;
  return secretTool({
    root: () => app.activeWorkspaceRoot(),
    home: () => app.homeDir(),
    privatePaths: () => projectPrivatePaths(app),
    canAsk: () => app.interactive && app.terminal.canAsk && !app.closing && (seam !== undefined || !!app.terminal.exclusiveHost()),
    planning: () => app.planning,
    ask: (ask, signal) => oneAtATime(app, async () => {
      if (app.closing) return undefined;
      const stop = signal ?? app.commandAbort?.signal ?? new AbortController().signal;
      const title = `The AI asks for ${ask.name}`;
      const hint = `${ask.why}\nIt goes to ${ask.to}. The AI never sees it, and Casper doesn't show or log it. Esc skips.`;
      if (seam) return seam({ label: `${ask.name}:`, title, hint });
      const picker = app.terminal.exclusiveHost();
      if (!picker) return undefined;
      return picker.run((io) => withLoginDisplay(io, stop, (display) => display.privateInput(`${ask.name}:`, undefined, { title, hint, password: true })))
        .catch(() => undefined);
    }),
    tell: (text) => { if (!app.closing) app.output.write(text); },
    git: (root, args) => git(root, args),
  });
}
