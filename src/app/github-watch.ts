/** The session's pull request watches (the github tool's watch verb, src/github/watch.ts) and their wakes: a change
 * worth a look queues a request Casper starts itself (src/app/wakes.ts), which runs at the idle prompt or after the
 * running request. A desktop notification goes with it when the terminal is not in front. Only an open Casper at a
 * terminal watches; the watches end when it closes. */

import type { CasperApp } from "../app";
import { desktopNotify } from "../jobs/notify";
import { PullWatches, wakeText, WATCH_EVERY_MS, type WatchesHost } from "../github/watch";

/** Tests: the watch's timer and the desktop notification. */
export interface GithubWatchSeams {
  schedule?: WatchesHost["schedule"];
  notify?: (text: string) => Promise<boolean>;
}

/** The watches for the github tool's `verb`, or why it can't run now. A wake's turn may stop a watch, never start one. */
export function githubWatchesFor(app: CasperApp, verb: "watch" | "unwatch" = "watch"): PullWatches | string | undefined {
  if (verb === "unwatch" && app.githubWatches) return app.githubWatches;
  if (!app.interactive || app.away || app.closing) return undefined;
  if (verb === "watch" && app.wakeRunning) return "Not started: a watch starts only from a request the person made, not during a wake.";
  return githubWatches(app);
}

/** Stops every watch and its waiting wake, with one line saying why: the folder moved, or the github tool is off. */
export function stopGithubWatches(app: CasperApp, why: string): void {
  const ended = app.githubWatches?.stopAll() ?? [];
  if (!ended.length || app.closing) return;
  app.events.ensureLineBreak();
  app.output.write(`◐ Stopped watching ${ended.map((watch) => `#${watch.number}`).join(", ")}: ${why}.\n`);
}

export function githubWatches(app: CasperApp): PullWatches {
  if (app.githubWatches) return app.githubWatches;
  const seams = app.githubWatchSeams ?? {};
  // notifications: off in /settings turns these off too; a terminal in front needs none.
  const notify = (text: string) => {
    if (app.projectContext?.notifications !== false && app.terminal.inFront !== true) void (seams.notify ?? desktopNotify)(text).catch(() => false);
  };
  const tell = (line: string) => {
    if (app.closing) return;
    app.events.ensureLineBreak();
    app.output.write(`${line}\n`);
    notify(line.replace(/^◐ /, ""));
  };
  const watches = app.githubWatches = new PullWatches({
    ...(seams.schedule ? { schedule: seams.schedule } : {}),
    wake: (watch, reasons) => {
      if (app.closing) return;
      // github: off in /settings takes the tool away, and its watches with it: a wake could not read anything.
      if (app.projectContext?.github === false) { stopGithubWatches(app, "the GitHub tool is off in /settings"); return; }
      // A walk-away job: nobody is there and no wake runs (src/app/command-loop.ts), so the person only hears of it.
      if (app.away) { tell(`◐ GitHub #${watch.number}: ${reasons.join("; ")}. The AI does not look during a walk-away job.`); return; }
      // While a request runs, the person hears now and the AI after it; at the prompt the wake's own line says it.
      if (app.commandActive) tell(`◐ GitHub #${watch.number}: ${reasons.join("; ")}. The AI looks after this request.`);
      else notify(`GitHub #${watch.number}: ${reasons.join("; ")}`);
      app.wakes.push({ key: watch.key, reasons,
        text: (all) => wakeText(watch.number, watch.repo, all),
        line: (all) => `◐ GitHub #${watch.number}: ${all.join("; ")}. Casper asks the AI to look (your watch, not a merge decision).` });
    },
    say: (line) => tell(`◐ ${line}`),
    stopped: (key) => app.wakes.drop(key),
  });
  app.lifecycle.add({ name: "github-watches", close: async () => { watches.close(); } });
  return watches;
}

/** /tasks: one row per watched pull request. */
export function watchTasks(app: CasperApp) {
  const watches = app.githubWatches;
  return (watches?.list() ?? []).map((watch) => ({
    kind: "watch" as const, name: `pull request #${watch.number} (${watch.repo})`, status: `read every ${WATCH_EVERY_MS / 60_000} min`, startedAt: watch.startedAt,
    stop: async () => watches!.stop(watch.key) ? `Stopped watching #${watch.number}.` : `#${watch.number} was no longer watched.`,
  }));
}
