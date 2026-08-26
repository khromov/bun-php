import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhpTimeoutError } from "../src/errors";
import { createInterpreter } from "../src/interpreter";

const BOOT_MS = 30_000;

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bun-php-isolation-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("isolation: 'process'", () => {
  test(
    "runs a CLI invocation in a child and reports stdout and exit code",
    async () => {
      const php = createInterpreter({ isolation: "process" });
      const result = await php.cli(["php", "-r", 'echo "hi"; exit(3);']);
      expect(result.stdout).toBe("hi");
      expect(result.exitCode).toBe(3);
    },
    BOOT_MS,
  );

  test(
    "the journal reaches the child: mounts, writes and ini all apply",
    async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, "data.txt"), "from the host");
        const php = createInterpreter({
          isolation: "process",
          ini: { memory_limit: "512M" },
        });
        await php.mount(dir, "/data");
        await php.mkdir("/s");
        await php.writeFile("/s/f.txt", "staged");
        const result = await php.cli([
          "php",
          "-r",
          'echo file_get_contents("/data/data.txt"), "|", file_get_contents("/s/f.txt"), "|", ini_get("memory_limit");',
        ]);
        expect(result.stdout).toBe("from the host|staged|512M");
      });
    },
    BOOT_MS,
  );

  test(
    "binary writeFile data survives the JSON boundary",
    async () => {
      const php = createInterpreter({ isolation: "process" });
      await php.writeFile("/bin.dat", new Uint8Array([0, 1, 2, 255, 254]));
      const result = await php.cli([
        "php",
        "-r",
        'echo implode(",", array_map("ord", str_split(file_get_contents("/bin.dat"))));',
      ]);
      expect(result.stdout).toBe("0,1,2,255,254");
    },
    BOOT_MS,
  );

  test(
    "every call gets a fresh child, so a second cli() just works",
    async () => {
      const php = createInterpreter({ isolation: "process", phpVersion: "8.3" });
      const first = await php.cli(["php", "-r", "echo PHP_VERSION;"]);
      const second = await php.cli(["php", "-r", "echo PHP_VERSION;"]);
      expect(first.stdout.startsWith("8.3.")).toBe(true);
      expect(second.stdout).toBe(first.stdout);
      expect(second.exitCode).toBe(0);
    },
    BOOT_MS,
  );

  test(
    "timeoutMs is a SIGKILL: an infinite loop rejects promptly and the interpreter survives",
    async () => {
      const php = createInterpreter({ isolation: "process", timeoutMs: 700 });
      const started = Date.now();
      const error = await php.cli(["php", "-r", "while (true) {}"]).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(PhpTimeoutError);
      // In-process this loop would run forever; the kill lands near the deadline.
      expect(Date.now() - started).toBeLessThan(5_000);
      // No retirement: the dead child took the whole request with it.
      expect(php.retired).toBe(false);
      const after = await php.cli(["php", "-r", 'echo "alive";'], { timeoutMs: 0 });
      expect(after.stdout).toBe("alive");
    },
    BOOT_MS,
  );

  test("parent memory stays flat across calls — the point of the mode", async () => {
    const rss = () => {
      Bun.gc(true);
      return process.memoryUsage.rss();
    };
    const php = createInterpreter({ isolation: "process" });
    await php.cli(["php", "-r", "echo 1;"]);
    const base = rss();
    for (let i = 0; i < 5; i++) await php.cli(["php", "-r", "echo 1;"]);
    // In-process, five boot/dispose cycles retain hundreds of MB; isolated
    // calls leave the parent within noise of where it started.
    expect(rss() - base).toBeLessThan(100 * 1024 * 1024);
  }, 120_000);

  test("isolated calls overlap — children run on their own cores", async () => {
    const busy = () =>
      createInterpreter({ isolation: "process" }).cli([
        "php",
        "-r",
        '$t=microtime(true); while (microtime(true)-$t < 1) {} echo "ok";',
      ]);
    const oneStart = Date.now();
    await busy();
    const oneMs = Date.now() - oneStart;
    const twoStart = Date.now();
    const results = await Promise.all([busy(), busy()]);
    const twoMs = Date.now() - twoStart;
    expect(results.every((r) => r.stdout === "ok")).toBe(true);
    // In-process the same pair measures ~1.96x; children measure ~1.04x.
    expect(twoMs).toBeLessThan(oneMs * 1.6);
  }, 120_000);

  test("refuses options that cannot cross the process boundary", () => {
    expect(() =>
      createInterpreter({
        isolation: "process",
        loader: () => {
          throw new Error("never");
        },
      }),
    ).toThrow("loader");
    expect(() =>
      createInterpreter({
        isolation: "process",
        spawn: () => {
          throw new Error("never");
        },
      }),
    ).toThrow("spawn");
    // The one spawn value that serializes is fine.
    expect(() => createInterpreter({ isolation: "process", spawn: "refuse" })).not.toThrow();
  });

  test("php() has no instance to hand back", async () => {
    const php = createInterpreter({ isolation: "process" });
    expect(php.php()).rejects.toThrow("isolation");
  });
});
