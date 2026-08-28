import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { PhpError } from "../src/errors";
import { asClosureBody, BunPHP } from "../src/inline";

afterAll(async () => {
  await BunPHP.dispose();
});

/** Run something, returning whatever it wrote to the terminal. */
async function printed(run: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });

  try {
    await run();
  } finally {
    write.mockRestore();
  }

  return chunks.join("");
}

describe("result", () => {
  test("printed output comes back as a string", async () => {
    expect(await BunPHP.capture`<?php echo "Hello world";`).toBe("Hello world");
  });

  test("a top-level return wins over output", async () => {
    expect(await BunPHP`<?php return 40 + 2;`).toBe(42);
    expect(await BunPHP.capture`<?php echo "ignored"; return "returned";`).toBe("returned");
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
    expect(await BunPHP.capture`<?php $unused = 1;`).toBe("");
  });

  test("a snippet ending in a line comment still runs", async () => {
    expect(await BunPHP`<?php return 7; // done`).toBe(7);
  });
});

describe("output", () => {
  test("echo reaches the terminal, as it does from an imported .php file", async () => {
    expect(await printed(() => BunPHP`<?php echo "Hello world";`)).toBe("Hello world");
  });

  test("a printing snippet resolves to null, not to its output", async () => {
    let value: unknown = "unset";
    await printed(async () => {
      value = await BunPHP`<?php echo "Hello world";`;
    });
    expect(value).toBeNull();
  });

  test("a return still wins, and is not printed", async () => {
    let value: unknown;
    const out = await printed(async () => {
      value = await BunPHP`<?php return 40 + 2;`;
    });
    expect(value).toBe(42);
    expect(out).toBe("");
  });

  test("capture takes the output instead of printing it", async () => {
    let value: unknown;
    const out = await printed(async () => {
      value = await BunPHP.capture`<?php echo "Hello world";`;
    });
    expect(value).toBe("Hello world");
    expect(out).toBe("");
  });

  test("output produced before a throw is still printed", async () => {
    const out = await printed(async () => {
      await expect(BunPHP`<?php echo "before"; throw new RuntimeException("x");`).rejects.toThrow();
    });
    expect(out).toBe("before");
  });

  test("a throwing snippet does not leave its output for the next one", async () => {
    await expect(
      BunPHP.capture`<?php echo "leaked"; throw new RuntimeException("x");`,
    ).rejects.toThrow();
    expect(await BunPHP.capture`<?php echo "clean";`).toBe("clean");
  });
});

describe("open and close tags", () => {
  test("the opening tag is optional", async () => {
    expect(await BunPHP`return 1 + 1;`).toBe(2);
    expect(await BunPHP`<?php return 1 + 1;`).toBe(2);
  });

  test("the closing tag is optional", async () => {
    expect(await BunPHP.capture`<?php echo "Hello world";`).toBe("Hello world");
    expect(await BunPHP.capture`<?php echo "Hello world"; ?>`).toBe("Hello world");
  });

  test("a closing tag works with a return too", async () => {
    expect(await BunPHP`<?php return 40 + 2;`).toBe(42);
    expect(await BunPHP`<?php return 40 + 2; ?>`).toBe(42);
  });

  test("PHP eats a single newline after the closing tag", async () => {
    expect(await BunPHP.capture`<?php echo "hi"; ?>`).toBe("hi");
  });

  test("a closing tag without an opening one still works", async () => {
    expect(await BunPHP.capture`echo "a"; ?>`).toBe("a");
  });

  test("the short echo tag works, closed or not", async () => {
    expect(await BunPHP.capture`<?= 6 * 7;`).toBe("42");
    expect(await BunPHP.capture`<?= 6 * 7 ?>`).toBe("42");
  });

  test("markup before the first tag is emitted, as in a PHP file", async () => {
    expect(await BunPHP.capture`<p>a</p><?php echo "b";`).toBe("<p>a</p>b");
  });

  test("a snippet can switch modes repeatedly", async () => {
    expect(await BunPHP.capture`<?php echo "a"; ?><i>b</i><?php echo "c";`).toBe("a<i>b</i>c");
  });

  test("code after a closing tag can still return a value", async () => {
    expect(await BunPHP`<?php $n = 5; ?><?php return $n * 2;`).toBe(10);
  });

  test("interpolation works inside markup", async () => {
    expect(await BunPHP.capture`<b><?= ${"safe"} ?></b>`).toContain("<b>safe</b>");
  });

  test("an uppercase open tag runs", async () => {
    // Stripping only `<?` left `PHP return 1;`, which is a parse error.
    expect(await BunPHP`<?PHP return 6 * 7;`).toBe(42);
  });

  test("a closing tag inside a string literal is not a mode switch", async () => {
    expect(await BunPHP`<?php return "?>";`).toBe("?>");
    expect(await BunPHP`return '?>';`).toBe("?>");
  });

  test("an opening tag inside a string literal is not leading markup", async () => {
    expect(await BunPHP`return "<?";`).toBe("<?");
    expect(await BunPHP`return "<?php";`).toBe("<?php");
  });

  test("a snippet that starts as code keeps running as code across a tag", async () => {
    expect(await BunPHP.capture`echo "a"; ?><?php echo "b";`).toBe("ab");
  });

  test("a closing tag inside a comment or heredoc is not a mode switch", async () => {
    expect(await BunPHP`/* ?> */ return 1;`).toBe(1);
    expect(
      await BunPHP`return <<<'EOT'
?>
EOT;`,
    ).toBe("?>");
  });
});

/** Where the tag rules actually live; testing them here costs no interpreter boot. */
describe("asClosureBody", () => {
  test("drops a leading open tag and keeps code mode", () => {
    expect(asClosureBody(`<?php return 1;`)).toBe(` return 1;`);
    expect(asClosureBody(`<?= 6 * 7;`)).toBe(`echo  6 * 7;`);
  });

  test("an open tag is case-insensitive, as PHP's lexer has it", () => {
    expect(asClosureBody(`<?PHP return 1;`)).toBe(` return 1;`);
    expect(asClosureBody(`<?Php return 1;`)).toBe(` return 1;`);
  });

  test("re-enters code mode only when the snippet really ends in markup", () => {
    expect(asClosureBody(`echo "a"; ?>`)).toBe(`echo "a"; ?>\n<?php `);
    expect(asClosureBody(`<?php echo "a"; ?><i>b</i><?php echo "c";`)).toBe(
      ` echo "a"; ?><i>b</i><?php echo "c";`,
    );
  });

  test("prefixes `?>` only for markup ahead of a real tag", () => {
    expect(asClosureBody(`<p>a</p><?php echo "b";`)).toBe(`?><p>a</p><?php echo "b";`);
    expect(asClosureBody(`return "<?";`)).toBe(`return "<?";`);
    // Code ran before that tag, so the snippet is code-first however many tags follow.
    expect(asClosureBody(`echo "a"; ?><?php echo "b";`)).toBe(`echo "a"; ?><?php echo "b";`);
  });

  test("ignores tags inside string literals", () => {
    expect(asClosureBody(`return "?>";`)).toBe(`return "?>";`);
    expect(asClosureBody(`return '?>';`)).toBe(`return '?>';`);
    // The escaped quote does not end the literal, so the `?>` inside it is still not a tag.
    expect(asClosureBody(`return "a\\"?>";`)).toBe(`return "a\\"?>";`);
  });

  test("ignores a closing tag inside a block comment, but not a line comment", () => {
    expect(asClosureBody(`/* ?> */ return 1;`)).toBe(`/* ?> */ return 1;`);
    // PHP ends a line comment at `?>` and leaves code mode with it.
    expect(asClosureBody(`// x ?> tail`)).toBe(`// x ?> tail\n<?php `);
    // `#[` opens an attribute, not a comment.
    expect(asClosureBody(`#[Attr] function f() {} return 1;`)).toBe(
      `#[Attr] function f() {} return 1;`,
    );
  });

  test("ignores tags inside a heredoc or nowdoc", () => {
    expect(asClosureBody(`return <<<'EOT'\n?>\nEOT;`)).toBe(`return <<<'EOT'\n?>\nEOT;`);
    expect(asClosureBody(`return <<<EOT\n<?php\n  EOT;`)).toBe(`return <<<EOT\n<?php\n  EOT;`);
  });
});

describe("raw template segments", () => {
  test("JavaScript does not eat the snippet's escapes", async () => {
    // Cooked strings turn `\d` into `d`, silently breaking every regex in an inline snippet.
    expect(await BunPHP`return preg_match("/\d+/", "abc123");`).toBe(1);
    expect(await BunPHP`return "\\" . "d";`).toBe("\\d");
  });

  test("PHP applies its own quoting rules, not JavaScript's", async () => {
    // Single quotes keep the backslash in PHP; double quotes expand it. Cooked did both the same.
    expect(await BunPHP`return 'a\tb';`).toBe("a\\tb");
    expect(await BunPHP`return "a\tb";`).toBe("a\tb");
  });

  test("a namespace separator survives", async () => {
    // PHP leaves `\D` alone inside double quotes; JavaScript's cooked strings did not.
    expect(await BunPHP`return "\DateTimeImmutable";`).toBe("\\DateTimeImmutable");
    expect(await BunPHP`return get_class(new \DateTimeImmutable());`).toBe("DateTimeImmutable");
  });

  test("an invalid JavaScript escape does not erase the snippet", async () => {
    // A cooked segment is `undefined` here, and `?? ""` used to drop the whole snippet, returning null.
    expect(await BunPHP`return "C:\uwhoops";`).toBe("C:\\uwhoops");
  });
});

describe("interpolation", () => {
  test("interpolates the common types", async () => {
    expect(await BunPHP`<?php return ${"text"};`).toBe("text");
    expect(await BunPHP`<?php return ${42};`).toBe(42);
    expect(await BunPHP`<?php return ${1.5};`).toBe(1.5);
    expect(await BunPHP`<?php return ${true};`).toBe(true);
    expect(await BunPHP`<?php return ${null};`).toBeNull();
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
    // Captured, or PHP's parse-error page prints through the test output.
    await expect(BunPHP.capture`<?php this is not php`).rejects.toThrow();
    expect(await BunPHP`<?php return "still working";`).toBe("still working");
  });

  test("calling either tag as a plain function is refused", async () => {
    // @ts-expect-error deliberately misusing the tag
    await expect(BunPHP("<?php echo 1;")).rejects.toThrow(/tagged template/);
    // @ts-expect-error deliberately misusing the tag
    await expect(BunPHP.capture("<?php echo 1;")).rejects.toThrow(
      /BunPHP\.capture is a tagged template/,
    );
  });
});

describe("concurrency", () => {
  test("overlapping snippets do not mix up their output", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => BunPHP.capture`<?php echo ${`v${i}`};`),
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

  test("overlapping printing snippets print in call order", async () => {
    // bun-php does not queue snippets itself; php-wasm runs one request at a time,
    // in the order they were started, and that is what keeps the terminal in order.
    const out = await printed(() =>
      Promise.all([
        BunPHP`<?php usleep(20000); echo "first";`,
        BunPHP`<?php echo "second";`,
        BunPHP`<?php usleep(10000); echo "third";`,
      ]),
    );
    expect(out).toBe("firstsecondthird");
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
