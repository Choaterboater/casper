import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VisualizationGraph, VisualizationProvider, VisualizationResult, VisualizationType } from "./types";
import { ArtifactDirectory, artifactFilesystemSupported } from "./artifacts";

export interface VisualizationSettings {
  /** Providers to render, in preference order; the first result is shown inline. */
  providers: string[];
  /** Absolute directory for artifacts, or null to keep results in-conversation only. */
  outputDir: string | null;
}

export const DEFAULT_VISUALIZATION_PROVIDERS = ["mermaid", "mindmesh"] as const;

export interface RenderedVisualization {
  graph: VisualizationGraph;
  primary: VisualizationResult;
  artifacts: Array<{ provider: string; path: string; bytes: number; lossiness: string[] }>;
  /** Present when artifact files were not written for a platform reason. */
  artifactNote?: string;
  /** Providers configured but unable to render this type. */
  skipped: string[];
}

export interface VisualizationRouterOptions {
  providers: VisualizationProvider[];
  settings: VisualizationSettings;
  now?: () => Date;
  workspaceRoot?: string;
}

/** Routes a neutral graph to configured providers and persists artifacts outside the code workspace. */
export class VisualizationRouter {
  private readonly providers: VisualizationProvider[];
  readonly settings: VisualizationSettings;
  private readonly workspaceRoot: string;
  private readonly now: () => Date;
  readonly diagnostics: string[] = [];

  constructor(options: VisualizationRouterOptions) {
    this.settings = options.settings;
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    this.now = options.now ?? (() => new Date());
    const byName = new Map(options.providers.map((provider) => [provider.name, provider]));
    this.providers = [];
    for (const name of options.settings.providers) {
      const provider = byName.get(name);
      if (!provider) { this.diagnostics.push(`Unknown visualization provider ${JSON.stringify(name)} ignored`); continue; }
      if (!this.providers.includes(provider)) this.providers.push(provider);
    }
    if (!this.providers.length) throw new Error("No usable visualization providers configured");
  }

  providerNames(): string[] { return this.providers.map((provider) => provider.name); }

  supports(type: VisualizationType): boolean { return this.providers.some((provider) => provider.supports(type)); }

  async render(graph: VisualizationGraph, signal?: AbortSignal): Promise<RenderedVisualization> {
    const check = () => { if (signal?.aborted) throw new Error("Visualization cancelled"); };
    check();
    const results: VisualizationResult[] = [];
    const skipped: string[] = [];
    for (const provider of this.providers) {
      if (signal?.aborted) throw new Error("Visualization cancelled");
      if (!provider.supports(graph.type)) { skipped.push(provider.name); continue; }
      results.push(await provider.render(graph));
      check();
    }
    if (!results.length) throw new Error(`No configured provider supports ${graph.type}`);
    const artifacts: RenderedVisualization["artifacts"] = [];
    let artifactNote: string | undefined;
    if (this.settings.outputDir && !artifactFilesystemSupported) {
      artifactNote = `Artifact files require macOS or Linux; on ${process.platform} the diagram stays in-conversation.`;
      this.diagnostics.push(artifactNote);
    } else if (this.settings.outputDir) {
      check();
      const workspace = await canonicalPath(this.workspaceRoot, check);
      check();
      const destination = await canonicalPath(path.resolve(os.homedir(), this.settings.outputDir), check);
      check();
      const assertOutside = (target: string) => {
        const relative = path.relative(workspace, target);
        if (!relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
          throw new Error("Visualization artifacts must stay outside the workspace");
        }
      };
      assertOutside(destination);
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      check();
      // Hold the validated directory inode across creation and cleanup. A parent
      // pathname swap cannot redirect either operation into the workspace.
      const directory = await ArtifactDirectory.open(destination, workspace, check);
      try {
      for (let attempt = 1; ; attempt++) {
        check();
        const base = `${stamp}-${slug(graph.title)}${attempt > 1 ? `-${attempt}` : ""}`;
        const written: RenderedVisualization["artifacts"] = [];
        try {
          for (const result of results) {
            check();
            if (!/^[a-zA-Z0-9_-]+$/.test(result.provider) || !/^[a-zA-Z0-9_-]+$/.test(result.format)) {
              throw new Error("Invalid visualization artifact provider or format");
            }
            assertOutside(await canonicalPath(destination, check));
            check();
            const target = path.join(destination, `${base}.${result.provider}.${result.format}`);
            const file = await directory.create(path.basename(target));
            written.push({ provider: result.provider, path: target, bytes: Buffer.byteLength(result.content), lossiness: result.lossiness });
            try {
              check();
              await file.writeFile(result.content);
              check();
            } finally { await file.close(); }
            check();
          }
          check();
          await directory.assertCurrent();
          check();
          artifacts.push(...written);
          break;
        } catch (error) {
          for (const artifact of written) directory.remove(path.basename(artifact.path));
          check();
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 1000) throw error;
        }
      }
      } finally { await directory.close(); }
    }
    check();
    return { graph, primary: results[0]!, artifacts, skipped, ...(artifactNote ? { artifactNote } : {}) };
  }
}

/** Resolve existing ancestors before creating anything, including destinations not yet on disk. */
async function canonicalPath(target: string, check: () => void): Promise<string> {
  check();
  try {
    await fs.lstat(target);
  } catch (error) {
    check();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    const resolvedParent = await canonicalPath(parent, check);
    check();
    return path.join(resolvedParent, path.basename(target));
  }
  check();
  // Dangling symlinks fail closed instead of being mistaken for missing directories.
  const resolved = await fs.realpath(target);
  check();
  return resolved;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "visualization";
}

export interface ResolveVisualizationSettingsOptions {
  projectName: string;
  homeDir?: string;
  /** Configuration layers in increasing precedence: global, profile, project. */
  layers: Array<{ document: Record<string, unknown>; source: "global" | "profile" | "project" }>;
}

/**
 * `visualize.providers` may be set at any layer. `visualize.outputDir` accepts a path (`~` expands)
 * from user-owned layers or `false` from any layer; a project file cannot redirect writes.
 */
export function resolveVisualizationSettings(options: ResolveVisualizationSettingsOptions): VisualizationSettings {
  const homeDir = options.homeDir ?? os.homedir();
  let providers: string[] = [...DEFAULT_VISUALIZATION_PROVIDERS];
  let outputDir: string | null = path.join(homeDir, ".casper", "visualizations", slug(options.projectName));
  for (const { document, source } of options.layers) {
    const section = document.visualize;
    if (section === undefined) continue;
    if (typeof section !== "object" || section === null || Array.isArray(section)) throw new Error("visualize must be a mapping");
    const settings = section as Record<string, unknown>;
    if (settings.providers !== undefined) {
      if (!Array.isArray(settings.providers) || !settings.providers.length || settings.providers.some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error("visualize.providers must be a nonempty list of provider names");
      }
      providers = settings.providers.map((item: string) => item.trim());
    }
    if (settings.outputDir === undefined) continue;
    if (settings.outputDir === false) { outputDir = null; continue; }
    if (typeof settings.outputDir !== "string" || !settings.outputDir.trim()) throw new Error("visualize.outputDir must be a path or false");
    if (source === "project") throw new Error("visualize.outputDir may only be set in global or profile configuration, or disabled with false");
    const raw = settings.outputDir.trim();
    outputDir = path.resolve(homeDir, raw === "~" || raw.startsWith("~/") ? path.join(homeDir, raw.slice(1)) : raw);
  }
  return { providers, outputDir };
}
