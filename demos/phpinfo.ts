/**
 * Serves PHP's own `phpinfo()` page from a PHP 8.5 interpreter running in
 * WebAssembly, with no PHP binary involved.
 *
 *     bun run phpinfo
 */
import php, { phpInfoHtml, runtimeSummary } from "./php/info.php";

type Summary = {
  php: string;
  sapi: string;
  extensions: number;
  memory_limit: string;
};

const port = Number(process.env.PORT ?? 8080);

/** A small header so it is obvious what produced the page. */
function banner(summary: Summary): string {
  return `<div style="font:14px/1.5 system-ui,sans-serif;background:#1a1a2e;color:#eee;padding:12px 16px">
    <strong>bun-php</strong> &mdash; PHP ${summary.php} (${summary.sapi} SAPI) in WebAssembly,
    served by Bun ${Bun.version}. ${summary.extensions} extensions loaded,
    memory limit ${summary.memory_limit}.
  </div>`;
}

async function page(): Promise<Response> {
  const [html, summary] = await Promise.all([
    phpInfoHtml(),
    runtimeSummary() as Promise<Summary>,
  ]);

  return new Response(html.replace(/<body[^>]*>/i, (tag) => tag + banner(summary)), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port,
    routes: {
      "/": page,
      "/favicon.ico": () => new Response(null, { status: 204 }),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `Could not listen on port ${port}: ${message}\n` +
      `Set a different one with PORT=8081 bun run phpinfo`,
  );
  process.exit(1);
}

// Boot PHP up front so the first request is not the one that pays for it.
const started = performance.now();
await php.$ready();
console.log(`PHP booted in ${(performance.now() - started).toFixed(0)}ms`);
console.log(`phpinfo() at ${server.url}`);
