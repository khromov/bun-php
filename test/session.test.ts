/**
 * The persistent session keeps one PHP request alive to serve every call, so
 * the autoloader is registered once and loaded classes stay resident.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { PhpError, PhpFatalError } from "../src/errors";
import { parsePhp } from "../src/parse";
import { createPhpModule } from "../src/runtime";
import type { PhpModuleApi, StdoutMode } from "../src/types";

const modules: PhpModuleApi[] = [];
let counter = 0;

function moduleFor(
  source: string,
  options: { persist?: boolean; stdout?: StdoutMode } = {},
): PhpModuleApi {
  const id = `/virtual/session-${counter++}.php`;
  const meta = parsePhp(source, id);
  const mod = createPhpModule({
    id,
    source,
    functions: Object.fromEntries(meta.functions.map((f) => [f.exportName, f.phpName])),
    meta,
    root: null,
    autoload: null,
    ...options,
  });
  modules.push(mod);
  return mod;
}

afterAll(async () => {
  await Promise.all(modules.map((mod) => mod.$dispose().catch(() => {})));
});

const STATEFUL = `<?php
function tick(): int { static $n = 0; return ++$n; }
function setGlobal(string $v): void { $GLOBALS['kept'] = $v; }
function getGlobal(): ?string { return $GLOBALS['kept'] ?? null; }
function loaderCount(): int { return count(spl_autoload_functions() ?: []); }
function registerLoader(): void { spl_autoload_register(function ($c) {}); }
`;

describe("persistent mode (the default)", () => {
  test("static variables accumulate across calls", async () => {
    const mod = moduleFor(STATEFUL);
    expect(await mod.call("tick", [])).toBe(1);
    expect(await mod.call("tick", [])).toBe(2);
    expect(await mod.call("tick", [])).toBe(3);
  });

  test("globals survive between calls", async () => {
    const mod = moduleFor(STATEFUL);
    expect(await mod.call("getGlobal", [])).toBeNull();
    await mod.call("setGlobal", ["remembered"]);
    expect(await mod.call("getGlobal", [])).toBe("remembered");
  });

  test("an autoloader is registered once, not per call", async () => {
    // This is the whole point: re-registering per call is what made
    // Composer-backed calls expensive.
    const mod = moduleFor(STATEFUL);
    await mod.call("registerLoader", []);
    const after = await mod.call("loaderCount", []);
    expect(await mod.call("loaderCount", [])).toBe(after);
    expect(await mod.call("loaderCount", [])).toBe(after);
  });

  test("$reset clears PHP state", async () => {
    const mod = moduleFor(STATEFUL);
    await mod.call("tick", []);
    await mod.call("tick", []);
    await mod.$reset();
    expect(await mod.call("tick", [])).toBe(1);
  });
});

describe("isolated mode (persist: false)", () => {
  test("state does not carry between calls", async () => {
    const mod = moduleFor(STATEFUL, { persist: false });
    expect(await mod.call("tick", [])).toBe(1);
    expect(await mod.call("tick", [])).toBe(1);
  });

  test("globals do not carry between calls", async () => {
    const mod = moduleFor(STATEFUL, { persist: false });
    await mod.call("setGlobal", ["remembered"]);
    expect(await mod.call("getGlobal", [])).toBeNull();
  });
});

describe("errors keep the session serving", () => {
  const THROWS = `<?php
function ok(): string { return "fine"; }
function boom(): void { throw new \\RuntimeException("kaboom"); }
function undefinedCall(): void { definitely_not_defined(); }
function quits(): void { exit(3); }
`;

  test("a thrown exception maps to PhpError and the session survives", async () => {
    const mod = moduleFor(THROWS);
    try {
      await mod.call("boom", []);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PhpError);
      expect((error as PhpError).phpClass).toBe("RuntimeException");
      expect((error as PhpError).phpLine).toBeGreaterThan(0);
    }
    expect(await mod.call("ok", [])).toBe("fine");
  });

  test("a PHP 8 Error is catchable, so the session survives too", async () => {
    const mod = moduleFor(THROWS);
    expect(mod.call("undefinedCall", [])).rejects.toThrow(PhpError);
    expect(await mod.call("ok", [])).toBe("fine");
  });

  test("exit() ends the session, and the next call restarts it", async () => {
    const mod = moduleFor(THROWS);
    await mod.call("ok", []);

    try {
      await mod.call("quits", []);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PhpFatalError);
      expect((error as Error).message).toContain("ended unexpectedly");
    }

    // Transparently recovered on the next call.
    expect(await mod.call("ok", [])).toBe("fine");
  });

  test("state is fresh after an exit() restart", async () => {
    const mod = moduleFor(`<?php
function tick(): int { static $n = 0; return ++$n; }
function quits(): void { exit(1); }
`);
    expect(await mod.call("tick", [])).toBe(1);
    expect(await mod.call("tick", [])).toBe(2);
    await mod.call("quits", []).catch(() => {});
    expect(await mod.call("tick", [])).toBe(1);
  });
});

describe("call correctness", () => {
  const ECHOES = `<?php
function identity(int $n): int { return $n; }
function slow(int $n): int { usleep(1000); return $n; }
function talks(string $s): string { echo "out:$s;"; return strtoupper($s); }
`;

  test("concurrent calls each receive their own result", async () => {
    // Results are matched to callers by queue order, so overlapping calls
    // must not cross wires.
    const mod = moduleFor(ECHOES);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => mod.call("identity", [i])),
    );
    expect(results).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  test("concurrent calls of differing duration stay matched", async () => {
    const mod = moduleFor(ECHOES);
    const results = await Promise.all([
      mod.call("slow", [1]),
      mod.call("identity", [2]),
      mod.call("slow", [3]),
      mod.call("identity", [4]),
    ]);
    expect(results).toEqual([1, 2, 3, 4]);
  });

  test("output is captured per call, not mixed into the result", async () => {
    const mod = moduleFor(ECHOES, { stdout: "capture" });
    expect(await mod.call("talks", ["a"])).toBe("A");
    expect(await mod.call("talks", ["b"])).toBe("B");
    expect(mod.$output()).toBe("out:a;out:b;");
  });

  test("arguments and return values round-trip", async () => {
    const mod = moduleFor(`<?php function echoBack(mixed $v): mixed { return $v; }`);
    const payload = { s: "x'y\"z", n: 1.5, b: true, nil: null, list: [1, 2], deep: { k: "v" } };
    expect(await mod.call("echoBack", [payload])).toEqual(payload);
    expect(await mod.call("echoBack", [[1, "two", null]])).toEqual([1, "two", null]);
  });

  test("$eval runs against the live session", async () => {
    const mod = moduleFor(STATEFUL);
    await mod.call("tick", []);
    // The eval sees the same interpreter, so it observes the same static.
    expect(await mod.$eval("return tick();")).toBe(2);
    expect(await mod.$eval("return 6 * 7;")).toBe(42);
  });

  test("a syntax error in $eval does not kill the session", async () => {
    const mod = moduleFor(STATEFUL);
    expect(mod.$eval("this is not php")).rejects.toThrow();
    expect(await mod.$eval("return 1 + 1;")).toBe(2);
  });
});
