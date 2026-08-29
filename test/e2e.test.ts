/**
 * End-to-end tests: these import real `.php` files through the plugin, which
 * is registered by the `preload` entry in bunfig.toml.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { PhpError, PhpFatalError } from "../src/errors";
import php, {
  addAll,
  APP_NAME,
  bigInt,
  boom,
  echoNull,
  greet,
  makeAssoc,
  makeList,
  nothing,
  quits,
  roundTrip,
  tick,
  warnsThenExits,
  withDefault,
  withShutdown,
} from "./fixtures/e2e.php";
import reserved, { yield as yieldConstant } from "./fixtures/reserved.php";

afterAll(async () => {
  await php.$dispose();
  await reserved.$dispose();
});

describe("calling PHP functions", () => {
  test("returns a string", async () => {
    expect(await greet("world")).toBe("Hello, world!");
  });

  test("accepts variadic arguments", async () => {
    expect(await addAll(1, 2, 3, 4, 5)).toBe(15);
    expect(await addAll()).toBe(0);
  });

  test("applies PHP defaults when arguments are omitted", async () => {
    expect(await withDefault("a")).toBe("a/default");
    expect(await withDefault("a", "b")).toBe("a/b");
  });

  test("a list array becomes a JS array", async () => {
    expect(await makeList()).toEqual([1, 2, 3]);
  });

  test("an associative array becomes a JS object", async () => {
    expect(await makeAssoc()).toEqual({ a: 1, nested: { b: true } });
  });

  test("null round-trips", async () => {
    expect(await echoNull()).toBeNull();
  });

  test("void returns null", async () => {
    expect(await nothing()).toBeNull();
  });

  test("structured data round-trips both ways", async () => {
    const payload = { name: "x", tags: ["a", "b"], nested: { n: 1, ok: true } };
    expect(await roundTrip(payload)).toEqual(payload);
    expect(await roundTrip([1, "two", null])).toEqual([1, "two", null]);
  });

  test("strings needing escaping survive the boundary", async () => {
    const nasty = `quote' double" back\\slash $var {curly} \n newline ünïcödé 🎉`;
    expect(await greet(nasty)).toBe(`Hello, ${nasty}!`);
  });

  test("output printed after the result does not corrupt it", async () => {
    // A user-registered shutdown function runs after the envelope is emitted.
    expect(await withShutdown()).toBe(41);
  });

  test("a PHP function shadowing Object.prototype is reachable", async () => {
    expect(await (php as any).toString()).toBe("shadowed the prototype");
  });
});

describe("argument marshalling", () => {
  test("a trailing undefined argument falls back to the PHP default", async () => {
    expect(await withDefault("a", undefined as any)).toBe("a/default");
  });

  test("an undefined hole before a defined argument is rejected", async () => {
    await expect(withDefault(undefined as any, "b")).rejects.toThrow(
      /withDefault: argument #1 is undefined/,
    );
  });

  test("BigInt arguments become PHP ints", async () => {
    expect(await addAll(2n as any, 3n as any)).toBe(5);
  });

  test("a BigInt beyond 64 bits is rejected with context", async () => {
    await expect(addAll((2n ** 64n) as any)).rejects.toThrow(/overflows/);
  });
});

describe("constants", () => {
  test("are exported as plain values, available without booting PHP", () => {
    expect(APP_NAME).toBe("bun-php");
  });
});

describe("reserved words", () => {
  test("a PHP function named `delete` is importable under an alias", async () => {
    expect(await reserved.call("delete", ["file"])).toBe("deleted file");
  });

  test("and is reachable on the default export", async () => {
    expect(await reserved.class_of("x")).toBe("x");
  });

  test("a strict-mode-only reserved name survives the real module loader", () => {
    // Bun's transpiler tolerates `const yield`, but its module loader (and
    // every spec-compliant engine) rejects it; this import only resolves
    // because codegen re-exports the constant through an alias.
    expect(yieldConstant).toBe("coroutine");
  });
});

describe("errors", () => {
  test("a PHP exception becomes a PhpError carrying its class", async () => {
    await expect(boom()).rejects.toThrow(PhpError);
    try {
      await boom();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PhpError);
      const phpError = error as PhpError;
      expect(phpError.phpClass).toBe("RuntimeException");
      expect(phpError.message).toContain("kaboom");
      expect(phpError.phpLine).toBeGreaterThan(0);
      expect(phpError.phpTrace).toBeTruthy();
    }
  });

  test("call() does not reach Object.prototype", async () => {
    // `functions.constructor` would otherwise template-stringify a native function into the PHP
    // source, so the error blamed `function Object() { [native code] }` instead of the name asked for.
    for (const name of ["constructor", "hasOwnProperty", "valueOf"]) {
      const error = await php.call(name, []).catch((err: unknown) => err as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain("[native code]");
      expect(error.message).toContain(`Call to undefined function ${name}()`);
    }

    // A PHP function that really is named after a prototype member still resolves.
    expect(await php.call("toString", [])).toBe("shadowed the prototype");
  });

  test("calling an undefined function rejects", async () => {
    await expect(php.call("no_such_function", [])).rejects.toThrow(/no_such_function/);
  });

  test("exit() becomes a PhpFatalError rather than hanging", async () => {
    try {
      await quits();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PhpFatalError);
    }
  });

  test("a stale warning is not blamed for an envelope-less exit", async () => {
    try {
      await warnsThenExits();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PhpFatalError);
      expect((error as Error).message).toContain("PHP exited before returning a value");
      expect((error as Error).message).not.toContain("just a warning");
    }
  });

  test("the interpreter still works after an error", async () => {
    expect(await greet("after")).toBe("Hello, after!");
  });
});

describe("interpreter lifecycle", () => {
  test("the first call boots and later calls reuse the instance", async () => {
    await php.$ready();
    const started = performance.now();
    await greet("warm");
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("PHP request state does not leak between calls", async () => {
    // php-wasm resets request-scoped state per run, so a `static` counter
    // restarts every time rather than accumulating.
    expect(await tick()).toBe(1);
    expect(await tick()).toBe(1);
  });

  test("$eval runs arbitrary PHP against the same instance", async () => {
    expect(await php.$eval("return 6 * 7;")).toBe(42);
    expect(await php.$eval("return PHP_VERSION;")).toStartWith("8.5");
  });

  test("$eval tolerates a trailing line comment", async () => {
    expect(await php.$eval("return 7; // done")).toBe(7);
    expect(await php.$eval("return 8; # also done")).toBe(8);
  });

  test("$reset swaps in a fresh runtime and keeps working", async () => {
    await php.$reset();
    expect(await greet("reset")).toBe("Hello, reset!");
    expect(await php.$eval("return 1 + 1;")).toBe(2);
  });

  test("$reset discards files written into the virtual filesystem", async () => {
    await php.$eval("file_put_contents('/tmp/reset-probe', 'x'); return true;");
    expect(await php.$eval("return file_exists('/tmp/reset-probe');")).toBe(true);
    await php.$reset();
    expect(await php.$eval("return file_exists('/tmp/reset-probe');")).toBe(false);
  });

  test("$reset lets an in-flight call finish instead of killing it", async () => {
    const [greeting] = await Promise.all([greet("concurrent"), php.$reset()]);
    expect(greeting).toBe("Hello, concurrent!");
  });

  test("$dispose during boot still tears the instance down", async () => {
    const cache = (globalThis as any).__bunPhpInstances as Map<string, unknown>;
    const id = `${import.meta.dir}/fixtures/e2e.php`;

    await php.$dispose(); // Go cold so $ready() below starts a real boot.
    const ready = php.$ready();
    await php.$dispose();
    await ready; // The pending boot resolves, but must not resurrect anything.
    expect(cache.has(id)).toBe(false);

    // The next call boots a fresh interpreter and re-registers it.
    expect(await greet("revived")).toBe("Hello, revived!");
    expect(cache.has(id)).toBe(true);
  });

  test("$meta reports what the parser found", () => {
    const names = php.$meta.functions.map((f: any) => f.exportName);
    expect(names).toContain("greet");
    expect(names).not.toContain("shouldNotExist");
    expect(php.$meta.constants).toContainEqual({
      name: "APP_NAME",
      value: "bun-php",
    });
  });

  test("$php exposes the underlying php-wasm instance", async () => {
    const instance = await php.$php();
    expect(typeof instance.writeFile).toBe("function");
    expect(instance.fileExists(import.meta.dir + "/fixtures/e2e.php")).toBe(true);
  });
});

describe("known marshalling limits", () => {
  test("a lone surrogate is refused before PHP is reached", async () => {
    // roundTrip is typed `array $data`, so before the check this arrived as null and PHP answered
    // with a confusing TypeError about the parameter rather than naming the real problem.
    expect(await roundTrip({ ok: "\u{1f600}" })).toEqual({ ok: "\u{1f600}" });
    await expect(roundTrip({ ok: "\ud800" })).rejects.toThrow(/lone UTF-16 surrogate/);
  });

  test("PHP_INT_MAX loses precision through JSON, as documented", async () => {
    // 9223372036854775807 cannot be represented exactly as a JS number.
    expect(await bigInt()).toBe(9223372036854776000);
  });
});
