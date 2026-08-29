import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterpreter } from "../src/interpreter";
import { buildImportError, PhpBuildLoadError, PhpBuildNotInstalledError } from "../src/php-runtime";
import { isBuildInstalled } from "./php-builds";

const BOOT_MS = 30_000;

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bun-php-interp-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A `loader` that counts how many times the wasm runtime was instantiated. */
function countingLoader() {
  const counter = { boots: 0 };
  const loader = async () => {
    counter.boots++;
    return (await import("@php-wasm/node-8-5")).getPHPLoaderModule();
  };
  return { counter, loader };
}

describe("createInterpreter", () => {
  test(
    "runs a CLI invocation and reports stdout and exit code",
    async () => {
      const php = createInterpreter();
      try {
        const result = await php.cli(["php", "-r", 'echo "hi"; exit(3);']);
        expect(result.stdout).toBe("hi");
        expect(result.exitCode).toBe(3);
      } finally {
        await php.dispose();
      }
    },
    BOOT_MS,
  );

  test(
    "mounts a host directory named at call time",
    async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, "data.txt"), "from the host");
        const php = createInterpreter();
        try {
          await php.mount(dir, "/data");
          const result = await php.cli(["php", "-r", 'echo file_get_contents("/data/data.txt");']);
          expect(result.stdout).toBe("from the host");
        } finally {
          await php.dispose();
        }
      });
    },
    BOOT_MS,
  );

  test(
    "mounts supplied up front are in place before the first call",
    async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, "a.txt"), "mounted");
        const php = createInterpreter({ mounts: [{ host: dir, at: "/m" }] });
        try {
          const result = await php.cli(["php", "-r", 'echo file_get_contents("/m/a.txt");']);
          expect(result.stdout).toBe("mounted");
        } finally {
          await php.dispose();
        }
      });
    },
    BOOT_MS,
  );

  test(
    "applies php.ini entries",
    async () => {
      const php = createInterpreter({ ini: { memory_limit: "512M" } });
      try {
        const result = await php.cli(["php", "-r", 'echo ini_get("memory_limit");']);
        expect(result.stdout).toBe("512M");
      } finally {
        await php.dispose();
      }
    },
    BOOT_MS,
  );

  test(
    "a pinned php.ini entry cannot be set on a live instance either",
    async () => {
      // Boot re-asserts the pin after the journal, but ini() lands on an instance already running,
      // where nothing corrects it afterwards. Warning about it was not the same as ignoring it.
      const php = createInterpreter();
      try {
        await php.php();
        await php.ini({ short_open_tag: "1", memory_limit: "256M" });

        const result = await php.cli([
          "php",
          "-r",
          'echo ini_get("short_open_tag") === "1" ? "On" : "Off", "|", ini_get("memory_limit");',
        ]);
        // The pinned entry is dropped; everything alongside it still applies.
        expect(result.stdout).toBe("Off|256M");
      } finally {
        await php.dispose();
      }
    },
    BOOT_MS,
  );

  test(
    'spawn: "refuse" answers process functions instead of hanging',
    async () => {
      const php = createInterpreter({ spawn: "refuse" });
      try {
        const result = await php.cli(["php", "-r", 'var_dump(shell_exec("tty"));']);
        expect(result.stdout).toContain("NULL");
      } finally {
        await php.dispose();
      }
    },
    BOOT_MS,
  );

  test(
    "a second cli() works, and keeps what was staged for the first",
    async () => {
      // `PHP.cli()` exits its instance when the command finishes; reusing it raw
      // returns exit code -1 with no output and no error at all.
      const php = createInterpreter();
      try {
        await php.mkdir("/s");
        await php.writeFile("/s/f.txt", "staged");
        const first = await php.cli(["php", "-r", 'echo file_get_contents("/s/f.txt");']);
        const second = await php.cli([
          "php",
          "-r",
          'echo file_get_contents("/s/f.txt"), "-again";',
        ]);
        expect(first.stdout).toBe("staged");
        expect(second.stdout).toBe("staged-again");
        expect(second.exitCode).toBe(0);
      } finally {
        await php.dispose();
      }
    },
    BOOT_MS,
  );

  test(
    "writeFile puts a file inside the virtual filesystem",
    async () => {
      const php = createInterpreter();
      try {
        await php.mkdir("/scratch");
        await php.writeFile("/scratch/list.txt", "one\ntwo");
        const result = await php.cli([
          "php",
          "-r",
          'echo trim(file_get_contents("/scratch/list.txt"));',
        ]);
        expect(result.stdout).toBe("one\ntwo");
      } finally {
        await php.dispose();
      }
    },
    BOOT_MS,
  );
});

describe("instances", () => {
  test(
    "concurrent cli() calls on one interpreter each get their own instance",
    async () => {
      const { counter, loader } = countingLoader();
      const php = createInterpreter({ loader });
      try {
        const [a, b] = await Promise.all([
          php.cli(["php", "-r", 'echo "a";']),
          php.cli(["php", "-r", 'echo "b";']),
        ]);
        // Sharing one instance would hand the second call exit code -1 and no output.
        expect([a.stdout, a.exitCode]).toEqual(["a", 0]);
        expect([b.stdout, b.exitCode]).toEqual(["b", 0]);
        expect(counter.boots).toBe(2);
      } finally {
        await php.dispose();
      }
    },
    BOOT_MS,
  );

  test(
    "ini and mounts given as options are re-applied to every fresh instance",
    async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, "a.txt"), "mounted");
        const php = createInterpreter({
          ini: { memory_limit: "512M" },
          mounts: [{ host: dir, at: "/m" }],
        });
        try {
          const script = 'echo ini_get("memory_limit"), "|", file_get_contents("/m/a.txt");';
          const first = await php.cli(["php", "-r", script]);
          // cli() consumed that instance, so this call runs on a replacement.
          const second = await php.cli(["php", "-r", script]);
          expect(first.stdout).toBe("512M|mounted");
          expect(second.stdout).toBe("512M|mounted");
        } finally {
          await php.dispose();
        }
      });
    },
    BOOT_MS,
  );

  test(
    "options and later staging are applied in order, so staging can build on a mount",
    async () => {
      await withTempDir(async (dir) => {
        const php = createInterpreter({ mounts: [{ host: dir, at: "/m" }] });
        try {
          // Writing into the mount only works if the mount was applied first.
          await php.writeFile("/m/written.txt", "through the mount");
          const result = await php.cli(["php", "-r", 'echo file_get_contents("/m/written.txt");']);
          expect(result.stdout).toBe("through the mount");
          expect(await Bun.file(join(dir, "written.txt")).text()).toBe("through the mount");
        } finally {
          await php.dispose();
        }
      });
    },
    BOOT_MS,
  );
});

describe("phpVersion", () => {
  test(
    "defaults to 8.5 and honours an explicit older build",
    async () => {
      const latest = createInterpreter();
      const older = createInterpreter({ phpVersion: "8.3" });
      try {
        const [a, b] = await Promise.all([
          latest.cli(["php", "-r", "echo PHP_VERSION;"]),
          older.cli(["php", "-r", "echo PHP_VERSION;"]),
        ]);
        expect(a.stdout.startsWith("8.5.")).toBe(true);
        expect(b.stdout.startsWith("8.3.")).toBe(true);
      } finally {
        await Promise.all([latest.dispose(), older.dispose()]);
      }
    },
    BOOT_MS,
  );

  test(
    "a failed boot is not cached, so the next call tries again",
    async () => {
      // A rejected promise left in place replayed the same failure until $reset()/$dispose().
      let attempts = 0;
      const php = createInterpreter({
        loader: async () => {
          attempts++;
          if (attempts === 1) throw new Error("transient boot failure");
          return (await import("@php-wasm/node-8-5")).getPHPLoaderModule();
        },
      });
      try {
        await expect(php.php()).rejects.toThrow("transient boot failure");
        expect((await php.cli(["php", "-r", "echo 'recovered';"])).stdout).toBe("recovered");
        expect(attempts).toBe(2);
      } finally {
        await php.dispose();
      }
    },
    BOOT_MS,
  );

  test(
    "an op that fails is not recorded in the journal",
    async () => {
      // Recorded regardless, it replays onto every later boot: the caller is told the mount failed
      // while it quietly breaks every call that follows.
      const php = createInterpreter();
      try {
        const failed = await php.mount("/definitely/not/a/real/host/path", "/mnt").then(
          () => null,
          (err: unknown) => err ?? new Error("rejected with a falsy value"),
        );
        expect(failed).not.toBeNull();

        // The first call reuses the instance the mount booted; the second boots afresh and replays.
        expect((await php.cli(["php", "-r", "echo 1;"])).stdout).toBe("1");
        expect((await php.cli(["php", "-r", "echo 2;"])).stdout).toBe("2");
      } finally {
        await php.dispose();
      }
    },
    BOOT_MS,
  );

  test(
    "dispose survives a runtime that throws on exit",
    async () => {
      // createPhpModule discards this promise (`void cached.dispose()`), so a rejection here
      // would be an unhandled rejection with nobody to catch it.
      const php = createInterpreter();
      const instance = await php.php();
      const exit = instance.exit.bind(instance);
      instance.exit = () => {
        throw new Error("already exiting");
      };

      await expect(php.dispose()).resolves.toBeUndefined();

      instance.exit = exit;
      instance.exit();
    },
    BOOT_MS,
  );

  // Skipped rather than failed where 8.1 *is* installed: the version matrix job installs it, and
  // so does anyone who ran `bun run php-builds:install`.
  test.skipIf(isBuildInstalled("8.1"))("names the package a missing build needs", async () => {
    const php = createInterpreter({ phpVersion: "8.1" });
    const error = await php.cli(["php", "-v"]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PhpBuildNotInstalledError);
    expect((error as Error).message).toContain("@php-wasm/node-8-1");
    expect((error as Error).message).toContain("not installed");
    expect((error as Error).cause).toBeDefined();
  });

  test("a transitive resolution failure is not blamed on the build package", async () => {
    // `bun add @php-wasm/node-8-5` cannot fix a dependency *inside* an installed build.
    const throws = 'data:text/javascript,await import("totally-not-installed-xyz")';
    const transitive = await import(throws).catch((err: unknown) => err);
    expect((transitive as { code?: string }).code).toBe("ERR_MODULE_NOT_FOUND");

    const error = buildImportError("8.5", "@php-wasm/node-8-5", transitive);
    expect(error).toBeInstanceOf(PhpBuildLoadError);
    expect(error.message).not.toContain("bun add");
  });

  // Skipped where 8.1 is installed: the import below has to actually fail to resolve.
  test.skipIf(isBuildInstalled("8.1"))(
    "tells a broken build apart from a missing one",
    async () => {
      // Both are real import failures: one cannot resolve, the other throws while evaluating.
      // The specifiers go through variables so TypeScript does not try to resolve them itself.
      const absent = "@php-wasm/node-8-1";
      const throws = 'data:text/javascript,throw new TypeError("boom")';
      const missing = await import(absent).catch((err: unknown) => err);
      const broken = await import(throws).catch((err: unknown) => err);

      const notInstalled = buildImportError("8.1", "@php-wasm/node-8-1", missing);
      expect(notInstalled).toBeInstanceOf(PhpBuildNotInstalledError);
      expect(notInstalled.message).toContain("bun add @php-wasm/node-8-1");

      // `bun add` cannot fix a package that is already there, so it must not be the advice.
      const failedToLoad = buildImportError("8.1", "@php-wasm/node-8-1", broken);
      expect(failedToLoad).toBeInstanceOf(PhpBuildLoadError);
      expect(failedToLoad.message).toContain("is installed but failed to load");
      expect(failedToLoad.message).not.toContain("bun add");
      expect(failedToLoad.cause).toBe(broken);
    },
  );

  test(
    "loader takes precedence over phpVersion",
    async () => {
      const php = createInterpreter({
        phpVersion: "8.3",
        loader: async () => {
          const build = await import("@php-wasm/node-8-5");
          return build.getPHPLoaderModule();
        },
      });
      try {
        const result = await php.cli(["php", "-r", "echo PHP_VERSION;"]);
        expect(result.stdout.startsWith("8.5.")).toBe(true);
      } finally {
        await php.dispose();
      }
    },
    BOOT_MS,
  );
});

describe("concurrency", () => {
  test("two interpreters do not overlap — the wasm work holds the thread", async () => {
    // Pins the reason there is no pool API: a second instance buys nothing.
    // Parallelism needs a Worker per interpreter, which is a caller's choice.
    const busy = () =>
      createInterpreter().cli([
        "php",
        "-r",
        '$t=microtime(true); while (microtime(true)-$t < 1) {} echo "ok";',
      ]);

    const oneStart = Date.now();
    await busy();
    const oneMs = Date.now() - oneStart;

    const twoStart = Date.now();
    await Promise.all([busy(), busy()]);
    const twoMs = Date.now() - twoStart;

    expect(twoMs).toBeGreaterThan(oneMs * 1.6);
  }, 120_000);
});
