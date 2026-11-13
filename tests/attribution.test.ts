import { expect, test } from "bun:test";
import { attributeChanges, moveFolders, movedElsewhere, withoutFiles, WriteWindows } from "../src/task/attribution";

/** Times by path under the fake root "/r" (path.join writes it \r on Windows). */
const at = (times: Record<string, number | undefined>) => async (absolute: string) => times[absolute.replaceAll("\\", "/").replace(/^\/r\/?/, "") || "."];
const none = { added: [], modified: [], removed: [] };

test("a change while a writing tool ran is the task's; one while none ran is another program's", async () => {
  const split = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]],
    changes: { ...none, added: ["new.py", "PROJECT_SUMMARY.md"], modified: ["app.py"] },
    changedAt: at({ "new.py": 11_000, "PROJECT_SUMMARY.md": 30_000, "app.py": 13_500 }) });
  expect(split).toEqual({ task: ["app.py", "new.py"], others: ["PROJECT_SUMMARY.md"], unsure: [] , testData: [] });
});

test("the task's own edit and write tools, a time from before the task, and an unreadable time", async () => {
  const split = await attributeChanges({ root: "/r", since: 5_000, until: 60_000, windows: [[10_000, 12_000]], toolFiles: new Set(["named.py"]),
    changes: { ...none, added: ["named.py", "unpacked.py", "gone.py"] },
    changedAt: at({ "named.py": 40_000, "unpacked.py": 100, "gone.py": undefined }) });
  // A file the edit tool named is the task's whatever its time; an archive's old time says nothing.
  expect(split).toEqual({ task: ["named.py", "unpacked.py"], others: [], unsure: ["gone.py"] , testData: [] });
});

test("a deleted file goes by its folder's time; while a command or service the task left runs, Casper can't tell", async () => {
  const removed = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]],
    changes: { ...none, removed: ["src/a.py", "docs/b.md"] }, changedAt: at({ src: 11_000, docs: 30_000 }) });
  expect(removed).toEqual({ task: ["src/a.py"], others: [], unsure: ["docs/b.md"] , testData: [] });
  const running = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], unsure: true,
    changes: { ...none, modified: ["data/export.csv"] }, changedAt: at({ "data/export.csv": 30_000 }) });
  expect(running).toEqual({ task: [], others: [], unsure: ["data/export.csv"] , testData: [] });
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
  expect(split).toEqual({ task: ["notes.txt"], others: ["logs/casper.json", "logs/casper.stderr.log"], unsure: [] , testData: [] });
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
  expect(split).toEqual({ task: ["results/checks/A.server.log"], others: ["logs/app.log", "results/checks/B.server.log"], unsure: [] , testData: [] });
});

test("a log the task moved into another folder is the task's: the move was its command, whatever wrote the log", async () => {
  // `mv builds runs results logs run-3/`: the logs moved with the rest, their times from before the task.
  const changes = { ...none, added: ["run-3/logs/omp.stderr.log", "run-3/results/checks/A.server.log", "logs/app.log.1"], removed: ["logs/omp.stderr.log"] };
  const split = await attributeChanges({ root: "/r", since: 5_000, until: 60_000, windows: [[10_000, 12_000]], changes,
    changedAt: at({ "run-3/logs/omp.stderr.log": 1_000, "run-3/results/checks/A.server.log": 2_000, "logs/app.log.1": 30_000, logs: 11_000 }),
    commands: ["mkdir run-3 && mv builds runs results logs run-3/"], liveFiles: new Set(["logs/omp.stderr.log"]),
    moved: new Set(["run-3/logs/omp.stderr.log", "run-3/results/checks/A.server.log", "logs/omp.stderr.log"]) });
  // A rotated log (app.log to app.log.1 in its own folder) is not a move into another folder: still the app's.
  expect(split).toEqual({ task: ["logs/omp.stderr.log", "run-3/logs/omp.stderr.log", "run-3/results/checks/A.server.log"], others: ["logs/app.log.1"], unsure: [] , testData: [] });
});

test("a move goes by the folder that took it: a moved file's own time from just before the task says nothing", async () => {
  // `mkdir run-1 && mv runs run-1/` 2.3 s into the task: the file keeps its time from 50 ms before the task began.
  const moves = [{ from: "runs/a.txt", to: "run-1/runs/a.txt" }];
  const changes = { ...none, added: ["run-1/runs/a.txt"], removed: ["runs/a.txt"] };
  const input = { root: "/r", since: 1_000, until: 60_000, windows: [[3_300, 3_400]] as const, changes, moved: movedElsewhere(moves, changes), movedInto: moveFolders(moves) };
  const split = await attributeChanges({ ...input, changedAt: at({ "run-1/runs/a.txt": 950, "run-1/runs": 950, "run-1": 3_350, runs: 3_350 }) });
  expect(split).toEqual({ task: ["run-1/runs/a.txt", "runs/a.txt"], others: [], unsure: [], testData: [] });
  // Moved in while none of the task's tools ran: another program's, as before.
  const elsewhere = await attributeChanges({ ...input, changedAt: at({ "run-1/runs/a.txt": 950, "run-1/runs": 950, "run-1": 30_000, ".": 30_000, runs: 30_000 }) });
  expect(elsewhere.others).toEqual(["run-1/runs/a.txt"]);
  // Only the folders up to the one that took it count: a change to the project's own folder during the task does not.
  const above = await attributeChanges({ ...input, changedAt: at({ "run-1/runs/a.txt": 950, "run-1/runs": 950, "run-1": 30_000, ".": 3_350, runs: 3_350 }) });
  expect(above.others).toEqual(["run-1/runs/a.txt"]);
});

test("the folder that took a move: the moved entry's new parent, never a rename in its own folder", () => {
  expect(Object.fromEntries(moveFolders([{ from: "runs/casper/app.js", to: "run-1/runs/casper/app.js" }, { from: "a.txt", to: "archive/a.txt" },
    { from: "x/old.txt", to: "y/new.txt" }, { from: "deep/a/b.txt", to: "a/b.txt" }, { from: "logs/app.log", to: "logs/app.log.1" }])))
    .toEqual({ "run-1/runs/casper/app.js": "run-1", "archive/a.txt": "archive", "y/new.txt": "y", "a/b.txt": "." });
});

test("moved elsewhere: into another folder, both ends when the old path is gone; a rename in its own folder is not", () => {
  const changes = { added: ["run-3/logs/omp.stderr.log", "run-3/results/checks/A.server.log", "logs/app.log.1"], modified: ["results/checks/A.server.log", "logs/app.log"], removed: ["logs/omp.stderr.log"] };
  expect([...movedElsewhere([{ from: "logs/omp.stderr.log", to: "run-3/logs/omp.stderr.log" }, { from: "results/checks/A.server.log", to: "run-3/results/checks/A.server.log" },
    { from: "logs/app.log", to: "logs/app.log.1" }], changes)].sort())
    .toEqual(["logs/omp.stderr.log", "run-3/logs/omp.stderr.log", "run-3/results/checks/A.server.log"]);
});

test("a new data file the task's own commands could have written is the task's test data, never another program's", async () => {
  // Run 8: the AI started its own server (`PORT=3456 node src/server.js &`) and signed up through it. data/tracker.db and
  // its -wal and -shm were new, written while no tool of the AI's ran, and the receipt called them "Changed by
  // something else"; the build shipped them with a user in them.
  const changes = { ...none, added: ["data/tracker.db", "data/tracker.db-wal", "data/tracker.db-shm", "db/seed-run.json", "src/server.js", "builds/A/data/app.db"] };
  const between = at({ "data/tracker.db": 30_000, "data/tracker.db-wal": 30_000, "data/tracker.db-shm": 30_000, "db/seed-run.json": 30_000, "src/server.js": 11_000, "builds/A/data/app.db": 30_000 });
  const split = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], changes, changedAt: between,
    commands: ["PORT=3456 node src/server.js &"], ownRuns: true });
  expect(split.testData).toEqual(["data/tracker.db", "data/tracker.db-shm", "data/tracker.db-wal", "db/seed-run.json"]);
  expect(split.task).toEqual(["data/tracker.db", "data/tracker.db-shm", "data/tracker.db-wal", "db/seed-run.json", "src/server.js"]);
  // A comparison's output folder is that program's, as before.
  expect(split.others).toEqual(["builds/A/data/app.db"]);
  // With no command, service or browser of its own, a new database is still another program's.
  expect((await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], changes, changedAt: between })).testData).toEqual([]);
  // A database that was there before the task is a running app's (the Home Assistant case), even its new -wal.
  const live = await attributeChanges({ root: "/r", since: 1_000, until: 60_000, windows: [[10_000, 12_000]], changedAt: between, ownRuns: true,
    changes: { ...none, modified: ["config/home-assistant_v2.db"], added: ["config/home-assistant_v2.db-wal"] } });
  expect(live).toEqual({ task: [], others: ["config/home-assistant_v2.db", "config/home-assistant_v2.db-wal"], unsure: [], testData: [] });
});
