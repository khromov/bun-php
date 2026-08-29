/**
 * Install `@php-wasm/node-8-*` builds so `bun run test:versions` can cover them, naming versions
 * ("8.1") or nothing for all six. The installed builds stay in node_modules until the next
 * `bun install`; package.json and bun.lock are put back exactly as they were.
 *
 * Two Bun behaviours force the shape of this. `bun add --no-save` is a silent no-op here — it
 * resolves the tree from package.json, where these are only optional peers, and reports success
 * having installed nothing. And a plain `bun add` is *also* a no-op while the package is still
 * declared as an optional peer, so the declaration has to come out first.
 */
import { BUILD_PACKAGES } from "../src/php-runtime";
import type { PhpVersion } from "../src/types";

const ALL = Object.keys(BUILD_PACKAGES) as PhpVersion[];
const args = process.argv.slice(2);
const requested = (args.length > 0 ? args : ALL) as PhpVersion[];

const unknown = requested.filter((version) => !ALL.includes(version));
if (unknown.length > 0) {
  console.error(
    `Not a PHP version bun-php builds: ${unknown.join(", ")}. Known: ${ALL.join(", ")}`,
  );
  process.exit(1);
}

const packages = requested.map((version) => BUILD_PACKAGES[version]);
const MANIFEST = ["package.json", "bun.lock"];
const saved = await Promise.all(MANIFEST.map((file) => Bun.file(file).text()));
let failure = 0;

try {
  const manifest = JSON.parse(saved[0]!) as {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, unknown>;
  };
  for (const name of packages) {
    delete manifest.peerDependencies?.[name];
    delete manifest.peerDependenciesMeta?.[name];
  }
  await Bun.write("package.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const add = Bun.spawnSync(["bun", "add", ...packages], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  // Recorded, not exited on: `process.exit` unwinds nothing, so exiting here would skip the restore
  // below and leave the manifests stripped — the one state this script promises never to leave.
  failure = add.exitCode ?? 1;
} finally {
  await Promise.all(MANIFEST.map((file, i) => Bun.write(file, saved[i]!)));
}

if (failure !== 0) process.exit(failure);
