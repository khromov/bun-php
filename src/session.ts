import type { PHP } from "@php-wasm/universal";
import { PhpFatalError } from "./errors";
import { buildLoopScript, type Envelope } from "./marshal";

/**
 * A long-running PHP request that serves many calls.
 *
 * Normally php-wasm resets request-scoped state between runs, so every call has
 * to re-register Composer's autoloader and re-execute the class files it pulls
 * in. Instead this keeps a *single* request alive: PHP blocks inside
 * `post_message_to_js()`, and the JavaScript listener answers with the next job.
 * The autoloader is registered once and loaded classes stay resident, which is
 * worth roughly 50x on Composer-backed calls.
 *
 * Neither of the mechanisms PHP normally offers for this works here:
 * php-wasm's `/internal/shared/preload/` is implemented with
 * `auto_prepend_file`, so it re-runs every request, and OPcache — although
 * compiled in — reports itself disabled in this build, which takes
 * `opcache.preload` off the table.
 */

export type Job =
  | { type: "call"; fn: string; args: readonly unknown[] }
  | { type: "eval"; code: string }
  | { type: "shutdown" };

interface Waiter {
  resolve: (envelope: Envelope) => void;
  reject: (error: unknown) => void;
}

export class PhpSession {
  #queue: Job[] = [];
  #awaitingJob: ((job: Job) => void) | null = null;
  #waiters: Waiter[] = [];
  #unsubscribe: (() => Promise<void>) | null = null;
  #stopping = false;
  #alive = false;
  #ready = false;
  /** Resolves when the long-running request finishes. */
  #request: Promise<void> = Promise.resolve();

  constructor(
    private readonly php: PHP,
    private readonly modulePath: string,
    private readonly autoload: string | null,
    private readonly onOutput: (text: string) => void,
  ) {}

  get alive(): boolean {
    return this.#alive;
  }

  /** Start the loop and resolve once PHP reports it is ready to serve. */
  async start(): Promise<void> {
    let onReady: () => void;
    let onFailed: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      onReady = resolve;
      onFailed = reject;
    });

    this.#unsubscribe = this.php.onMessage(async (raw: string) => {
      let message: { type?: string; out?: string } & Partial<Envelope>;
      try {
        message = JSON.parse(raw);
      } catch {
        return "";
      }

      if (message.type === "ready") {
        this.#alive = true;
        this.#ready = true;
        if (message.out) this.onOutput(message.out);
        onReady();
      } else if (message.type === "result") {
        if (message.out) this.onOutput(message.out);
        this.#waiters.shift()?.resolve(message as Envelope);
      }

      return JSON.stringify(await this.#nextJob());
    });

    // Deliberately not awaited here: this request lives for as long as the
    // session. `stop()` awaits it so callers can sequence teardown.
    this.#request = this.php
      .runStream({ code: buildLoopScript(this.modulePath, this.autoload) })
      .then(async (response) => {
        const [exitCode, stderr] = await Promise.all([
          response.exitCode,
          response.stderrText,
        ]);
        this.#die(exitCode, stderr);
        // Only a failure to boot is worth reporting as a startup error; a
        // request that ends after the session was serving is either a normal
        // shutdown or an exit(), both handled by #die().
        if (!this.#ready) {
          onFailed(
            new PhpFatalError(
              `PHP exited before the session was ready (exit code ${exitCode})` +
                (stderr.trim() ? `\n${stderr.trim()}` : ""),
              this.modulePath,
              0,
            ),
          );
        }
      })
      .catch((error) => {
        this.#die(-1, String(error));
        if (!this.#ready) onFailed(error);
      });

    await ready;
  }

  /** Submit a job and wait for its result. */
  run(job: Job): Promise<Envelope> {
    if (!this.#alive) {
      return Promise.reject(
        new PhpFatalError("The PHP session is not running", this.modulePath, 0),
      );
    }

    return new Promise<Envelope>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
      this.#dispatch(job);
    });
  }

  /** Ask the loop to exit, and wait for the request to finish. */
  async stop(): Promise<void> {
    if (!this.#alive) {
      await this.#unsubscribe?.().catch(() => {});
      this.#unsubscribe = null;
      return;
    }
    this.#stopping = true;
    this.#dispatch({ type: "shutdown" });
    // Wait for the request to actually finish: anything that swaps or tears
    // down the runtime afterwards must not race with it.
    await this.#request.catch(() => {});
    await this.#unsubscribe?.().catch(() => {});
    this.#unsubscribe = null;
    this.#alive = false;
  }

  #dispatch(job: Job): void {
    if (this.#awaitingJob) {
      const deliver = this.#awaitingJob;
      this.#awaitingJob = null;
      deliver(job);
      return;
    }
    this.#queue.push(job);
  }

  /**
   * Hand PHP its next job, waiting if there is nothing to do yet.
   *
   * PHP is suspended for the duration, so this costs nothing while idle.
   */
  #nextJob(): Promise<Job> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift()!);
    if (this.#stopping || !this.#alive) {
      return Promise.resolve({ type: "shutdown" });
    }
    return new Promise<Job>((resolve) => {
      this.#awaitingJob = resolve;
    });
  }

  /** The loop ended; fail anything still outstanding. */
  #die(exitCode: number, stderr: string): void {
    this.#alive = false;

    // Release the listener if it is parked waiting for work, then drop it.
    // php-wasm consults message listeners in registration order, so a dead
    // session left subscribed would intercept the handshake of whichever
    // session replaces it.
    const deliver = this.#awaitingJob;
    this.#awaitingJob = null;
    deliver?.({ type: "shutdown" });
    void this.#unsubscribe?.().catch(() => {});
    this.#unsubscribe = null;

    const waiters = this.#waiters;
    this.#waiters = [];
    if (this.#stopping) return;

    for (const waiter of waiters) {
      waiter.reject(
        new PhpFatalError(
          `The PHP session ended unexpectedly (exit code ${exitCode}). ` +
            "exit(), die() or a non-recoverable fatal error stops the " +
            "long-running interpreter." +
            (stderr.trim() ? `\n${stderr.trim()}` : ""),
          this.modulePath,
          0,
        ),
      );
    }
  }
}
