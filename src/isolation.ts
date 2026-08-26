import { PhpTimeoutError } from "./errors";
import type { JournalOp } from "./journal";
import type { PhpCliResult, PhpRuntimeOptions } from "./interpreter";

/**
 * What crosses the wire to the runner. Everything here must survive JSON,
 * which is why `loader` and a function-valued `spawn` are rejected before an
 * isolated interpreter is ever constructed.
 */
export interface IsolationRequest {
  options: Pick<PhpRuntimeOptions, "phpVersion" | "ini" | "mounts"> & {
    spawn?: "refuse";
  };
  journal: readonly JournalOp[];
  argv: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type IsolationReply =
  | { ok: true; result: PhpCliResult }
  | { ok: false; name: string; error: string };

/**
 * The runner, resolved by absolute path like the plugin's RUNTIME_PATH, so it
 * is found whether bun-php is a dependency, a link, or this repository.
 */
const RUNNER_PATH = Bun.fileURLToPath(new URL("./isolation-runner.ts", import.meta.url));

/**
 * Run one CLI invocation in a child process that exits afterwards.
 *
 * The process boundary is what makes two things true that no in-process mode
 * can offer: the deadline is a SIGKILL, so the work actually stops rather than
 * merely being abandoned; and the wasm heap — which never shrinks and retains
 * hundreds of MB across boot/dispose cycles — is reclaimed whole by the OS.
 */
export async function runIsolatedCli(
  request: IsolationRequest,
  timeoutMs: number,
): Promise<PhpCliResult> {
  const proc = Bun.spawn([process.execPath, RUNNER_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs);
  }

  try {
    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new PhpTimeoutError(
        `PHP call exceeded ${timeoutMs}ms; the child process was killed`,
        timeoutMs,
      );
    }
    // A crash before the reply — a wasm abort, most likely — has no JSON to
    // parse, so the child's stderr is the best available diagnostic.
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `bun-php isolation runner exited ${exitCode}`);
    }
    const reply = JSON.parse(stdout) as IsolationReply;
    if (!reply.ok) throw new Error(`${reply.name}: ${reply.error}`);
    return reply.result;
  } finally {
    clearTimeout(timer);
    proc.kill(9);
  }
}
