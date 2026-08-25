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
  withDefault,
} from "./fixtures/e2e.php";
import reserved from "./fixtures/reserved.php";

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
});

describe("errors", () => {
  test("a PHP exception becomes a PhpError carrying its class", async () => {
    expect(boom()).rejects.toThrow(PhpError);
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

  test("calling an undefined function rejects", async () => {
    expect(php.call("no_such_function", [])).rejects.toThrow();
  });

  test("exit() becomes a PhpFatalError rather than hanging", async () => {
    try {
      await quits();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PhpFatalError);
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

  test("PHP state persists across calls", async () => {
    // The default persistent mode keeps one PHP request alive, so a `static`
    // counter accumulates the way it would in any long-running PHP process.
    const first = await tick();
    expect(await tick()).toBe(first + 1);
    expect(await tick()).toBe(first + 2);
  });

  test("$eval runs arbitrary PHP against the same instance", async () => {
    expect(await php.$eval("return 6 * 7;")).toBe(42);
    expect(await php.$eval("return PHP_VERSION;")).toStartWith("8.5");
  });

  test("$reset swaps in a fresh runtime and keeps working", async () => {
    await php.$reset();
    expect(await greet("reset")).toBe("Hello, reset!");
    expect(await php.$eval("return 1 + 1;")).toBe(2);
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
  test("PHP_INT_MAX loses precision through JSON, as documented", async () => {
    // 9223372036854775807 cannot be represented exactly as a JS number.
    expect(await bigInt()).toBe(9223372036854776000);
  });
});
