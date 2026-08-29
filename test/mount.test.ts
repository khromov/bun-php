/**
 * Mounting the project directory is what makes multi-file PHP work: sibling
 * `require`, `__DIR__`, and Composer's autoloader all depend on it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePhp } from "../src/parse";
import { resolveProject } from "../src/project";
import { createPhpModule } from "../src/runtime";
import type { PhpModuleApi } from "../src/types";

const tempDirs: string[] = [];
const modules: PhpModuleApi[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bun-php-mount-"));
  tempDirs.push(dir);
  return dir;
}

/** Build a module the way the plugin would, including project detection. */
function moduleFor(
  path: string,
  source: string,
  overrides: { root?: string | null; autoload?: string | null } = {},
): PhpModuleApi {
  const meta = parsePhp(source, path);
  const project = resolveProject(path);
  const mod = createPhpModule({
    id: path,
    source,
    functions: Object.fromEntries(meta.functions.map((f) => [f.exportName, f.phpName])),
    meta,
    root: overrides.root !== undefined ? overrides.root : project.root,
    autoload: overrides.autoload !== undefined ? overrides.autoload : project.autoload,
  });
  modules.push(mod);
  return mod;
}

afterAll(async () => {
  await Promise.all(modules.map((mod) => mod.$dispose().catch(() => {})));
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("mounted project directory", () => {
  test("a sibling file can be required", async () => {
    const dir = await scratch();
    await Bun.write(
      join(dir, "helper.php"),
      `<?php function helper(): string { return "helped"; }`,
    );
    const main = join(dir, "main.php");
    const source = `<?php
require_once __DIR__ . '/helper.php';
function callHelper(): string { return helper(); }
`;
    await Bun.write(main, source);

    expect(await moduleFor(main, source).$call("callHelper", [])).toBe("helped");
  });

  test("a nested file can be required", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "lib", "deep"), { recursive: true });
    await Bun.write(
      join(dir, "lib", "deep", "nested.php"),
      `<?php function nested(): int { return 7; }`,
    );
    const main = join(dir, "main.php");
    const source = `<?php
require_once __DIR__ . '/lib/deep/nested.php';
function callNested(): int { return nested(); }
`;
    await Bun.write(main, source);

    expect(await moduleFor(main, source).$call("callNested", [])).toBe(7);
  });

  test("__DIR__ and __FILE__ report the real host paths", async () => {
    const dir = await scratch();
    const main = join(dir, "paths.php");
    const source = `<?php
function whereAmI(): array { return ['dir' => __DIR__, 'file' => __FILE__]; }
`;
    await Bun.write(main, source);

    expect(await moduleFor(main, source).$call("whereAmI", [])).toEqual({
      dir,
      file: main,
    });
  });

  test("the mount is a live view of the host filesystem", async () => {
    const dir = await scratch();
    const main = join(dir, "live.php");
    const source = `<?php
function readLate(): string { return trim(file_get_contents(__DIR__ . '/late.txt')); }
`;
    await Bun.write(main, source);
    const mod = moduleFor(main, source);
    await mod.$ready();

    // Written after the interpreter booted and mounted the directory.
    await Bun.write(join(dir, "late.txt"), "written later");
    expect(await mod.$call("readLate", [])).toBe("written later");
  });

  test("files can be read and written back to the host", async () => {
    const dir = await scratch();
    const main = join(dir, "io.php");
    const source = `<?php
function writeOut(string $text): int { return file_put_contents(__DIR__ . '/out.txt', $text); }
`;
    await Bun.write(main, source);

    await moduleFor(main, source).$call("writeOut", ["from php"]);
    expect(await Bun.file(join(dir, "out.txt")).text()).toBe("from php");
  });
});

describe("autoload", () => {
  test("a detected autoloader runs before the module", async () => {
    const dir = await scratch();
    await Bun.write(join(dir, "composer.json"), "{}");
    await Bun.write(
      join(dir, "vendor", "autoload.php"),
      `<?php function fromAutoload(): string { return "autoloaded"; }`,
    );
    const main = join(dir, "app.php");
    const source = `<?php function useAutoload(): string { return fromAutoload(); }`;
    await Bun.write(main, source);

    const project = resolveProject(main);
    expect(project.autoload).toBe(join(dir, "vendor", "autoload.php"));
    expect(await moduleFor(main, source).$call("useAutoload", [])).toBe("autoloaded");
  });

  test("the autoloader is re-registered on every call", async () => {
    // PHP request state resets between calls, so a class autoloaded once must
    // still resolve on the next call.
    const dir = await scratch();
    await Bun.write(join(dir, "composer.json"), "{}");
    await mkdir(join(dir, "vendor"), { recursive: true });
    await Bun.write(
      join(dir, "vendor", "autoload.php"),
      `<?php spl_autoload_register(function ($class) {
         if ($class === 'Lazy') { eval('class Lazy { public function hi() { return "lazy hi"; } }'); }
       });`,
    );
    const main = join(dir, "app.php");
    const source = `<?php function useLazy(): string { return (new Lazy())->hi(); }`;
    await Bun.write(main, source);

    const mod = moduleFor(main, source);
    expect(await mod.$call("useLazy", [])).toBe("lazy hi");
    expect(await mod.$call("useLazy", [])).toBe("lazy hi");
  });
});

describe("fallback when the directory is not on disk", () => {
  test("a module with no host directory uses its inlined source", async () => {
    // This is what a bundle running elsewhere looks like.
    const source = `<?php function inlined(): string { return "from inlined source"; }`;
    const mod = moduleFor("/nowhere/on/disk/mod.php", source, {
      root: "/nowhere/on/disk",
      autoload: null,
    });

    expect(await mod.$call("inlined", [])).toBe("from inlined source");
  });

  test("a root that exists without the module file still uses the inlined source", async () => {
    // Gated on the directory, this mounted the root and then fatally failed the require_once of
    // every call, where the inlined source would have worked.
    const dir = await scratch();
    const source = `<?php function ghost(): string { return "from inlined source"; }`;
    const mod = moduleFor(join(dir, "never-written.php"), source, { root: dir, autoload: null });

    expect(await mod.$call("ghost", [])).toBe("from inlined source");
  });

  test("an autoloader that was never mounted is not required", async () => {
    // A bundle built where vendor/ existed and run where the root does not: the autoload path
    // survives into the module, but requiring it would fatal on every call.
    const source = `<?php function stillWorks(): string { return "no autoloader needed"; }`;
    const mod = moduleFor("/nowhere/on/disk/bundled.php", source, {
      root: "/nowhere/on/disk",
      autoload: "/nowhere/on/disk/vendor/autoload.php",
    });

    expect(await mod.$call("stillWorks", [])).toBe("no autoloader needed");
  });
});
