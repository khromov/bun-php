import { PhpTimeoutError } from "./errors";
import type { JournalOp, PhpCliResult, PhpVersion } from "./types";

/** What crosses the wire to the runner; everything here must survive JSON. */
export interface IsolationRequest {
  options: { phpVersion?: PhpVersion; spawn?: "refuse" };
  journal: readonly JournalOp[];
  argv: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type IsolationReply =
  | { ok: true; result: PhpCliResult }
  | { ok: false; name: string; error: string };

// An absolute path, like the plugin's RUNTIME_PATH, so it resolves whether bun-php is a dependency, a link, or this repo.
const RUNNER_PATH = Bun.fileURLToPath(new URL("./isolation-runner.ts", import.meta.url));

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
    if (timedOut) {
      throw new PhpTimeoutError(
        `PHP call exceeded ${timeoutMs}ms; the child process was killed`,
        timeoutMs,
      );
    }
    // No reply means the child crashed (a wasm abort, most likely); its stderr is the best diagnostic.
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `bun-php isolation runner exited ${exitCode}`);
    }
    const reply = JSON.parse(stdout) as IsolationReply;
    if (!reply.ok) throw new Error(`${reply.name}: ${reply.error}`);
    return reply.result;
  } finally {
    clearTimeout(timer);
    child.kill(9);
  }
}
