import { expect, test } from "bun:test";
import { configChanges, configEntries, isConfigFile, isLockfile } from "../src/task/config-files";

test("project, tool, CI, Ansible and device settings are config files", () => {
  for (const file of ["package.json", "apps/web/package.json", "tsconfig.json", "tsconfig.build.json", ".env", ".env.local", "deploy/prod.env",
    "config/app.yaml", "docker-compose.yml", "compose.yaml", "Cargo.toml", "pyproject.toml", "setup.cfg", "php.ini", "app.properties",
    "Dockerfile", "Dockerfile.dev", "web.Dockerfile", "Containerfile", ".github/workflows/ci.yml", ".github/workflows/scripts/notify",
    ".casper/project.yaml", "requirements.txt", "requirements-dev.txt", "go.mod", "Gemfile", "vite.config.ts", "eslint.config.mjs",
    ".npmrc", ".eslintrc.json", "group_vars/all", "inventories/prod/host_vars/sw1.yml", "inventories/prod/hosts", "inventory",
    "junos/sw1.set", "nginx/nginx.conf", "configs/core-sw1", "oxidized/edge-1", "templates/access.j2", "apps\\web\\package.json",
    ".github\\workflows\\ci.yml"]) expect({ file, config: isConfigFile(file) }).toEqual({ file, config: true });
});

test("code, docs and data are not config files", () => {
  for (const file of ["src/index.ts", "README.md", "docs/config.md", "src/config.ts", "src/env.ts", "src/dockerfile-parser.ts",
    "tests/fixtures/data.json", "app.py", "notes.txt", "src/inventory/item.ts", "src/hosts.ts", "tsconfig.ts", ".github/CODEOWNERS",
    "scripts/deploy.sh"]) expect({ file, config: isConfigFile(file) }).toEqual({ file, config: false });
});

test("lockfiles are config, kept apart and named as one entry", () => {
  for (const file of ["bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "web/Cargo.lock", "go.sum", "poetry.lock", "uv.lock"]) {
    expect({ file, lockfile: isLockfile(file), config: isConfigFile(file) }).toEqual({ file, lockfile: true, config: true });
  }
  expect(isLockfile("package.json")).toBe(false);
  const changes = configChanges(["src/a.ts", "package.json", "bun.lock", ".casper/project.yaml", "web/package-lock.json", "README.md"]);
  expect(changes).toEqual({ files: ["package.json", ".casper/project.yaml"], lockfiles: ["bun.lock", "web/package-lock.json"] });
  expect(configEntries(changes)).toEqual(["package.json", ".casper/project.yaml", "2 lockfiles"]);
  expect(configEntries(configChanges(["bun.lock", "tsconfig.json"]))).toEqual(["tsconfig.json", "bun.lock"]);
  expect(configEntries(configChanges(["src/a.ts"]))).toEqual([]);
});
