import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { ask, compareHome, loadConfig, SIDE_NAMES, SIDES, type Side } from "./config";
import { serveJudge, type JudgeApp } from "./judge";
import { casperDefaultModel, skyn3tModelEnv } from "./model";
import { isPromptSet, pickPrompt, PROMPT_SETS, PROMPTS, SET_MINUTES, type ComparePrompt } from "./prompts";
import {
  appendPick, formatTally, LABELS, loadRun, readPicks, saveRun, shuffleLabels, tally, type RunRecord,
} from "./results";
import { experimentBuild, prepareBaseline, prepareSkyn3t, runCasperSide, runSkyn3tSide, type SideJob, type SideResult } from "./sides";
import { startApp, type RunningApp } from "./start-app";

const USAGE = `Blind A/B/C compare. Side A is Casper v0.2.32, side B is this branch's Casper, side C is
SkyN3t. Each builds the same prompt in its own fresh folder, then you pick the best app on a judge
page that labels them X, Y and Z in a random order.

  bun run compare run <set>      Run one prompt on all three sides, then judge it.
                                 Sets: ${PROMPT_SETS.join(", ")}
  bun run compare judge [run]    Judge a run (default: the newest one not judged yet).
  bun run compare tally          The scoreboard.
  bun run compare prompts        The prompts in each set and how often each was judged.

For run:
  --prompt <id>       This prompt (see prompts) instead of the least-judged one in the set.
  --model <p/m>       Use this model on all three sides without asking.
  --yes               Don't ask; use the model Casper is set to.
  --minutes <n>       Time limit for each side (default: ${PROMPT_SETS.map((set) => `${set} ${SET_MINUTES[set]}`).join(", ")}).
  --skyn3t <folder>   Where SkyN3t is (asked once, then remembered).
  --no-judge          Stop after the sides finish; judge later.
For run and judge:
  --no-open           Print the judge page address instead of opening the browser.
For tally:
  --since YYYY-MM-DD  Only picks from this day on.
  --experiment <sha>  Only picks where side B was this commit.
  --json              The numbers as JSON.

Runs and picks are kept in ~/casper-compare (or $CASPER_COMPARE_HOME), not in the repo.`;

const VALUE_FLAGS = new Set(["prompt", "model", "minutes", "skyn3t", "since", "experiment"]);
const BOOLEAN_FLAGS = new Set(["yes", "no-judge", "no-open", "json", "help"]);
type Flags = Map<string, string | true>;

export function parseArgs(argv: readonly string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h") { flags.set("help", true); continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(name) && inline === undefined) flags.set(name, true);
    else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "") throw new Error(`--${name} needs a value.`);
      flags.set(name, value);
    } else throw new Error(`Unknown option --${name}. See: bun run compare --help`);
  }
  return { positional, flags };
}

const log = (line: string) => console.log(line);
const flag = (flags: Flags, name: string) => { const value = flags.get(name); return typeof value === "string" ? value : undefined; };
const two = (n: number) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;

/** The model for all three sides: Casper's current one unless the person types another. Asked once per run. */
async function chooseModel(flags: Flags): Promise<{ model: string; env: Record<string, string>; via: string }> {
  let model = flag(flags, "model");
  const current = await casperDefaultModel();
  for (let tries = 0; ; tries++) {
    if (!model) {
      if (flags.has("yes")) {
        if (!current) throw new Error("Casper has no model picked yet. Pick one in Casper (/model) or pass --model.");
        model = current;
      } else {
        const answer = await ask(current
          ? `Model for all three sides: ${current}\nPress Enter to use it, or type another (provider/model): `
          : "Casper has no model picked yet. Type one for all three sides (provider/model): ", "--model <provider/model> or --yes");
        model = answer || current;
        if (!model) continue;
      }
    }
    const sky = skyn3tModelEnv(model);
    if ("env" in sky) return { model, ...sky };
    if (flags.has("model") || flags.has("yes") || tries >= 2) throw new Error(sky.error);
    log(sky.error);
    model = undefined;
  }
}

function sideError(job: SideJob, error: unknown): SideResult {
  return { side: job.side, status: job.signal.aborted ? "stopped" : "failed", exitCode: null, minutes: 0, appDir: null, error: (error as Error).message };
}

async function pickCounts(home: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const pick of await readPicks(home)) counts.set(pick.promptId, (counts.get(pick.promptId) ?? 0) + 1);
  return counts;
}

async function resolvePrompt(home: string, set: string | undefined, promptId: string | undefined): Promise<ComparePrompt> {
  if (promptId) {
    const prompt = PROMPTS.find((candidate) => candidate.id === promptId);
    if (!prompt) throw new Error(`No prompt "${promptId}". See: bun run compare prompts`);
    return prompt;
  }
  if (!set || !isPromptSet(set)) throw new Error(`Pick a set: ${PROMPT_SETS.join(", ")} (for example: bun run compare run web).`);
  return pickPrompt(set, await pickCounts(home));
}

async function runCommand(positional: string[], flags: Flags, signal: AbortSignal): Promise<void> {
  const home = compareHome();
  await mkdir(home, { recursive: true });
  const prompt = await resolvePrompt(home, positional[0], flag(flags, "prompt"));
  const minutesFlag = flag(flags, "minutes");
  const minutes = minutesFlag === undefined ? SET_MINUTES[prompt.set] : Number(minutesFlag);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) throw new Error("--minutes must be a number from 1 to 600.");

  const { model, env: skyEnv, via } = await chooseModel(flags);
  const skyn3t = await prepareSkyn3t(home, await loadConfig(home), flag(flags, "skyn3t"));
  const baseline = await prepareBaseline(home, log);
  const experiment = await experimentBuild();
  if (experiment.dirty) log(`Note: this checkout has changes that aren't committed; side B runs them as they are (commit ${experiment.commit}).`);

  const id = `${stamp()}-${prompt.id}`;
  const runDir = path.join(home, "runs", id);
  await mkdir(runDir, { recursive: true });
  const record: RunRecord = {
    v: 1, id, created: new Date().toISOString(), set: prompt.set, promptId: prompt.id, prompt: prompt.text,
    ...(prompt.starter ? { starter: prompt.starter } : {}), model, experiment: { commit: experiment.commit, dirty: experiment.dirty }, skyn3t: { dir: skyn3t.dir, via }, minutes, sides: {}, status: "running",
  };
  await saveRun(runDir, record);
  log("");
  log(`Run ${id}`);
  log(`Prompt: ${prompt.text}`);
  log(`Model: ${model} (SkyN3t uses it through the ${via})`);
  log(`All three sides are working now, up to ${minutes} minutes each. Ctrl-C stops them.`);

  const job = (side: Side): SideJob => ({ side, runDir, prompt, model, timeoutMs: minutes * 60_000, signal });
  const started = performance.now();
  let finished = 0;
  // Which side finished is not printed: it would hint at which app is which on the judge page.
  const heartbeat = setInterval(() => log(`  ... still working: ${3 - finished} of 3 sides, ${Math.round((performance.now() - started) / 60_000)} min so far`), 5 * 60_000);
  const runs: Record<Side, () => Promise<SideResult>> = {
    A: () => runCasperSide(job("A"), baseline),
    B: () => runCasperSide(job("B"), experiment.command),
    C: () => runSkyn3tSide(job("C"), skyn3t.command, skyEnv),
  };
  try {
    await Promise.all(SIDES.map(async (side) => {
      const result = await runs[side]().catch((error) => sideError(job(side), error));
      record.sides[side] = result;
      finished++;
      log(`  ${finished} of 3 sides finished (${Math.round((performance.now() - started) / 60_000)} min)`);
    }));
  } finally { clearInterval(heartbeat); }
  record.status = "ready";
  await saveRun(runDir, record);
  if (signal.aborted) { log(`Stopped. What the sides made so far is in ${runDir}`); return; }
  // A side that fails in its first minute hit a setup problem (sign-in, model name, install), not a quality one.
  const broken = SIDES.map((side) => record.sides[side]!).filter((result) => result.status === "failed" && result.minutes < 1);
  if (broken.length) {
    log("");
    for (const result of broken) log(`Side ${result.side} (${SIDE_NAMES[result.side]}) stopped after ${Math.round(result.minutes * 60)} seconds: ${result.error ?? "see its run.log"}`);
    log("That looks like a setup problem, not a result, so the judge page was not opened.");
    log(`Logs are in ${runDir}. To judge it anyway: bun run compare judge ${id}`);
    return;
  }
  if (flags.has("no-judge")) { log(`Done. Judge it with: bun run compare judge ${id}`); return; }
  await judgeRun(home, runDir, flags, signal);
}

/** Folder names would say which side an app is from (SkyN3t's sits in projects/), so the judge page shows
 * logs with each app folder, then the run folder, replaced by a placeholder. */
export function hideFolders(text: string, runDir: string, appDirs: readonly (string | null)[]): string {
  const folders = [...appDirs.filter((dir): dir is string => Boolean(dir)), runDir].sort((a, b) => b.length - a.length);
  return folders.reduce((out, dir) => out.split(dir).join(dir === runDir ? "<run folder>" : "<app folder>"), text)
    .replace(/<run folder>([\\/])[ABC](?=[\\/])/g, "<run folder>$1<side>");
}

async function judgeRun(home: string, runDir: string, flags: Flags, signal: AbortSignal): Promise<void> {
  const record = await loadRun(runDir);
  if (record.status === "judged") throw new Error(`Run ${record.id} is already judged. See: bun run compare tally`);
  const order = shuffleLabels();
  const apps: JudgeApp[] = [];
  const running: RunningApp[] = [];
  try {
    log("Starting the three apps (installing packages first where needed) ...");
    for (const label of LABELS) {
      const side = order[label];
      const folder = record.sides[side]?.appDir ?? null;
      const app = await startApp(folder, path.join(runDir, side, "start.log"), signal);
      running.push(app);
      const appDirs = SIDES.map((other) => record.sides[other]?.appDir ?? null);
      apps.push({ label, side, url: app.url, ...(app.error ? { error: app.error } : {}), log: hideFolders(app.log, runDir, appDirs), folder });
      log(`  App ${label}: ${app.url ?? `could not start (${app.error})`}`);
      if (signal.aborted) return;
    }
    await serveJudge({
      run: record, apps, open: !flags.has("no-open"), signal, log,
      async save(pick, labels, note) {
        const started = Object.fromEntries(apps.map((app) => [app.side, app.url !== null])) as Record<Side, boolean>;
        await appendPick(home, {
          v: 1, time: new Date().toISOString(), runId: record.id, set: record.set, promptId: record.promptId, model: record.model,
          pick, labels, ...(note ? { note } : {}), experiment: record.experiment, started,
        });
        Object.assign(record, { status: "judged", pick, labels });
        await saveRun(runDir, record);
        log(`Saved: ${pick === "tie" ? "a tie" : `${pick} (${SIDE_NAMES[pick]}) is best`}.`);
        for (const side of SIDES) {
          const result = record.sides[side];
          log(`  ${side} ${SIDE_NAMES[side]}: ${result ? `${result.status}, ${result.minutes} min${result.error ? ` (${result.error})` : ""}` : "no result"}`);
        }
        log("Click Finish on the page (or press Ctrl-C) to stop the apps.");
      },
    });
  } finally {
    await Promise.all(running.map((app) => app.stop()));
  }
}

async function latestUnjudged(home: string): Promise<string> {
  const runs = (await readdir(path.join(home, "runs")).catch(() => [])).sort().reverse();
  for (const id of runs) {
    const record = await loadRun(path.join(home, "runs", id)).catch(() => undefined);
    if (record && record.status !== "judged") return path.join(home, "runs", id);
  }
  throw new Error("No run is waiting to be judged. Start one with: bun run compare run web");
}

async function promptsCommand(): Promise<void> {
  const counts = await pickCounts(compareHome());
  for (const set of PROMPT_SETS) {
    log(`${set} (${SET_MINUTES[set]} min per side)`);
    for (const prompt of PROMPTS.filter((candidate) => candidate.set === set)) {
      log(`  ${prompt.id.padEnd(24)} judged ${counts.get(prompt.id) ?? 0}x${prompt.starter ? `  starts from: ${prompt.starter}` : ""}`);
      log(`    ${prompt.text}`);
    }
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs(argv); } catch (error) { console.error((error as Error).message); return 64; }
  const { positional, flags } = parsed;
  const command = positional.shift();
  if (!command || flags.has("help") || command === "help") { log(USAGE); return command || flags.has("help") ? 0 : 64; }
  const controller = new AbortController();
  let interrupts = 0;
  const onInterrupt = () => {
    if (++interrupts > 1) process.exit(130);
    log("\nStopping (Ctrl-C again to quit at once) ...");
    controller.abort();
  };
  process.on("SIGINT", onInterrupt);
  try {
    if (command === "run") await runCommand(positional, flags, controller.signal);
    else if (command === "judge") {
      const home = compareHome();
      const id = positional[0];
      await judgeRun(home, id ? path.join(home, "runs", path.basename(id)) : await latestUnjudged(home), flags, controller.signal);
    } else if (command === "tally") {
      const result = tally(await readPicks(compareHome()), { since: flag(flags, "since"), experiment: flag(flags, "experiment") });
      log(flags.has("json") ? JSON.stringify(result, null, 2) : formatTally(result));
    } else if (command === "prompts") await promptsCommand();
    else { console.error(`Unknown command "${command}".\n`); log(USAGE); return 64; }
    return controller.signal.aborted ? 130 : 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  } finally { process.off("SIGINT", onInterrupt); }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
