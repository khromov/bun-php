import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "../src/project";

const tempDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bun-php-project-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveProject", () => {
  test("falls back to the file's own directory with no project around it", async () => {
    const dir = await scratch();
    await Bun.write(join(dir, "solo.php"), "<?php");

    const project = resolveProject(join(dir, "solo.php"));
    expect(project.root).toBe(dir);
    expect(project.autoload).toBeNull();
  });

  test("finds a Composer project above the file", async () => {
    const dir = await scratch();
    await Bun.write(join(dir, "composer.json"), "{}");
    await mkdir(join(dir, "src", "deep"), { recursive: true });
    await Bun.write(join(dir, "src", "deep", "app.php"), "<?php");

    const project = resolveProject(join(dir, "src", "deep", "app.php"));
    expect(project.root).toBe(dir);
    // No vendor directory, so there is nothing to autoload.
    expect(project.autoload).toBeNull();
  });

  test("detects vendor/autoload.php", async () => {
    const dir = await scratch();
    await Bun.write(join(dir, "composer.json"), "{}");
    await Bun.write(join(dir, "vendor", "autoload.php"), "<?php");
    await mkdir(join(dir, "app"), { recursive: true });
    await Bun.write(join(dir, "app", "main.php"), "<?php");

    const project = resolveProject(join(dir, "app", "main.php"));
    expect(project.root).toBe(dir);
    expect(project.autoload).toBe(join(dir, "vendor", "autoload.php"));
  });

  test("stops at the nearest project, not the outermost", async () => {
    const outer = await scratch();
    await Bun.write(join(outer, "composer.json"), "{}");
    const inner = join(outer, "packages", "inner");
    await mkdir(inner, { recursive: true });
    await Bun.write(join(inner, "composer.json"), "{}");
    await Bun.write(join(inner, "lib.php"), "<?php");

    expect(resolveProject(join(inner, "lib.php")).root).toBe(inner);
  });

  test("an explicit autoload path overrides detection", async () => {
    const dir = await scratch();
    await Bun.write(join(dir, "app.php"), "<?php");

    const project = resolveProject(join(dir, "app.php"), {
      autoload: "/custom/bootstrap.php",
    });
    expect(project.autoload).toBe("/custom/bootstrap.php");
  });

  test("autoload: false disables detection", async () => {
    const dir = await scratch();
    await Bun.write(join(dir, "composer.json"), "{}");
    await Bun.write(join(dir, "vendor", "autoload.php"), "<?php");
    await Bun.write(join(dir, "app.php"), "<?php");

    const project = resolveProject(join(dir, "app.php"), { autoload: false });
    expect(project.root).toBe(dir);
    expect(project.autoload).toBeNull();
  });
});
