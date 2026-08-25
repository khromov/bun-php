import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phpPlugin } from "../src/plugin";
import { createPhpModule } from "../src/runtime";
import { parsePhp } from "../src/parse";

const tempDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bun-php-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Drive a plugin's `onLoad` hook without going through Bun's module loader. */
async function runOnLoad(plugin: ReturnType<typeof phpPlugin>, path: string, config: any = {}) {
  let handler: any;
  const builder: any = {
    config,
    onLoad: (_constraints: unknown, callback: unknown) => {
      handler = callback;
      return builder;
    },
    onResolve: () => builder,
    onStart: () => builder,
    onEnd: () => builder,
    onBeforeParse: () => builder,
    module: () => builder,
  };
  await plugin.setup(builder);
  return handler({ path, namespace: "file", loader: "js", defer: async () => {} });
}

const SAMPLE = `<?php
function greet(string $name): string { return "Hello, $name!"; }
const NAME = 'sample';
`;

describe("onLoad", () => {
  test("returns generated JS with a resolveDir", async () => {
    const dir = await scratch();
    const file = join(dir, "sample.php");
    await Bun.write(file, SAMPLE);

    const result = await runOnLoad(phpPlugin(), file);
    expect(result.loader).toBe("js");
    expect(result.resolveDir).toBe(dir);
    expect(result.contents).toContain("export const greet");
    expect(result.contents).toContain(`export const NAME = "sample";`);
  });

  test("a syntax error in the PHP surfaces as an import failure", async () => {
    const dir = await scratch();
    const file = join(dir, "broken.php");
    await Bun.write(file, "<?php function {");

    expect(runOnLoad(phpPlugin(), file)).rejects.toThrow(/syntax error/i);
  });
});

describe("sidecar .d.ts", () => {
  test("is written next to the source file", async () => {
    const dir = await scratch();
    const file = join(dir, "sample.php");
    await Bun.write(file, SAMPLE);

    await runOnLoad(phpPlugin(), file);

    const sidecar = await Bun.file(`${file}.d.ts`).text();
    expect(sidecar).toContain(
      "export declare function greet(name: string): Promise<string>;",
    );
    expect(sidecar).toContain(`export declare const NAME: "sample";`);
  });

  test("is not rewritten when the content is unchanged", async () => {
    // An unconditional write churns mtime and would retrigger --watch/--hot.
    const dir = await scratch();
    const file = join(dir, "sample.php");
    await Bun.write(file, SAMPLE);

    await runOnLoad(phpPlugin(), file);
    const first = await stat(`${file}.d.ts`);

    await Bun.sleep(20);
    await runOnLoad(phpPlugin(), file);
    const second = await stat(`${file}.d.ts`);

    expect(second.mtimeMs).toBe(first.mtimeMs);
  });

  test("is rewritten when the PHP changes", async () => {
    const dir = await scratch();
    const file = join(dir, "sample.php");
    await Bun.write(file, SAMPLE);
    await runOnLoad(phpPlugin(), file);

    await Bun.write(file, `<?php function other(int $n): int { return $n; }`);
    await runOnLoad(phpPlugin(), file);

    const sidecar = await Bun.file(`${file}.d.ts`).text();
    expect(sidecar).toContain("other(n: number): Promise<number>");
    expect(sidecar).not.toContain("greet");
  });

  test("is skipped when producing a bundle", async () => {
    const dir = await scratch();
    const file = join(dir, "sample.php");
    await Bun.write(file, SAMPLE);

    await runOnLoad(phpPlugin(), file, { outdir: join(dir, "out") });

    expect(await Bun.file(`${file}.d.ts`).exists()).toBe(false);
  });

  test("can be forced on during a bundle, or disabled entirely", async () => {
    const dir = await scratch();
    const file = join(dir, "sample.php");
    await Bun.write(file, SAMPLE);

    await runOnLoad(phpPlugin({ dts: true }), file, { outdir: join(dir, "out") });
    expect(await Bun.file(`${file}.d.ts`).exists()).toBe(true);

    const other = join(dir, "other.php");
    await Bun.write(other, SAMPLE);
    await runOnLoad(phpPlugin({ dts: false }), other);
    expect(await Bun.file(`${other}.d.ts`).exists()).toBe(false);
  });
});

describe("Bun.build", () => {
  test("bundles a .php import through the plugin", async () => {
    const dir = await scratch();
    await Bun.write(join(dir, "lib.php"), SAMPLE);
    await Bun.write(
      join(dir, "entry.ts"),
      `import { greet } from "./lib.php";\nconsole.log(await greet("bundled"));\n`,
    );

    const result = await Bun.build({
      entrypoints: [join(dir, "entry.ts")],
      outdir: join(dir, "out"),
      target: "bun",
      plugins: [phpPlugin()],
    });

    expect(result.success).toBe(true);
    const bundled = await result.outputs[0]!.text();
    expect(bundled).toContain("createPhpModule");
  });
});

describe("stdout modes", () => {
  const talkative = `<?php function talks(): string { echo "side-effect"; return "value"; }`;

  const moduleWith = (stdout: "capture" | "ignore", id: string) => {
    const meta = parsePhp(talkative, id);
    return createPhpModule({
      id,
      source: talkative,
      functions: Object.fromEntries(meta.functions.map((f) => [f.exportName, f.phpName])),
      meta,
      stdout,
    });
  };

  test("capture collects echo output instead of printing it", async () => {
    const mod = moduleWith("capture", "/virtual/capture.php");
    expect(await mod.call("talks", [])).toBe("value");
    expect(mod.$output()).toBe("side-effect");
    // Draining leaves the buffer empty.
    expect(mod.$output()).toBe("");
    await mod.$dispose();
  });

  test("ignore discards echo output", async () => {
    const mod = moduleWith("ignore", "/virtual/ignore.php");
    expect(await mod.call("talks", [])).toBe("value");
    expect(mod.$output()).toBe("");
    await mod.$dispose();
  });
});
