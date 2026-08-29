import type { BunPlugin, OnLoadResult, PluginBuilder } from "bun";
import { basename, dirname } from "node:path";
import { generateModule } from "./codegen";
import { generateDts } from "./dts";
import { parsePhp } from "./parse";
import { resolveProject } from "./project";
import type { PhpModuleMeta, PhpModuleRuntimeOptions, PhpPluginOptions } from "./types";

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
  const runtime = options.runtime && assertSerialisable(options.runtime);

  return {
    name: "bun-php",

    setup(build: PluginBuilder) {
      // No outdir means serving the runtime rather than producing a bundle, which is when sidecars help.
      const bundling = Boolean(build.config?.outdir);
      const writeDts = dts === true || (dts === "auto" && !bundling);

      build.onLoad({ filter }, async ({ path }): Promise<LoadResult> => {
        const source = await Bun.file(path).text();
        const meta = parsePhp(source, path);
        // Without a mount only the module's own source is in the VFS, so any autoloader — detected
        // or configured — could only be a `require_once` of a file that is not there.
        const project = resolveProject(path, { autoload: mount ? options.autoload : false });

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
            runtime,
          }),
          loader: "js",
          resolveDir: dirname(path),
        };
      });
    },
  };
}

// The options reach the module as generated source, so anything a function or a live object cannot
// cross; `timeoutMs` is rejected for a different reason — module calls have no deadline at all, and
// accepting it silently is the dead configuration this used to ship. TypeScript rules all of these
// out already; this is the guard for JavaScript callers.
function assertSerialisable(runtime: PhpModuleRuntimeOptions): PhpModuleRuntimeOptions {
  const offending = ["loader", "isolation", "timeoutMs"].filter((key) => key in runtime);
  if (typeof (runtime as { spawn?: unknown }).spawn === "function") offending.push("spawn");
  if (offending.length > 0) {
    throw new TypeError(
      `phpPlugin: runtime.${offending.join(", runtime.")} is not supported for imported .php modules; ` +
        // `createPhpModule` takes `loader` and a `spawn` handler, but refuses the other two itself.
        "use createInterpreter, or createPhpModule from bun-php/runtime for loader and spawn",
    );
  }
  return runtime;
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
