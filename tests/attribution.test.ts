import { expect, test } from "bun:test";
import { attributeChanges, movedElsewhere, withoutFiles, WriteWindows } from "../src/task/attribution";

/** Times by path under the fake root "/r" (path.join writes it \r on Windows). */
const at = (times: Record<string, number | undefined>) => async (absolute: string) => times[absolute.replaceAll("\\", "/").replace(/^\/r\/?/, "") || "."];
const none = { added: [], modified: [], removed: [] };

test("a change while a writing tool ran is the task's; one while none ran is another program's", async () => {
  const split = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]],
    changes: { ...none, added: ["new.py", "PROJECT_SUMMARY.md"], modified: ["app.py"] },
    changedAt: at({ "new.py": 11_000, "PROJECT_SUMMARY.md": 30_000, "app.py": 13_500 }) });
  expect(split).toEqual({ task: ["app.py", "new.py"], others: ["PROJECT_SUMMARY.md"], unsure: [] });
});

test("the task's own edit and write tools, a time from before the task, and an unreadable time", async () => {
  const split = await attributeChanges({ root: "/r", since: 5_000, until: 60_000, windows: [[10_000, 12_000]], toolFiles: new Set(["named.py"]),
    changes: { ...none, added: ["named.py", "unpacked.py", "gone.py"] },
    changedAt: at({ "named.py": 40_000, "unpacked.py": 100, "gone.py": undefined }) });
  // A file the edit tool named is the task's whatever its time; an archive's old time says nothing.
  expect(split).toEqual({ task: ["named.py", "unpacked.py"], others: [], unsure: ["gone.py"] });
});

test("a deleted file goes by its folder's time; while a command or service the task left runs, Casper can't tell", async () => {
  const removed = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]],
    changes: { ...none, removed: ["src/a.py", "docs/b.md"] }, changedAt: at({ src: 11_000, docs: 30_000 }) });
  expect(removed).toEqual({ task: ["src/a.py"], others: [], unsure: ["docs/b.md"] });
  const running = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], unsure: true,
    changes: { ...none, modified: ["data/export.csv"] }, changedAt: at({ "data/export.csv": 30_000 }) });
  expect(running).toEqual({ task: [], others: [], unsure: ["data/export.csv"] });
});

test("tool windows: an end without a start counts from the last end; a picture is held until released", () => {
  const windows = new WriteWindows(100);
  windows.start("a", false, 200); windows.end("a", 300);
  windows.end("b", 500);
  windows.start("p", true, 600); windows.end("p", 650);
  expect(windows.windows(900)).toEqual([[200, 300], [300, 500], [600, 900]]);
  windows.release(1_000);
  expect(windows.windows(2_000)).toEqual([[200, 300], [300, 500], [600, 1_000]]);
});

test("another program's files are left out of a later copy only while they are as it left them", () => {
  const before = new Map([["a", "1"]]);
  const found = new Map([["a", "2"], ["b", "x"]]);
  expect(withoutFiles(found, before, ["a", "b"])).toEqual(new Map([["a", "1"]]));
  // Changed again afterwards (by the task's checks, say): that change counts.
  expect(withoutFiles(new Map([["a", "3"], ["b", "x"]]), before, ["a", "b"], found)).toEqual(new Map([["a", "3"]]));
});

test("a running app's database and log are the app's even while the AI's command runs, unless the command names them", async () => {
  const changes = { ...none, modified: ["config/home-assistant_v2.db", "config/home-assistant_v2.db-wal", "config/home-assistant.log", "config/automations.yaml"],
    added: ["config/home-assistant_v2.db-shm", "logs/app.log.1", "logs/app.log.2.gz"], removed: ["config/home-assistant_v2.db-journal"] };
  const during = at(Object.fromEntries([...changes.modified, ...changes.added].map((file) => [file, 11_000])));
  const split = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], changes, changedAt: during,
    commands: ["docker compose restart homeassistant"] });
  expect(split.task).toEqual(["config/automations.yaml"]);
  expect(split.others).toEqual(["config/home-assistant.log", "config/home-assistant_v2.db", "config/home-assistant_v2.db-journal",
    "config/home-assistant_v2.db-shm", "config/home-assistant_v2.db-wal", "logs/app.log.1", "logs/app.log.2.gz"]);
  // A command that works on the database (or the edit tool on the log) keeps them the task's.
  const named = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], changes, changedAt: during,
    commands: ["sqlite3 config/home-assistant_v2.db 'DELETE FROM states WHERE 1'"], toolFiles: new Set(["logs/app.log.1"]) });
  expect(named.task).toEqual(["config/automations.yaml", "config/home-assistant_v2.db", "config/home-assistant_v2.db-shm", "config/home-assistant_v2.db-wal", "logs/app.log.1"]);
});

test("files a job from an earlier task keeps writing are its own, even while this task's command reads them", async () => {
  // The smoke session's "is it still runing?": the comparison runner (started two tasks before) wrote its log and its JSON
  // between the tasks, and again while the AI's `tail logs/casper.stderr.log` ran.
  const changes = { ...none, modified: ["logs/casper.json", "logs/casper.stderr.log", "notes.txt"] };
  const during = at({ "logs/casper.json": 11_000, "logs/casper.stderr.log": 11_500, "notes.txt": 11_200 });
  const split = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], changes, changedAt: during,
    commands: ["cat compare.out; ps -axo pid=,etime=,command=; tail -c 600 logs/casper.stderr.log"],
    liveFiles: new Set(["logs/casper.json", "logs/casper.stderr.log", "compare.out"]) });
  expect(split).toEqual({ task: ["notes.txt"], others: ["logs/casper.json", "logs/casper.stderr.log"], unsure: [] });
  // The AI's own edit of one keeps it the task's.
  const edited = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], changes, changedAt: during,
    liveFiles: new Set(["logs/casper.json"]), toolFiles: new Set(["logs/casper.json"]) });
  expect(edited.task).toContain("logs/casper.json");
});

test("a server log in results/ written while the AI's command ran is that command's output; one written between commands is not", async () => {
  // The comparison's "re run the test for test 4": `node evaluate.mjs` started each build's server, which logged into
  // results/checks/. The command never names the log, and a log is a running app's by default; in a run's own output
  // folder (builds/, runs/, results/) its time decides, as for any other file. An app's log in logs/ is still the app's.
  const changes = { ...none, modified: ["results/checks/A.server.log", "results/checks/B.server.log", "logs/app.log"] };
  const split = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], changes,
    changedAt: at({ "results/checks/A.server.log": 11_000, "results/checks/B.server.log": 30_000, "logs/app.log": 11_000 }), commands: ["node evaluate.mjs"] });
  expect(split).toEqual({ task: ["results/checks/A.server.log"], others: ["logs/app.log", "results/checks/B.server.log"], unsure: [] });
});

test("a log the task moved into another folder is the task's: the move was its command, whatever wrote the log", async () => {
  // `mv builds runs results logs run-3/`: the logs moved with the rest, their times from before the task.
  const changes = { ...none, added: ["run-3/logs/omp.stderr.log", "run-3/results/checks/A.server.log", "logs/app.log.1"], removed: ["logs/omp.stderr.log"] };
  const split = await attributeChanges({ root: "/r", since: 5_000, until: 60_000, windows: [[10_000, 12_000]], changes,
    changedAt: at({ "run-3/logs/omp.stderr.log": 1_000, "run-3/results/checks/A.server.log": 2_000, "logs/app.log.1": 30_000, logs: 11_000 }),
    commands: ["mkdir run-3 && mv builds runs results logs run-3/"], liveFiles: new Set(["logs/omp.stderr.log"]),
    moved: new Set(["run-3/logs/omp.stderr.log", "run-3/results/checks/A.server.log", "logs/omp.stderr.log"]) });
  // A rotated log (app.log to app.log.1 in its own folder) is not a move into another folder: still the app's.
  expect(split).toEqual({ task: ["logs/omp.stderr.log", "run-3/logs/omp.stderr.log", "run-3/results/checks/A.server.log"], others: ["logs/app.log.1"], unsure: [] });
});

test("moved elsewhere: into another folder, both ends when the old path is gone; a rename in its own folder is not", () => {
  const changes = { added: ["run-3/logs/omp.stderr.log", "run-3/results/checks/A.server.log", "logs/app.log.1"], modified: ["results/checks/A.server.log", "logs/app.log"], removed: ["logs/omp.stderr.log"] };
  expect([...movedElsewhere([{ from: "logs/omp.stderr.log", to: "run-3/logs/omp.stderr.log" }, { from: "results/checks/A.server.log", to: "run-3/results/checks/A.server.log" },
    { from: "logs/app.log", to: "logs/app.log.1" }], changes)].sort())
    .toEqual(["logs/omp.stderr.log", "run-3/logs/omp.stderr.log", "run-3/results/checks/A.server.log"]);
});
