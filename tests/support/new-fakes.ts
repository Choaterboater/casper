import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Fake uv and bun for `casper new` tests: they log their argv, save their environment, and write
 * what the real init tools write (pyproject.toml, package.json), with no network. git is real.
 */

const FAKE_UV = `#!/bin/sh
printf '%s\\n' "uv $*" >> "$FAKE_DIR/calls.log"
case "$1" in
  --version) echo "uv 0.8.0 (fake)"; exit 0 ;;
  init)
    env > "$FAKE_DIR/uv-init.env"
    if [ -n "$FAKE_INIT_FAIL" ]; then echo "init broke" >&2; exit 2; fi
    name=""; prev=""
    for a in "$@"; do [ "$prev" = "--name" ] && name="$a"; prev="$a"; done
    module=$(printf '%s' "$name" | tr - _)
    printf '[project]\\nname = "%s"\\nversion = "0.1.0"\\n\\n[build-system]\\nrequires = ["uv_build"]\\n' "$name" > pyproject.toml
    printf 'UV README\\n' > README.md
    printf 'FROM-UV\\n' > .gitignore
    mkdir -p "src/$module"
    printf 'def main():\\n    print("hello")\\n' > "src/$module/__init__.py"
    exit 0 ;;
  add)
    if [ -n "$FAKE_OFFLINE" ]; then echo "error: Failed to fetch: https://pypi.org/simple/pytest/ (dns error)" >&2; exit 2; fi
    shift
    printf '# added: %s\\n' "$*" >> pyproject.toml
    : > uv.lock
    if [ -n "$FAKE_MAKE_GIT" ]; then mkdir -p .git/hooks; fi
    exit 0 ;;
  run)
    env > "$FAKE_DIR/uv-run.env"
    shift
    if [ "$1" = "pytest" ]; then
      if [ -n "$FAKE_TEST_FAIL" ]; then echo "FAILED tests/test_cli.py::test_hello - assert 1 == 2"; echo "1 failed in 0.01s"; exit 1; fi
      echo "3 passed in 0.01s"
    fi
    exit 0 ;;
esac
exit 0
`;

const FAKE_BUN = `#!/bin/sh
printf '%s\\n' "bun $*" >> "$FAKE_DIR/calls.log"
case "$1" in
  --version) echo "1.4.0"; exit 0 ;;
  init)
    env > "$FAKE_DIR/bun-init.env"
    # Bun 1.4.0 with BUN_OPTIONS set wrote the project into ./init instead of here.
    if [ -n "$BUN_OPTIONS" ] || [ -n "$FAKE_WRITE_ELSEWHERE" ]; then mkdir -p init; cd init; fi
    printf '{"name":"bun-react-template","scripts":{"dev":"bun --hot src/index.ts"}}\\n' > package.json
    mkdir -p src
    printf 'export function App() { return null; }\\n' > src/App.tsx
    : > bun.lock
    exit 0 ;;
  add) exit 0 ;;
  run)
    env > "$FAKE_DIR/bun-run.env"
    shift
    [ "$1" = "test" ] && echo " 2 pass"
    exit 0 ;;
esac
exit 0
`;

export interface NewFakes {
  root: string;
  /** Fake tools; put first on PATH. */
  bin: string;
  /** Logs and saved environments. */
  logs: string;
  home: string;
  /** ~/Projects. */
  parent: string;
  gitconfig: string;
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
  calls(): Promise<string[]>;
  savedEnv(name: "uv-init" | "uv-run" | "bun-init" | "bun-run"): Promise<Record<string, string>>;
  cleanup(): Promise<void>;
}

/** A temp home with ~/Projects, fake uv/bun, and a git identity unless `identity` is false. */
export async function makeNewFakes(options: { identity?: boolean; tools?: Array<"uv" | "bun"> } = {}): Promise<NewFakes> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-new-"));
  const bin = path.join(root, "bin");
  const logs = path.join(root, "logs");
  const home = path.join(root, "home");
  const parent = path.join(home, "Projects");
  const gitconfig = path.join(root, "gitconfig");
  await mkdir(bin);
  await mkdir(logs);
  await mkdir(parent, { recursive: true });
  const tools = options.tools ?? ["uv", "bun"];
  if (tools.includes("uv")) await writeFile(path.join(bin, "uv"), FAKE_UV);
  if (tools.includes("bun")) await writeFile(path.join(bin, "bun"), FAKE_BUN);
  for (const tool of tools) await chmod(path.join(bin, tool), 0o755);
  await writeFile(gitconfig, options.identity === false ? "" : "[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  // Only system folders after the fakes: a real uv or bun on the developer's PATH must never run.
  const systemPath = ["/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter);
  return {
    root, bin, logs, home, parent, gitconfig,
    env: (extra = {}) => ({
      PATH: `${bin}${path.delimiter}${systemPath}`,
      HOME: home,
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_NOSYSTEM: "1",
      FAKE_DIR: logs,
      ...extra,
    }),
    calls: async () => (await readFile(path.join(logs, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean),
    savedEnv: async (name) => Object.fromEntries((await readFile(path.join(logs, `${name}.env`), "utf8")).split("\n")
      .filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
