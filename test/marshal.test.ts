import { describe, expect, test } from "bun:test";
import { decodeOutput, encodeArgs, encodeValue, SENTINEL } from "../src/marshal";

describe("encodeArgs", () => {
  test("drops trailing undefined so PHP defaults apply", () => {
    expect(encodeArgs(["a", undefined, undefined])).toBe(encodeArgs(["a"]));
    expect(encodeArgs([undefined])).toBe("");
  });

  test("rejects an undefined hole with the function name and position", () => {
    expect(() => encodeArgs([undefined, 1], "f")).toThrow(
      /f: argument #1 is undefined/,
    );
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
