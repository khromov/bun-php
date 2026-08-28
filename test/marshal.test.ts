import { describe, expect, test } from "bun:test";
import { encodeArgs, encodeValue, EnvelopeSplitter, SENTINEL } from "../src/marshal";

/** Split a complete stdout string the way the runtime splits a stream. */
function decodeOutput(stdout: string) {
  let out = "";
  const splitter = new EnvelopeSplitter((text) => {
    out += text;
  });
  splitter.push(stdout);
  const envelope = splitter.end();
  return { out, envelope };
}

describe("encodeArgs", () => {
  test("drops trailing undefined so PHP defaults apply", () => {
    expect(encodeArgs(["a", undefined, undefined])).toBe(encodeArgs(["a"]));
    expect(encodeArgs([undefined])).toBe("");
  });

  test("rejects an undefined hole with the function name and position", () => {
    expect(() => encodeArgs([undefined, 1], "f")).toThrow(/f: argument #1 is undefined/);
  });

  test("reports a sparse hole the way a literal undefined is reported", () => {
    // Built rather than written as `[, 1]`, which the linter rejects; `.map` skips the hole, which
    // used to emit the invalid `f(, 1)` instead of naming the argument.
    const sparse: unknown[] = [];
    sparse[1] = 1;
    expect(() => encodeArgs(sparse, "f")).toThrow("f: argument #1 is undefined; pass null instead");
  });

  test("encodes BigInt as a PHP int literal", () => {
    expect(encodeArgs([42n])).toBe("42");
    expect(encodeArgs([2n ** 63n - 1n])).toBe("9223372036854775807");
    expect(encodeArgs([-(2n ** 63n)])).toBe("(-9223372036854775807 - 1)");
    expect(() => encodeArgs([2n ** 63n], "f")).toThrow(/overflows/);
  });

  test("encodes non-finite numbers as PHP float constants", () => {
    expect(encodeArgs([NaN, Infinity, -Infinity])).toBe("NAN, INF, -INF");
  });
});

describe("encodeValue", () => {
  test("refuses a non-finite number nested inside a value", () => {
    // Top level becomes NAN/INF, but phpVar's JSON path would silently make a nested one null.
    expect(() => encodeValue([1, NaN], "f: argument #1")).toThrow(
      /holds a non-finite number at \[1\]/,
    );
    expect(() => encodeValue({ a: { b: Infinity } }, "f: argument #1")).toThrow(
      /holds a non-finite number at \.a\.b/,
    );
  });

  test("reports a cycle instead of blowing the stack", () => {
    // The non-finite scan recurses; without cycle protection it died before phpVar could explain.
    const list: unknown[] = [];
    list.push(list);
    const object: Record<string, unknown> = {};
    object.self = object;

    for (const value of [list, object]) {
      const error = (() => {
        try {
          encodeValue(value, "f: argument #1");
        } catch (err) {
          return err as Error;
        }
        throw new Error("should have thrown");
      })();

      expect(error).not.toBeInstanceOf(RangeError);
      expect(error.message).toContain("f: argument #1 could not be encoded");
      expect(error.message).toContain("cyclic");
    }
  });

  test("names the value in error messages", () => {
    expect(() => encodeValue(undefined, "BunPHP: interpolation #2")).toThrow(
      /BunPHP: interpolation #2 is undefined/,
    );
  });

  test("wraps encoder failures with context", () => {
    // A nested BigInt reaches JSON.stringify inside phpVar and throws there.
    expect(() => encodeValue([1n], "f: argument #1")).toThrow(
      /f: argument #1 could not be encoded/,
    );
  });
});

describe("decodeOutput", () => {
  const wrap = (json: string) => `${SENTINEL}${json}${SENTINEL}`;

  test("parses the envelope between the sentinel pair", () => {
    const { out, envelope } = decodeOutput(`before${wrap('{"ok":true,"v":1}')}`);
    expect(out).toBe("before");
    expect(envelope).toEqual({ ok: true, v: 1 });
  });

  test("output after the closing sentinel is kept as output", () => {
    // What a user shutdown function or destructor printing at request end
    // looks like: it must not corrupt the envelope.
    const { out, envelope } = decodeOutput(`a${wrap('{"ok":true,"v":41}')}bye`);
    expect(out).toBe("abye");
    expect(envelope).toEqual({ ok: true, v: 41 });
  });

  test("no sentinel means no envelope", () => {
    expect(decodeOutput("plain output")).toEqual({
      out: "plain output",
      envelope: null,
    });
  });

  test("a lone sentinel still parses (the process died mid-envelope)", () => {
    const { out, envelope } = decodeOutput(`x${SENTINEL}{"ok":true,"v":2}`);
    expect(out).toBe("x");
    expect(envelope).toEqual({ ok: true, v: 2 });
  });

  test("an unparseable envelope returns everything as output", () => {
    const raw = `${SENTINEL}{oops${SENTINEL}`;
    expect(decodeOutput(raw)).toEqual({ out: raw, envelope: null });
  });
});

describe("EnvelopeSplitter", () => {
  const wrap = (json: string) => `${SENTINEL}${json}${SENTINEL}`;

  /** Feed the chunks in order, returning what was emitted and when. */
  function split(chunks: string[]) {
    const emitted: string[] = [];
    const splitter = new EnvelopeSplitter((text) => emitted.push(text));
    for (const chunk of chunks) splitter.push(chunk);
    const envelope = splitter.end();
    return { emitted, envelope, out: emitted.join("") };
  }

  test("emits output as it arrives, before the envelope closes", () => {
    const emitted: string[] = [];
    const splitter = new EnvelopeSplitter((text) => emitted.push(text));

    splitter.push("log 1\n");
    expect(emitted).toEqual(["log 1\n"]);
    splitter.push("log 2\n");
    expect(emitted).toEqual(["log 1\n", "log 2\n"]);

    splitter.push(wrap('{"ok":true,"v":1}'));
    expect(splitter.end()).toEqual({ ok: true, v: 1 });
    expect(emitted.join("")).toBe("log 1\nlog 2\n");
  });

  test("a sentinel split across chunks is still recognised", () => {
    const raw = `out${wrap('{"ok":true,"v":7}')}`;
    for (let at = 1; at < raw.length; at++) {
      const { out, envelope } = split([raw.slice(0, at), raw.slice(at)]);
      expect(envelope).toEqual({ ok: true, v: 7 });
      expect(out).toBe("out");
    }
  });

  test("output is not held back waiting for a sentinel that never comes", () => {
    // A partial marker is withheld, but only the part that could still grow
    // into one — never the text in front of it.
    const emitted: string[] = [];
    const splitter = new EnvelopeSplitter((text) => emitted.push(text));
    splitter.push(`done\u0000BUN`);
    expect(emitted.join("")).toBe("done");
    expect(splitter.end()).toBeNull();
    expect(emitted.join("")).toBe(`done\u0000BUN`);
  });

  test("a sentinel pair that is not JSON is put back as output", () => {
    const raw = `a${wrap("not json")}b`;
    const { out, envelope } = split([raw]);
    expect(envelope).toBeNull();
    expect(out).toBe(raw);
  });

  test("a stray sentinel in the output does not hide the envelope after it", () => {
    // The failed pair's closing sentinel is put back as an opener, so the pairing cannot shift by
    // one and leave the real envelope's JSON classified as output.
    const json = '{"ok":true,"v":42}';
    const { out, envelope } = split([`before${SENTINEL}after${SENTINEL}${json}${SENTINEL}`]);
    expect(envelope).toEqual({ ok: true, v: 42 });
    expect(out).toBe(`before${SENTINEL}after`);
  });

  test("the last envelope wins, and the earlier one becomes output", () => {
    const first = wrap('{"ok":true,"v":1}');
    const second = wrap('{"ok":true,"v":2}');
    const { out, envelope } = split([`a${first}b${second}c`]);
    expect(envelope).toEqual({ ok: true, v: 2 });
    expect(out).toBe(`a${first}bc`);
  });

  test("tail keeps the end of the output for error reporting", () => {
    const splitter = new EnvelopeSplitter(() => {});
    splitter.push("x".repeat(9000) + "END");
    splitter.end();
    expect(splitter.tail).toEndWith("END");
    expect(splitter.tail.length).toBeLessThanOrEqual(8192);
  });
});
