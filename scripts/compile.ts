import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

/**
 * The shared compiler used by release builds and standalone regression fixtures.
 *
 * Bun 1.4 copies a read-only runtime (Homebrew installs it 0555) into the build's cwd as
 * `.<hash>-00000000.bun-build` and cannot unlink the copy, leaking ~57 MB per compile. The
 * build therefore runs in a child whose cwd is a private scratch directory removed afterwards:
 * `process.chdir` is process-global (bun test shares one process) and deleting cwd matches would
 * race concurrent compiles (`test:fast` runs two compile tests at once).
 */
export async function compileExecutable(entrypoint: string, outfile: string, target?: Bun.Build.CompileTarget): Promise<void> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-compile-"));
  try {
    const child = Bun.spawn([process.execPath, import.meta.path, path.resolve(entrypoint), path.resolve(outfile), ...(target ? [target] : [])], {
      cwd: scratch, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${stderr}${stdout}`.trim() || `compile exited with code ${code}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function build(entrypoint: string, outfile: string, target?: Bun.Build.CompileTarget): Promise<void> {
  const result = await Bun.build({
    entrypoints: [path.resolve(entrypoint)],
    minify: true,
    loader: { ".wasm": "file" },
    plugins: [{
      name: "embedded-photon-wasm",
      setup(build) {
        build.onLoad({ filter: /[\\/]photon-node[\\/]photon_rs\.js$/ }, async ({ path: file }) => {
          const source = await readFile(file, "utf8");
          // Rewrite only the pinned upstream loader, never installed dependencies.
          // A plain --asset leaves Photon's baked absolute __dirname lookup intact.
          const original = "const bytes = require('fs').readFileSync(path);";
          const lookup = "const path = require('path').join(__dirname, 'photon_rs_bg.wasm');";
          if (source.split(original).length !== 2 || source.split(lookup).length !== 2) throw new Error("Photon layout changed; review standalone WASM packaging");
          return {
            contents: source.replace(lookup, "").replace(original, "const bytes = require('fs').readFileSync(require('./photon_rs_bg.wasm'));"),
            loader: "js", resolveDir: path.dirname(file),
          };
        });
      },
    }],
    // Pi/OMP use baseline x64 builds and disable project Bun preload/config
    // discovery so starting a downloaded executable cannot run a cwd bunfig preload.
    compile: {
      outfile: path.resolve(outfile),
      ...(target ? { target: (target.endsWith("-x64") ? `${target}-baseline` : target) as Bun.Build.CompileTarget } : {}),
      autoloadBunfig: false, autoloadDotenv: false,
      autoloadTsconfig: false, autoloadPackageJson: false,
    },
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
}

if (import.meta.main) {
  const [entrypoint, outfile, target] = process.argv.slice(2);
  if (!entrypoint || !outfile) throw new Error("usage: compile.ts <entrypoint> <outfile> [target]");
  await build(entrypoint, outfile, target as Bun.Build.CompileTarget | undefined);
}
