/**
 * Compatibility across every `@php-wasm/node-8-*` build. `BUN_PHP_VERSIONS` picks the targets (CI
 * runs one build per job); unset, this covers whichever builds happen to be installed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhpError, PhpFatalError } from "../src/errors";
import { createInterpreter } from "../src/interpreter";
import { parsePhp } from "../src/parse";
import { PHP_VERSION } from "../src/php-runtime";
import { createPhpModule } from "../src/runtime";
import type { PhpRuntimeOptions } from "../src/types";
import { versionTargets } from "./php-builds";

const BOOT_MS = 30_000;

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bun-php-versions-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const FIXTURE = join(import.meta.dir, "fixtures/e2e.php");
// PHP 8.0-compatible on purpose: this fixture is what pins the oldest build we claim to support.
const SOURCE = await Bun.file(FIXTURE).text();
const META = parsePhp(SOURCE, FIXTURE);
const FUNCTIONS = Object.fromEntries(META.functions.map((f) => [f.exportName, f.phpName]));

for (const { label, version } of versionTargets()) {
  // What PHP should report: an explicit build, or the default the runtime falls back to.
  const expected = version ?? PHP_VERSION;
  const runtime = version ? { phpVersion: version } : {};
  const interpreterOptions = (extra: PhpRuntimeOptions = {}): PhpRuntimeOptions => ({
    ...runtime,
    ...extra,
  });

  describe(`PHP ${label}`, () => {
    // A virtual id, not the real fixture path: instances are cached by id, so reusing the path
    // would dispose the one test/e2e.test.ts is holding.
    const php = createPhpModule({
      id: `/virtual/versions-${label}.php`,
      source: SOURCE,
      functions: FUNCTIONS,
      meta: META,
      stdout: "capture",
      runtime,
    });

    afterAll(async () => {
      await php.$dispose();
    });

    test(
      "boots and reports the expected version",
      async () => {
        expect(await php.$eval("return PHP_VERSION;")).toStartWith(`${expected}.`);
      },
      BOOT_MS,
    );

    test(
      "calls a function and marshals its arguments",
      async () => {
        expect(await php.call("greet", ["world"])).toBe("Hello, world!");
        expect(await php.call("addAll", [1, 2, 3, 4, 5])).toBe(15);
        expect(await php.call("withDefault", ["a"])).toBe("a/default");
      },
      BOOT_MS,
    );

    test(
      "every value shape survives the round trip",
      async () => {
        expect(await php.call("makeList", [])).toEqual([1, 2, 3]);
        expect(await php.call("makeAssoc", [])).toEqual({ a: 1, nested: { b: true } });
        expect(await php.call("echoNull", [])).toBeNull();
        expect(await php.call("nothing", [])).toBeNull();
        expect(await php.call("bigInt", [])).toBe(9223372036854776000);

        const payload = {
          str: "héllo ✓",
          int: 42,
          float: 1.5,
          bool: false,
          nil: null,
          list: [1, "two", true],
          nested: { deep: { deeper: [1, 2] } },
        };
        expect(await php.call("roundTrip", [payload])).toEqual(payload);
        // PHP has one array type, so both spellings of "empty" come back as an empty JS array.
        expect(await php.call("roundTrip", [{ a: [], b: {} }])).toEqual({ a: [], b: [] });
      },
      BOOT_MS,
    );

    test(
      "streams stdout and keeps it out of the return value",
      async () => {
        php.$output();
        expect(await php.call("talks", ["hi"])).toBe("HI");
        expect(php.$output()).toContain("spoken: hi");
      },
      BOOT_MS,
    );

    test(
      "output written after the envelope still arrives",
      async () => {
        php.$output();
        expect(await php.call("withShutdown", [])).toBe(41);
        expect(php.$output()).toContain("bye");
      },
      BOOT_MS,
    );

    test(
      "a PHP exception becomes a PhpError carrying its class",
      async () => {
        const error = await php.call("boom", []).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(PhpError);
        expect((error as PhpError).phpClass).toBe("RuntimeException");
        expect((error as PhpError).message).toContain("kaboom");
        expect((error as PhpError).phpLine).toBeGreaterThan(0);
      },
      BOOT_MS,
    );

    test(
      "exit() becomes a PhpFatalError and an undefined function rejects by name",
      async () => {
        await expect(php.call("quits", [])).rejects.toThrow(PhpFatalError);
        await expect(php.call("no_such_function", [])).rejects.toThrow(/no_such_function/);
      },
      BOOT_MS,
    );

    test(
      "$reset re-boots the same build",
      async () => {
        await php.$reset();
        expect(await php.call("greet", ["reset"])).toBe("Hello, reset!");
        expect(await php.$eval("return PHP_VERSION;")).toStartWith(`${expected}.`);
      },
      BOOT_MS,
    );

    test(
      "cli() runs the php binary",
      async () => {
        const cli = createInterpreter(interpreterOptions());
        try {
          const result = await cli.cli(["php", "-r", "echo PHP_VERSION;"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toStartWith(`${expected}.`);
        } finally {
          await cli.dispose();
        }
      },
      BOOT_MS,
    );

    test(
      "ini entries reach the interpreter",
      async () => {
        const cli = createInterpreter(interpreterOptions({ ini: { memory_limit: "123M" } }));
        try {
          const result = await cli.cli(["php", "-r", "echo ini_get('memory_limit');"]);
          expect(result.stdout).toBe("123M");
        } finally {
          await cli.dispose();
        }
      },
      BOOT_MS,
    );

    test(
      "a host directory mounts and is readable",
      async () => {
        await withTempDir(async (dir) => {
          await writeFile(join(dir, "probe.txt"), "mounted");
          const cli = createInterpreter(interpreterOptions());
          try {
            await cli.mount(dir, "/host");
            const result = await cli.cli([
              "php",
              "-r",
              "echo file_get_contents('/host/probe.txt');",
            ]);
            expect(result.stdout).toBe("mounted");
          } finally {
            await cli.dispose();
          }
        });
      },
      BOOT_MS,
    );

    test(
      "isolation: 'process' boots the same build in a child",
      async () => {
        const cli = createInterpreter(interpreterOptions({ isolation: "process" }));
        const result = await cli.cli(["php", "-r", "echo PHP_VERSION;"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toStartWith(`${expected}.`);
      },
      BOOT_MS,
    );
  });
}
