import type { PHP } from "@php-wasm/universal";
import { PhpFatalError } from "./errors";
import {
  buildCallScript,
  decodeOutput,
  encodeArgs,
  unwrapEnvelope,
} from "./marshal";
import { bootPhp, createRuntimeId, nodeFsMountHandler } from "./php-runtime";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { PhpModuleApi, PhpModuleMeta, StdoutMode } from "./types";

export interface CreatePhpModuleOptions {
  /** Absolute path of the source file; doubles as the cache key. */
  id: string;
  /** The PHP source, inlined at build time so bundles stay self-contained. */
  source: string;
  /** Exported JS name -> fully-qualified PHP function name. */
  functions: Record<string, string>;
  meta: PhpModuleMeta;
  stdout?: StdoutMode;
  /** Host directory to mount into the virtual filesystem, if any. */
  root?: string | null;
  /** Composer autoloader to require before the module, if any. */
  autoload?: string | null;
}

/**
 * Interpreters are cached on `globalThis` rather than in a module-level
 * variable so they survive `bun --hot` soft reloads, which reset the module
 * registry (and therefore re-run the plugin's `onLoad`) on every save.
 */
const CACHE_KEY = "__bunPhpInstances";

function instanceCache(): Map<string, PhpInstance> {
  const globals = globalThis as Record<string, unknown>;
  const existing = globals[CACHE_KEY] as Map<string, PhpInstance> | undefined;
  if (existing) return existing;
  const created = new Map<string, PhpInstance>();
  globals[CACHE_KEY] = created;
  return created;
}

class PhpInstance {
  #php: PHP | null = null;
  #booting: Promise<PHP> | null = null;
  #captured = "";
  #mounted = false;

  constructor(
    readonly id: string,
    readonly source: string,
    readonly stdout: StdoutMode,
    readonly root: string | null,
    readonly autoload: string | null,
  ) {}

  /** Boot lazily, and only once even under concurrent first calls. */
  async php(): Promise<PHP> {
    if (this.#php) return this.#php;
    this.#booting ??= this.#boot();
    return this.#booting;
  }

  async #boot(): Promise<PHP> {
    const php = await bootPhp();
    await this.#populate(php);
    this.#php = php;
    return php;
  }

  /**
   * Make the PHP file reachable from inside the interpreter.
   *
   * Mounting the project directory is preferred: it is a live view of the host
   * filesystem, so sibling `require`s, `__DIR__` and Composer's vendor tree all
   * resolve. When the directory is not on disk — a bundle running elsewhere —
   * the source inlined at build time is written instead, which keeps
   * single-file modules working.
   */
  async #populate(php: PHP): Promise<void> {
    if (this.root && existsSync(this.root)) {
      php.mkdir(this.root);
      await php.mount(this.root, nodeFsMountHandler(this.root));
      this.#mounted = true;
      return;
    }
    php.mkdir(dirname(this.id));
    php.writeFile(this.id, this.source);
  }

  async run(expression: string, label: string): Promise<unknown> {
    const php = await this.php();
    const script = buildCallScript(this.id, expression, this.autoload);

    const response = await php.runStream({ code: script });
    const [raw, exitCode, stderr] = await Promise.all([
      response.stdoutText,
      response.exitCode,
      response.stderrText,
    ]);

    const { out, envelope } = decodeOutput(raw);
    // `out` is anything PHP flushed ahead of the envelope (which happens on a
    // fatal error); `envelope.out` is the normally buffered script output.
    this.#emit(out);
    if (envelope?.out) this.#emit(envelope.out);

    if (!envelope) {
      const detail = [stderr.trim(), out.trim()].filter(Boolean).join("\n");
      throw new PhpFatalError(
        `${label}: PHP produced no result (exit code ${exitCode})${
          detail ? `\n${detail}` : ""
        }`,
        this.id,
        0,
      );
    }

    return unwrapEnvelope(envelope, label);
  }

  #emit(text: string): void {
    if (!text) return;
    if (this.stdout === "inherit") process.stdout.write(text);
    else if (this.stdout === "capture") this.#captured += text;
  }

  takeOutput(): string {
    const value = this.#captured;
    this.#captured = "";
    return value;
  }

  /** Swap in a fresh runtime, discarding every trace of PHP state. */
  async reset(): Promise<void> {
    const php = await this.php();
    await php.hotSwapPHPRuntime(await createRuntimeId());
    // php-wasm re-applies mounts across a runtime swap, so only the
    // written-source fallback needs restoring.
    if (!this.#mounted) {
      php.mkdir(dirname(this.id));
      php.writeFile(this.id, this.source);
    }
    this.#captured = "";
  }

  async dispose(): Promise<void> {
    const php = this.#php;
    this.#php = null;
    this.#booting = null;
    this.#mounted = false;
    instanceCache().delete(this.id);
    php?.exit();
  }
}

/**
 * Build the object a generated `.php` module exports.
 *
 * Each PHP function becomes an async JS function. The interpreter boots on the
 * first call, not at import time, so importing a `.php` file stays cheap.
 */
export function createPhpModule(options: CreatePhpModuleOptions): PhpModuleApi {
  const { id, source, functions, meta } = options;
  const stdout = options.stdout ?? "inherit";
  const root = options.root ?? null;
  const autoload = options.autoload ?? null;

  const cache = instanceCache();
  let instance = cache.get(id);
  // A changed source means the file was edited under --hot; rebuild from scratch.
  if (instance && instance.source !== source) {
    void instance.dispose();
    instance = undefined;
  }
  if (!instance) {
    instance = new PhpInstance(id, source, stdout, root, autoload);
    cache.set(id, instance);
  }
  const live = instance;

  const api: PhpModuleApi = {
    async call(name: string, args: readonly unknown[]): Promise<any> {
      const phpName = functions[name] ?? name;
      const expression = `\\${phpName}(${encodeArgs(args)})`;
      return live.run(expression, phpName);
    },
    async $ready(): Promise<void> {
      await live.php();
    },
    async $reset(): Promise<void> {
      await live.reset();
    },
    async $dispose(): Promise<void> {
      await live.dispose();
    },
    async $eval(code: string): Promise<any> {
      return live.run(`(static function () { ${code} })()`, "$eval");
    },
    async $php(): Promise<PHP> {
      return live.php();
    },
    $output(): string {
      return live.takeOutput();
    },
    $meta: meta,
  };

  // Expose every PHP function on the default export too.
  for (const exportName of Object.keys(functions)) {
    if (exportName in api) continue;
    Object.defineProperty(api, exportName, {
      value: (...args: unknown[]) => api.call(exportName, args),
      enumerable: true,
    });
  }

  return api;
}
