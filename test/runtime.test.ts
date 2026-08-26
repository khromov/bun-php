import { describe, expect, test } from "bun:test";
import { createPhpModule } from "../src/runtime";
import type { PhpModuleMeta, StdoutMode } from "../src/types";

const meta: PhpModuleMeta = { functions: [], constants: [], skipped: [] };

const cache = () => (globalThis as Record<string, any>).__bunPhpInstances as Map<string, unknown>;

const moduleWith = (id: string, stdout: StdoutMode) =>
  createPhpModule({ id, source: "<?php\n", functions: {}, meta, stdout });

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
