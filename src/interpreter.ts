import { setPhpIniEntries } from "@php-wasm/universal";
import type { PHP, SpawnHandler, StreamedPHPResponse } from "@php-wasm/universal";
import { EventEmitter } from "node:events";
import { PhpTimeoutError } from "./errors";
import { applyJournalOp, writeFileOp, type JournalOp } from "./journal";
import { runIsolatedCli, type IsolationRequest } from "./isolation";
import { bootPhp, nodeFsMountHandler, type PhpRuntimeSource } from "./php-runtime";

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
  /**
   * `"process"` runs every `cli()` in a child process that exits afterwards.
   *
   * This is the mode for driving PHP at volume, because it fixes the three
   * things the in-process interpreter cannot: `timeoutMs` becomes a SIGKILL
   * that actually stops the work; the wasm heap — which retains hundreds of MB
   * across boot/dispose cycles and never returns to baseline — is reclaimed
   * whole by the OS after every call; and concurrent calls run on separate
   * cores instead of serialising on the one thread the wasm holds.
   *
   * The trade: options must survive JSON, so `loader` and a function-valued
   * `spawn` are rejected up front, and `php()` has no instance to hand back.
   */
  isolation?: "process";
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
export async function applyRuntimeOptions(php: PHP, options: PhpRuntimeOptions): Promise<void> {
  if (options.spawn) {
    const handler = options.spawn === "refuse" ? refusingSpawnHandler() : options.spawn;
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
 * In-process, interpreters do **not** overlap with each other: two concurrent
 * one-second calls on two separate instances take two seconds, because the
 * wasm work holds the thread. `isolation: "process"` is what buys parallelism.
 */
export class PhpInterpreter {
  #php: PHP | null = null;
  #booting: Promise<PHP> | null = null;
  /** A timed-out in-process interpreter is never handed out again; see `#deadline`. */
  #retired = false;
  /**
   * `PHP.cli()` calls `exit()` on its instance when the command finishes, and a
   * second call on the same one returns exit code -1 with no output and no
   * error. So the instance is replaced between commands, and the journal is
   * replayed onto the replacement.
   */
  #spent = false;
  readonly #journal: JournalOp[] = [];

  constructor(private readonly options: PhpRuntimeOptions = {}) {
    if (options.isolation === "process") {
      // Everything an isolated interpreter is told must survive JSON to reach
      // the child; a closure cannot, so refusing it here beats a child that
      // silently runs without it.
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
  }

  /**
   * Boot lazily, and only once even under concurrent first calls.
   *
   * Unavailable under `isolation: "process"` — the interpreter lives in a
   * child that exits after each call, so there is no instance to hand back.
   */
  php(): Promise<PHP> {
    if (this.options.isolation === "process") {
      return Promise.reject(
        new Error(
          "php() is not available under isolation: 'process'; there is no in-process instance",
        ),
      );
    }
    if (this.#php) return Promise.resolve(this.#php);
    this.#booting ??= this.#boot();
    return this.#booting;
  }

  /** Whether an in-process call has timed out on this interpreter, retiring it. */
  get retired(): boolean {
    return this.#retired;
  }

  async #boot(): Promise<PHP> {
    const php = await bootPhp(this.options);
    await applyRuntimeOptions(php, this.options);
    for (const op of this.#journal) await applyJournalOp(php, op);
    this.#php = php;
    return php;
  }

  /**
   * Record one step and, in-process, apply it to the interpreter running now.
   * Isolated interpreters record only: the child replays the journal at boot.
   */
  async replay(op: JournalOp): Promise<void> {
    if (this.options.isolation === "process") {
      this.#journal.push(op);
      return;
    }
    // Booting first, because a boot replays the journal — recording this op
    // beforehand would run it twice on the very first call.
    const php = await this.php();
    this.#journal.push(op);
    await applyJournalOp(php, op);
  }

  /** Mount a host directory after boot, for a path only known per call. */
  async mount(host: string, at: string): Promise<void> {
    await this.replay({ kind: "mount", host, at });
  }

  async ini(entries: Record<string, string | number>): Promise<void> {
    await this.replay({ kind: "ini", entries });
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await this.replay(writeFileOp(path, data));
  }

  async mkdir(path: string): Promise<void> {
    await this.replay({ kind: "mkdir", path });
  }

  /**
   * Run PHP as a command line, the way `php script.php --flag` runs it.
   *
   * `argv[0]` is the binary name, so the script is `argv[1]`. The whole output
   * is buffered: a CLI tool's stdout is its result, not something to stream.
   */
  async cli(argv: string[], options: PhpCliOptions = {}): Promise<PhpCliResult> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 0;
    if (this.options.isolation === "process") {
      return runIsolatedCli(this.#isolationRequest(argv, options), timeoutMs);
    }
    const run = this.#cli(argv, options);
    return timeoutMs > 0 ? this.#deadline(run, timeoutMs) : run;
  }

  #isolationRequest(argv: string[], options: PhpCliOptions): IsolationRequest {
    const { phpVersion, ini, spawn, mounts } = this.options;
    return {
      options: {
        phpVersion,
        ini,
        // The constructor refused a function, so only "refuse" can be left.
        spawn: spawn === "refuse" ? spawn : undefined,
        mounts,
      },
      // Snapshot, so a concurrent replay() cannot mutate a request in flight.
      journal: [...this.#journal],
      argv,
      env: options.env,
      cwd: options.cwd,
    };
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
   * Give the caller its turn back after `timeoutMs`, in-process.
   *
   * php-wasm cannot interrupt a running request — `PHP.exit()` mid-call returns
   * without stopping it, verified against a busy loop that then ran to
   * completion — so this bounds *waiting*, never the work. The interpreter is
   * retired rather than reused, since the abandoned request is still using it.
   * Under `isolation: "process"` the deadline is a SIGKILL instead, which
   * stops the work for real.
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

  /** Drop the spent instance so `php()` boots a replacement and replays the journal. */
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

export function createInterpreter(options: PhpRuntimeOptions = {}): PhpInterpreter {
  return new PhpInterpreter(options);
}
