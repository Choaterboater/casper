/**
 * Coming back to a walk-away job (decision 51): the start's row offers what a job left (a result to see, a question to
 * answer, one still working), /jobs lists them, and plain words ("how's my job", "keep going after I leave") need no
 * command. No model; nothing here starts one.
 */
import path from "node:path";
import type { CasperApp } from "../app";
import { open } from "node:fs/promises";
import { jobLog, listJobs, readJob, writeAnswer, writeJob, type JobRecord, type ListedJob } from "../jobs/store";
import { tildePath } from "../new/scaffold";
import { ReceiptStore } from "../task/receipts";
import { formatDuration, terminalText } from "../tui/format";
import { buildNextRow, type NextItem } from "../tui/next-row";

const USAGE = "Usage: /jobs | /jobs show <job> | /jobs answer <job>";

/** "12m ago", "just now". */
function ago(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  return !Number.isFinite(ms) || ms < 60_000 ? "just now" : `${formatDuration(Math.floor(ms / 60_000) * 60_000)} ago`;
}

const plain = (text: string, max = 80) => terminalText(text).replace(/\s+/g, " ").trim().slice(0, max);
const ref = (job: ListedJob) => job.here ? job.record.id : `${job.key}/${job.record.id}`;

/** The plain status of one job: "done 12m ago", "waiting on you: Run this command?", "working for 3m". */
export function jobState(record: JobRecord, now = Date.now()): string {
  if (record.status === "waiting") return `waiting on you: ${plain(record.question?.question ?? "a question", 60)}`;
  if (record.status === "running") return `working · left ${ago(record.leftAt, now)}`;
  const when = ago(record.endedAt ?? record.updatedAt, now);
  return record.status === "done" ? `done ${when}` : `stopped ${when}: ${plain(record.why ?? "", 80)}`;
}

async function jobs(app: CasperApp): Promise<ListedJob[]> {
  const here = app.projectContext ? path.basename(app.projectContext.stateDirectory) : undefined;
  return listJobs(app.homeDir(), here).catch(() => []);
}

/** At most two keys for the start's row: a question waiting first, then a result you haven't seen, then a job working
 * here. A job elsewhere names its folder. */
export async function jobRowItems(app: CasperApp): Promise<NextItem[]> {
  const listed = await jobs(app);
  const where = (job: ListedJob) => job.here ? "" : ` in ${plain(job.record.folder, 30)}`;
  const items: NextItem[] = [
    ...listed.filter((job) => job.record.status === "waiting").map((job) => ({ label: `Answer the job's question${where(job)}`,
      command: `/jobs answer ${ref(job)}`, note: plain(job.record.request, 50) })),
    ...listed.filter((job) => (job.record.status === "done" || job.record.status === "stopped") && !job.record.seen).map((job) => ({
      label: `See the job's result${where(job)}`, command: `/jobs show ${ref(job)}`,
      note: `${plain(job.record.request, 50)} · ${job.record.status === "done" ? "done" : "stopped"}` })),
    ...listed.filter((job) => job.here && job.record.status === "running").map((job) => ({ label: "Job working here", command: "/jobs",
      note: `${plain(job.record.request, 50)} · left ${ago(job.record.leftAt)}` })),
  ];
  return items.slice(0, 2);
}

async function find(app: CasperApp, wanted: string): Promise<ListedJob | undefined> {
  const listed = await jobs(app);
  return listed.find((job) => ref(job) === wanted || (job.here && job.record.id === wanted));
}

/** The last `lines` lines of a job's log (its last 16 KiB), each one printable. */
export async function logTail(file: string, lines = 12): Promise<string> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return "";
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 16 * 1024);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, size - length);
    const text = bytes.toString("utf8").split("\n").slice(size > length ? 1 : 0);
    return text.map((line) => terminalText(line).replace(/\s+$/, "")).filter(Boolean).slice(-lines).join("\n");
  } finally { await handle.close(); }
}

/** A job working in this folder: its conversation is its own until it ends (src/app/earlier-conversation.ts). */
export async function jobWorkingHere(app: CasperApp): Promise<boolean> {
  return (await jobs(app)).some((job) => job.here && (job.record.status === "running" || job.record.status === "waiting"));
}

/** /jobs: what each job is doing or did, this folder's first; the row picks one with a key. */
async function listCommand(app: CasperApp): Promise<void> {
  const listed = (await jobs(app)).slice(0, 9);
  if (!listed.length) {
    app.output.write("[jobs] No jobs. A task keeps going on its own when its terminal closes or SSH drops (macOS and Linux).\n");
    return;
  }
  app.output.write(`Jobs, this folder first:\n${listed.map((job, index) =>
    `  ${index + 1}  ${plain(job.record.request, 50)} · ${jobState(job.record)}${job.here ? "" : ` · ${plain(job.record.folder, 30)}`}`).join("\n")}\n`);
  if (!app.interactive) return;
  app.terminal.offerNext(buildNextRow({ more: listed.map((job) => job.record.status === "waiting"
    ? { label: "Answer", command: `/jobs answer ${ref(job)}`, note: plain(job.record.request, 30) }
    : { label: job.record.status === "running" ? "Look" : "See result", command: `/jobs show ${ref(job)}`, note: plain(job.record.request, 30) }) }));
}

/** /jobs show <job>: the AI's last words and the receipt. In the job's own folder the receipt is the saved one, with
 * its Show diff and Undo keys; elsewhere its lines, and where those keys are. A finished job is then marked seen. */
async function showCommand(app: CasperApp, wanted: string): Promise<void> {
  const job = await find(app, wanted);
  if (!job) { app.output.write(`[jobs] No job ${terminalText(wanted)}. /jobs lists them.\n`); return; }
  const { record } = job;
  app.output.write(`[jobs] ${plain(record.request)} · ${jobState(record)}${job.here ? "" : ` · in ${terminalText(tildePath(record.root, app.homeDir()))}`}\n`);
  if (record.status === "running" || record.status === "waiting") {
    // What it is doing: the last lines of its log, secrets hidden as on the screen it would have had.
    const tail = await logTail(jobLog(job.directory, record.id));
    if (tail) app.output.write(`Lately:\n${tail.split("\n").map((line) => `  ${line}`).join("\n")}\n`);
    if (record.status === "waiting" && app.interactive) app.terminal.offerNext(buildNextRow({ more: [{ label: "Answer the job's question", command: `/jobs answer ${ref(job)}` }] }));
    return;
  }
  if (record.answer) app.output.write(`${terminalText(record.answer).trimEnd()}\n`);
  const n = record.receipt?.n;
  if (job.here && n && app.projectContext) {
    await app.taskUndo.receipt(String(n));
    const saved = await new ReceiptStore(app.projectContext.stateDirectory).get(n).catch(() => "missing" as const);
    const task = typeof saved === "object" && saved.task ? { ...saved.task, receipt: n } : undefined;
    if (task && app.interactive) app.terminal.offerNext(buildNextRow(app.taskUndo.nextItems(task)));
  } else {
    if (record.receipt?.text) app.output.write(`${terminalText(record.receipt.text).trimEnd()}\n`);
    if (!job.here && n) app.output.write(`Show diff and Undo for it (task ${n}) are in ${terminalText(tildePath(record.root, app.homeDir()))}.\n`);
  }
  if (!record.seen) await writeJob(job.directory, { ...record, seen: true }).catch(() => {});
}

/** /jobs answer <job>: the question the job holds, in the same box; your answer goes to the job, which carries on. */
async function answerCommand(app: CasperApp, wanted: string): Promise<void> {
  const job = await find(app, wanted);
  const question = job?.record.status === "waiting" ? job.record.question : undefined;
  if (!job || !question) { app.output.write(`[jobs] ${job ? "That job isn't waiting on you any more." : `No job ${terminalText(wanted)}.`} /jobs lists them.\n`); return; }
  if (!app.interactive || !app.terminal.canAsk) { app.output.write("[jobs] Its question needs Casper open in a terminal.\n"); return; }
  app.output.write(`[jobs] ${plain(job.record.request)}${job.here ? "" : ` · in ${terminalText(tildePath(job.record.root, app.homeDir()))}`} asks:\n`);
  const signal = app.commandAbort?.signal;
  let picked: string[] | undefined, note: string | undefined;
  if (question.kind === "approve") {
    // A note typed with No goes to the job's AI, never to a task here.
    const answer = await app.terminal.withNote((line) => { note = line; },
      () => app.terminal.approve(question.preview ?? "", question.question, question.choices, signal));
    picked = answer === undefined ? undefined : [answer];
  } else if (question.kind === "line") {
    const answer = await app.terminal.askLine(question.question, question.hint ?? "", signal);
    picked = answer ? [answer] : undefined;
  } else if (question.kind === "pick" && !question.typed) {
    if (question.preview) app.output.write(`${terminalText(question.preview).trimEnd()}\n`);
    const answer = await app.terminal.pick(question.question, question.choices, signal);
    picked = answer === undefined ? undefined : [answer];
  } else {
    if (question.preview) app.output.write(`${terminalText(question.preview).trimEnd()}\n`);
    picked = await app.terminal.ask(question.question, question.choices, question.multi === true, signal, question.from ?? "casper");
  }
  if (picked === undefined) { app.output.write("[jobs] Not answered; the job keeps waiting, and the row offers it next time.\n"); return; }
  // The job may have stopped waiting meanwhile (its own limit, or another terminal answered first).
  const now = await readJob(job.directory, job.record.id);
  if (now?.status !== "waiting" || now.question?.id !== question.id) { app.output.write("[jobs] That job isn't waiting on you any more; nothing was sent.\n"); return; }
  await writeAnswer(job.directory, job.record.id, { question: question.id, picked, ...(note ? { note } : {}) });
  app.output.write("[jobs] Sent. The job carries on; you'll hear when it ends.\n");
}

/** /jobs [show|answer <job>]. Runs during a task too. */
export async function jobsCommand(app: CasperApp, args: string): Promise<void> {
  const [action, wanted, ...extra] = args.split(/\s+/).filter(Boolean);
  if (!action || action === "list") { if (wanted) app.output.write(`${USAGE}\n`); else await listCommand(app); return; }
  if ((action !== "show" && action !== "answer") || !wanted || extra.length) { app.output.write(`${USAGE}\n`); return; }
  if (action === "show") await showCommand(app, wanted); else await answerCommand(app, wanted);
}

const POLITE = String.raw`(?:(?:please|pls|ok|okay|casper|and)[,\s]+)*`;
/** "keep going after I leave", "finish this while I'm away", "I'm heading out, keep working": only that, nothing else. */
const LEAVING = new RegExp(String.raw`^${POLITE}(?:(?:keep\s+(?:going|working)|carry\s+on|finish(?:\s+(?:this|it|up))?|continue)\s+(?:after|when|once|while)\s+i(?:'m|\s+am)?\s+(?:leave|go|gone|away|out|close\s+(?:the|this)\s+(?:terminal|laptop|lid))|i'?m\s+(?:leaving|heading\s+out|going\s+(?:home|out))(?:[,\s]+(?:so\s+)?(?:keep\s+(?:going|working)|carry\s+on|finish\s+(?:this|it|up)))?)$`, "i");
/** "how's my job", "is the job done", "what is the job waiting on", "job status". */
const STATUS = new RegExp(String.raw`^${POLITE}(?:how(?:'s|\s+is)\s+(?:my|the)\s+job(?:\s+going)?|is\s+(?:my|the)\s+job\s+(?:done|finished|still\s+(?:going|running|working))|what(?:'s|\s+is)\s+(?:my|the)\s+job\s+(?:doing|waiting\s+(?:on|for))|(?:my\s+|the\s+)?jobs?\s+status|show\s+(?:me\s+)?(?:my|the)\s+jobs?)$`, "i");

function words(line: string, pasted: readonly string[]): string | undefined {
  if (pasted.some(Boolean) || line.length > 80 || /[\r\n]/.test(line.trim())) return undefined;
  return line.trim().replace(/\s*[.!?]+$/, "").trim();
}

/** The whole typed line only says you are leaving and the work should go on. */
export function leavingWords(line: string, pasted: readonly string[] = []): boolean {
  const text = words(line, pasted);
  return text !== undefined && LEAVING.test(text);
}

/** The whole typed line only asks how a job is going. */
export function jobStatusWords(line: string, pasted: readonly string[] = []): boolean {
  const text = words(line, pasted);
  return text !== undefined && STATUS.test(text);
}

/** What Casper says to "keep going after I leave": nothing to set, and what happens on this computer. */
export function leavingReply(platform: NodeJS.Platform = process.platform, working = false): string {
  if (platform === "win32") return "[jobs] On Windows, closing this window stops the task. Leave it open until the task ends.\n";
  return `[jobs] ${working ? "It will" : "A task will"}: close the terminal whenever, or lose SSH, and it keeps going on this computer while it's awake. `
    + "Anything that would ask you waits for you, a notification says when it ends or needs you, and the next Casper you open shows the result.\n";
}
