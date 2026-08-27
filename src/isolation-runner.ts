// The child half of `isolation: "process"`: boot, run one CLI invocation, reply, exit. The exit is
// the point: it is the only thing that hands the wasm heap back to the OS.
import { PhpInterpreter } from "./interpreter";
import type { IsolationReply, IsolationRequest } from "./isolation";

const request = JSON.parse(await Bun.stdin.text()) as IsolationRequest;

let reply: IsolationReply;
try {
  // In-process on purpose: this process is the isolation.
  const php = new PhpInterpreter(request.options, request.journal);
  const result = await php.cli([...request.argv], { env: request.env, cwd: request.cwd });
  reply = { ok: true, result };
} catch (err) {
  reply = {
    ok: false,
    name: err instanceof Error ? err.name : "Error",
    error: err instanceof Error ? err.message : String(err),
  };
}

await Bun.write(Bun.stdout, JSON.stringify(reply));
process.exit(0);
