/**
 * Repo-level guards for mistakes that pass every other check: an assertion that never runs, and an
 * ignore pattern that never matches. Both have bitten this project once already.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// Spelled out rather than written literally, so this file does not trip its own scan.
const ASYNC_MATCHERS = ["rejects", "resolves"];
const MATCHER = new RegExp(`\\.(${ASYNC_MATCHERS.join("|")})\\b`);

/**
 * Lines whose async matcher is neither awaited nor returned, so the assertion is thrown away.
 * The scan walks back to the nearest `expect(` because oxfmt may wrap a long call across lines.
 */
function unawaitedMatchers(source: string): number[] {
  const lines = source.split("\n");
  const offenders: number[] = [];

  for (const [index, line] of lines.entries()) {
    if (!MATCHER.test(line)) continue;
    const opener = lines.slice(0, index + 1).findLastIndex((l) => l.includes("expect("));
    if (opener < 0) continue;
    const before = lines[opener]!.slice(0, lines[opener]!.indexOf("expect("));
    if (!/\b(await|return)\s+$/.test(before)) offenders.push(index + 1);
  }

  return offenders;
}

describe("async matchers", () => {
  test("every rejects/resolves assertion is awaited", async () => {
    // An un-awaited one passes whatever the code does, so the test silently asserts nothing.
    const found: string[] = [];

    for await (const file of new Glob("{test,demos}/**/*.test.ts").scan(ROOT)) {
      const source = await Bun.file(join(ROOT, file)).text();
      found.push(...unawaitedMatchers(source).map((line) => `${file}:${line}`));
    }

    expect(found).toEqual([]);
  });

  test("the scan actually recognises an un-awaited matcher", () => {
    // Otherwise a broken scan would report a clean tree forever.
    // Assembled from the constant so this fixture is not itself an un-awaited matcher.
    const bad = [
      'test("x", async () => {',
      `  expect(boom()).${ASYNC_MATCHERS[0]}.toThrow();`,
      "});",
    ].join("\n");
    const good = bad.replace("  expect", "  await expect");

    expect(unawaitedMatchers(bad)).toEqual([2]);
    expect(unawaitedMatchers(good)).toEqual([]);
  });
});

describe("ignore files", () => {
  test("globs use * rather than a corrupted _", async () => {
    // `_.log` and `_.php.d.ts` match nothing at all, and nothing reports that they don't.
    for (const name of [".gitignore", ".aidigestignore"]) {
      const lines = (await Bun.file(join(ROOT, name)).text()).split("\n");
      expect({ [name]: lines.filter((line) => /(^|\/)_\./.test(line)) }).toEqual({ [name]: [] });
    }
  });

  test("git really ignores a log file", () => {
    const ignored = Bun.spawnSync(["git", "check-ignore", "-q", "debug.log"], { cwd: ROOT });
    expect(ignored.exitCode).toBe(0);
  });
});
