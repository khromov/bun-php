import type { PHP } from "@php-wasm/universal";
import { PhpTimeoutError } from "./errors";
import { runIsolatedCli, type IsolationRequest } from "./isolation";
import { applyOp, bootPhp, optionOps, writeFileOp } from "./php-runtime";
import type { JournalOp, PhpCliOptions, PhpCliResult, PhpRuntimeOptions } from "./types";

/**
 * A configured interpreter with no `.php` import behind it, for driving PHP tools directly.
 * In-process calls never overlap (the wasm holds the thread); `isolation: "process"` buys parallelism.
 */
export class PhpInterpreter {
  /** The booted (or booting) instance; `null` once `cli()` has taken it. */
  #instance: Promise<PHP> | null = null;
  #retired = false;
  readonly #journal: JournalOp[];

  constructor(
    private readonly options: PhpRuntimeOptions = {},
    journal: readonly JournalOp[] = [],
  ) {
    if (options.isolation === "process") {
      // Functions cannot cross the JSON boundary to the child.
      if (options.loader) {
        throw new TypeError(
          "isolation: 'process' cannot ship a loader function to the child; use phpVersion instead",
        );
      }
      if (typeof options.spawn === "function") {
        throw new TypeError(
          "isolation: 'process' cannot ship a spawn handler function to the child; use spawn: 'refuse'",
        );
      }
    }
    this.#journal = [...optionOps(options), ...journal];
  }

  /** The in-process instance, booted on first use. */
  php(): Promise<PHP> {
    if (this.options.isolation === "process") {
      return Promise.reject(
        new Error(
          "php() is not available under isolation: 'process'; there is no in-process instance",
        ),
      );
    }
    return (this.#instance ??= bootPhp(this.options, this.#journal));
  }

  /** Whether an in-process call timed out here; the abandoned request still owns that instance. */
  get retired(): boolean {
    return this.#retired;
  }

  mount(host: string, at: string): Promise<void> {
    return this.#apply({ kind: "mount", host, at });
  }

  ini(entries: Record<string, string | number>): Promise<void> {
    return this.#apply({ kind: "ini", entries });
  }

  writeFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.#apply(writeFileOp(path, data));
  }

  mkdir(path: string): Promise<void> {
    return this.#apply({ kind: "mkdir", path });
  }

  /** Record one step and, in-process, apply it now; an isolation child replays the journal at boot. */
  async #apply(op: JournalOp): Promise<void> {
    if (this.options.isolation === "process") {
      this.#journal.push(op);
      return;
    }
    // Boot before recording: a boot replays the journal, so recording first would run the op twice.
    const php = await this.php();
    this.#journal.push(op);
    await applyOp(php, op);
  }

  /** Run PHP as `php script.php --flag` would; `argv[0]` is the binary name. Output is buffered whole. */
  async cli(argv: string[], options: PhpCliOptions = {}): Promise<PhpCliResult> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 0;
    if (this.options.isolation === "process") {
      return runIsolatedCli(this.#isolationRequest(argv, options), timeoutMs);
    }
    const run = this.#cli(argv, options);
    return timeoutMs > 0 ? this.#deadline(run, timeoutMs) : run;
  }

  #isolationRequest(argv: string[], options: PhpCliOptions): IsolationRequest {
    const { phpVersion, spawn } = this.options;
    return {
      // The constructor refused a function, so only "refuse" can be left.
      options: { phpVersion, spawn: spawn === "refuse" ? spawn : undefined },
      // A snapshot, so a concurrent mount() cannot change a request in flight.
      journal: [...this.#journal],
      argv,
      env: options.env,
      cwd: options.cwd,
    };
  }

  async #cli(argv: string[], options: PhpCliOptions): Promise<PhpCliResult> {
    const instance = this.php();
    // `PHP.cli()` exits its instance when the command ends, so forget it now and let the next call boot afresh.
    this.#instance = null;
    const php = await instance;
    const response = await php.cli(argv, { env: options.env, cwd: options.cwd });
    const [stdout, stderr, exitCode] = await Promise.all([
      response.stdoutText,
      response.stderrText,
      response.exitCode,
    ]);
    return { stdout, stderr, exitCode };
  }

  // php-wasm cannot interrupt a request, so this bounds waiting only; the abandoned request keeps running.
  async #deadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.#retired = true;
        reject(
          new PhpTimeoutError(
            `PHP call exceeded ${timeoutMs}ms; the request is still running and this interpreter is retired`,
            timeoutMs,
          ),
        );
      }, timeoutMs);
    });
    // The loser settling later must not surface as an unhandled rejection.
    void work.catch(() => {});
    try {
      return await Promise.race([work, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Shut down; a disposed interpreter re-boots on next use. */
  async dispose(): Promise<void> {
    const instance = this.#instance;
    this.#instance = null;
    const php = await instance?.catch(() => null);
    // A runtime that is already exiting throws here, and `createPhpModule` discards this promise.
    try {
      php?.exit();
    } catch {}
  }
}

export function createInterpreter(options: PhpRuntimeOptions = {}): PhpInterpreter {
  return new PhpInterpreter(options);
}
