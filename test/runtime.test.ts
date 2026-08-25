import { describe, expect, test } from "bun:test";
import { createPhpModule } from "../src/runtime";
import type { PhpModuleMeta, StdoutMode } from "../src/types";

const meta: PhpModuleMeta = { functions: [], constants: [], skipped: [] };

const cache = () =>
  (globalThis as Record<string, any>).__bunPhpInstances as Map<string, unknown>;

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
