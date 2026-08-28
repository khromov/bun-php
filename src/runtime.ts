import type { PHP } from "@php-wasm/universal";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { PhpFatalError, PhpTimeoutError } from "./errors";
import { PhpInterpreter, withDeadline } from "./interpreter";
import { buildCallScript, EnvelopeSplitter, encodeArgs, unwrapEnvelope } from "./marshal";
import { writeFileOp } from "./php-runtime";
import type {
  JournalOp,
  PhpModuleApi,
  PhpModuleMeta,
  PhpRuntimeOptions,
  StdoutMode,
} from "./types";

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
  runtime?: PhpRuntimeOptions;
}

// Cached on globalThis, not in a module variable: `bun --hot` resets the module registry on every
// save and would otherwise leak an interpreter per edit.
function cache(): Map<string, PhpInstance> {
  const globals = globalThis as { __bunPhpInstances?: Map<string, PhpInstance> };
  return (globals.__bunPhpInstances ??= new Map());
}

class PhpInstance {
  readonly #interpreter: PhpInterpreter;
  #captured = "";
  /** The autoloader to require, once it is known to be reachable. */
  readonly autoload: string | null;
  /** Calls in progress, so reset/dispose can wait them out. */
  readonly #running = new Set<Promise<unknown>>();

  constructor(
    readonly id: string,
    readonly key: string,
    readonly stdout: StdoutMode,
    autoload: string | null,
    readonly runtime: PhpRuntimeOptions,
    root: string | null,
    source: string,
  ) {
    // Mounting the directory gives a live view of the host, so sibling requires, `__DIR__` and Composer
    // work; writing the inlined source is the fallback for a bundle running somewhere else.
    // Gated on the module file: a root that exists without it mounts fine and then fatals on the
    // `require_once` of every call, where the inlined source would have worked.
    const mounted = root !== null && existsSync(id);
    // An autoloader outside the virtual filesystem could only fatal, so it goes with the mount.
    this.autoload = mounted ? autoload : null;
    const setup: JournalOp[] = mounted
      ? [{ kind: "mount", host: root, at: root }]
      : [{ kind: "mkdir", path: dirname(id) }, writeFileOp(id, source)];
    this.#interpreter = new PhpInterpreter(runtime, setup);
  }

  php(): Promise<PHP> {
    // A disposed instance re-boots on first use, so put it back where --hot teardown can find it
    // (unless a newer instance owns the id).
    if (!cache().has(this.id)) cache().set(this.id, this);
    return this.#interpreter.php();
  }

  run(expression: string, label: string, sink?: (text: string) => void): Promise<unknown> {
    const task = this.#run(expression, label, sink);
    this.#running.add(task);
    const done = () => this.#running.delete(task);
    task.then(done, done);

    const timeoutMs = this.runtime.timeoutMs ?? 0;
    if (timeoutMs <= 0) return task;
    // Waiting only, as in-process always is: the request runs on, and the next call queues behind it.
    return withDeadline(
      task,
      timeoutMs,
      () =>
        new PhpTimeoutError(
          `${label}: PHP call exceeded ${timeoutMs}ms; the request is still running and later calls queue behind it`,
          timeoutMs,
        ),
    );
  }

  async #run(expression: string, label: string, sink?: (text: string) => void): Promise<unknown> {
    const php = await this.php();
    const response = await php.runStream({
      code: buildCallScript(this.id, expression, this.autoload),
    });
    // A sink takes this call's output instead of the module's stdout mode; that is what `BunPHP.capture` collects.
    const emit = sink ?? ((text: string) => this.#write(text));
    const splitter = new EnvelopeSplitter(emit);
    const decoder = new TextDecoder();
    const reader = response.stdout.getReader();

    // Read chunk by chunk so a slow script's output appears while it is still running.
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        splitter.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }

    splitter.push(decoder.decode());
    // `end()` releases any buffers the script left open, in the order PHP wrote them.
    const envelope = splitter.end();

    const [exitCode, stderr] = await Promise.all([response.exitCode, response.stderrText]);
    if (!envelope) {
      const detail = [stderr.trim(), splitter.tail.trim()].filter(Boolean).join("\n");
      throw new PhpFatalError(
        `${label}: PHP produced no result (exit code ${exitCode})${detail ? `\n${detail}` : ""}`,
        this.id,
        0,
      );
    }
    return unwrapEnvelope(envelope, label);
  }

  #write(text: string): void {
    if (this.stdout === "inherit") process.stdout.write(text);
    else if (this.stdout === "capture") this.#captured += text;
  }

  takeOutput(): string {
    const value = this.#captured;
    this.#captured = "";
    return value;
  }

  /** Discard all PHP state, the virtual filesystem included; the next call boots afresh. */
  async reset(): Promise<void> {
    await this.#drain();
    // After the drain: a call finishing during it would otherwise refill the buffer past the reset.
    this.#captured = "";
    await this.#interpreter.dispose();
  }

  async dispose(): Promise<void> {
    // Only evict while the entry is still this instance, so a stale --hot handle cannot evict its replacement.
    if (cache().get(this.id) === this) cache().delete(this.id);
    await this.#drain();
    await this.#interpreter.dispose();
  }

  // Let in-flight calls finish before the runtime under them goes away.
  async #drain(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled(this.#running);
  }
}

/** The object a generated `.php` module exports. The interpreter boots on the first call, not at import. */
export function createPhpModule(options: CreatePhpModuleOptions): PhpModuleApi {
  const { id, source, functions, meta } = options;
  const stdout = options.stdout ?? "inherit";
  const root = options.root ?? null;
  const autoload = options.autoload ?? null;
  const runtime = options.runtime ?? {};
  // A module makes many small calls against one live instance, the opposite of a child that exits per call.
  if (runtime.isolation) {
    throw new TypeError(
      "isolation is not supported for imported .php modules; use createInterpreter",
    );
  }

  // Everything that decides which interpreter to boot; `loader` and `spawn` are compared by identity.
  const { loader, spawn, ...serialisable } = runtime;
  const key = JSON.stringify({ source, stdout, root, autoload, runtime: serialisable });

  const cached = cache().get(id);
  const sameConfig =
    cached?.key === key && cached.runtime.loader === loader && cached.runtime.spawn === spawn;
  if (cached && !sameConfig) void cached.dispose();
  const instance =
    cached && sameConfig
      ? cached
      : new PhpInstance(id, key, stdout, autoload, runtime, root, source);
  cache().set(id, instance);

  // Async so an argument that cannot be encoded rejects rather than throws.
  const call = async (name: string, args: readonly unknown[]): Promise<unknown> => {
    // Own properties only: `functions.toString` would otherwise hand PHP a native function object.
    const phpName = Object.hasOwn(functions, name) ? functions[name]! : name;
    return instance.run(`\\${phpName}(${encodeArgs(args, phpName)})`, phpName);
  };

  return {
    // Every PHP function on the default export too. Spread defines own properties, so a PHP
    // function named `toString` shadows Object.prototype instead of being skipped. `call` is
    // listed after the spread on purpose: the API owns that name, and the sidecar says so.
    ...Object.fromEntries(
      Object.keys(functions).map((name) => [name, (...args: unknown[]) => call(name, args)]),
    ),
    call,
    $ready: async () => {
      await instance.php();
    },
    $reset: () => instance.reset(),
    $dispose: () => instance.dispose(),
    // The newline keeps a trailing `//` or `#` comment in `code` from swallowing the closing brace.
    $eval: (code, onOutput) =>
      instance.run(`(static function () { ${code}\n})()`, "$eval", onOutput),
    $php: () => instance.php(),
    $output: () => instance.takeOutput(),
    $meta: meta,
  };
}
