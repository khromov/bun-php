import { setPhpIniEntries } from "@php-wasm/universal";
import type { PHP, SpawnHandler, StreamedPHPResponse } from "@php-wasm/universal";
import { EventEmitter } from "node:events";
import { PhpTimeoutError } from "./errors";
import {
  bootPhp,
  nodeFsMountHandler,
  type PhpRuntimeSource,
} from "./php-runtime";

export interface PhpMount {
  /** Absolute path on the host. */
  host: string;
  /** Where it appears inside the virtual filesystem. */
  at: string;
}

export interface PhpRuntimeOptions extends PhpRuntimeSource {
  /** `php.ini` entries applied once, before the first call. */
  ini?: Record<string, string | number>;
  /**
   * How PHP's process functions behave. `"refuse"` answers every spawn with an
   * immediate non-zero exit, which is what a tool probing for a terminal needs:
   * leaving a spawn unanswered hangs the wasm bridge forever, and a real
   * handler hands guest code host execution.
   */
  spawn?: SpawnHandler | "refuse";
  /** Host directories to mount before the first call. */
  mounts?: readonly PhpMount[];
  /** Default deadline for {@link PhpInterpreter.cli}; see its caveat. */
  timeoutMs?: number;
}

export interface PhpCliOptions {
  env?: Record<string, string>;
  cwd?: string;
  /** Overrides the interpreter's own `timeoutMs`; `0` disables it. */
  timeoutMs?: number;
}

export interface PhpCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function refusingSpawnHandler(): SpawnHandler {
  return () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    queueMicrotask(() => {
      child.emit("exit", 1);
      child.emit("close", 1);
    });
    return child as unknown as ReturnType<SpawnHandler>;
  };
}

/**
 * Apply the options that have to be in place before PHP first runs.
 *
 * Shared with `runtime.ts` so an imported `.php` module and a bare interpreter
 * cannot end up configured differently.
 */
export async function applyRuntimeOptions(
  php: PHP,
  options: PhpRuntimeOptions,
): Promise<void> {
  if (options.spawn) {
    const handler =
      options.spawn === "refuse" ? refusingSpawnHandler() : options.spawn;
    await php.setSpawnHandler(handler);
  }
  if (options.ini) await setPhpIniEntries(php, options.ini);
  for (const mount of options.mounts ?? []) {
    php.mkdir(mount.at);
    await php.mount(mount.at, nodeFsMountHandler(mount.host));
  }
}

/**
 * A configured PHP interpreter with no `.php` import behind it.
 *
 * The plugin bakes its options into the generated module at load time, which
 * cannot express a mount path or an argument that is only known per call. This
 * is the seam for driving PHP directly — a CLI tool, a phar, a scratch script.
 *
 * Interpreters do **not** overlap with each other: two concurrent one-second
 * calls on two separate instances take two seconds, because the wasm work holds
 * the thread. Parallelism needs a `Worker` per interpreter.
 */
export class PhpInterpreter {
  #php: PHP | null = null;
  #booting: Promise<PHP> | null = null;
  /** A timed-out interpreter is never handed out again; see `#deadline`. */
  #retired = false;
  /**
   * `PHP.cli()` calls `exit()` on its instance when the command finishes, and a
   * second call on the same one returns exit code -1 with no output and no
   * error. So the instance is replaced between commands, and everything staged
   * on the filesystem is replayed onto the replacement.
   */
  #spent = false;
  readonly #staged: ((php: PHP) => Promise<void> | void)[] = [];

  constructor(private readonly options: PhpRuntimeOptions = {}) {}

  /** Boot lazily, and only once even under concurrent first calls. */
  php(): Promise<PHP> {
    if (this.#php) return Promise.resolve(this.#php);
    this.#booting ??= this.#boot();
    return this.#booting;
  }

  /** Whether a call has timed out on this interpreter, retiring it. */
  get retired(): boolean {
    return this.#retired;
  }

  async #boot(): Promise<PHP> {
    const php = await bootPhp(this.options);
    await applyRuntimeOptions(php, this.options);
    for (const step of this.#staged) await step(php);
    this.#php = php;
    return php;
  }

  /** Record a filesystem step and apply it to the interpreter running now. */
  async #stage(step: (php: PHP) => Promise<void> | void): Promise<void> {
    // Booting first, because a boot replays what is already staged — recording
    // this step beforehand would run it twice on the very first call.
    const php = await this.php();
    this.#staged.push(step);
    await step(php);
  }

  /** Mount a host directory after boot, for a path only known per call. */
  async mount(host: string, at: string): Promise<void> {
    await this.#stage(async (php) => {
      php.mkdir(at);
      await php.mount(at, nodeFsMountHandler(host));
    });
  }

  async ini(entries: Record<string, string | number>): Promise<void> {
    await this.#stage((php) => setPhpIniEntries(php, entries));
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await this.#stage((php) => php.writeFile(path, data));
  }

  async mkdir(path: string): Promise<void> {
    await this.#stage((php) => php.mkdir(path));
  }

  /**
   * Run PHP as a command line, the way `php script.php --flag` runs it.
   *
   * `argv[0]` is the binary name, so the script is `argv[1]`. The whole output
   * is buffered: a CLI tool's stdout is its result, not something to stream.
   */
  async cli(argv: string[], options: PhpCliOptions = {}): Promise<PhpCliResult> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 0;
    const run = this.#cli(argv, options);
    return timeoutMs > 0 ? this.#deadline(run, timeoutMs) : run;
  }

  async #cli(argv: string[], options: PhpCliOptions): Promise<PhpCliResult> {
    if (this.#spent) await this.#replaceInstance();
    this.#spent = true;
    const response: StreamedPHPResponse = await (
      await this.php()
    ).cli(argv, { env: options.env, cwd: options.cwd });
    const [stdout, stderr, exitCode] = await Promise.all([
      response.stdoutText,
      response.stderrText,
      response.exitCode,
    ]);
    return { stdout, stderr, exitCode };
  }

  /**
   * Give the caller its turn back after `timeoutMs`.
   *
   * php-wasm cannot interrupt a running request — `PHP.exit()` mid-call returns
   * without stopping it, verified against a busy loop that then ran to
   * completion — so this bounds *waiting*, never the work. The interpreter is
   * retired rather than reused, since the abandoned request is still using it.
   */
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
    // The loser is left to settle on its own: rejecting it early would surface
    // as an unhandled rejection once the abandoned request finally finishes.
    void work.catch(() => {});
    try {
      return await Promise.race([work, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drop the spent instance so `php()` boots a replacement and replays staging. */
  async #replaceInstance(): Promise<void> {
    this.#spent = false;
    const php = this.#php;
    this.#php = null;
    this.#booting = null;
    php?.exit();
  }

  /** Shut the interpreter down. A disposed interpreter re-boots on next use. */
  async dispose(): Promise<void> {
    const booting = this.#booting;
    this.#booting = null;
    const php = this.#php ?? (booting ? await booting.catch(() => null) : null);
    this.#php = null;
    php?.exit();
  }
}

export function createInterpreter(
  options: PhpRuntimeOptions = {},
): PhpInterpreter {
  return new PhpInterpreter(options);
}
