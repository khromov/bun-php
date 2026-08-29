import { describe, expect, test } from "bun:test";
import { PhpTimeoutError } from "../src/errors";
import { createPhpModule } from "../src/runtime";
import type { PhpModuleMeta, StdoutMode } from "../src/types";

const meta: PhpModuleMeta = { functions: [], constants: [], skipped: [] };

const cache = () => (globalThis as Record<string, any>).__bunPhpInstances as Map<string, unknown>;

const moduleWith = (id: string, stdout: StdoutMode) =>
  createPhpModule({ id, source: "<?php\n", functions: {}, meta, stdout });

/** A `loader` that counts how many times the wasm runtime was instantiated. */
function countingLoader() {
  const counter = { boots: 0 };
  const loader = async () => {
    counter.boots++;
    return (await import("@php-wasm/node-8-5")).getPHPLoaderModule();
  };
  return { counter, loader };
}

describe("instance cache", () => {
  test("unchanged options reuse the cached instance", () => {
    const id = "/virtual/cache-same.php";
    moduleWith(id, "capture");
    const first = cache().get(id);
    moduleWith(id, "capture");
    expect(cache().get(id)).toBe(first);
    cache().delete(id);
  });

  test("a changed stdout option rebuilds the cached instance", () => {
    // Otherwise the first module's mode silently sticks: $output() would stay
    // empty forever, or output would vanish into an undrained buffer.
    const id = "/virtual/cache-stdout.php";
    moduleWith(id, "capture");
    const first = cache().get(id);
    moduleWith(id, "ignore");
    expect(cache().get(id)).not.toBe(first);
    cache().delete(id);
  });

  test("the key does not depend on the order options were written", () => {
    // A plain JSON.stringify made the same configuration two different keys, disposing and
    // re-booting an interpreter over nothing.
    const id = "/virtual/cache-order.php";
    const build = (runtime: Record<string, unknown>) =>
      createPhpModule({ id, source: "<?php\n", functions: {}, meta, stdout: "ignore", runtime });

    build({ phpVersion: "8.5", timeoutMs: 1000, ini: { memory_limit: "64M", precision: 14 } });
    const first = cache().get(id);
    build({ ini: { precision: 14, memory_limit: "64M" }, timeoutMs: 1000, phpVersion: "8.5" });

    expect(cache().get(id)).toBe(first);
    cache().delete(id);
  });
});

describe("default export", () => {
  test("exposes PHP functions named after Object.prototype members", () => {
    const id = "/virtual/proto-names.php";
    const api = createPhpModule({
      id,
      source: "<?php\n",
      functions: { toString: "toString", hasOwnProperty: "hasOwnProperty" },
      meta,
      stdout: "ignore",
    });
    expect(Object.hasOwn(api, "toString")).toBe(true);
    expect(Object.hasOwn(api, "hasOwnProperty")).toBe(true);
    cache().delete(id);
  });
});

describe("streaming output", () => {
  test("output arrives while the script is still running", async () => {
    const module = createPhpModule({
      id: "/virtual/stream-live.php",
      source: "<?php\n",
      functions: {},
      meta,
      stdout: "ignore",
    });

    const started = performance.now();
    const arrivals: number[] = [];
    await module.$eval(`echo "a"; usleep(300000); echo "b";`, () => {
      arrivals.push(performance.now() - started);
    });

    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    // Handed over in one piece at the end, the two would land together; the
    // gap between them can only exist if each was released as PHP wrote it.
    expect(arrivals.at(-1)! - arrivals[0]!).toBeGreaterThan(200);

    await module.$dispose();
  });

  test("a sink takes the output away from the stdout mode", async () => {
    const module = createPhpModule({
      id: "/virtual/stream-sink.php",
      source: "<?php\n",
      functions: {},
      meta,
      stdout: "capture",
    });

    let sunk = "";
    await module.$eval(`echo "to the sink";`, (text) => {
      sunk += text;
    });
    expect(sunk).toBe("to the sink");
    expect(module.$output()).toBe("");

    // Without one, the module's own mode applies again.
    await module.$eval(`echo "to the module";`);
    expect(module.$output()).toBe("to the module");

    await module.$dispose();
  });
});

describe("runtime.timeoutMs", () => {
  test("does not count the wasm boot against the first call", async () => {
    // Booting costs 100-800ms cold, which no caller can influence; charging it to the deadline made
    // the first call reject and the retry succeed. The loader is slowed so the boot alone outlasts
    // the budget however warm the wasm cache is, while leaving the call itself room on a slow runner.
    const module = createPhpModule({
      id: "/virtual/timeout-cold.php",
      source: "<?php\n",
      functions: {},
      meta,
      stdout: "ignore",
      runtime: {
        timeoutMs: 400,
        loader: async () => {
          await Bun.sleep(1000);
          return (await import("@php-wasm/node-8-5")).getPHPLoaderModule();
        },
      },
    });

    expect(await module.$eval("return 1;")).toBe(1);
    await module.$dispose();
  }, 30_000);

  test("bounds the wait on a module call", async () => {
    // The plugin accepts and documents it, but nothing outside cli() used to consume it.
    const module = createPhpModule({
      id: "/virtual/timeout.php",
      source: "<?php\n",
      functions: {},
      meta,
      stdout: "ignore",
      runtime: { timeoutMs: 100 },
    });
    await module.$ready();

    const error = await module.$eval("usleep(700000); return 1;").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PhpTimeoutError);
    expect((error as PhpTimeoutError).timeoutMs).toBe(100);

    await module.$dispose();
  }, 30_000);

  test("a call inside the deadline is untouched", async () => {
    const module = createPhpModule({
      id: "/virtual/timeout-ok.php",
      source: "<?php\n",
      functions: {},
      meta,
      stdout: "ignore",
      runtime: { timeoutMs: 30_000 },
    });
    expect(await module.$eval("return 7;")).toBe(7);
    await module.$dispose();
  }, 30_000);
});

describe("output chronology", () => {
  test("buffers left open arrive before output written after the envelope", async () => {
    // The envelope carries what was still buffered when it was emitted, so it was written first.
    const module = createPhpModule({
      id: "/virtual/chrono.php",
      source: "<?php\n",
      functions: {},
      meta,
      stdout: "ignore",
    });

    const order: string[] = [];
    await module.$eval(
      `ob_start();
         echo "[buffered first]";
         register_shutdown_function(function () { echo "[shutdown last]"; });
         return 1;`,
      (text) => order.push(text),
    );

    expect(order.join("")).toBe("[buffered first][shutdown last]");
    await module.$dispose();
  }, 30_000);
});

describe("$reset", () => {
  test("defers the re-boot to the next call", async () => {
    const { counter, loader } = countingLoader();
    const module = createPhpModule({
      id: "/virtual/reset-lazy.php",
      source: "<?php\n",
      functions: {},
      meta,
      stdout: "ignore",
      runtime: { loader },
    });

    // Cold: nothing to discard, and nothing worth booting yet.
    await module.$reset();
    expect(counter.boots).toBe(0);

    await module.$ready();
    expect(counter.boots).toBe(1);

    // The old runtime is gone, but a new one is not paid for until it is needed.
    await module.$reset();
    expect(counter.boots).toBe(1);

    expect(await module.$eval("return 1;")).toBe(1);
    expect(counter.boots).toBe(2);

    await module.$dispose();
  }, 30_000);

  test("waits for a call the deadline already rejected", async () => {
    // The timeout rejects the caller, but the PHP runs on. Dropping it from `#running` there let a
    // reset exit the runtime out from under a live request, defeating the drain's whole purpose.
    const module = createPhpModule({
      id: "/virtual/reset-timeout.php",
      source: "<?php\n",
      functions: {},
      meta,
      stdout: "ignore",
      runtime: { timeoutMs: 200 },
    });
    await module.$ready();

    await expect(module.$eval("usleep(1200000); return 1;")).rejects.toBeInstanceOf(
      PhpTimeoutError,
    );

    const started = performance.now();
    await module.$reset();
    // The abandoned request had ~1s left to run; a reset that returned at once ignored it.
    expect(performance.now() - started).toBeGreaterThan(500);

    await module.$dispose();
  }, 30_000);

  test("discards output from a call that lands during the drain", async () => {
    // Clearing before the drain let an in-flight call refill the buffer past the reset.
    const module = createPhpModule({
      id: "/virtual/reset-capture.php",
      source: "<?php\n",
      functions: {},
      meta,
      stdout: "capture",
    });
    await module.$ready();

    const call = module.$eval(`usleep(250000); echo "late output"; return 1;`);
    await Bun.sleep(30);
    await module.$reset();
    await call;

    expect(module.$output()).toBe("");
    await module.$dispose();
  }, 30_000);

  test("keeps the module in the cache, unlike $dispose", async () => {
    const id = "/virtual/reset-cache.php";
    const module = moduleWith(id, "ignore");
    await module.$ready();

    await module.$reset();
    expect(cache().has(id)).toBe(true);

    await module.$dispose();
    expect(cache().has(id)).toBe(false);
  }, 30_000);

  test("overlapping resets and disposes settle, and the module keeps working", async () => {
    const module = moduleWith("/virtual/reset-overlap.php", "ignore");
    await module.$ready();

    // Neither call is serialised behind the other any more, so they must be
    // safe to run against the same runtime at the same time.
    await Promise.all([module.$reset(), module.$dispose(), module.$reset(), module.$dispose()]);

    expect(await module.$eval("return 2;")).toBe(2);
    await module.$dispose();
  }, 30_000);
});
