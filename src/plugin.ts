import type { BunPlugin, OnLoadResult, PluginBuilder } from "bun";
import { basename, dirname } from "node:path";
import { generateModule } from "./codegen";
import { generateDts } from "./dts";
import { parsePhp } from "./parse";
import { resolveProject } from "./project";
import type { PhpModuleMeta, PhpPluginOptions } from "./types";

// Generated code imports the runtime by absolute path rather than `bun-php/runtime`, so it resolves
// the same whether bun-php is a dependency, a link, or this repository.
const RUNTIME_PATH = Bun.fileURLToPath(new URL("./runtime.ts", import.meta.url));

/** `onLoad` may return `resolveDir`, which Bun's own types omit. */
type LoadResult = OnLoadResult & { resolveDir?: string };

export function phpPlugin(options: PhpPluginOptions = {}): BunPlugin {
  const filter = options.filter ?? /\.php$/;
  const stdout = options.stdout ?? "inherit";
  const dts = options.dts ?? "auto";
  const mount = options.mount ?? true;

  return {
    name: "bun-php",

    setup(build: PluginBuilder) {
      // No outdir means serving the runtime rather than producing a bundle, which is when sidecars help.
      const bundling = Boolean(build.config?.outdir);
      const writeDts = dts === true || (dts === "auto" && !bundling);

      build.onLoad({ filter }, async ({ path }): Promise<LoadResult> => {
        const source = await Bun.file(path).text();
        const meta = parsePhp(source, path);
        const project = resolveProject(path, { autoload: options.autoload });

        if (writeDts) await writeSidecar(path, meta);

        return {
          contents: generateModule({
            path,
            source,
            meta,
            runtimeSpecifier: RUNTIME_PATH,
            stdout,
            root: mount ? project.root : null,
            autoload: project.autoload,
          }),
          loader: "js",
          resolveDir: dirname(path),
        };
      });
    },
  };
}

// Skipped when unchanged: rewriting churns the mtime and retriggers `bun --watch`/`--hot` in a loop.
async function writeSidecar(path: string, meta: PhpModuleMeta): Promise<void> {
  const target = `${path}.d.ts`;
  const next = generateDts(meta, basename(path));
  const existing = await Bun.file(target)
    .text()
    .catch(() => null);
  if (existing === next) return;
  // A read-only source tree (node_modules, a CI cache) must not break the import.
  await Bun.write(target, next).catch(() => {});
}
