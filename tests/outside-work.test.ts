import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandPlaces, OutsideWork } from "../src/task/outside-work";
import { posixOnly } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

/** A home holding the open folder and a sibling repository, as in ~/Documents/home-app and ~/Documents/sensor-lib. */
async function place() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-outside-")));
  roots.push(root);
  const home = path.join(root, "home"), project = path.join(home, "Documents/home-app"), sibling = path.join(home, "Documents/sensor-lib");
  await mkdir(project, { recursive: true }); await mkdir(path.join(sibling, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: sibling, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  await writeFile(path.join(sibling, "src/api.py"), "a = 1\n"); await writeFile(path.join(sibling, "README.md"), "hi\n");
  git("add", "-A"); git("commit", "-qm", "first");
  return { home, project, sibling, git };
}

test("the folders a command works in: where it starts, cd and pushd, git -C; paths it names", () => {
  // Folders as this system writes them (D:\\h\\Documents\\other on Windows).
  const at = (...parts: string[]) => path.resolve(...parts);
  expect(commandPlaces("cd ~/Documents/other && python3 - <<'EOF'\nx\nEOF", at("/p"), at("/h"))).toEqual({ folders: [at("/p"), at("/h/Documents/other")], paths: [] });
  expect(commandPlaces("git -C ../repo push origin main", at("/p/sub"), at("/h")).folders).toEqual([at("/p/sub"), at("/p/repo")]);
  expect(commandPlaces("cp out.txt /srv/site/index.html && cd $DIR", at("/p"), at("/h"))).toEqual({ folders: [at("/p")], paths: [at("/srv/site/index.html")] });
});

test("Git Bash on Windows writes C:\\Users as /c/Users: a cd there is that folder", () => {
  expect(commandPlaces("cd /c/Users/me/Documents/other && make", "C:\\Users\\me\\Documents\\app", "C:\\Users\\me", "win32").folders)
    .toEqual(["C:\\Users\\me\\Documents\\app", "C:\\Users\\me\\Documents\\other"]);
});

test("a sibling repository a command changed and committed in is listed with its files and commit", async () => {
  const { home, project, sibling, git } = await place();
  const work = new OutsideWork(project, home);
  await work.before("cd ~/Documents/sensor-lib && python3 fix.py", project);
  await work.before("cd ~/Documents/sensor-lib && python3 -m pytest -q", project);
  await writeFile(path.join(sibling, "src/api.py"), "a = 2\n");
  await writeFile(path.join(sibling, "src/sensor.py"), "s = 1\n");
  git("add", "src/api.py"); git("commit", "-qm", "fix");
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: sibling, encoding: "utf8" }).trim();
  const [change, ...more] = await work.finish();
  expect(more).toEqual([]);
  expect(change).toEqual({ place: "~/Documents/sensor-lib", dir: sibling, repository: true, files: ["src/api.py", "src/sensor.py"],
    commits: [expect.stringMatching(new RegExp(`^${commit}`))], testsRun: true });
}, 60_000);

test("an edit tool write outside the project, a plain folder a command worked in, and places left alone", async () => {
  const { home, project, sibling } = await place();
  const plain = path.join(home, "notes"); await mkdir(plain); await writeFile(path.join(plain, "a.txt"), "a\n");
  const untouched = path.join(home, "Documents/untouched"); await mkdir(untouched);
  const work = new OutsideWork(project, home);
  await work.beforeWrite(path.join(sibling, "tests/test_new.py"));
  // As a shell command names a folder: forward slashes, which Git Bash on Windows takes too.
  const shell = (folder: string) => folder.replaceAll("\\", "/");
  await work.before(`cd ${shell(plain)} && sed -i.bak s/a/b/ a.txt`, project);
  await work.before(`cd ${shell(untouched)} && make`, project);
  // Reads, and the project itself, are not followed.
  await work.before("ls ~/Documents/sensor-lib", project);
  await mkdir(path.join(sibling, "tests")); await writeFile(path.join(sibling, "tests/test_new.py"), "t\n");
  await writeFile(path.join(plain, "a.txt"), "b\n");
  expect(await work.finish()).toEqual([
    { place: "~/Documents/sensor-lib", dir: sibling, repository: true, files: ["tests/test_new.py"] },
    { place: "~/notes", dir: plain, repository: false, files: ["a.txt"] },
  ]);
}, 60_000);

posixOnly("an untracked link to a folder in the repository is compared, not a reason to give up on it", async () => {
  const { home, project, sibling } = await place();
  await mkdir(path.join(sibling, "releases/v2"), { recursive: true });
  await symlink("releases/v2", path.join(sibling, "current"));
  const work = new OutsideWork(project, home);
  await work.before("cd ~/Documents/sensor-lib && ./deploy.sh", project);
  await writeFile(path.join(sibling, "src/api.py"), "a = 3\n");
  expect(await work.finish()).toEqual([{ place: "~/Documents/sensor-lib", dir: sibling, repository: true, files: ["src/api.py"] }]);
}, 60_000);
