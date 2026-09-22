import path from "node:path";
import { readFile } from "node:fs/promises";

/** The shared compiler used by release builds and standalone regression fixtures. */
export async function compileExecutable(entrypoint: string, outfile: string, target?: Bun.Build.CompileTarget): Promise<void> {
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
