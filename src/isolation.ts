import { PhpError, PhpFatalError, PhpParseError, PhpTimeoutError } from "./errors";
import { PhpBuildLoadError, PhpBuildNotInstalledError } from "./php-runtime";
import type { JournalOp, PhpCliResult, PhpVersion } from "./types";

/** What crosses the wire to the runner; everything here must survive JSON. */
export interface IsolationRequest {
  options: { phpVersion?: PhpVersion; spawn?: "refuse" };
  journal: readonly JournalOp[];
  argv: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type IsolationFailure = {
  ok: false;
  name: string;
  error: string;
  /** The fields the named error type carries, so the parent can rebuild the same class. */
  fields?: Record<string, unknown>;
  /** A cause cannot cross as an object; its message is the part worth keeping. */
  cause?: string;
};

export type IsolationReply = { ok: true; result: PhpCliResult } | IsolationFailure;

type Fields = Record<string, unknown>;

/** bun-php's own error types, so one crossing the boundary keeps its class and what it knows. */
const ERROR_TYPES: Record<
  string,
  { fields: readonly string[]; build: (message: string, f: Fields, cause?: string) => Error }
> = {
  PhpParseError: {
    fields: ["file", "line"],
    build: (message, f) =>
      new PhpParseError(message, String(f.file ?? ""), f.line == null ? undefined : Number(f.line)),
  },
  PhpError: {
    fields: ["phpClass", "phpFile", "phpLine", "phpTrace"],
    build: (message, f) =>
      new PhpError(
        message,
        String(f.phpClass ?? ""),
        String(f.phpFile ?? ""),
        Number(f.phpLine ?? 0),
        String(f.phpTrace ?? ""),
      ),
  },
  PhpFatalError: {
    fields: ["phpFile", "phpLine"],
    build: (message, f) =>
      new PhpFatalError(message, String(f.phpFile ?? ""), Number(f.phpLine ?? 0)),
  },
  PhpTimeoutError: {
    fields: ["timeoutMs"],
    build: (message, f) => new PhpTimeoutError(message, Number(f.timeoutMs ?? 0)),
  },
  // These two build their own message from the two fields, so the wire message is redundant.
  PhpBuildNotInstalledError: {
    fields: ["phpVersion", "packageName"],
    build: (_message, f, cause) =>
      new PhpBuildNotInstalledError(f.phpVersion as PhpVersion, String(f.packageName ?? ""), cause),
  },
  PhpBuildLoadError: {
    fields: ["phpVersion", "packageName"],
    build: (_message, f, cause) =>
      new PhpBuildLoadError(f.phpVersion as PhpVersion, String(f.packageName ?? ""), cause),
  },
};

/**
 * The entry for an error name, if bun-php owns one. `Object.hasOwn` because an error named
 * `valueOf` or `toString` otherwise finds `Object.prototype` and is treated as a known type.
 */
function errorType(name: string): (typeof ERROR_TYPES)[string] | undefined {
  return Object.hasOwn(ERROR_TYPES, name) ? ERROR_TYPES[name] : undefined;
}

/** Flatten an error for the wire; only JSON survives the pipe to the parent. */
export function serialiseError(err: unknown): IsolationFailure {
  if (!(err instanceof Error)) return { ok: false, name: "Error", error: String(err) };
  const known = errorType(err.name);
  const fields = Object.fromEntries(
    (known?.fields ?? []).map((key) => [key, (err as unknown as Fields)[key]]),
  );
  return {
    ok: false,
    name: err.name,
    error: err.message,
    ...(known && { fields }),
    ...(err.cause != null && {
      cause: err.cause instanceof Error ? err.cause.message : String(err.cause),
    }),
  };
}

/** Rebuild what the child sent, keeping the class whenever bun-php owns it. */
export function reviveError(failure: IsolationFailure): Error {
  const known = errorType(failure.name);
  if (!known) return new Error(`${failure.name}: ${failure.error}`);
  return known.build(failure.error, failure.fields ?? {}, failure.cause);
}

// An absolute path, like the plugin's RUNTIME_PATH, so it resolves whether bun-php is a dependency, a link, or this repo.
const RUNNER_PATH = Bun.fileURLToPath(new URL("./isolation-runner.ts", import.meta.url));

/** How much of the child's stray stdout to quote back when it is not a reply. */
const STDOUT_EXCERPT = 500;

/**
 * The child's answer, or the best account of why there wasn't one. Both failures report the same
 * way: a crash and a polluted stdout are equally opaque without the child's own output.
 */
export function readReply(stdout: string, stderr: string, exitCode: number): PhpCliResult {
  // No reply means the child crashed (a wasm abort, most likely); its stderr is the best diagnostic.
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `bun-php isolation runner exited ${exitCode}`);
  }

  let reply: IsolationReply;
  try {
    reply = JSON.parse(stdout) as IsolationReply;
  } catch {
    // Exiting 0 without a reply means something else wrote to the child's stdout.
    const detail = [
      stderr.trim(),
      stdout.trim() && `stdout: ${stdout.trim().slice(0, STDOUT_EXCERPT)}`,
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `bun-php isolation runner exited 0 without a usable reply${detail ? `\n${detail}` : ""}`,
    );
  }

  if (!reply.ok) throw reviveError(reply);
  return reply.result;
}

/**
 * Whether the deadline is what ended the child. A timer that fires as the child is already exiting
 * kills a corpse, and the complete reply it left behind is a real result, not a casualty of the clock.
 */
export function killedByDeadline(timedOut: boolean, signalCode: string | null): boolean {
  return timedOut && signalCode !== null;
}

/** Run one CLI invocation in a child that exits afterwards, so the deadline is a SIGKILL. */
export async function runIsolatedCli(
  request: IsolationRequest,
  timeoutMs: number,
): Promise<PhpCliResult> {
  const child = Bun.spawn([process.execPath, RUNNER_PATH], {
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill(9);
        }, timeoutMs)
      : undefined;

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (killedByDeadline(timedOut, child.signalCode)) {
      throw new PhpTimeoutError(
        `PHP call exceeded ${timeoutMs}ms; the child process was killed`,
        timeoutMs,
      );
    }
    return readReply(stdout, stderr, exitCode);
  } finally {
    clearTimeout(timer);
    child.kill(9);
  }
}
