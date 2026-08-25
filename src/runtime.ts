import type { PHP } from "@php-wasm/universal";
import { PhpFatalError } from "./errors";
import {
  buildCallScript,
  EnvelopeSplitter,
  encodeArgs,
  unwrapEnvelope,
} from "./marshal";
import { bootPhp, nodeFsMountHandler } from "./php-runtime";
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
  /** Calls currently executing, so lifecycle methods can wait them out. */
  readonly #inflight = new Set<Promise<unknown>>();
  /** Serialises reset/dispose so they cannot interleave with each other. */
  #lifecycle: Promise<unknown> = Promise.resolve();

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
    // A disposed instance re-boots on first use; put it back in the cache so
    // --hot teardown can find it again (unless a newer instance owns the id).
    const cache = instanceCache();
    if (!cache.has(this.id)) cache.set(this.id, this);
    this.#booting ??= this.#boot();
    return this.#booting;
  }

  #serialize<T>(op: () => Promise<T>): Promise<T> {
    const task = this.#lifecycle.then(op, op);
    this.#lifecycle = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
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

  async run(
    expression: string,
    label: string,
    sink?: (text: string) => void,
  ): Promise<unknown> {
    const task = this.#run(expression, label, sink);
    this.#inflight.add(task);
    const settle = () => this.#inflight.delete(task);
    task.then(settle, settle);
    return task;
  }

  async #run(
    expression: string,
    label: string,
    sink?: (text: string) => void,
  ): Promise<unknown> {
    const php = await this.php();
    const script = buildCallScript(this.id, expression, this.autoload);

    const response = await php.runStream({ code: script });
    // Read stdout as it is produced rather than awaiting `stdoutText`, so that
    // a slow script's output appears while it is still running. The splitter
    // keeps the envelope out of what gets emitted.
    // A sink takes the output instead of this instance's stdout mode, and gets
    // it chunk by chunk — that is what `BunPHP.capture` collects.
    const emit = sink ?? ((text: string) => this.#emit(text));
    const splitter = new EnvelopeSplitter(emit);
    const decoder = new TextDecoder();
    const reader = response.stdout.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // `stream: true` so a multi-byte character split across two chunks is
        // decoded once both halves have arrived.
        splitter.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }

    splitter.push(decoder.decode());
    const envelope = splitter.end();
    // Only buffers the script itself opened and left open reach the envelope
    // now; everything else has already been emitted above.
    if (envelope?.out) emit(envelope.out);

    const [exitCode, stderr] = await Promise.all([
      response.exitCode,
      response.stderrText,
    ]);

    if (!envelope) {
      const detail = [stderr.trim(), splitter.tail.trim()]
        .filter(Boolean)
        .join("\n");
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

  /**
   * Tear down the interpreter and boot a fresh one, discarding every trace of
   * PHP state — the virtual filesystem included, which is why this boots a new
   * runtime instead of using php-wasm's `hotSwapPHPRuntime` (a hot swap copies
   * the old MEMFS into the replacement).
   */
  reset(): Promise<void> {
    return this.#serialize(() => this.#reset());
  }

  async #reset(): Promise<void> {
    this.#captured = "";
    if (!this.#php && !this.#booting) return; // Never booted: nothing to discard.
    const php = this.#php ?? (await this.#booting!.catch(() => null));
    // Let in-flight calls finish before the runtime under them is torn down.
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
    }
    if (php && this.#php === php) {
      this.#php = null;
      this.#booting = null;
      this.#mounted = false;
      php.exit();
    }
    await this.php();
  }

  /**
   * Shut the interpreter down and drop this instance from the cache.
   *
   * A boot still in flight is awaited so its runtime cannot leak (or re-arm
   * `#php` after the fact), and the cache entry is only removed while it still
   * points at this instance, so disposing a stale `--hot` handle does not
   * evict its replacement.
   */
  dispose(): Promise<void> {
    return this.#serialize(() => this.#dispose());
  }

  async #dispose(): Promise<void> {
    const cache = instanceCache();
    if (cache.get(this.id) === this) cache.delete(this.id);
    const booting = this.#booting;
    this.#booting = null;
    const php = this.#php ?? (booting ? await booting.catch(() => null) : null);
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
    }
    this.#php = null;
    this.#mounted = false;
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
  // A changed source (the file was edited under --hot) or changed plugin
  // options mean the cached interpreter no longer matches; rebuild it.
  if (
    instance &&
    (instance.source !== source ||
      instance.stdout !== stdout ||
      instance.root !== root ||
      instance.autoload !== autoload)
  ) {
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
      const expression = `\\${phpName}(${encodeArgs(args, phpName)})`;
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
    async $eval(
      code: string,
      onOutput?: (text: string) => void,
    ): Promise<any> {
      // The newline keeps a trailing `//` or `#` comment in `code` from
      // swallowing the closing brace.
      return live.run(`(static function () { ${code}\n})()`, "$eval", onOutput);
    },
    async $php(): Promise<PHP> {
      return live.php();
    },
    $output(): string {
      return live.takeOutput();
    },
    $meta: meta,
  };

  // Expose every PHP function on the default export too. `Object.hasOwn`
  // rather than `in`: a PHP function named `toString` or `constructor` must
  // shadow `Object.prototype`, not be skipped because of it.
  for (const exportName of Object.keys(functions)) {
    if (Object.hasOwn(api, exportName)) continue;
    Object.defineProperty(api, exportName, {
      value: (...args: unknown[]) => api.call(exportName, args),
      enumerable: true,
    });
  }

  return api;
}
