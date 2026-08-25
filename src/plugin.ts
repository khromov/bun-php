import type { BunPlugin, OnLoadResult, PluginBuilder } from "bun";
import { generateModule } from "./codegen";
import { generateDts } from "./dts";
import { parsePhp } from "./parse";
import { resolveProject } from "./project";
import type { PhpPluginOptions } from "./types";

/**
 * Absolute path to the runtime module.
 *
 * Generated code imports the runtime by absolute path rather than by the
 * `bun-php/runtime` specifier, so it resolves identically whether bun-php is
 * an installed dependency, a linked checkout, or this repository itself.
 */
const RUNTIME_PATH = Bun.fileURLToPath(new URL("./runtime.ts", import.meta.url));

/** `onLoad` may return `resolveDir`, which is missing from Bun's own types. */
type LoadResult = OnLoadResult & { resolveDir?: string };

export function phpPlugin(options: PhpPluginOptions = {}): BunPlugin {
  const filter = options.filter ?? /\.php$/;
  const stdout = options.stdout ?? "inherit";
  const dtsMode = options.dts ?? "auto";
  const shouldMount = options.mount ?? true;
  const persist = options.persist ?? true;

  return {
    name: "bun-php",

    setup(build: PluginBuilder) {
      // Without an outdir the plugin is serving the runtime rather than
      // producing a bundle, which is when sidecar types are useful.
      const bundling = Boolean(build.config?.outdir);
      const writeDts = dtsMode === true || (dtsMode === "auto" && !bundling);

      build.onLoad({ filter }, async ({ path }): Promise<LoadResult> => {
        const source = await Bun.file(path).text();
        const meta = parsePhp(source, path);
        const project = resolveProject(path, { autoload: options.autoload });

        if (writeDts) {
          await writeSidecar(path, meta, source);
        }

        return {
          contents: generateModule({
            path,
            source,
            meta,
            runtimeSpecifier: RUNTIME_PATH,
            stdout,
            root: shouldMount ? project.root : null,
            autoload: project.autoload,
            persist,
          }),
          loader: "js",
          resolveDir: path.slice(0, path.lastIndexOf("/")) || "/",
        };
      });
    },
  };
}

/**
 * Write `<file>.php.d.ts` next to the source.
 *
 * The write is skipped when the content is unchanged: rewriting unconditionally
 * churns the file's mtime, which would retrigger `bun --watch` / `--hot` in a
 * loop.
 */
async function writeSidecar(
  path: string,
  meta: ReturnType<typeof parsePhp>,
  _source: string,
): Promise<void> {
  const target = `${path}.d.ts`;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const next = generateDts(meta, name);

  try {
    const existing = await Bun.file(target).text();
    if (existing === next) return;
  } catch {
    // No sidecar yet.
  }

  try {
    await Bun.write(target, next);
  } catch {
    // A read-only source tree (node_modules, CI cache) must not break the import.
  }
}
