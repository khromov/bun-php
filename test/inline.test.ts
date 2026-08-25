import { afterAll, describe, expect, test } from "bun:test";
import { PhpError } from "../src/errors";
import { BunPHP } from "../src/inline";

afterAll(async () => {
  await BunPHP.dispose();
});

describe("result", () => {
  test("printed output comes back as a string", async () => {
    expect(await BunPHP`<?php echo "Hello world";`).toBe("Hello world");
  });

  test("a top-level return wins over output", async () => {
    expect(await BunPHP`<?php return 40 + 2;`).toBe(42);
    expect(await BunPHP`<?php echo "ignored"; return "returned";`).toBe("returned");
  });

  test("falsy return values are preserved", async () => {
    expect(await BunPHP`<?php return 0;`).toBe(0);
    expect(await BunPHP`<?php return false;`).toBe(false);
    expect(await BunPHP`<?php return "";`).toBe("");
  });

  test("structured returns arrive as JavaScript values", async () => {
    expect(await BunPHP`<?php return ["a" => 1, "b" => [2, 3]];`).toEqual({
      a: 1,
      b: [2, 3],
    });
    expect(await BunPHP`<?php return [1, 2, 3];`).toEqual([1, 2, 3]);
  });

  test("a snippet with neither output nor return resolves to an empty string", async () => {
    expect(await BunPHP`<?php $unused = 1;`).toBe("");
  });

  test("a snippet ending in a line comment still runs", async () => {
    expect(await BunPHP`<?php return 7; // done`).toBe(7);
  });
});

describe("open and close tags", () => {
  test("the opening tag is optional", async () => {
    expect(await BunPHP`return 1 + 1;`).toBe(2);
    expect(await BunPHP`<?php return 1 + 1;`).toBe(2);
  });

  test("the closing tag is optional", async () => {
    expect(await BunPHP`<?php echo "Hello world";`).toBe("Hello world");
    expect(await BunPHP`<?php echo "Hello world"; ?>`).toBe("Hello world");
  });

  test("a closing tag works with a return too", async () => {
    expect(await BunPHP`<?php return 40 + 2;`).toBe(42);
    expect(await BunPHP`<?php return 40 + 2; ?>`).toBe(42);
  });

  test("PHP eats a single newline after the closing tag", async () => {
    expect(await BunPHP`<?php echo "hi"; ?>`).toBe("hi");
  });

  test("a closing tag without an opening one still works", async () => {
    expect(await BunPHP`echo "a"; ?>`).toBe("a");
  });

  test("the short echo tag works, closed or not", async () => {
    expect(await BunPHP`<?= 6 * 7;`).toBe("42");
    expect(await BunPHP`<?= 6 * 7 ?>`).toBe("42");
  });

  test("markup before the first tag is emitted, as in a PHP file", async () => {
    expect(await BunPHP`<p>a</p><?php echo "b";`).toBe("<p>a</p>b");
  });

  test("a snippet can switch modes repeatedly", async () => {
    expect(await BunPHP`<?php echo "a"; ?><i>b</i><?php echo "c";`).toBe("a<i>b</i>c");
  });

  test("code after a closing tag can still return a value", async () => {
    expect(await BunPHP`<?php $n = 5; ?><?php return $n * 2;`).toBe(10);
  });

  test("interpolation works inside markup", async () => {
    expect(await BunPHP`<b><?= ${"safe"} ?></b>`).toContain("<b>safe</b>");
  });
});

describe("interpolation", () => {
  test("interpolates the common types", async () => {
    expect(await BunPHP`<?php return ${"text"};`).toBe("text");
    expect(await BunPHP`<?php return ${42};`).toBe(42);
    expect(await BunPHP`<?php return ${1.5};`).toBe(1.5);
    expect(await BunPHP`<?php return ${true};`).toBe(true);
    expect(await BunPHP`<?php return ${null};`).toBe("");
    expect(await BunPHP`<?php return ${[1, 2]};`).toEqual([1, 2]);
    expect(await BunPHP`<?php return ${{ k: "v" }};`).toEqual({ k: "v" });
  });

  test("interpolated values are usable as PHP expressions", async () => {
    const name = "Bun";
    expect(await BunPHP`<?php return "Hello " . ${name} . "!";`).toBe("Hello Bun!");
    expect(await BunPHP`<?php return array_sum(${[1, 2, 3, 4]});`).toBe(10);
  });

  test("several interpolations in one snippet stay in order", async () => {
    expect(await BunPHP`<?php return ${"a"} . ${"b"} . ${"c"};`).toBe("abc");
  });

  test("values are data, never code", async () => {
    // Spliced in as raw source, each of these would execute.
    const attacks = [
      `"; system("echo pwned"); "`,
      `' . file_put_contents("/tmp/bun-php-pwned.txt","x") . '`,
      `1); exit(1); //`,
      "exit(99);",
    ];

    for (const attack of attacks) {
      expect(await BunPHP`<?php return "v=" . ${attack};`).toBe(`v=${attack}`);
    }

    expect(await Bun.file("/tmp/bun-php-pwned.txt").exists()).toBe(false);
    expect(await BunPHP`<?php return "alive";`).toBe("alive");
  });

  test("strings needing escaping survive intact", async () => {
    const nasty = `quote' double" back\\slash $var {curly}\nnewline ünïcödé 🎉`;
    expect(await BunPHP`<?php return ${nasty};`).toBe(nasty);
  });

  test("BigInt interpolates as a PHP int", async () => {
    expect(await BunPHP`<?php return ${2n} + ${3n};`).toBe(5);
  });

  test("an undefined interpolation is rejected, naming its position", async () => {
    const missing = undefined as any;
    await expect(BunPHP`<?php return ${missing};`).rejects.toThrow(
      /BunPHP: interpolation #1 is undefined/,
    );
  });
});

describe("errors", () => {
  test("a thrown exception maps to PhpError", async () => {
    try {
      await BunPHP`<?php throw new RuntimeException("nope");`;
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PhpError);
      expect((error as PhpError).phpClass).toBe("RuntimeException");
    }
  });

  test("a syntax error rejects without killing the interpreter", async () => {
    expect(BunPHP`<?php this is not php`).rejects.toThrow();
    expect(await BunPHP`<?php return "still working";`).toBe("still working");
  });

  test("calling it as a plain function is refused", async () => {
    // @ts-expect-error deliberately misusing the tag
    expect(BunPHP("<?php echo 1;")).rejects.toThrow(/tagged template/);
  });
});

describe("concurrency", () => {
  test("overlapping snippets do not mix up their output", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => BunPHP`<?php echo ${`v${i}`};`),
    );
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => `v${i}`));
  });

  test("overlapping snippets do not mix up return values", async () => {
    const results = await Promise.all([
      BunPHP`<?php usleep(2000); return 1;`,
      BunPHP`<?php return 2;`,
      BunPHP`<?php usleep(1000); return 3;`,
    ]);
    expect(results).toEqual([1, 2, 3]);
  });
});

describe("lifecycle", () => {
  test("state does not leak between snippets", async () => {
    await BunPHP`<?php $GLOBALS["leaked"] = "yes";`;
    expect(await BunPHP`<?php return $GLOBALS["leaked"] ?? "clean";`).toBe("clean");
  });

  test("the interpreter is reused, so later snippets are fast", async () => {
    await BunPHP`<?php return 1;`;
    const started = performance.now();
    await BunPHP`<?php return 1;`;
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("module() exposes the underlying instance", async () => {
    const php = await BunPHP.module().$php();
    expect(typeof php.writeFile).toBe("function");
  });
});
