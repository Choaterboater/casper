import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectInfo } from "../src/project/inspect";
import { loadProjectModel } from "../src/project/model";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function project(files: Record<string, string>, folders: string[] = []): Promise<ProjectInfo> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-python-")); dirs.push(root);
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  for (const folder of folders) await mkdir(path.join(root, folder), { recursive: true });
  return { root, name: path.basename(root), isGit: false } as ProjectInfo;
}
async function commands(files: Record<string, string>, folders: string[] = []) {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-python-home-")); dirs.push(home);
  return (await loadProjectModel(await project(files, folders), { homeDir: home })).commands;
}
const venvPython = process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python";
const systemPython = process.platform === "win32" ? "python" : "python3";

test("a uv project runs its tools through uv, and bare mypy when [tool.mypy] lists its files", async () => {
  expect(await commands({ "uv.lock": "", "pyproject.toml": '[dependency-groups]\ndev = ["pytest>=9", "ruff", "mypy"]\n[tool.mypy]\nstrict = true\nfiles = [\n  "src/app/core.py",\n]\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' }))
    .toMatchObject({ test: "uv run pytest", lint: "uv run ruff check .", typecheck: "uv run mypy" });
  expect((await commands({ "uv.lock": "", "pyproject.toml": '[dependency-groups]\ndev = ["mypy"]\n[tool.mypy]\nstrict = true\n' })).typecheck).toBe("uv run mypy .");
});

test("a poetry project runs through poetry, even before its lock file exists", async () => {
  expect(await commands({ "pyproject.toml": '[tool.poetry]\nname = "x"\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n' }))
    .toMatchObject({ test: "poetry run pytest" });
});

test("a plain pyproject uses the project's .venv when there is one, else python3 -m", async () => {
  expect((await commands({ "pyproject.toml": '[project]\nname = "x"\n[project.optional-dependencies]\ndev = ["pytest"]\n' }, [".venv/bin"])).test)
    .toBe(`${venvPython} -m pytest`);
  expect((await commands({ "pyproject.toml": '[project]\nname = "x"\n[project.optional-dependencies]\ndev = ["pytest", "ruff"]\n' })))
    .toMatchObject({ test: `${systemPython} -m pytest`, lint: `${systemPython} -m ruff check .` });
});

test("requirements files alone give a test command when they list pytest", async () => {
  const detected = await commands({ "requirements.txt": "requests==2.32\n", "requirements-dev.txt": "# tooling\npytest==8.4.2\npyflakes==3.4.0\n", "tests/test_a.py": "" });
  expect(detected.test).toBe(`${systemPython} -m pytest`);
  expect(await commands({ "requirements.txt": "requests\n" })).toEqual({});
});

test("adding a requirements file or a .venv invalidates the cached detection", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-python-home-")); dirs.push(home);
  const info = await project({ "requirements.txt": "requests\n" });
  expect((await loadProjectModel(info, { homeDir: home })).commands.test).toBeUndefined();
  await writeFile(path.join(info.root, "requirements-dev.txt"), "pytest\n");
  expect((await loadProjectModel(info, { homeDir: home })).commands.test).toBe(`${systemPython} -m pytest`);
  await mkdir(path.join(info.root, ".venv"));
  expect((await loadProjectModel(info, { homeDir: home })).commands.test).toBe(`${venvPython} -m pytest`);
});

test("a Python project with test_*.py files and no pytest runs them with unittest", async () => {
  const unit = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n";
  expect((await commands({ "pyproject.toml": '[project]\nname = "sample-tools"\n', "tests/test_sites.py": unit })).test)
    .toBe(`${systemPython} -m unittest discover -s tests`);
  expect((await commands({ "requirements.txt": "requests\n", "test_main.py": unit })).test).toBe(`${systemPython} -m unittest discover`);
  // uv and poetry have no `unittest` program: the project's interpreter runs the module.
  expect((await commands({ "uv.lock": "", "pyproject.toml": '[project]\nname = "x"\n', "tests/test_a.py": unit })).test)
    .toBe("uv run python -m unittest discover -s tests");
  expect((await commands({ "poetry.lock": "", "pyproject.toml": '[tool.poetry]\nname = "x"\n', "tests/test_a.py": unit })).test)
    .toBe("poetry run python -m unittest discover -s tests");
  // unittest would run none of these and still say OK: pytest-style tests, and foo_test.py (not its pattern).
  expect((await commands({ "pyproject.toml": '[project]\nname = "x"\n', "tests/test_a.py": "def test_a():\n    assert True\n" })).test).toBeUndefined();
  expect((await commands({ "pyproject.toml": '[project]\nname = "x"\n', "tests/sites_test.py": unit })).test).toBeUndefined();
  // pytest still wins when the project names it; no test files, no command.
  expect((await commands({ "pyproject.toml": '[project]\nname = "x"\ndependencies = ["pytest"]\n', "tests/test_a.py": "" })).test).toBe(`${systemPython} -m pytest`);
  expect((await commands({ "pyproject.toml": '[project]\nname = "x"\n' })).test).toBeUndefined();
});

test("a [build-system] builds only when the build tool is there: listed, in the .venv, or uv and poetry", async () => {
  const pyproject = '[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n[project]\nname = "x"\n';
  expect((await commands({ "pyproject.toml": pyproject })).build).toBeUndefined();
  expect((await commands({ "pyproject.toml": `${pyproject}[project.optional-dependencies]\ndev = ["build>=1.2", "pytest"]\n` })).build).toBe(`${systemPython} -m build`);
  expect((await commands({ "pyproject.toml": pyproject, "requirements-dev.txt": "build==1.2.2\n" })).build).toBe(`${systemPython} -m build`);
  const sitePackages = process.platform === "win32" ? ".venv/Lib/site-packages/build" : ".venv/lib/python3.12/site-packages/build";
  expect((await commands({ "pyproject.toml": pyproject }, [sitePackages])).build).toBe(`${venvPython} -m build`);
  expect((await commands({ "pyproject.toml": pyproject }, [".venv/bin"])).build).toBeUndefined();
  expect((await commands({ "uv.lock": "", "pyproject.toml": pyproject })).build).toBe("uv build");
  expect((await commands({ "poetry.lock": "", "pyproject.toml": pyproject })).build).toBe("poetry build");
});

test("a \"build\" in tool settings is not the build tool; one in a dependency list is", async () => {
  const pyproject = '[build-system]\nrequires = ["setuptools", "build"]\n[tool.ruff]\nextend-exclude = ["build", "dist"]\n'
    + '[tool.setuptools]\npackages = ["build"]\n[project]\nname = "x"\ndependencies = [\n  "requests[socks]>=2",\n]\n';
  expect((await commands({ "pyproject.toml": pyproject })).build).toBeUndefined();
  const listed = (extra: string) => commands({ "pyproject.toml": pyproject.replace('dependencies = [\n', `dependencies = [\n${extra}`) });
  expect((await listed('  "build",\n')).build).toBe(`${systemPython} -m build`);
  expect((await commands({ "pyproject.toml": `${pyproject}[dependency-groups]\ndev = ["build>=1"]\n` })).build).toBe(`${systemPython} -m build`);
  expect((await commands({ "pyproject.toml": `${pyproject}[tool.uv]\ndev-dependencies = ["build"]\n` })).build).toBe(`${systemPython} -m build`);
  expect((await commands({ "pyproject.toml": `${pyproject}[tool.black]\nexclude = ["build"]\n` })).build).toBeUndefined();
});

test("installing build into the .venv invalidates the cached detection", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-python-home-")); dirs.push(home);
  const sitePackages = process.platform === "win32" ? ".venv/Lib/site-packages" : ".venv/lib/python3.12/site-packages";
  const info = await project({ "pyproject.toml": '[build-system]\nrequires = ["setuptools"]\n' }, [sitePackages]);
  expect((await loadProjectModel(info, { homeDir: home })).commands.build).toBeUndefined();
  await mkdir(path.join(info.root, sitePackages, "build"));
  expect((await loadProjectModel(info, { homeDir: home })).commands.build).toBe(`${venvPython} -m build`);
});
