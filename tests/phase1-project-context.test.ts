import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import type { ProjectInfo } from "../src/project/inspect";
import { loadProjectModel } from "../src/project/model";
import { classifyTask, formatTaskPrompt } from "../src/task/classify";

const tempDirs: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Phase 1 project context", () => {
  test("loads the selected profile, project rules, overrides, and merged safe policy", async () => {
    const root = await temporaryDirectory("casper-config-project-");
    const homeDir = await temporaryDirectory("casper-config-home-");
    const profileDir = path.join(homeDir, ".casper", "profiles", "project-profile");
    await mkdir(profileDir, { recursive: true });
    await mkdir(path.join(root, ".casper"));

    await writeFile(
      path.join(homeDir, ".casper", "config.yaml"),
      [
        "profile: global-profile",
        "behavior:",
        "  autonomy: low",
        "  inspectBeforeEditing: false",
        "code:",
        "  preferSmallChanges: false",
      ].join("\n"),
    );
    await writeFile(
      path.join(profileDir, "config.yaml"),
      [
        "behavior:",
        "  autonomy: medium",
        "  inspectBeforeEditing: true",
        "code:",
        "  preserveArchitecture: false",
      ].join("\n"),
    );
    await writeFile(path.join(profileDir, "rules.md"), "Use profile conventions.");
    await writeFile(
      path.join(root, ".casper", "project.yaml"),
      [
        "profile: project-profile",
        "languages: [typescript]",
        "commands:",
        "  test: bun test",
        "policy:",
        "  behavior:",
        "    autonomy: high",
        "  git:",
        "    confirmDestructive: false",
      ].join("\n"),
    );
    await writeFile(path.join(root, ".casper", "rules.md"), "Never edit generated files.");

    const configuration = await loadConfiguration({ projectRoot: root, homeDir });

    expect(configuration.profileName).toBe("project-profile");
    expect(configuration.policy.behavior.autonomy).toBe("high");
    expect(configuration.policy.behavior.inspectBeforeEditing).toBe(true);
    expect(configuration.policy.code.preferSmallChanges).toBe(false);
    expect(configuration.policy.code.preserveArchitecture).toBe(false);
    expect(configuration.policy.git.confirmDestructive).toBe(true);
    expect(configuration.profileRules).toBe("Use profile conventions.");
    expect(configuration.projectRules).toBe("Never edit generated files.");
    expect(configuration.projectOverrides.languages).toEqual(["typescript"]);
    expect(configuration.projectOverrides.commands).toEqual({ test: "bun test" });
  });

  test("detects stack and commands, then reuses and invalidates the project cache", async () => {
    const root = await temporaryDirectory("casper-model-project-");
    const homeDir = await temporaryDirectory("casper-model-home-");
    const project: ProjectInfo = {
      cwd: root,
      root,
      name: "example",
      gitBranch: null,
      isGit: false,
    };
    const packagePath = path.join(root, "package.json");

    await writeFile(
      packagePath,
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: { test: "vitest", build: "vite build", typecheck: "tsc --noEmit" },
        dependencies: { react: "latest", vite: "latest" },
        devDependencies: { typescript: "latest" },
      }),
    );
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    await writeFile(path.join(root, "tsconfig.json"), "{}");

    const first = await loadProjectModel(project, { homeDir });
    const cached = await loadProjectModel(project, { homeDir });

    expect(first.languages).toEqual(["typescript"]);
    expect(first.frameworks).toEqual(["react", "vite"]);
    expect(first.packageManager).toBe("pnpm");
    expect(first.commands).toEqual({
      test: "pnpm run test",
      typecheck: "pnpm run typecheck",
      build: "pnpm run build",
    });
    expect(cached).toEqual(first);

    await writeFile(
      packagePath,
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: { test: "vitest --run", build: "vite build", typecheck: "tsc --noEmit", lint: "eslint ." },
        dependencies: { react: "latest", vite: "latest" },
        devDependencies: { typescript: "latest" },
      }),
    );
    const refreshed = await loadProjectModel(project, { homeDir });
    expect(refreshed.commands.lint).toBe("pnpm run lint");
  });

  test("classifies a task and supplies only detected relevant commands", () => {
    const classification = classifyTask("Fix the failing login flow");
    const prompt = formatTaskPrompt("Fix the failing login flow", classification, {
      schemaVersion: 1,
      project: { name: "example", root: "/example", git: true },
      languages: ["typescript"],
      frameworks: [],
      packageManager: "bun",
      commands: { test: "bun test", build: "bun run build" },
      architecture: {},
      conventions: [],
      detectedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(classification).toEqual({
      intent: "fix",
      mode: "modify",
      verification: ["typecheck", "lint", "test", "build"],
    });
    expect(prompt).toContain("test=bun test; build=bun run build");
    expect(prompt).toContain("User request:\nFix the failing login flow");
  });
});
